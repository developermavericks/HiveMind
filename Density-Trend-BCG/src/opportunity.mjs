// Opportunity score (HiveMind.docx §6) and author fit (§7).
//
// score (0–100) = Σ weight × component, each component scored 0–100 on a defined scale first:
//   momentum        100 × clamp(log₂(momentum) / 2, 0, 1)                    ×1 → 0, ×2 → 50, ×4+ → 100
//   acceleration    50 + 50 × clamp(Δlog₂ momentum / 1.5, −1, 1)              50 = no change
//   source breadth  100 × min(1, independent origins / 8)
//   sector evidence 100 × relevance × (0.6 + 0.4 × min(1, full-text stories / 3)), ×0.85 when inherited from the parent bracket
//   trigger timing  100 within 24h of a verified trigger, → 60 at 72h, → 0 at 7 days; halved when the trigger is unverified
//   headroom        100 × (1 − coverage-share percentile), capped when the topic is crowded or declining
// The score ranks opportunities. It is not a probability. Evidence strength is reported separately.
import { HOUR } from "./metrics.mjs";
import { isWeakLabel } from "./topics.mjs";
import { norm } from "./brackets.mjs";

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const r1 = (x) => Math.round(x * 10) / 10;
const STOP = new Set("and the of for in on to with a an or by at from as is are".split(" "));
const toks = (s) => new Set(norm(s ?? "").split(" ").filter((w) => w.length > 2 && !STOP.has(w)));

export function itemsByLabel(items) {
  const m = new Map();
  for (const it of items) for (const k of it.labels.keys()) (m.get(k) ?? m.set(k, []).get(k)).push(it);
  return m;
}

function pickTrigger(list, asOf) {
  const recent = list.filter((i) => asOf - i.at <= 168 * HOUR);
  const pool = recent.filter((i) => i.verified && asOf - i.at <= 72 * HOUR);
  const best = (a) => a.sort((x, y) => y.maxSev * y.outletCount - x.maxSev * x.outletCount)[0];
  let it = best([...pool]);
  if (!it) it = best(recent.filter((i) => i.verified));
  if (!it) it = best(recent.filter((i) => i.maxSev >= 0.4));
  if (!it) return null;
  return { id: it.id, title: it.title, url: it.url, publishedAt: it.at, verified: it.verified, origins: it.originCount, primary: it.primary, ageHours: (asOf - it.at) / HOUR,
    reason: it.primary ? "Primary source" : it.verified ? `${it.originCount} independent origins` : `Unverified: ${it.originCount} origin${it.originCount === 1 ? "" : "s"}` };
}

const timingScore = (age, verified) => {
  const base = age <= 24 ? 100 : age <= 72 ? 100 - ((age - 24) / 48) * 40 : age <= 168 ? 60 - ((age - 72) / 96) * 60 : 0;
  return verified ? base : base * 0.5;
};

// The six scored components for one label. `sector` carries the sector-evidence input (a score and a note), which
// differs between a company opportunity (relevance-based) and the company-free backtest (impact breadth).
export function labelComponents(m, { trigger, sector }, cfg) {
  const W = cfg.weights, wSum = Object.values(W).reduce((a, b) => a + b, 0);
  const headroomRaw = 100 * (1 - (m.sharePercentile ?? 0.5));
  const headroom = m.stage === "crowded" ? Math.min(headroomRaw, 30) : m.stage === "declining" ? Math.min(headroomRaw, 25) : headroomRaw;
  const comp = {
    momentum: { score: m.ratio == null ? 0 : 100 * clamp(Math.log2(m.ratio) / 2, 0, 1), raw: m.ratio, note: m.ratio == null ? "no baseline yet" : `×${m.ratio.toFixed(2)} vs baseline share` },
    acceleration: { score: m.accel == null ? 0 : 50 + 50 * clamp(m.accel / 1.5, -1, 1), raw: m.accel, note: m.accel == null ? "needs two comparable steps" : `Δlog₂ ${m.accel >= 0 ? "+" : ""}${m.accel.toFixed(2)}` },
    sourceBreadth: { score: 100 * Math.min(1, m.originsRecent / cfg.evidence.originsForFullScore), raw: m.originsRecent, note: `${m.originsRecent} independent origins` },
    sectorEvidence: { score: sector.score, raw: sector.raw, note: sector.note },
    triggerTiming: { score: trigger ? timingScore(trigger.ageHours, trigger.verified) : 0, raw: trigger?.ageHours ?? null, note: trigger ? `${trigger.reason}, ${Math.round(trigger.ageHours)}h ago` : "no trigger found" },
    headroom: { score: headroom, raw: m.sharePercentile, note: `share percentile ${Math.round((m.sharePercentile ?? 0) * 100)}, stage ${m.stage}` },
  };
  let score = 0;
  for (const [k, c] of Object.entries(comp)) { c.weight = W[k]; c.points = (W[k] * c.score) / wSum; score += c.points; }
  return { comp, score, headroom };
}

export { pickTrigger };

export function actionFor({ score, stage, evidence, headroom, trigger, evidenceStatus, baselineHours = Infinity, origins = Infinity, qualityRed = false }, cfg) {
  const a = cfg.action, why = [];
  if (stage === "declining") return { action: "skip", why: ["Coverage of this topic is declining."] };
  if (stage === "crowded" && headroom < a.skipHeadroom) return { action: "skip", why: [`Crowded, with little editorial headroom (${r1(headroom)} < ${a.skipHeadroom}).`] };
  if (score < a.monitorScore) return { action: "skip", why: [`Score ${r1(score)} is below the monitoring threshold (${a.monitorScore}).`] };
  if (stage === "watch") return { action: "monitor", why: ["Too little evidence for a forecast: kept on the watchlist until more independent coverage accumulates."] };
  const needs = [
    [score >= a.writeNowScore, `score ≥ ${a.writeNowScore} (is ${r1(score)})`],
    [evidence.level !== "low", `evidence at least medium (is ${evidence.level})`],
    [stage === "rising" || stage === "emerging", `stage rising or emerging (is ${stage})`],
    [headroom >= a.writeNowMinHeadroom, `headroom ≥ ${a.writeNowMinHeadroom} (is ${r1(headroom)})`],
    [!!trigger?.verified, "a verified trigger within the last 7 days"],
    [evidenceStatus === "supported", "a supported (not hypothesised) sector link"],
    [baselineHours >= (a.writeNowMinBaselineHours ?? 0), `at least ${a.writeNowMinBaselineHours}h of history (is ${Math.round(baselineHours)}h)`],
    [origins >= (a.writeNowMinOrigins ?? 0), `at least ${a.writeNowMinOrigins} independent origins (is ${origins})`],
  ];
  const missing = needs.filter(([ok]) => !ok).map(([, t]) => t);
  if (!missing.length && qualityRed) return { action: "investigate", why: ["Every write-now condition is met, but data quality is below the safe threshold, so this is held at investigate (see Accuracy → Data quality)."], hold: "Held back: data quality is below the safe threshold." };
  if (!missing.length) return { action: "write now", why: ["All write-now conditions met: " + needs.map(([, t]) => t).join("; ") + "."] };
  why.push("Not yet write-now. Missing: " + missing.join("; ") + ".");
  if (score >= a.investigateScore) return { action: "investigate", why };
  return { action: "monitor", why };
}

export function buildOpportunities({ company, matches, analysisResult, byLabel, ctx, asOf, minRelevance = 0.3, limit = 60, topicMatches = new Map(), qualityRed = false }) {
  const { cfg, registry, topics, signals = {} } = ctx;
  const headlineMode = cfg.reading?.mode === "headline", tm = cfg.topicMatch ?? {};
  const labelName = (key) => (key.startsWith("b:") ? registry.get(key.slice(2))?.name : topics.get(key.slice(2))?.name) ?? key;
  const out = [];
  for (const m of analysisResult.labels.values()) {
    if (m.count === 0) continue;
    if (m.level === "topic" && m.count < cfg.evidence.minClusters) continue; // a topic seen in fewer than 3 stories is noise, not an opportunity
    if (m.level === "topic" && (m.originsRecent < (cfg.topics?.minOrigins ?? 3) || isWeakLabel(labelName(m.key), cfg))) continue; // needs independent coverage, and a real subject
    const bracketId = m.level === "bracket" ? m.id : m.parent;
    const inheritedMatch = bracketId ? matches[registry.canonical(bracketId)] ?? matches[bracketId] : null;
    // A topic judged directly for this client (its own sectors, relevance and angle) beats the bracket's inherited match.
    const judged = m.level === "topic" ? topicMatches.get(m.id) ?? topicMatches.get(m.key) : null;
    const match = judged ? { sectors: judged.sectors } : inheritedMatch;
    if (!match) continue;
    const list = (byLabel.get(m.key) ?? []).filter((i) => asOf - i.at <= 168 * HOUR);
    const trigger = pickTrigger(list, asOf);
    const inherited = m.level === "topic" && !judged;
    for (const h of match.sectors.filter((s) => s.relevance >= minRelevance)) {
      const ftFactor = headlineMode ? 1 : 0.6 + 0.4 * Math.min(1, m.fullTextCount / 3);
      const { comp, score, headroom } = labelComponents(m, {
        trigger,
        sector: { score: 100 * h.relevance * ftFactor * (inherited ? 0.85 : 1), raw: h.relevance, note: `relevance ${h.relevance.toFixed(2)}, ${m.fullTextCount} full-text stor${m.fullTextCount === 1 ? "y" : "ies"}${inherited ? ", inherited from parent bracket" : ""}` },
      }, cfg);
      const evidenceStatus = !inherited && h.relevance >= (judged ? tm.supportedRelevance ?? 0.5 : 0.5) && m.count >= (tm.minStories ?? 2) && (headlineMode || m.fullTextCount >= 1) ? "supported" : "hypothesis";
      const decision = actionFor({ score, stage: m.stage, evidence: m.evidence, headroom, trigger, evidenceStatus, baselineHours: m.baselineHours, origins: m.originsRecent, qualityRed }, cfg);
      const horizons = list.map((i) => i.horizon);
      const immediate = horizons.filter((x) => x === "immediate").length >= horizons.length / 2;
      const window = immediate || (trigger && trigger.ageHours <= 48) ? { label: "Next 24–72 hours", kind: "immediate" } : { label: "Next 3–7 days", kind: "analysis" };
      const missing = [];
      if (m.ratio == null) missing.push(`Baseline: ${m.baselineHours}h of history, needs ≥ ${cfg.intervals.minBaselineHours}h`);
      else if (m.baselineHours < cfg.intervals.baselineHours) missing.push(`Short baseline: ${m.baselineHours}h of the ${cfg.intervals.baselineHours}h (7-day) target`);
      if (!signals.searchInterest) missing.push("Search interest: not connected (kept separate; never treated as zero)");
      if (!headlineMode && m.count && m.fullTextCount < m.count / 2) missing.push(`Mostly headline-only reporting (${m.fullTextCount}/${m.count} read in full)`);
      if (m.baselineHours < (cfg.action.writeNowMinBaselineHours ?? 0)) missing.push(`Too early for write-now: ${Math.round(m.baselineHours)}h of history, needs ${cfg.action.writeNowMinBaselineHours}h`);
      if (evidenceStatus === "hypothesis") missing.push(inherited ? "Sector link inherited from the parent bracket: a hypothesis" : judged ? `Sector link judged for this topic but only moderately relevant (${h.relevance.toFixed(2)}): a hypothesis` : "Sector link not yet backed by enough stories: a hypothesis");
      if (!trigger?.verified) missing.push("No verified trigger (needs a primary source or ≥3 independent origins)");
      const top = [...list].sort((a, b) => b.maxSev * b.outletCount - a.maxSev * a.outletCount).slice(0, 5)
        .map((i) => ({ id: i.id, title: i.title, url: i.url, summary: i.summary, outlets: i.outletCount, origins: i.originCount, primary: i.primary, fullText: i.fullText, publishedAt: i.at, contentType: i.contentType }));
      const bracketName = bracketId ? registry.get(bracketId)?.name : null;
      out.push({
        key: `${company.id}|${h.sector}|${m.key}`, company: company.id, sector: h.sector,
        label: { key: m.key, name: labelName(m.key), level: m.level, parent: bracketId ?? null, parentName: bracketName },
        angle: h.write_about, why: h.why, relevance: h.relevance, channel: h.channel, front: h.front, evidenceStatus,
        score, components: comp, stage: m.stage, stageRule: m.stageRule, evidence: m.evidence, spark: m.spark,
        kind: m.stage === "watch" || m.ratio == null ? "editorial" : "forecast",
        action: decision.action, actionWhy: decision.why, window, trigger, headroom, holdReason: decision.hold ?? null,
        fit: m.level === "topic" ? { mode: judged ? "judged" : "inherited", relevance: h.relevance, judgedAt: judged?.judgedAt ?? null } : { mode: "judged", relevance: h.relevance, judgedAt: null },
        dataFlags: [...(m.baselineHours < (cfg.action.writeNowMinBaselineHours ?? 0) ? ["Thin history"] : []), ...(m.originsRecent < (cfg.action.writeNowMinOrigins ?? 0) ? ["Few independent origins"] : []), ...(inherited ? ["Sector link inherited"] : [])],
        metrics: { count: m.count, countPrev: m.countPrev, total: m.total, share: m.share, baseShare: m.baseShare, ratio: m.ratio, ratioPrev: m.ratioPrev, accel: m.accel,
          originsRecent: m.originsRecent, areaCount: m.areaCount, areas: m.areas, baselineHours: m.baselineHours, fullTextCount: m.fullTextCount, verifiedCount: m.verifiedCount, windowHours: m.windowHours, storiesAll: m.storiesAll },
        missing, stories: top,
        review: trigger
          ? `Revise or withdraw if "${trigger.title.slice(0, 90)}" is corrected, reversed or superseded, or if ${labelName(m.key)} momentum falls below ×1.0 for two consecutive ${cfg.intervals.stepHours}h steps.`
          : `Revise or withdraw if ${labelName(m.key)} momentum falls below ×1.0 for two consecutive ${cfg.intervals.stepHours}h steps, or if no verified trigger appears.`,
      });
    }
  }
  out.sort((a, b) => b.score - a.score);
  const counts = { total: out.length, action: {}, stage: {} };
  for (const o of out) { counts.action[o.action] = (counts.action[o.action] || 0) + 1; counts.stage[o.stage] = (counts.stage[o.stage] || 0) + 1; }
  return { items: out.slice(0, limit), counts };
}

// ---------------------------------------------------------------- author fit (separate from topic momentum)
// Matches only what an author's own profile says. It never infers or invents experience.
export function authorFit(author, opp, { topicTokens = new Set(), geography = [], windowHours = 72 } = {}) {
  const sectorTok = toks(opp.sector), oppTok = new Set([...sectorTok, ...toks(opp.label.name), ...toks(opp.label.parentName), ...topicTokens]);
  const why = [], missing = [];
  const aSectors = (author.sectors ?? []).filter(Boolean), tags = (author.expertise ?? []).filter(Boolean);
  const sectorHit = aSectors.find((s) => { const t = toks(s); return t.size && [...t].every((x) => sectorTok.has(x)) || norm(s) === norm(opp.sector); });
  const tagHits = tags.filter((t) => { const tt = toks(t); return tt.size && [...tt].filter((x) => oppTok.has(x)).length / tt.size >= 0.5; });
  if (sectorHit) why.push(`Lists the sector "${sectorHit}"`);
  if (tagHits.length) why.push(`Expertise tags match: ${tagHits.slice(0, 4).join(", ")}`);
  if (!aSectors.length && !tags.length) missing.push("expertise / sectors");
  const expertise = 100 * clamp(0.6 * (sectorHit ? 1 : 0) + 0.4 * Math.min(1, tagHits.length / 2), 0, 1);

  const aGeo = (author.geography ?? []).map(norm).filter(Boolean), gNorm = geography.map(norm);
  let geo = 0;
  if (!aGeo.length) missing.push("geography");
  else if (aGeo.some((g) => gNorm.some((x) => x.includes(g) || g.includes(x)))) { geo = 100; why.push("Geography matches the story locations"); }
  else if (aGeo.some((g) => g === "india" || g === "national")) { geo = 70; why.push("Covers India nationally"); }

  const aud = toks(author.audience);
  if (!aud.size) missing.push("audience");
  const audHit = [...aud].filter((x) => oppTok.has(x));
  const audience = aud.size ? (audHit.length ? 100 : 30) : 0;
  if (audHit.length) why.push(`Audience overlaps: ${audHit.slice(0, 3).join(", ")}`);

  const ta = Number(author.turnaroundHours);
  let turnaround = 0;
  if (!Number.isFinite(ta) || ta <= 0) missing.push("turnaround time");
  else { turnaround = ta <= windowHours / 3 ? 100 : ta >= windowHours ? 0 : 100 * (1 - (ta - windowHours / 3) / ((2 * windowHours) / 3)); why.push(`Turnaround ${ta}h against a ${windowHours}h window`); }

  const evs = (author.evidence ?? []).filter(Boolean);
  const evHits = evs.filter((e) => [...toks(e)].filter((x) => oppTok.has(x)).length >= 1);
  if (!evs.length) missing.push("evidence the author can contribute");
  const evidence = 100 * Math.min(1, evHits.length / 2);
  if (evHits.length) why.push(`Can contribute: ${evHits.slice(0, 2).join("; ")}`);

  const parts = { expertise: { score: expertise, weight: 45 }, geography: { score: geo, weight: 15 }, audience: { score: audience, weight: 10 }, turnaround: { score: turnaround, weight: 15 }, evidence: { score: evidence, weight: 15 } };
  const score = Object.values(parts).reduce((a, p) => a + (p.score * p.weight) / 100, 0);
  return { authorId: author.id, name: author.name, score, parts, why, missing };
}
