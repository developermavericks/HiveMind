// Assembles everything the dashboard shows. Pure orchestration: the calculations live in metrics.mjs,
// opportunity.mjs and backtest.mjs; the stories come from the database as of a chosen moment.
import { dayStart, DAY_MS } from "./db.mjs";
import { prepareItems, analyse, seriesFor, buildSeasonality, HOUR } from "./metrics.mjs";
import { buildEntities, itemsWithEntity, entityId } from "./entities.mjs";
import { evaluatePending, outcomeSummary, tuneWeights } from "./outcomes.mjs";
import { isWeakLabel } from "./topics.mjs";
import { qualityReport } from "./quality.mjs";
import { buildOpportunities, itemsByLabel } from "./opportunity.mjs";
import { journalistFit, toAuthor, toks } from "./journalists.mjs";
import { runBacktest } from "./backtest.mjs";
import { norm } from "./brackets.mjs";
import { TopicRegistry } from "./topics.mjs";

const LOAD_DAYS = 15; // enough for the 7-day baseline plus the 14-day daily chart
const TTL_MS = 5000;
const SENT = ["positive", "negative", "neutral", "mixed"];
const tallySentiment = (list) => {
  const t = { pos: 0, neg: 0, neu: 0, mixed: 0 };
  for (const i of list) { if (i.sentiment === "positive") t.pos++; else if (i.sentiment === "negative") t.neg++; else if (i.sentiment === "neutral") t.neu++; else if (i.sentiment === "mixed") t.mixed++; }
  const n = t.pos + t.neg + t.neu + t.mixed;
  return { ...t, n, net: n ? (t.pos - t.neg) / n : null };
};
const STAGES = ["emerging", "rising", "steady", "crowded", "declining", "watch"];

export class Analytics {
  constructor({ store, registry, sources, cfg, companies, reader, pubs = [] }) {
    Object.assign(this, { store, registry, sources, cfg, companies, reader, pubs });
    this.cache = new Map();
  }

  // ---------------------------------------------------------------- shared context (cached for a few seconds)
  context(date = null) {
    const span = this.store.span();
    if (!span.last) return null;
    const registry = this.registry();
    const sig = `${date}|${span.last}|${span.days}|${this.store.readingCount()}|${this.store.enrichmentCount()}|${this.store.sentimentCount()}|${this.store.mergedTopicCount()}|${registry.size}|${JSON.stringify(this.cfg.weights)}`;
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

  // ---------------------------------------------------------------- opportunities
  opportunities({ company: companyId = "bcg", date = null, limit = 60, group = false } = {}) {
    const c = this.context(date), company = this.company(companyId);
    if (!c || !company) return { empty: true, items: [], counts: { total: 0, action: {}, stage: {} } };
    const res = buildOpportunities({ company, matches: company.matches, analysisResult: c.analysis, byLabel: c.byLabel, ctx: c.ctx, asOf: c.asOf, limit, topicMatches: this.store.topicMatches(company.id), qualityRed: this.qualityRed(c) });
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
    return { ...res, items, asOf: c.asOf, company: { id: company.id, name: company.name, matched: Object.keys(company.matches).length } };
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
        opportunities: opps.counts.total, actions: opps.counts.action, journalists: this.store.journalistCount(),
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
      out[key] = { name: this.labelName(c, key), metrics: m ? this.labelRow(c, m) : null, ...seriesFor(c.items, key, gran, c.ctx, c.asOf) };
    }
    return { asOf: c.asOf, granularity: gran, series: out };
  }

  topic({ key, company: companyId = "bcg", date = null }) {
    const c = this.context(date);
    const m = c?.analysis.labels.get(key);
    if (!m) return { error: "Unknown topic" };
    const list = (c.byLabel.get(key) ?? []).filter((i) => c.asOf - i.at <= 72 * HOUR).sort((a, b) => b.maxSev * b.outletCount - a.maxSev * a.outletCount);
    const name = this.labelName(c, key);
    const pathways = [];
    for (const i of list.slice(0, 12)) for (const p of i.pathways) pathways.push({ ...p, story: i.title, url: i.url });
    const related = seriesFor(c.items, key, "hour", c.ctx, c.asOf).related.map((r) => ({ ...r, name: this.labelName(c, r.key), stage: c.analysis.labels.get(r.key)?.stage ?? null }));
    const si = this.store.getSignal(norm(name));
    return {
      row: this.labelRow(c, m), asOf: c.asOf,
      stories: list.slice(0, 12).map((i) => ({ id: i.id, title: i.title, url: i.url, summary: i.summary, outlets: i.outletCount, origins: i.originCount, primary: i.primary, wire: i.wire, verified: i.verified, fullText: i.fullText, publishedAt: i.at, contentType: i.contentType, geography: i.geography.slice(0, 3), reconstructed: i.reconstructed })),
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

  // ---------------------------------------------------------------- journalists
  // Best-matching journalists for one opportunity, computed on demand from the cached directory.
  journalistMatches({ oppKey, company: companyId = "bcg", date = null, limit = 8 }) {
    const c = this.context(date);
    const opp = this.opportunities({ company: companyId, date, limit: 300 }).items.find((o) => o.key === oppKey) ?? this.opportunities({ company: companyId, date, limit: 300, group: false }).items.find((o) => o.key === oppKey);
    if (!c || !opp) return { error: "That opportunity is no longer in the ranked list." };
    if (!this.journalistCache || this.journalistCache.n !== this.store.journalistCount()) this.journalistCache = { n: this.store.journalistCount(), list: this.store.allJournalists() };
    const items = (c.byLabel.get(opp.label.key) ?? []).filter((i) => c.asOf - i.at <= 7 * 24 * HOUR);
    const kw = c.ctx.registry.get(opp.label.parent ?? "")?.keywords ?? [];
    const topicTokens = toks([...kw, opp.label.name, ...opp.stories.map((s) => s.title)].join(" "));
    const ctx = { topicTokens, geography: [...new Set(items.flatMap((i) => i.geography))].slice(0, 25), outlets: new Set(items.flatMap((i) => i.outlets.map((o) => norm(o)))), now: c.asOf };
    const fits = [];
    for (const j of this.journalistCache.list) { const f = journalistFit(j, opp, ctx); if (f.parts.beat.score > 0 || f.parts.articles.score > 0) fits.push(f); } // place or outlet alone is not a topical link
    fits.sort((a, b) => b.score - a.score);
    return { opportunity: { key: opp.key, sector: opp.sector, topic: opp.label.name }, directory: this.journalistCache.n, matched: fits.length, matches: fits.slice(0, limit) };
  }

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
  reviewCandidates({ company = "bcg", limit = 30 } = {}) {
    const c = this.context(null), model = this.cfg.audit?.reviewModel ?? "", done = this.store.reviewedKeys(model);
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
        const i = s.bins.findIndex((b) => b === f.target_at - (f.target_at % HOUR));
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
    if (!this.reader?.provider) throw new Error("No LLM available to draft a brief. Start the server with ANTHROPIC_API_KEY set.");
    const opp = this.opportunities({ company: companyId, date, limit: 300 }).items.find((o) => o.key === oppKey);
    if (!opp) throw new Error("That opportunity is no longer in the ranked list. Refresh and try again.");
    let author = null;
    if (journalistId) { const j = this.store.getJournalist(journalistId); if (!j) throw new Error("Unknown journalist"); author = toAuthor(j); } // declared fields only, never contact details
    else if (authorId) { author = this.store.listAuthors().find((a) => a.id === authorId) ?? null; if (!author) throw new Error("Unknown author"); }
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
