// Assembles everything the dashboard shows. Pure orchestration: the calculations live in metrics.mjs,
// opportunity.mjs and backtest.mjs; the stories come from the database as of a chosen moment.
import { readdirSync, statSync } from "node:fs";
import { dayStart, dayOf, DAY_MS } from "./db.mjs";
import { prepareItems, analyse, seriesFor, buildSeasonality, HOUR } from "./metrics.mjs";
import { buildEntities, itemsWithEntity, entityId } from "./entities.mjs";
import { evaluatePending, outcomeSummary, tuneWeights } from "./outcomes.mjs";
import { isWeakLabel } from "./topics.mjs";
import { qualityReport } from "./quality.mjs";
import { buildOpportunities, itemsByLabel, onlineOnAngle } from "./opportunity.mjs";
// JOURNALISTS DISABLED: import { journalistFit, toAuthor, toks } from "./journalists.mjs";
import { runBacktest } from "./backtest.mjs";
import { norm } from "./brackets.mjs";
import { TopicRegistry } from "./topics.mjs";
import { getCachedIndiaTrends, matchOpportunityTrend } from "./xtrends.mjs";

const LOAD_DAYS = 15; // enough for the 7-day baseline plus the 14-day daily chart
// The shared context takes ~2 s to build, so it is kept for minutes, not seconds. It is still rebuilt as soon as its signature changes (new stories, readings,
// labels, a finished job) and dropped by cache.clear() (jobs, edits), so a longer life only saves work, it never shows older data.
// The signature already changes with every new story, reading, label, job or edit, so an unchanged signature means unchanged data: the context
// is kept for 30 min (HIVEMIND_CONTEXT_TTL_MS), not rebuilt every 5 min with every panel and topic recalculated from scratch.
const TTL_MS = Math.max(60e3, +(process.env.HIVEMIND_CONTEXT_TTL_MS ?? 1800e3));
const MEMO_MAX = Math.max(200, +(process.env.HIVEMIND_MEMO_MAX ?? 3000)); // remembered results per process (panels, topics, charts)
const SIG_TTL_MS = Math.max(0, +(process.env.HIVEMIND_SIG_TTL_MS ?? 3000)); // how long a data signature is reused (see signature())
// Part of every signature: when any source file changes (a new version is deployed) the saved views from the old code are not reused.
const CODE_STAMP = (() => { try { const d = new URL(".", import.meta.url); return String(Math.max(...readdirSync(d).filter((f) => f.endsWith(".mjs")).map((f) => statSync(new URL(f, d)).mtimeMs))); } catch { return "0"; } })();
// The heavy read-only views, remembered per (view, arguments) against the context they were computed from.
const MEMO = ["overview", "opportunities", "opportunity", "series", "entities", "sentiment", "sourcesView", "labels", "backtest", "topic", "origins"];
const SENT = ["positive", "negative", "neutral", "mixed"];
const tallySentiment = (list) => {
  const t = { pos: 0, neg: 0, neu: 0, mixed: 0 };
  for (const i of list) { if (i.sentiment === "positive") t.pos++; else if (i.sentiment === "negative") t.neg++; else if (i.sentiment === "neutral") t.neu++; else if (i.sentiment === "mixed") t.mixed++; }
  const n = t.pos + t.neg + t.neu + t.mixed;
  return { ...t, n, net: n ? (t.pos - t.neg) / n : null };
};
const STAGES = ["emerging", "rising", "steady", "crowded", "declining", "watch"];
// One key per place, whatever the spelling: "Global", "global" and "Global." count as the same place.
export const geoKey = (g) => String(g ?? "").trim().replace(/[.,;:]+$/, "").replace(/\s+/g, " ").toLowerCase();
// The publications that covered an event most, as its suggested outlets (real coverage, not a fixed list).
const topOutlets = (stories, n = 4) => {
  const c = new Map();
  for (const s of stories) for (const o of s.outlets || []) c.set(o, (c.get(o) || 0) + 1);
  return [...c].sort((a, b) => b[1] - a[1]).slice(0, n).map(([o]) => o).join(", ");
};

// Whole-word keyword test: short words match exactly ("ai" never matches "said", "port" never matches "report");
// entries ending in "*" are stems and match any ending ("regulat*" -> regulation, regulator).
const wordRx = (words) => new RegExp(`\\b(?:${words.map((w) => (w.endsWith("*") ? w.slice(0, -1).replace(/[.&/]/g, "\\$&") + "\\w*" : w.replace(/[.&/]/g, "\\$&"))).join("|")})\\b`, "i");
const PRACTICE_RULES = [
  ["Travel, Cities and Infrastructure", wordRx(["aviation", "flight*", "plane*", "aircraft", "airport*", "runway*", "airline*", "rail*", "train", "trains", "metro", "highway*", "port", "ports", "shipping", "transport*", "infrastructure", "urban"])],
  ["Healthcare", wordRx(["health*", "hospital*", "pharma*", "drug*", "medicine*", "vaccin*", "doctor*", "clinical", "disease*", "medtech"])],
  ["Industrial Goods", wordRx(["auto", "automobile*", "automotive", "car", "cars", "motor*", "steel", "mining", "metal*", "chemical*", "factory", "factories", "industrial", "manufactur*"])],
  ["Financial Institutions", wordRx(["bank*", "lending", "lender*", "credit", "nbfc*", "payment*", "fintech*", "rbi", "upi", "loan*", "insurer*", "insurance", "fraud*", "scam*"])],
  ["Energy", wordRx(["energy", "oil", "petrol", "diesel", "gas", "power", "grid", "solar", "renewable*", "fuel*"])],
  ["Technology, Media, Telecommunications", wordRx(["cyber*", "cloud", "software", "telecom*", "semiconductor*", "chip", "chips", "ai", "artificial intelligence", "data", "digital", "tech", "technology", "outage*", "hack*", "malware", "ransomware"])],
  ["Climate & Sustainability", wordRx(["climate", "carbon", "emission*", "flood*", "cyclone*", "weather", "pollution", "esg", "heatwave*", "monsoon"])],
  ["Public Sector", wordRx(["policy", "policies", "ministry", "court*", "regulat*", "governance", "defence", "defense", "election*", "panchayat*", "government", "parliament"])],
  ["Corporate Finance and Strategy", wordRx(["merger*", "acquisition*", "acquire*", "ipo", "valuation*", "stake", "deal", "deals", "funding", "investor*", "private equity"])],
];
function detectPracticeArea(labelName, text) {
  const t = `${labelName || ""} ${text || ""}`;
  for (const [practice, rx] of PRACTICE_RULES) if (rx.test(t)) return practice;
  return DEFAULT_PRACTICE;
}
const DEFAULT_PRACTICE = "Corporate Strategy & Leadership";

// What kind of event a cluster is, from the AI's event type for each story (and the headline as a fallback).
const KIND_RULES = [
  ["nonbusiness", wordRx(["sport*", "cricket*", "football", "match", "matches", "tournament*", "series", "olympic*", "film*", "movie*", "celebrit*", "entertainment", "bollywood", "music", "wedding*", "festival*", "horoscope*", "obituar*"])],
  ["crisis", wordRx(["accident*", "crash*", "disaster*", "outage*", "failure*", "fire*", "explosion*", "collapse*", "flood*", "cyclone*", "attack*", "breach*", "hack*", "fraud*", "scam*", "death*", "deaths", "killed", "injur*", "derail*", "leak*", "strike*", "shortage*", "disruption*", "incident*", "glitch*", "delay*"])],
  ["policy", wordRx(["policy", "policies", "regulat*", "ruling*", "verdict*", "ban", "bans", "banned", "law", "laws", "bill", "budget*", "tariff*", "tax", "taxes", "mandate*", "directive*", "guideline*", "notification*", "court*", "government decision"])],
  ["deal", wordRx(["merger*", "acquisition*", "acquire*", "deal", "deals", "partnership*", "investment*", "funding", "ipo", "stake*", "launch*", "expansion*", "results", "earnings", "profit*", "revenue*"])],
  ["market", wordRx(["price*", "inflation", "rate", "rates", "market*", "demand", "exports?", "imports?", "trade", "currency", "rupee", "stock*", "shares"])],
];
// Each story's kind comes from its AI event type (else its headline); the cluster takes the most common kind, so one stray
// story (e.g. a cricket item grouped into a fraud event) does not decide it. "nonbusiness" needs a real majority.
function storyKind(s) {
  for (const [kind, rx] of KIND_RULES) if (rx.test(s.eventType || "")) return kind;
  for (const [kind, rx] of KIND_RULES) if (rx.test(s.title || "")) return kind;
  return "general";
}
function eventKind(cl) {
  const counts = new Map();
  for (const s of cl.stories) { const k = storyKind(s); counts.set(k, (counts.get(k) || 0) + 1); }
  const n = cl.stories.length || 1;
  if ((counts.get("nonbusiness") || 0) / n > 0.5) return "nonbusiness";
  counts.delete("nonbusiness");
  const lead = storyKind(cl.stories[0] ?? {});
  let best = "general", bestN = 0;
  for (const [k, c] of counts) if (c > bestN || (c === bestN && k === lead)) { best = k; bestN = c; }
  return best;
}

// Question sets per event kind; place and company names are filled in per event.
const ANGLE_KINDS = {
  crisis: {
    format: "Op-Ed / Executive Leadership Column", ending: "From Crisis Response to Structural Resilience",
    questions: (loc, ent) => [
      `Operational Resilience: Are our control towers, vendor SLAs and fallback systems insulated against the single-point failures seen in ${loc}?`,
      `Regulatory & Statutory Exposure: What is our exposure to the directives, tighter mandates and penalties likely to follow in ${loc}?`,
      `Capex & Capital Allocation: What balance between redundancy capex, monitoring and quarterly margins gives durable resilience?`,
      `Brand & Market Positioning: Can transparency and reliability become a differentiator while ${ent} manage the fallout?`,
      `Board Oversight: How quickly can the board's risk committee verify maintenance records, supplier certifications and emergency SOPs?`,
    ],
  },
  policy: {
    format: "Policy Perspective / Op-Ed", ending: "What Leaders Must Do Before the Rules Bite",
    questions: (loc, ent) => [
      `Regulatory & Statutory Exposure: Which of our products, contracts and operations in ${loc} does this change touch, and by when?`,
      `Compliance Cost & Timeline: What will compliance cost, and what is the realistic transition window?`,
      `Strategic Positioning: Where does the change open room to gain share against ${ent}?`,
      `Government & Stakeholder Engagement: Where should we engage regulators and industry bodies before the details are final?`,
      `Scenario Planning: How do our plans change under strict, moderate and delayed enforcement?`,
    ],
  },
  deal: {
    format: "Strategy Perspective / Op-Ed", ending: "Where the Value Will Really Be Created",
    questions: (loc, ent) => [
      `Value Creation: Where will this move by ${ent} create or destroy value, and for whom?`,
      `Competitive Response: How should competitors in ${loc} respond: match, partner or differentiate?`,
      `Integration & Execution: What usually goes wrong in executing moves like this, and how is it avoided?`,
      `Capex & Capital Allocation: Does this change where capital should go in the sector over the next 2-3 years?`,
      `Regulatory & Antitrust: What approvals or scrutiny could change the outcome?`,
    ],
  },
  market: {
    format: "Market Perspective / Op-Ed", ending: "How Leaders Should Respond to the Shift",
    questions: (loc, ent) => [
      `Demand & Pricing: How will customers in ${loc} react, and how much can be passed on in prices?`,
      `Cost & Margin: Which cost lines move first, and what is the margin impact over two quarters?`,
      `Supply Chain: Which suppliers and inputs are most exposed, and what are the alternatives?`,
      `Capex & Capital Allocation: Should investment plans be accelerated, paused or redirected?`,
      `Scenario Planning: What do the next 6-12 months look like if the trend continues, reverses or deepens for ${ent}?`,
    ],
  },
  general: {
    format: "Executive Perspective / Op-Ed", ending: "What It Means for the Boardroom",
    questions: (loc, ent) => [
      `Strategic Implications: What does this development in ${loc} change about our strategy?`,
      `Operating Model: Which processes, partners or capabilities need to adapt?`,
      `Capex & Capital Allocation: Does it change where we invest or what we stop?`,
      `Talent & Capability: Do we have the people and skills to act on it?`,
      `Stakeholder Communication: What should we say to customers, employees, investors and ${ent}?`,
    ],
  },
};

// match: the topic's existing AI sector match for the client ({ sector, why, angle } or { irrelevant: true }), or null.
// saved: Map story_key -> AI-written angle (store.eventAnglesFor). An event shows a saved angle if any of its stories has one.
function buildTopicEventClusters(items, labelName, match = null, saved = new Map()) {
  const clusters = [];
  for (const item of items) {
    const loc = (item.geography && item.geography.length) ? item.geography[0] : null;
    const titleLower = (item.title || "").toLowerCase();
    const itemEntities = new Set((item.entities || []).map((e) => String(e).toLowerCase()));
    const words = new Set(titleLower.replace(/[^\w\s]/g, "").split(/\s+/).filter((w) => w.length >= 4));

    let matched = null;
    for (const cl of clusters) {
      if (Math.abs(item.at - cl.anchorTime) > 72 * HOUR) continue;
      const sameLoc = loc && cl.location && (loc.toLowerCase() === cl.location.toLowerCase() || loc.toLowerCase().includes(cl.location.toLowerCase()) || cl.location.toLowerCase().includes(loc.toLowerCase()));
      const sharedEntity = (cl.entities || []).some((e) => itemEntities.has(String(e).toLowerCase()));
      let overlap = 0;
      for (const w of words) if (cl.wordSet.has(w)) overlap++;
      if ((sameLoc && (sharedEntity || overlap >= 1)) || (sharedEntity && overlap >= 2) || overlap >= 3) {
        matched = cl;
        break;
      }
    }

    if (matched) {
      matched.stories.push(item);
      matched.storyCount++;
      matched.lastSeen = Math.max(matched.lastSeen, item.at);
      matched.firstSeen = Math.min(matched.firstSeen, item.at);
      for (const o of (item.outlets || [])) matched.outlets.add(o);
      for (const e of (item.entities || [])) if (matched.entities.length < 6 && !matched.entities.includes(e)) matched.entities.push(e);
      for (const w of words) matched.wordSet.add(w);
      if (!matched.location && loc) matched.location = loc;
    } else {
      clusters.push({
        id: "ev-" + (clusters.length + 1) + "-" + (loc ? loc.toLowerCase().replace(/\W+/g, "-").slice(0, 20) : "incident"),
        title: item.title,
        summary: item.summary || item.title,
        location: loc || (item.geography && item.geography[0]) || "National / Regional",
        eventType: item.eventType || "Operational Incident",
        anchorTime: item.at,
        firstSeen: item.at,
        lastSeen: item.at,
        storyCount: 1,
        outlets: new Set(item.outlets || []),
        entities: [...(item.entities || []).slice(0, 4)],
        wordSet: words,
        stories: [item],
      });
    }
  }

  clusters.sort((a, b) => b.storyCount - a.storyCount);

  return clusters.slice(0, 10).map((cl) => {
    const locStr = cl.location || "Regional";
    const entityStr = cl.entities.length ? cl.entities.join(", ") : "industry players";
    const shortTitle = cl.title.replace(/\s*[|–]\s.*$/, "").replace(/\s+-\s.*$/, "").trim();
    const kind = eventKind(cl);
    // Practice area: the BCG sector the AI already matched to this topic (no new AI call); keywords only when there is no match.
    // A topic judged directly by the AI gives its sector. A broad bracket's inherited sector is the same for every event in it, so there
    // the event's own words decide first, and the bracket's sector is used only when they name no practice area.
    const kw = detectPracticeArea(null, `${cl.title} ${cl.summary}`);
    const practice = match?.sector && !match.inherited ? match.sector : (kw !== DEFAULT_PRACTICE ? kw : match?.sector || DEFAULT_PRACTICE);
    const basedOn = match?.sector && !match.inherited ? "sector match" : kw !== DEFAULT_PRACTICE ? "keywords" : match?.sector ? "sector match" : "default";
    const k = ANGLE_KINDS[kind] ?? ANGLE_KINDS.general;
    // No op-ed angle for sport, entertainment and similar events, or for topics the AI judged irrelevant to every sector.
    // The event's first story (earliest) is its anchor: a new AI angle is saved under it.
    const anchor = [...cl.stories].sort((a, b) => a.at - b.at)[0];
    const ai = cl.stories.map((st) => saved.get(st.id)).find(Boolean) ?? null;
    const business = !(kind === "nonbusiness" || match?.irrelevant);
    const mdpAngles = !business ? [] : ai ? [{
        id: `${cl.id}-mdp-1`,
        role: "BCG Managing Director & Senior Partner (MDP)",
        practice,
        eventKind: kind,
        basedOn: "AI, written for this event",
        editorialFormat: k.format,
        title: ai.title,
        thesis: ai.thesis,
        boardroomQuestions: ai.questions,
        targetAudience: ai.audience || "CEOs, Boards, Risk Committees and Investors",
        targetOutlets: topOutlets(cl.stories),
        pitch: ai.pitch,
        aiWritten: true,
      }] : [
      {
        id: `${cl.id}-mdp-1`,
        role: "BCG Managing Director & Senior Partner (MDP)",
        practice,
        eventKind: kind,
        basedOn,
        editorialFormat: k.format,
        title: `${shortTitle}: ${k.ending}`,
        thesis: match?.why
          ? `${shortTitle} (${locStr}). ${match.why}`
          : `${shortTitle} (${locStr}) matters for ${practice}: leaders need to judge what it changes for strategy, operations and risk, not only react to the news.`,
        boardroomQuestions: k.questions(locStr, entityStr),
        targetAudience: kind === "policy" ? "CEOs, CFOs, Regulatory Affairs heads and Industry Bodies" : kind === "deal" ? "CEOs, Strategy heads, Boards and Investors" : kind === "market" ? "CEOs, CFOs, Commercial and Supply Chain heads" : "CEOs, Boards, Risk Committees and Investors",
        targetOutlets: topOutlets(cl.stories),
        pitch: match?.angle || `An executive op-ed on what ${shortTitle.slice(0, 80)} means for ${practice} leaders and what they should do next.`,
      }
    ];

    return {
      id: cl.id,
      anchorKey: anchor?.id ?? null,
      anchorAt: anchor?.at ?? null,
      needsAngle: business && !ai,
      kind, practice,
      title: cl.title,
      summary: cl.summary,
      location: cl.location,
      eventType: cl.eventType,
      storyCount: cl.storyCount,
      outletsCount: cl.outlets.size,
      outlets: Array.from(cl.outlets).slice(0, 8),
      entities: cl.entities,
      firstSeen: cl.firstSeen,
      lastSeen: cl.lastSeen,
      mdpAngles,
      stories: cl.stories.map((s) => ({
        id: s.id,
        title: s.title,
        url: s.url,
        summary: s.summary,
        outlets: s.outletCount,
        origins: s.originCount,
        publishedAt: s.at,
        geography: s.geography,
        verified: s.verified
      }))
    };
  });
}

export class Analytics {
  constructor({ store, registry, sources, cfg, companies, reader, pubs = [] }) {
    Object.assign(this, { store, registry, sources, cfg, companies, reader, pubs });
    // clear() also moves the saved-views revision on, so views saved before an edit or a job are never served afterwards (also after a restart).
    const store_ = store;
    this.cache = new (class extends Map { clear() { super.clear(); try { store_?.setMeta?.("cache.rev", String(Date.now()) + Math.random().toString(36).slice(2, 6)); } catch { /* a counter must not break an edit */ } this.onClear?.(); } })();
    { const clearMap = this.cache.clear.bind(this.cache), self = this; this.cache.clear = () => { self._sigMemo?.clear(); return clearMap(); }; } // a cleared cache also forgets the signature
    for (const name of MEMO) {
      const raw = this[name].bind(this);
      this[name] = (args = {}) => {
        const c = this.context(name === "backtest" ? null : args.date ?? null);
        if (!c) return raw(args);
        const key = "memo|" + name + "|" + JSON.stringify(args), hit = this.cache.get(key);
        if (hit && hit.ctx === c) return hit.value;
        const value = raw(args);
        // Full: forget the oldest small results, never the big shared lists (opportunities, labels) that every panel and topic is cut from.
        if (this.cache.size > MEMO_MAX) { let drop = this.cache.size - Math.floor(MEMO_MAX * 0.8); for (const k of this.cache.keys()) { if (drop <= 0) break; if (k.startsWith("memo|") && !/^memo\|(opportunities|labels|overview)\|/.test(k)) { this.cache.delete(k); drop--; } } }
        this.cache.set(key, { ctx: c, value, at: Date.now() });
        return value;
      };
    }
  }

  // ---------------------------------------------------------------- shared context (cached for a few seconds)
  // A short fingerprint of everything the views are computed from: it changes when stories, readings, labels or weights change, when a job finishes, or
  // when cache.clear() is called after an edit. Cheap (a few counts), so it can decide whether a saved view is still current without building anything.
  // The data signature counts across whole tables. One page asks for it many times while it is built, so the answer is kept
  // for SIG_TTL_MS (3 s): the data only changes when a job finishes or an edit is made, and both clear the cache, which
  // also drops this memo, so a change is never missed. On SQLite this saves a little; on PostgreSQL it saves seconds per page.
  signature(date = null) {
    const now = Date.now(), memo = (this._sigMemo ??= new Map()), hit = memo.get(date);
    if (hit && now - hit.at < SIG_TTL_MS) return hit.value;
    const span = this.store.span();
    const value = !span.last ? null : `${date}|${span.last}|${span.days}|${this.store.readingCount()}|${this.store.enrichmentCount()}|${this.store.sentimentCount()}|${this.store.mergedTopicCount()}|${this.store.jobRev()}|${this.registry().size}|${JSON.stringify(this.cfg.weights)}|${this.store.getMeta("cache.rev", "0")}|${CODE_STAMP}`;
    memo.set(date, { at: now, value });
    return value;
  }
  context(date = null) {
    const span = this.store.span();
    if (!span.last) return null;
    const registry = this.registry();
    const sig = this.signature(date);
    const hit = this.cache.get(date ?? "live");
    if (hit && hit.sig === sig && Date.now() - hit.at < TTL_MS) return hit.value;

    const liveAsOf = Math.max(span.last, span.lastSeen);
    const asOf = date ? Math.min(dayStart(date) + DAY_MS, liveAsOf) : liveAsOf;
    const topics = new TopicRegistry(this.store);
    const ctx = { cfg: this.cfg, registry, sources: this.sources, topics: topics.asMap(), signals: { searchInterest: this.store.signalTopics().length > 0 } };
    // When each label came into existence, so its share is judged only against stories that could have carried it.
    const topicMap = ctx.topics;
    ctx.elig = (key) => {
      if (key.startsWith("b:")) { const b = registry.get(key.slice(2)); return b && !b.seed ? { from: b.createdAt ?? 0, field: "readAt" } : null; }
      const t = topicMap.get(key.slice(2));
      return t ? { from: t.createdAt ?? 0, field: "enrichedAt" } : null;
    };
    const loadDays = span.days >= (this.cfg.seasonality?.minDays ?? 28) ? Math.max(LOAD_DAYS, (this.cfg.seasonality?.minDays ?? 28) + 17) : LOAD_DAYS;
    const stories = this.store.loadStories({ from: asOf - loadDays * DAY_MS, to: asOf + 1 });
    const items = prepareItems(stories, { registry, sources: this.sources, cfg: this.cfg, asOf, gate: false }); // browsing: every story published by asOf
    ctx.seasonal = buildSeasonality(items, asOf, this.cfg);
    const analysis = analyse(items, ctx, asOf);
    const value = { asOf, date, span, ctx, items, analysis, byLabel: itemsByLabel(items), storyCount: stories.length };
    this.cache.set(date ?? "live", { sig, at: Date.now(), value });
    return value;
  }

  // A topic is shown only with real independent coverage and a specific subject (not "personal stories").
  topicOk(c, m) {
    return m.level === "bracket" || (m.count >= this.cfg.evidence.minClusters && m.originsRecent >= (this.cfg.topics?.minOrigins ?? 3) && !isWeakLabel(this.labelName(c, m.key), this.cfg));
  }

  labelName(c, key) { return (key.startsWith("b:") ? c.ctx.registry.get(key.slice(2))?.name : c.ctx.topics.get(key.slice(2))?.name) ?? key; }

  labelRow(c, m) {
    return {
      key: m.key, level: m.level, id: m.id, name: this.labelName(c, m.key), parent: m.parent, parentName: m.parent ? c.ctx.registry.get(m.parent)?.name ?? null : null,
      stage: m.stage, stageRule: m.stageRule, count: m.count, countPrev: m.countPrev, total: m.total, share: m.share, baseShare: m.baseShare, ratio: m.ratio, ratioPrev: m.ratioPrev,
      accel: m.accel, originsRecent: m.originsRecent, originsTotal: m.originsTotal, areaCount: m.areaCount, areas: m.areas, evidence: m.evidence, sharePercentile: m.sharePercentile,
      spark: m.spark, fullTextCount: m.fullTextCount, verifiedCount: m.verifiedCount, windowHours: m.windowHours, lastObservedAt: m.lastObservedAt, storiesAll: m.storiesAll, weight: m.weight, seasonalFactor: m.seasonalFactor ?? 1,
    };
  }

  company(id) { return this.companies.get(id) ?? this.companies.list()[0] ?? null; }

  // Authored (opinion / analysis) print articles matched to each suggested angle, within the window. Null until print articles have been
  // read for that window, so the headroom falls back to coverage share rather than treating "no data" as "nobody has written it".
  ocrHeadroom(companyId, asOf, mode = null) {
    const cfg = this.cfg.ocr ?? {}, days = cfg.windowDays ?? 7;
    const to = dayOf(asOf), from = dayOf(asOf - days * 864e5);
    if (!this.store.ocrHasData(from, to)) return null;
    return { byOpp: this.store.ocrMatchesByOpp(companyId, from, to), cap: cfg.saturationCount ?? 5, windowDays: days, mode: mode === "validated" || mode === "whitespace" ? mode : cfg.mode === "validated" ? "validated" : "whitespace" };
  }

  // Online opinion / analysis pieces: the stored readings of their text, the angles matched, and the stories found on a paper's opinion page.
  onlineContext(companyId) {
    const pieces = this.store.onlinePieces();
    for (const k of this.store.onlineSectionKeys()) if (!pieces.has(k)) pieces.set(k, { source: "section" });
    return { pieces, matches: this.store.onlineMatches(companyId), windowDays: (this.cfg.ocr ?? {}).windowDays ?? 7, count: this.cfg.online?.countInHeadroom !== false };
  }

  // ---------------------------------------------------------------- opportunities
  // slim: the list the Opportunities page shows. The heavy parts only the opened row needs (its stories, score components and the lists of print and
  // online articles; the counts stay) are left out and fetched by opportunity() when a row is opened.
  opportunities({ company: companyId = "bcg", date = null, limit = 60, group = false, mode = null, slim = false } = {}) {
    if (slim) {
      const full = this.opportunities({ company: companyId, date, limit, group, mode });
      if (!full.items) return full;
      // otherSectors repeats moreSectors (the list reads moreSectors); the row filter only needs to know whether the trigger is verified.
      return { ...full, items: full.items.map(({ stories, components, authored, otherSectors, trigger, ...o }) => ({ ...o, ...(otherSectors && !o.moreSectors ? { otherSectors } : {}), trigger: trigger && { verified: trigger.verified }, slim: true, authored: authored && { ...authored, articles: [], onlineArticles: [] } })) };
    }
    const c = this.context(date), company = this.company(companyId);
    if (!c || !company) return { empty: true, items: [], counts: { total: 0, action: {}, stage: {} } };
    const res = buildOpportunities({ company, matches: company.matches, analysisResult: c.analysis, byLabel: c.byLabel, ctx: c.ctx, asOf: c.asOf, limit, topicMatches: this.store.topicMatches(company.id), qualityRed: this.qualityRed(c), ocr: this.ocrHeadroom(company.id, c.asOf, mode), online: this.onlineContext(company.id) });
    const briefs = new Map();
    for (const b of this.store.listBriefs({ limit: 500 })) if (!briefs.has(b.oppKey)) briefs.set(b.oppKey, { id: b.id, status: b.status });
    for (const o of res.items) o.brief = briefs.get(o.key) ?? null;
    let items = this.dedupeOpportunities(c, res.items, res.counts);
    if (group) {
      // One row per topic: its best-scoring sector pairing, with the other sectors it also touches.
      const best = new Map();
      for (const o of items) {
        const cur = best.get(o.label.key);
        if (!cur) best.set(o.label.key, { ...o, otherSectors: [] });
        else cur.otherSectors.push({ sector: o.sector, score: o.score, relevance: o.relevance, key: o.key, action: o.action });
      }
      items = [...best.values()].map((o) => ({ ...o, moreSectors: o.otherSectors }));
    }
    const cachedTrends = this.store ? getCachedIndiaTrends(this.store) : [];
    if (cachedTrends?.length) {
      for (const o of items) o.xTrending = matchOpportunityTrend(o, cachedTrends);
    }
    return { ...res, items, asOf: c.asOf, company: { id: company.id, name: company.name, matched: Object.keys(company.matches).length } };
  }

  // Every print and online piece counted on one angle (the opportunity's list is cut at 12; this is the whole set the count came from).
  pieces({ company: companyId = "bcg", key, date = null } = {}) {
    const c = this.context(date), company = this.company(companyId);
    if (!c || !company || !key) return { print: [], online: [] };
    const labelKey = String(key).split("|")[2] ?? "";
    const print = this.ocrHeadroom(company.id, c.asOf)?.byOpp.get(key) ?? [];
    const online = onlineOnAngle(c.byLabel.get(labelKey) ?? [], key, this.onlineContext(company.id), c.asOf);
    const [, sector = "", label = ""] = String(key).split("|");
    return { key, sector, topic: this.labelName(c, labelKey) || label, windowDays: (this.cfg.ocr ?? {}).windowDays ?? 7, print, online };
  }

  // ---------------------------------------------------------------- leadership view
  // For leaders: what is trending and why, what people are writing about it (print and online), what nobody has written, and what is next.
  // Built from the same opportunities as every other page; no model call.
  // The result is kept for a minute (and dropped whenever the analytics cache is cleared by a job): switching tabs or reopening the page costs nothing.
  leadership({ company: companyId = "bcg", date = null, mode = null } = {}) {
    const ck = `lead|${companyId}|${date ?? ""}|${mode ?? ""}`, hit = this.cache?.get(ck), c = this.context?.(date) ?? null;
    if (hit && Date.now() - hit.at < 300e3 && (hit.ctx ?? null) === c) return hit.value;
    const value = this._leadership(companyId, date, mode);
    if (!value.empty) this.cache?.set(ck, { at: Date.now(), value, ctx: c });
    return value;
  }
  _leadership(companyId, date, mode) {
    const c = this.context(date);
    if (!c) return { empty: true };
    const res = this.opportunities({ company: companyId, date, limit: 1000, group: true, mode });
    const trending = res.items.filter((o) => (o.stage === "rising" || o.stage === "emerging") && o.action !== "skip" && o.authored).sort((a, b) => b.score - a.score);
    // only what the page shows; the pieces behind a count and the articles behind a source count are fetched when opened (/api/leadership/pieces, /api/origins)
    const row = (o) => {
      const a = o.authored ?? {}, why = [];
      if (o.metrics.ratio != null) why.push(`${o.metrics.ratio.toFixed(1)}× its usual share of coverage`);
      if ((o.metrics.accel ?? 0) > 0.3) why.push("still accelerating");
      return { key: o.key, labelKey: o.label.key, topic: o.label.name, sector: o.sector, angle: o.angle, score: Math.round(o.score), stage: o.stage,
        ratio: o.metrics.ratio, accel: o.metrics.accel, sources: o.metrics.originsRecent, why: why.join(" · "),
        trigger: o.trigger ? { title: o.trigger.title, url: o.trigger.url, ageHours: o.trigger.ageHours, verified: o.trigger.verified } : null,
        print: a.print ?? 0, online: a.online ?? 0 };
    };
    const rows = trending.map(row);
    const written = rows.filter((r) => r.print + r.online > 0).sort((a, b) => b.print + b.online - (a.print + a.online) || b.score - a.score);
    const open = rows.filter((r) => r.print + r.online === 0);
    const next = rows.filter((r) => r.stage === "emerging" || (r.accel ?? 0) > 0.3).sort((a, b) => (b.accel ?? 0) - (a.accel ?? 0)).slice(0, 8);
    for (const r of rows.slice(0, 12)) { const w = this.store.lastWebCheck(norm(r.topic), "serper:news"); if (w) r.web = { at: w.at, total: w.total, outlets: w.outlets, outside: (w.outsideOurSources ?? []).length, top: (w.top ?? []).slice(0, 5) }; }
    const st = this.store.onlineStats(dayOf(c.asOf - 7 * DAY_MS)), cfg = this.cfg.online ?? {};
    return { asOf: c.asOf, windowDays: (this.cfg.ocr ?? {}).windowDays ?? 7, mode: res.items[0]?.authored?.mode ?? "whitespace",
      counts: { trending: rows.length, written: written.length, open: open.length, print: written.reduce((n, r) => n + r.print, 0), online: written.reduce((n, r) => n + r.online, 0) },
      written: written.slice(0, 15), open: open.slice(0, 15), next, hot: rows.filter((r) => r.web).slice(0, 5), top: rows.slice(0, 8),
      online: { ...st, analyze: cfg.analyze === true, dailyCap: cfg.dailyCap ?? 150, readToday: this.store.onlineReadOn(dayOf(Date.now())), sectionsOn: this.pubs.filter((p) => p.opinionPath).length } };
  }

  // One opportunity in full (what a slim list row leaves out), found among the same list the page showed.
  opportunity({ company: companyId = "bcg", key, date = null, mode = null, group = false } = {}) {
    for (const g of [group, !group]) {
      const hit = this.opportunities({ company: companyId, date, limit: 1000, group: g, mode }).items?.find((o) => o.key === key);
      if (hit) {
        if (!hit.xTrending) {
          const cachedTrends = this.store ? getCachedIndiaTrends(this.store) : [];
          if (cachedTrends?.length) hit.xTrending = matchOpportunityTrend(hit, cachedTrends);
        }
        return hit;
      }
    }
    return { error: "Unknown opportunity" };
  }

  // ---------------------------------------------------------------- overview (executive summary)
  overview({ company: companyId = "bcg", date = null } = {}) {
    const c = this.context(date);
    if (!c) return { empty: true };
    const { analysis, items } = c;
    const opps = this.opportunities({ company: companyId, date, limit: 200 });
    const grouped = this.opportunities({ company: companyId, date, limit: 200, group: true });
    const rows = [...analysis.labels.values()].filter((m) => m.count > 0 && this.topicOk(c, m)).map((m) => this.labelRow(c, m));
    const stages = { bracket: {}, topic: {} };
    for (const level of ["bracket", "topic"]) for (const s of STAGES) stages[level][s] = rows.filter((r) => r.level === level && r.stage === s).length;
    const risers = rows.filter((r) => r.level === "bracket" && r.ratio != null && r.count >= this.cfg.evidence.minClusters).sort((a, b) => b.ratio - a.ratio).slice(0, 8);
    const topicRisers = rows.filter((r) => r.level === "topic" && r.ratio != null && r.count >= this.cfg.evidence.minClusters).sort((a, b) => b.ratio - a.ratio).slice(0, 8);
    const sum = (f) => items.reduce((a, i) => a + f(i), 0);
    const latestRun = this.store.latestRun("rolling");
    const ageHours = (Date.now() - Math.max(c.span.last, c.span.lastSeen)) / HOUR;
    const labelled = items.filter((i) => { for (const k of i.labels.keys()) if (k.startsWith("t:")) return true; return false; }).length; // among the stories shown, so it never exceeds them
    return {
      asOf: c.asOf, view: { date }, dataAgeHours: ageHours, stale: !date && ageHours > 30,
      kpis: {
        stories: items.length, headlines: latestRun?.headlines ?? null, publications: this.pubs.length, days: this.store.days().length,
        outletMentions: sum((i) => i.outletCount), independentOrigins: sum((i) => i.originCount),
        fullTextPct: items.length ? sum((i) => (i.fullText ? 1 : 0)) / items.length : 0,
        verifiedTriggers: items.filter((i) => i.verified && c.asOf - i.at <= 72 * HOUR).length,
        brackets: rows.filter((r) => r.level === "bracket").length, topics: rows.filter((r) => r.level === "topic").length, labelledStories: labelled,
        opportunities: opps.counts.total, actions: opps.counts.action, // journalists: this.store.journalistCount(), (JOURNALISTS DISABLED)
       
        briefs: this.store.briefStats(),
      },
      history: { ...analysis.history, days: this.store.days().length, params: analysis.params, reconstructed: analysis.reconstructed },
      stages, topOpportunities: grouped.items.filter((o) => o.action !== "skip").slice(0, 6), risers, topicRisers,
      outages: analysis.outages.slice(-12), company: opps.company ?? null, quality: (({ status, flags }) => ({ status, flags }))(this.quality(c)),
    };
  }

  // ---------------------------------------------------------------- label tables and chart series
  labels({ date = null, level = "bracket", limit = 80 } = {}) {
    const c = this.context(date);
    if (!c) return { empty: true, rows: [] };
    const rows = [...c.analysis.labels.values()].filter((m) => m.level === level && m.count > 0 && this.topicOk(c, m)).map((m) => this.labelRow(c, m))
      .sort((a, b) => (b.ratio ?? 0) - (a.ratio ?? 0) || b.count - a.count);
    return { asOf: c.asOf, params: c.analysis.params, history: c.analysis.history, seasonality: c.analysis.seasonality, rows: rows.slice(0, limit), total: rows.length };
  }

  series({ keys, gran = "hour", date = null }) {
    const c = this.context(date);
    if (!c) return { empty: true };
    const out = {};
    for (const key of keys.slice(0, 6)) {
      const m = c.analysis.labels.get(key);
      out[key] = { name: this.labelName(c, key), metrics: m ? this.labelRow(c, m) : null, sentiment: this.labelSentiment(c, key), ...seriesFor(c.items, key, gran, c.ctx, c.asOf) };
    }
    return { asOf: c.asOf, granularity: gran, series: out };
  }

  // The client's existing AI sector match for a topic or bracket (already stored, so no new AI call): the most relevant sector,
  // or { irrelevant: true } when the AI judged the topic relevant to none of the client's sectors, or null when never judged.
  topicSectorMatch(m, companyId) {
    try {
      const company = this.companies?.get?.(companyId);
      const best = (sectors) => [...sectors].sort((a, b) => b.relevance - a.relevance)[0];
      if (m.level === "topic") {
        const judged = this.store.topicMatches?.(companyId)?.get(m.id) ?? null;
        if (judged) {
          const s = judged.sectors.filter((x) => x.relevance >= 0.3);
          if (!s.length) return { irrelevant: true };
          const b = best(s);
          return { sector: b.sector, why: b.why, angle: b.write_about };
        }
      }
      const bracketId = m.level === "bracket" ? m.id : m.parent;
      const inherited = bracketId && company?.matches ? company.matches[this.registry?.canonical?.(bracketId) ?? bracketId] ?? company.matches[bracketId] : null;
      const s = (inherited?.sectors ?? []).filter((x) => x.relevance >= 0.3);
      if (!s.length) return null;
      const b = best(s);
      // an inherited bracket match is broad: use its sector, but not its angle text, which was written for the whole bracket
      return { sector: b.sector, why: null, angle: null, inherited: true };
    } catch { return null; }
  }

  // New business events (first story at or after `since`) in the top topics that have no AI-written angle yet, most important topics first.
  // Earlier events are left with the template angle on purpose.
  eventAngleCandidates({ company = "bcg", since, topics = 30, limit = 50 }) {
    const opps = this.opportunities({ company, limit: 300, group: true })?.items ?? [];
    const keys = [...new Set(opps.map((o) => o.label?.key).filter((k) => k && k.startsWith("t:")))].slice(0, topics);
    const out = [], seen = new Set();
    for (const key of keys) {
      const t = this.topic({ key, company });
      if (!t || t.error) continue;
      for (const cl of t.eventClusters ?? []) {
        if (!cl.needsAngle || !cl.anchorKey || cl.anchorAt == null || cl.anchorAt < since || seen.has(cl.anchorKey)) continue;
        seen.add(cl.anchorKey);
        out.push({ anchorKey: cl.anchorKey, topicKey: key, topic: t.row?.name ?? key, practice: cl.practice, kind: cl.kind, location: cl.location,
          stories: (cl.stories ?? []).slice(0, 6).map((st) => ({ title: st.title, summary: st.summary })) });
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  topic({ key, company: companyId = "bcg", date = null, geo = null, eventId = null }) {
    const c = this.context(date);
    const m = c?.analysis.labels.get(key);
    if (!m) return { error: "Unknown topic" };
    const allList = (c.byLabel.get(key) ?? []);
    const recentList = allList.filter((i) => c.asOf - i.at <= 72 * HOUR).sort((a, b) => b.maxSev * b.outletCount - a.maxSev * a.outletCount);
    const last24hList = allList.filter((i) => c.asOf - i.at <= 24 * HOUR);
    const name = this.labelName(c, key);

    // 1. Story tracking metrics
    const storyTracking = {
      totalCount: allList.length,
      recent72hCount: recentList.length,
      recent24hCount: last24hList.length,
      growth24h: recentList.length - last24hList.length > 0 ? +(((last24hList.length / Math.max(1, recentList.length - last24hList.length)) - 1) * 100).toFixed(1) : null,
      outletsCount: new Set(allList.flatMap((i) => i.outlets || [])).size,
      topOutlets: Array.from(allList.reduce((acc, i) => {
        for (const o of (i.outlets || [])) acc.set(o, (acc.get(o) || 0) + 1);
        return acc;
      }, new Map()).entries()).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([oName, count]) => ({ name: oName, count })),
    };

    // 2. Geographic breakdown across all stories and recent stories
    const geoMap = new Map();
    for (const i of allList) {
      const geos = (i.geography && i.geography.length) ? i.geography : ["National / Global"];
      const seenHere = new Set(); // a story naming the same place twice counts once
      for (const g of geos) {
        const name = String(g).trim().replace(/[.,;:]+$/, ""), k = geoKey(g);
        if (!k || seenHere.has(k)) continue;
        seenHere.add(k);
        if (!geoMap.has(k)) geoMap.set(k, { name, count: 0, recentCount: 0 });
        const entry = geoMap.get(k);
        if (entry.name === entry.name.toLowerCase() && name !== name.toLowerCase()) entry.name = name; // prefer "Global" over "global"
        entry.count++;
        if (c.asOf - i.at <= 72 * HOUR) entry.recentCount++;
      }
    }
    const geoBreakdown = Array.from(geoMap.values()).sort((a, b) => b.count - a.count).slice(0, 16);

    // 3. Event-specific clusters with tailored BCG MDP editorial angles
    const clusterItems = recentList.length ? recentList : allList.slice(0, 50);
    const savedAngles = this.store.eventAnglesFor ? this.store.eventAnglesFor(clusterItems.map((i) => i.id)) : new Map();
    const eventClusters = buildTopicEventClusters(clusterItems, name, this.topicSectorMatch(m, companyId), savedAngles);

    // 4. Specific-based news filtering (by location or specific event cluster)
    let displayList = recentList.length ? recentList : allList;
    if (eventId) {
      const targetCluster = eventClusters.find((cl) => cl.id === eventId);
      if (targetCluster) {
        const clusterStoryIds = new Set(targetCluster.stories.map((s) => s.id));
        displayList = displayList.filter((s) => clusterStoryIds.has(s.id));
      }
    } else if (geo && geo !== "all") {
      // the place counts above are over all of the topic's stories, so the filter looks at all of them too (newest first)
      const targetGeo = geoKey(geo);
      const isDefault = targetGeo === geoKey("National / Global");
      displayList = [...allList].sort((a, b) => b.at - a.at).filter((s) => {
        const gs = (s.geography || []).map(geoKey).filter(Boolean);
        if (isDefault) return gs.length === 0;
        return gs.includes(targetGeo); // exactly the rule the place counts use, so "India (10)" shows those 10 stories
      });
    }

    const pathways = [];
    for (const i of displayList.slice(0, 12)) for (const p of i.pathways) pathways.push({ ...p, story: i.title, url: i.url });
    const related = seriesFor(c.items, key, "hour", c.ctx, c.asOf).related.map((r) => ({ ...r, name: this.labelName(c, r.key), stage: c.analysis.labels.get(r.key)?.stage ?? null }));
    const si = this.store.getSignal(norm(name));
    return {
      row: this.labelRow(c, m), asOf: c.asOf,
      stories: displayList.slice(0, 100).map((i) => ({ id: i.id, title: i.title, url: i.url, summary: i.summary, outlets: i.outletCount, origins: i.originCount, primary: i.primary, wire: i.wire, verified: i.verified, fullText: i.fullText, publishedAt: i.at, contentType: i.contentType, geography: (i.geography || []).slice(0, 8), reconstructed: i.reconstructed, sentiment: i.sentiment })),
      allStories: allList.slice(0, 250).map((i) => ({ id: i.id, title: i.title, url: i.url, summary: i.summary, outlets: i.outletCount, origins: i.originCount, primary: i.primary, wire: i.wire, verified: i.verified, fullText: i.fullText, publishedAt: i.at, contentType: i.contentType, geography: (i.geography || []).slice(0, 8), reconstructed: i.reconstructed, sentiment: i.sentiment })),
      storyTracking,
      geoBreakdown,
      eventClusters,
      filter: { geo: geo || null, eventId: eventId || null, count: displayList.length },
      pathways: pathways.slice(0, 8), related, seasonality: c.analysis.seasonality, sentiment: this.labelSentiment(c, key),
      webCheck: this.store.lastWebCheck(norm(name), "serper:news"),
      searchInterest: si.length ? { available: true, source: si[0].source, points: si.map(({ t, value }) => ({ t, value })), note: "Relative index 0–100, not search volume." } : { available: false, reason: process.env.SERPAPI_KEY ? "Not fetched yet for this topic." : "No search-interest source is connected. Missing data is shown as unavailable, never as zero." },
      opportunities: this.opportunities({ company: companyId, date, limit: 200 }).items.filter((o) => o.label.key === key).slice(0, 5),
    };
  }

  // ---------------------------------------------------------------- sentiment
  labelSentiment(c, key) {
    const list = c.byLabel.get(key) ?? [], now = c.asOf;
    const recent = tallySentiment(list.filter((i) => now - i.at <= 72 * HOUR)), all = tallySentiment(list);
    const byDay = new Map();
    for (const i of list) { if (!i.sentiment) continue; const d = new Date(i.at); const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; (byDay.get(day) ?? byDay.set(day, []).get(day)).push(i); }
    return { ...recent, all, series: [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([day, l]) => ({ day, ...tallySentiment(l) })) };
  }
  sentiment({ date = null } = {}) {
    const c = this.context(date);
    if (!c) return { empty: true };
    const { items, asOf } = c, labelled = items.filter((i) => i.sentiment).length;
    const recent = items.filter((i) => asOf - i.at <= 24 * HOUR), prev = items.filter((i) => asOf - i.at > 24 * HOUR && asOf - i.at <= 48 * HOUR);
    const byDay = new Map();
    for (const i of items) { if (!i.sentiment) continue; const d = new Date(i.at); const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; (byDay.get(day) ?? byDay.set(day, []).get(day)).push(i); }
    const byLabel = [];
    for (const [key, list] of c.byLabel) {
      const m = c.analysis.labels.get(key);
      if (!m || !this.topicOk(c, m)) continue;
      const cur = tallySentiment(list.filter((i) => asOf - i.at <= 24 * HOUR)), pr = tallySentiment(list.filter((i) => asOf - i.at > 24 * HOUR && asOf - i.at <= 48 * HOUR));
      if (cur.n < 5) continue;
      byLabel.push({ key, name: this.labelName(c, key), level: m.level, count: cur.n, pos: cur.pos, neg: cur.neg, neu: cur.neu, mixed: cur.mixed, net: cur.net, netPrev: pr.n >= 5 ? pr.net : null, delta: pr.n >= 5 ? cur.net - pr.net : null });
    }
    byLabel.sort((a, b) => Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0) || b.count - a.count);
    return {
      asOf, overall: tallySentiment(recent), previous: tallySentiment(prev),
      daily: [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(-14).map(([day, l]) => ({ day, ...tallySentiment(l) })),
      byLabel: byLabel.slice(0, 60), coverage: { labelled, total: items.length, pending: this.store.unsentimentedCount() },
    };
  }

  // ---------------------------------------------------------------- entities
  entities({ date = null, limit = 150 } = {}) {
    const c = this.context(date);
    if (!c) return { empty: true, entities: [], total: 0 };
    const r = buildEntities(c.items, c.asOf, this.cfg, { aliases: this.aliases() });
    return { asOf: c.asOf, total: r.rows.length, baselineOk: r.baselineOk, entities: r.rows.slice(0, limit) };
  }
  entity({ id, date = null }) {
    const c = this.context(date);
    if (!c) return { error: "No data" };
    const aliases = this.aliases();
    id = aliases.get(id) ?? id;
    const all = buildEntities(c.items, c.asOf, this.cfg, { minStories: 1, aliases }).rows.find((e) => e.id === id);
    if (!all) return { error: "Unknown entity" };
    const { key, all: items2, mine } = itemsWithEntity(c.items, id, aliases);
    const series = seriesFor(items2, key, "hour", c.ctx, c.asOf);
    series.forecast = { available: false, reason: "Forecasts are shown for topics, not entities." };
    series.triggers = []; series.related = [];
    const topics = new Map();
    for (const i of mine) for (const k of i.labels.keys()) if (k.startsWith("t:")) topics.set(k, (topics.get(k) || 0) + 1);
    return {
      entity: all, series: { key, name: all.name, ...series },
      topics: [...topics.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => ({ key: k, name: this.labelName(c, k), count: n })),
      stories: mine.filter((i) => c.asOf - i.at <= 72 * HOUR).sort((a, b) => b.at - a.at).slice(0, 15).map((i) => ({ id: i.id, title: i.title, url: i.url, outlets: i.outletCount, origins: i.originCount, at: i.at, sentiment: i.sentiment })),
      sentiment: tallySentiment(mine.filter((i) => c.asOf - i.at <= 72 * HOUR)),
    };
  }

  // ---------------------------------------------------------------- origins behind a topic (who independently reported it)
  origins({ key, date = null }) {
    const c = this.context(date);
    if (!c) return { total: 0, origins: [] };
    const R = c.analysis.params.recentHours, all = !key || key === "all", list = (all ? c.items : c.byLabel.get(key) ?? []).filter((i) => c.asOf - i.at <= R * HOUR);
    const by = new Map();
    for (const it of list) for (const o of it.origins) {
      const [kind, ...rest] = o.split(":"), name = rest.join(":");
      let e = by.get(o);
      if (!e) {
        const members = this.sources.list.filter((s) => s.group === name);
        e = { id: o, name: kind === "wire" ? `${name} (wire service)` : name, group: name, type: kind === "primary" ? "primary" : kind === "wire" ? "wire" : members[0]?.type ?? "newsroom", wire: kind === "wire", outlets: members.map((s) => s.name), stories: 0, sample: [] };
        by.set(o, e);
      }
      e.stories++;
      if (e.sample.length < 3) e.sample.push({ title: it.title, url: it.url, at: it.at });
      (e.items ??= []).push({ title: it.title, url: it.url, at: it.at });
    }
    const origins = [...by.values()].sort((a, b) => b.stories - a.stories);
    for (const o of origins) { o.items.sort((a, b) => b.at - a.at); o.items = o.items.slice(0, all ? 40 : 150); }
    const removedOffTopic = !all && key.startsWith("t:") ? this.store.topicDropCount(key.slice(2), c.asOf - R * HOUR) : 0;
    return { removedOffTopic, key: all ? "all" : key, name: all ? "All coverage" : this.labelName(c, key), windowHours: R, total: origins.length, stories: list.length, origins };
  }

  // ---------------------------------------------------------------- live hit rate and weight tuning
  judgeOutcomes() {
    const c = this.context(null);
    if (!c) return { evaluated: 0 };
    return evaluatePending({ store: this.store, items: c.items, cfg: this.cfg });
  }
  outcomes() {
    const rows = this.store.outcomes();
    return { ...outcomeSummary(rows, Date.now(), this.cfg.success.windowHours), window: `${this.cfg.success.windowHours}h`,
      definition: `Hit = coverage share reached ×${this.cfg.success.shareMultiple} of its prior baseline with ≥ ${this.cfg.success.minOrigins} independent origins within ${this.cfg.success.windowHours} hours.`,
      items: rows.slice(0, 200).map((r) => ({ id: r.id, oppKey: r.oppKey, label: r.label, sector: r.sector, action: r.action, score: r.score, ts: r.ts, hit: r.hit, peakRatio: r.peakRatio, origins: r.peakOrigins })) };
  }
  tuning() { return tuneWeights(this.store.outcomes(), this.cfg); }

  // ---------------------------------------------------------------- sources and collection health
  sourcesView({ date = null } = {}) {
    const c = this.context(date);
    const asOf = c?.asOf ?? Date.now();
    const stats = new Map(this.store.publicationStats(asOf - 7 * DAY_MS, asOf + 1).map((r) => [r.publication, r]));
    const day = new Map(this.store.publicationStats(asOf - DAY_MS, asOf + 1).map((r) => [r.publication, r]));
    const sources = this.sources.list.map((s) => ({ ...s, headlines7d: stats.get(s.name)?.headlines ?? 0, headlines24h: day.get(s.name)?.headlines ?? 0, lastSeen: stats.get(s.name)?.last ?? null }));
    const items = c?.items ?? [];
    const multi = items.filter((i) => i.outletCount > 1);
    const collapsed = multi.filter((i) => i.originCount === 1).length;
    const groups = {};
    for (const s of sources) groups[s.group] = (groups[s.group] || 0) + s.headlines7d;
    const runs = this.store.runs(20).map((r) => ({ ...r, perPublication: undefined, failedSources: r.perPublication.filter((p) => !p.polled).map((p) => p.name), durationMin: r.finishedAt ? (r.finishedAt - r.startedAt) / 60000 : null }));
    return {
      asOf, sources, groups: Object.entries(groups).sort((a, b) => b[1] - a[1]).map(([group, headlines]) => ({ group, headlines })),
      syndication: {
        stories: items.length, outletMentions: items.reduce((a, i) => a + i.outletCount, 0), independentOrigins: items.reduce((a, i) => a + i.originCount, 0),
        multiOutletStories: multi.length, singleOriginRepeats: collapsed, wireCredited: items.filter((i) => i.wire).length, primarySourced: items.filter((i) => i.primary).length,
        reconstructed: items.filter((i) => i.reconstructed).length,
      },
      runs, outages: c?.analysis.outages ?? [], history: c?.analysis.history ?? null,
    };
  }

  // ---------------------------------------------------------------- backtest
  backtest() {
    const c = this.context(null);
    if (!c) return { ready: false, reason: "No data yet." };
    const stories = this.store.loadStories({ from: 0, to: Date.now() + DAY_MS });
    return runBacktest({ stories, ctx: c.ctx, days: this.store.days(), briefStats: this.store.briefStats() });
  }

  // // ---------------------------------------------------------------- journalists
  // // Best-matching journalists for one opportunity, computed on demand from the cached directory.
  // journalistMatches({ oppKey, company: companyId = "bcg", date = null, limit = 8 }) {
  //   const c = this.context(date);
  //   const opp = this.opportunities({ company: companyId, date, limit: 300 }).items.find((o) => o.key === oppKey) ?? this.opportunities({ company: companyId, date, limit: 300, group: false }).items.find((o) => o.key === oppKey);
  //   if (!c || !opp) return { error: "That opportunity is no longer in the ranked list." };
  //   if (!this.journalistCache || this.journalistCache.n !== this.store.journalistCount()) this.journalistCache = { n: this.store.journalistCount(), list: this.store.allJournalists() };
  //   const items = (c.byLabel.get(opp.label.key) ?? []).filter((i) => c.asOf - i.at <= 7 * 24 * HOUR);
  //   const kw = c.ctx.registry.get(opp.label.parent ?? "")?.keywords ?? [];
  //   const topicTokens = toks([...kw, opp.label.name, ...opp.stories.map((s) => s.title)].join(" "));
  //   const ctx = { topicTokens, geography: [...new Set(items.flatMap((i) => i.geography))].slice(0, 25), outlets: new Set(items.flatMap((i) => i.outlets.map((o) => norm(o)))), now: c.asOf };
  //   const fits = [];
  //   for (const j of this.journalistCache.list) { const f = journalistFit(j, opp, ctx); if (f.parts.beat.score > 0 || f.parts.articles.score > 0) fits.push(f); } // place or outlet alone is not a topical link
  //   fits.sort((a, b) => b.score - a.score);
  //   return { opportunity: { key: opp.key, sector: opp.sector, topic: opp.label.name }, directory: this.journalistCache.n, matched: fits.length, matches: fits.slice(0, limit) };
  // }

  // ---------------------------------------------------------------- data quality, judged links, audit, forecasts
  aliases() { if (!this._al || Date.now() - this._al.at > 30000) this._al = { at: Date.now(), map: this.store.entityAliases() }; return this._al.map; }

  quality(c = this.context(null)) {
    if (!c) return { status: "green", checks: [], sources: [], flags: [] };
    if (this._q && this._q.asOf === c.asOf && Date.now() - this._q.at < 120000) return this._q.value;
    const topicRows = [...c.analysis.labels.values()].filter((m) => m.level === "topic" && this.topicOk(c, m)).map((m) => ({ key: m.key, name: this.labelName(c, m.key), count: m.storiesAll, parentShare: m.parentShare }));
    const value = qualityReport({ store: this.store, cfg: this.cfg, sources: this.sources, items: c.items, analysis: c.analysis, topicRows, forecast: this.forecastAccuracy() });
    this._q = { asOf: c.asOf, at: Date.now(), value };
    return value;
  }
  qualityRed(c) { return !!(this.cfg.quality?.holdWriteNowWhenRed && this.quality(c).status === "red"); }

  // The same opportunity must not appear twice. Within a sector, a row is dropped (and listed on the stronger row as "also covers")
  // when it carries the same suggested angle, or when its recent stories are mostly the same stories as a higher-scoring row.
  dedupeOpportunities(c, items, counts) {
    const norm = (t) => String(t ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const memo = new Map(), setOf = (o) => memo.get(o.label.key) ?? memo.set(o.label.key, new Set((c.byLabel.get(o.label.key) ?? []).filter((i) => c.asOf - i.at <= 72 * HOUR).map((i) => i.id))).get(o.label.key);
    const jac = (a, b) => { let n = 0; for (const x of a) if (b.has(x)) n++; return n / (a.size + b.size - n || 1); };
    const keep = [], dropped = [];
    for (const o of [...items].sort((a, b) => b.score - a.score)) {
      const angle = norm(o.angle);
      let why = null;
      const twin = keep.find((k) => k.sector === o.sector && k.label.key !== o.label.key && ((angle && angle === norm(k.angle) && (why = "same angle")) || (jac(setOf(k), setOf(o)) >= 0.5 && (why = "same stories"))));
      if (twin) { (twin.alsoCovers ??= []).push({ name: o.label.name, score: Math.round(o.score), reason: why }); dropped.push(o); } else keep.push(o);
    }
    if (dropped.length && counts) {
      counts.total -= dropped.length;
      for (const o of dropped) { counts.action[o.action] = Math.max(0, (counts.action[o.action] || 0) - 1); counts.stage[o.stage] = Math.max(0, (counts.stage[o.stage] || 0) - 1); }
    }
    return keep;
  }

  // Topics worth a direct, per-client judgement: rising ones with real coverage, not judged recently. Returns what the model needs.
  topicMatchCandidates(companyId, { force = false } = {}) {
    const c = this.context(null), tm = this.cfg.topicMatch ?? {};
    if (!c) return [];
    const have = this.store.topicMatches(companyId), now = Date.now();
    const rows = [...c.analysis.labels.values()].filter((m) => m.level === "topic" && this.topicOk(c, m) && m.ratio != null && m.stage !== "declining")
      .map((m) => ({ m, rank: Math.log2(Math.max(1, m.ratio)) * Math.log1p(m.count) * (1 + Math.min(1, m.originsRecent / 8)) })).sort((a, b) => b.rank - a.rank);
    const out = [];
    for (const { m } of rows) {
      const prev = have.get(m.id), stale = !prev || now - prev.judgedAt > (tm.refreshHours ?? 24) * 3600e3 || m.storiesAll > prev.storyCount * 1.5 + 2;
      if (!force && !stale) continue;
      const list = (c.byLabel.get(m.key) ?? []).filter((i) => c.asOf - i.at <= 72 * HOUR).sort((a, b) => b.maxSev * b.outletCount - a.maxSev * a.outletCount).slice(0, 6);
      if (list.length < (tm.minStories ?? 2)) continue;
      const parent = m.parent ? c.ctx.registry.get(m.parent)?.name : null;
      out.push({ id: m.id, key: m.key, name: this.labelName(c, m.key), description: `A specific recurring news topic${parent ? ` (mostly filed under ${parent})` : ""}. Judge relevance to the company's sectors from the stories shown, not from the broader area.`, storyCount: m.storiesAll,
        stories: list.map((i) => ({ title: i.title, summary: i.summary, outlets: i.outletCount })) });
      if (out.length >= (tm.maxTopics ?? 30)) break;
    }
    return out;
  }

  // Topics that feed today's opportunities, with their recent stories that have not been checked against the topic yet.
  topicVerifyCandidates() {
    const c = this.context(null), v = this.cfg.topicVerify ?? {};
    if (!c) return [];
    const checked = this.store.checkedTopicPairs(), seen = new Set(), out = [];
    for (const co of this.companies.list()) {
      for (const o of this.opportunities({ company: co.id, limit: 400, group: true }).items) {
        const key = o.label.key;
        if (o.label.level !== "topic" || seen.has(key)) continue;
        seen.add(key);
        const id = key.slice(2), t = c.ctx.topics.get(id);
        const items = (c.byLabel.get(key) ?? []).filter((i) => c.asOf - i.at <= (v.windowHours ?? 72) * HOUR && !checked.has(i.id + "|" + id)).sort((a, b) => b.at - a.at).slice(0, v.maxPerTopic ?? 150);
        if (items.length) out.push({ id, name: this.labelName(c, key), aliases: t?.aliases ?? [], items: items.map((i) => ({ key: i.id, title: i.title })) });
        if (out.length >= (v.maxTopics ?? 60)) return out;
      }
    }
    return out;
  }

  // For each topic feeding an opportunity: its best-scoring angle and the recent headlines not yet checked against THAT angle. Limited per topic and in total.
  // The check id carries a short hash of the angle, so a rewritten angle is checked again.
  angleFitCandidates() {
    const c = this.context(null), v = this.cfg.angleFit ?? {};
    if (!c || v.enabled === false) return [];
    const checked = this.store.checkedTopicPairs(), seen = new Set(), out = [];
    const hash = (s) => { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h.toString(36); };
    for (const co of this.companies.list()) {
      for (const o of this.opportunities({ company: co.id, limit: 400, group: true }).items) {
        const key = o.label.key;
        if (o.label.level !== "topic" || seen.has(key) || !o.angle) continue;
        seen.add(key);
        const id = key.slice(2), checkId = id + "@" + hash(o.angle), t = c.ctx.topics.get(id);
        const items = (c.byLabel.get(key) ?? []).filter((i) => c.asOf - i.at <= (v.windowHours ?? 168) * HOUR && !checked.has(i.id + "|" + checkId)).sort((a, b) => b.at - a.at).slice(0, v.maxPerTopic ?? 40);
        if (items.length) out.push({ id, checkId, angle: o.angle, name: this.labelName(c, key), aliases: t?.aliases ?? [], items: items.map((i) => ({ key: i.id, title: i.title })) });
        if (out.length >= (v.maxTopics ?? 40)) return out;
      }
    }
    return out;
  }

  // Recommendations logged under a pairing that no longer exists are voided, so they cannot count in the hit rate.
  voidStalePairings() {
    const keys = new Set();
    for (const co of this.companies.list()) for (const o of this.opportunities({ company: co.id, limit: 1000 }).items) keys.add(o.key);
    return this.store.voidRecommendations((r) => String(r.opp_key).split("|").pop().startsWith("t:") && !keys.has(r.opp_key));
  }

  // ---- human audit queue: a mix of the stories behind today's top opportunities and a random sample ----
  auditQueue({ limit = 50, company = "bcg" } = {}) {
    const c = this.context(null);
    if (!c) return { items: [], stats: this.store.auditStats() };
    const done = this.store.auditedKeys(), byId = new Map(c.items.map((i) => [i.id, i])), chosen = new Map();
    const push = (it, reason) => { if (it && !done.has(it.id) && !chosen.has(it.id) && it.impacts) chosen.set(it.id, { it, reason }); };
    for (const o of this.opportunities({ company, limit: 40, group: true }).items) { for (const s of o.stories.slice(0, 2)) push(byId.get(s.id), "behind a top opportunity"); if (chosen.size >= Math.ceil(limit * 0.6)) break; }
    const pool = c.items.filter((i) => c.asOf - i.at <= 72 * HOUR && !done.has(i.id) && !chosen.has(i.id));
    for (let n = 0; chosen.size < limit && pool.length && n < limit * 4; n++) push(pool[Math.floor(Math.random() * pool.length)], "random sample");
    const items = [...chosen.values()].slice(0, limit).map(({ it, reason }) => ({
      id: it.id, title: it.title, url: it.url, summary: it.summary, sentiment: it.sentiment, stance: it.stance, origins: it.originCount, reason,
      impacts: it.impacts.slice(0, 5).map((x) => ({ group: x.group, area: x.area, direction: x.direction, severity: x.severity, bracket: x.bracket })),
      topics: [...it.labels.keys()].filter((k) => k.startsWith("t:")).map((k) => this.labelName(c, k)).slice(0, 3),
    }));
    return { items, stats: { ...this.store.auditStats(), target: this.cfg.audit?.targetAccuracy ?? 0.9 } };
  }
  reviewAudit({ key, verdict, note = "", reviewer = "" }) {
    if (!["correct", "wrong", "unsure"].includes(verdict)) throw new Error("verdict must be correct, wrong or unsure");
    if (!this.store.db.prepare("SELECT 1 FROM stories WHERE key = ?").get(key)) throw new Error("Unknown story");
    this.store.putAudit({ key, verdict, note, reviewer, reason: "human" });
    this._q = null;
    return { ok: true, stats: { ...this.store.auditStats(), target: this.cfg.audit?.targetAccuracy ?? 0.9 } };
  }
  secondOpinion() {
    const rows = this.store.reviews(100), model = this.cfg.audit?.reviewModel ?? "";
    return { summary: { checked: rows.length, agree: rows.filter((r) => r.agrees).length, disagree: rows.filter((r) => !r.agrees).length, model }, items: rows };
  }
  // The stories to ask the stronger model about: those behind today's top opportunities, not yet reviewed by it.
  reviewCandidates({ company = "bcg", limit = 30, model: reviewer = null } = {}) {
    const c = this.context(null), model = reviewer ?? this.cfg.audit?.reviewModel ?? "", done = this.store.reviewedKeys(model);
    if (!c) return [];
    const byId = new Map(c.items.map((i) => [i.id, i])), out = new Map();
    for (const o of this.opportunities({ company, limit: 60, group: true }).items) {
      for (const s of [o.trigger ? { id: o.trigger.id } : null, o.stories[0]].filter(Boolean)) {
        const it = byId.get(s.id);
        if (it && !done.has(it.id) && !out.has(it.id)) {
          const snip = this.store.db.prepare("SELECT snippet FROM stories WHERE key = ?").get(it.id)?.snippet ?? "";
          out.set(it.id, { key: it.id, title: it.title, snippet: snip, analysis: { summary: it.summary, impacts: it.impacts }, sentiment: it.sentiment, stance: it.stance, topics: [...it.labels.keys()].filter((k) => k.startsWith("t:")).map((k) => this.labelName(c, k)) });
        }
      }
      if (out.size >= limit) break;
    }
    return [...out.values()].slice(0, limit);
  }

  // ---- forecast log: record what the dashed line says for the best topics, then compare with what happened ----
  logForecasts(c) {
    const fl = this.cfg.forecastLog ?? {}, now = c.asOf, seen = new Set(), todo = [];
    for (const co of this.companies.list().slice(0, 3)) {
      for (const o of this.opportunities({ company: co.id, limit: 60, group: true }).items) {
        if (o.label.level !== "topic" || o.action === "skip" || seen.has(o.label.key)) continue;
        seen.add(o.label.key);
        if (seen.size > (fl.topN ?? 15)) break;
        if (now - this.store.lastForecastAt(o.label.key) < (fl.everyHours ?? 6) * HOUR) continue;
        todo.push(o.label.key);
      }
    }
    const list = [];
    for (const key of todo) {
      const s = seriesFor(c.items, key, "hour", c.ctx, c.asOf);
      if (!s.forecast?.available) continue;
      const last = [...s.avg].reverse().find((v) => v != null);
      if (last == null) continue;
      for (const h of fl.horizons ?? [6, 12, 24]) { const p = s.forecast.points[h - 1]; if (p) list.push({ topic: key, madeAt: now, targetAt: p.t, horizon: h, predicted: p.value, lo: p.lo, hi: p.hi, naive: last }); }
    }
    if (list.length) this.store.addForecasts(list);
    return list.length;
  }
  judgeForecasts() {
    const c = this.context(null);
    if (!c) return { judged: 0 };
    const due = this.store.dueForecasts(c.asOf - HOUR).filter((f) => f.target_at + HOUR <= c.asOf), byTopic = new Map();
    for (const f of due) (byTopic.get(f.topic) ?? byTopic.set(f.topic, []).get(f.topic)).push(f);
    let judged = 0;
    for (const [key, list] of byTopic) {
      const s = seriesFor(c.items, key, "hour", c.ctx, c.asOf);
      for (const f of list) {
        const i = s.bins.findIndex((b) => Math.abs(b - f.target_at) < 1800000);
        const v = i >= 0 && (s.status[i] === "ok") ? s.avg[i] : null;
        if (v != null) { this.store.putForecastActual(f.id, v); judged++; }
      }
    }
    this._q = null;
    return { judged };
  }
  forecastAccuracy() {
    const rows = this.store.forecastRows(), target = 0.8;
    const stat = (r) => ({ n: r.length, coverage: r.length ? r.filter((x) => x.actual >= x.lo && x.actual <= x.hi).length / r.length : null, maeModel: r.length ? r.reduce((a, x) => a + Math.abs(x.predicted - x.actual), 0) / r.length : null, maeNaive: r.length ? r.reduce((a, x) => a + Math.abs(x.naive - x.actual), 0) / r.length : null });
    const all = stat(rows), byH = [...new Set(rows.map((r) => r.horizon))].sort((a, b) => a - b).map((h) => ({ hours: h, ...stat(rows.filter((r) => r.horizon === h)) }));
    return { evaluated: rows.length, pending: this.store.forecastPending(), target, bandCoverage: all.coverage, maeModel: all.maeModel, maeNaive: all.maeNaive, beatsNaive: all.n >= 30 ? all.maeModel < all.maeNaive : null, byHorizon: byH,
      note: rows.length ? "Compares each forecast with the share that was actually observed. The 80% band should hold about 80% of outcomes, and the model should beat simply repeating the latest value." : "No forecast is old enough to check yet. Forecasts are logged every few hours for the leading topics." };
  }

  // ---------------------------------------------------------------- briefs
  async makeBrief({ oppKey, company: companyId = "bcg", authorId = null, journalistId = null, date = null }) {
    if (!this.reader?.provider) throw new Error("No LLM available to draft a brief. Add a GROQ_API_KEY or OPENAI_API_KEY (or switch Claude on in Settings).");
    const opp = this.opportunities({ company: companyId, date, limit: 300 }).items.find((o) => o.key === oppKey);
    if (!opp) throw new Error("That opportunity is no longer in the ranked list. Refresh and try again.");
    let author = null;
    // JOURNALISTS DISABLED: if (journalistId) { const j = this.store.getJournalist(journalistId); if (!j) throw new Error("Unknown journalist"); author = toAuthor(j); }
    if (authorId) { author = this.store.listAuthors().find((a) => a.id === authorId) ?? null; if (!author) throw new Error("Unknown author"); }
    const brief = await this.reader.brief({ opp, stories: opp.stories.slice(0, this.cfg.briefs.maxStories), author });
    if (!brief) throw new Error("The model did not return a usable brief. Try again.");
    const id = this.store.addBrief({ company: companyId, oppKey, sector: opp.sector, topic: opp.label.name, authorId: authorId ?? journalistId, brief: { ...brief, generatedFor: { score: opp.score, stage: opp.stage, action: opp.action, window: opp.window.label, recipient: author ? { id: author.id, name: author.name, publication: (author.publications ?? [])[0] ?? "" } : null } }, model: this.reader.label });
    return { id, brief };
  }

  // ---------------------------------------------------------------- recommendation history
  // Records each opportunity the first time it is worth acting on, and again whenever its action, stage or score
  // moves materially, with a written reason. Only the live view is logged (a past-day view is a replay).
  snapshot() {
    const c = this.context(null);
    if (!c) return 0;
    let logged = 0;
    for (const co of this.companies.list()) {
      const res = this.opportunities({ company: co.id, limit: 40 });
      for (const o of res.items) {
        const last = this.store.lastRecommendation(co.id, o.key);
        const moved = last && (last.action !== o.action || last.stage !== o.stage || Math.abs(last.score - o.score) >= 5);
        if (last ? !moved : o.action === "skip") continue;
        this.store.addRecommendation({
          asOf: c.asOf, company: co.id, oppKey: o.key, sector: o.sector, label: o.label.name, level: o.label.level, score: o.score, action: o.action, stage: o.stage, kind: o.kind,
          components: Object.fromEntries(Object.entries(o.components).map(([k, v]) => [k, v.points])),
          evidence: o.stories.slice(0, 4).map((s) => ({ id: s.id, title: s.title, url: s.url })), reason: explainChange(last, o),
        });
        logged++;
      }
    }
    try { this.logForecasts(c); } catch { /* forecast logging must never break the snapshot */ }
    return logged;
  }
}

export function explainChange(last, o) {
  const s = o.score.toFixed(0);
  if (!last) return `First flagged as "${o.action}": score ${s}, stage ${o.stage}, ${o.metrics.originsRecent} independent origins.`;
  const parts = [];
  if (last.action !== o.action) parts.push(`action ${last.action} → ${o.action}`);
  if (last.stage !== o.stage) parts.push(`stage ${last.stage} → ${o.stage}`);
  const d = o.score - last.score;
  parts.push(`score ${last.score.toFixed(0)} → ${s}`);
  const deltas = Object.entries(o.components).map(([k, v]) => [k, v.points - (last.components?.[k] ?? 0)]).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 2).filter(([, v]) => Math.abs(v) >= 0.5);
  const why = deltas.map(([k, v]) => `${k} ${v >= 0 ? "+" : ""}${v.toFixed(1)} pts`).join(", ");
  return `${parts.join("; ")}${why ? ` (driven by ${why})` : ""}${Math.abs(d) < 0.5 && !why ? " — new evidence arrived" : ""}.`;
}
