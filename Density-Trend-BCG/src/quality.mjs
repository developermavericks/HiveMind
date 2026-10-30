// Data quality: duplicate and junk stories, silent sources, thin history, how concentrated topics are, human audit accuracy and
// forecast accuracy. Each check has an amber and a red limit in config/hivemind.json (quality). The overall status feeds a guardrail:
// when it is red, "write now" is held at "investigate". Duplicates and junk are never deleted: they are marked (story_dupes) and
// excluded from analysis, so every earlier result stays reproducible.
import { norm } from "./brackets.mjs";

const HOUR = 3600e3;

// ---------------------------------------------------------------- junk (template pages that are not news)
export function junkMatcher(cfg) {
  const res = (cfg.junk?.titlePatterns ?? []).map((p) => { try { return new RegExp(p, "i"); } catch { return null; } }).filter(Boolean);
  return (title) => res.some((r) => r.test(title ?? ""));
}

// ---------------------------------------------------------------- near-duplicate stories
const core = (t) => String(t ?? "").replace(/\s[-|–—]\s[^-|–—]{2,40}$/, ""); // drop a trailing " - Outlet"
const tokens = (t, minLen) => new Set(norm(core(t)).split(" ").filter((w) => w.length >= minLen));
const jaccard = (a, b) => { let i = 0; for (const x of a) if (b.has(x)) i++; return i / (a.size + b.size - i || 1); };

// rows: [{ key, title, published_at }] oldest first. Returns [{ key, canonical, jaccard }]: `key` repeats `canonical` (the earlier story).
export function findDuplicates(rows, cfg) {
  const d = cfg.dedupe ?? {}, minJ = d.minJaccard ?? 0.7, win = (d.withinHours ?? 36) * HOUR, minLen = d.minTokenLength ?? 3;
  const toks = rows.map((r) => tokens(r.title, minLen)), root = new Map(), out = [];
  // A pair can only be a repeat if it shares words, so a story is not compared with every earlier one (tens of millions of comparisons for two days
  // of news, about 20 seconds) but only with earlier ones that share one of its rarest words (prefix filtering). A set x needs at least
  // ceil(minJ * |x|) words in common with any set it matches, so one of its |x| - ceil(minJ * |x|) + 1 rarest words must be shared. The answer is
  // the same as comparing all pairs: the nearest earlier story inside the window whose jaccard reaches minJ.
  const freq = new Map();
  for (const t of toks) if (t.size >= 3) for (const w of t) freq.set(w, (freq.get(w) ?? 0) + 1);
  const prefix = toks.map((t) => (t.size < 3 ? [] : [...t].sort((a, b) => freq.get(a) - freq.get(b) || (a < b ? -1 : 1)).slice(0, t.size - Math.ceil(minJ * t.size) + 1)));
  const index = new Map();
  for (let i = 0; i < rows.length; i++) {
    if (toks[i].size < 3) continue; // too short to compare safely
    let best = -1;
    const seen = new Set();
    for (const w of prefix[i]) {
      for (const j of index.get(w) ?? []) {
        if (j < best || seen.has(j)) continue; // a nearer match is already known, or this one was checked
        seen.add(j);
        if (rows[i].published_at - rows[j].published_at > win) continue;
        if (Math.abs(toks[i].size - toks[j].size) > Math.max(toks[i].size, toks[j].size) * 0.5) continue;
        if (jaccard(toks[i], toks[j]) >= minJ) best = j;
      }
    }
    if (best >= 0) { const canon = root.get(rows[best].key) ?? rows[best].key; root.set(rows[i].key, canon); out.push({ key: rows[i].key, canonical: canon, jaccard: jaccard(toks[i], toks[best]), a: rows[i].title, b: rows[best].title }); }
    for (const w of prefix[i]) (index.get(w) ?? index.set(w, []).get(w)).push(i);
  }
  return out;
}

// Marks junk and duplicates among stories published since `since`. Returns what it found (already-marked stories are skipped).
export function dedupePass(store, cfg, { since = 0 } = {}) {
  const isJunk = junkMatcher(cfg), known = store.dupeMap(), rows = store.storyTitles(since);
  const marks = [];
  for (const r of rows) if (!known.has(r.key) && isJunk(r.title)) marks.push({ key: r.key, canonical: null, reason: "junk" });
  const junkKeys = new Set(marks.map((m) => m.key));
  const live = rows.filter((r) => !known.has(r.key) && !junkKeys.has(r.key));
  const dups = findDuplicates(live, cfg);
  for (const d of dups) marks.push({ key: d.key, canonical: d.canonical, reason: `repeat (${Math.round(d.jaccard * 100)}% same wording)` });
  if (marks.length) store.markDupes(marks);
  return { junk: marks.filter((m) => !m.canonical).length, duplicates: dups.length, scanned: rows.length };
}

// ---------------------------------------------------------------- the report
const level = (v, t, higherIsWorse = true) => {
  if (v == null || !t) return "info";
  return higherIsWorse ? (v >= t.red ? "red" : v >= t.amber ? "amber" : "green") : (v <= t.red ? "red" : v <= t.amber ? "amber" : "green");
};
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };

// ctx: { items (pipeline items, recent), analysis, topicRows: [{key,name,count,parentShare}] }
export function qualityReport({ store, cfg, sources, items, analysis, topicRows = [], now = Date.now(), forecast = null }) {
  const q = cfg.quality ?? {}, checks = [];
  // The dashboard shows value and limit as given, so percentages go out as percentages (not fractions) and limits as readable text.
  const fmt = (v, unit) => (unit === "%" ? `${+(v * 100).toFixed(1)}%` : `${v}${unit ? " " + unit : ""}`);
  const add = (c) => {
    const worse = c.key === "baselineHours" || c.key === "auditAccuracy" || c.key === "forecastCoverage" || c.key === "topicFit";
    const t = c.limit && typeof c.limit === "object" ? c.limit : null;
    const limit = t ? (worse ? `amber below ${fmt(t.amber, c.unit)}, red below ${fmt(t.red, c.unit)}` : `amber from ${fmt(t.amber, c.unit)}, red from ${fmt(t.red, c.unit)}`) : c.limit ?? "";
    checks.push({ ...c, thresholds: t, limit, value: c.unit === '%' && c.value != null ? +(c.value * 100).toFixed(1) : c.value });
  };
  const pct = (x) => `${(100 * x).toFixed(1)}%`;

  // duplicates and junk: already marked, and still unmarked in the last two days
  const counts = store.dupeCounts(), total = Math.max(1, store.span().days ? store.db.prepare("SELECT COUNT(*) AS n FROM stories").get().n : 1);
  const recent = store.storyTitles(now - 48 * HOUR), known = store.dupeMap(), isJunk = junkMatcher(cfg);
  const unmarked = recent.filter((r) => !known.has(r.key));
  const pendingDup = findDuplicates(unmarked.filter((r) => !isJunk(r.title)), cfg), pendingJunk = unmarked.filter((r) => isJunk(r.title)).length;
  const dupRate = unmarked.length ? pendingDup.length / unmarked.length : 0, junkRate = unmarked.length ? pendingJunk / unmarked.length : 0;
  add({ key: "duplicateRate", label: "Unmerged duplicate stories", value: dupRate, unit: "%", limit: q.duplicateRate, status: level(dupRate, q.duplicateRate), detail: `${pendingDup.length} of ${unmarked.length} recent stories repeat another; ${counts.duplicates} already merged earlier.` });
  add({ key: "junkRate", label: "Template pages mixed in as news", value: junkRate, unit: "%", limit: q.junkRate, status: level(junkRate, q.junkRate), detail: `${pendingJunk} recent items look like topic pages or scoreboards; ${counts.junk} already excluded.` });

  // stories with no real-world impact recorded
  const recentItems = items.filter((i) => now - i.at <= 72 * HOUR);
  const noImpact = recentItems.length ? recentItems.filter((i) => !(i.impacts?.length)).length / recentItems.length : 0;
  add({ key: "noImpactStories", label: "Stories with no impact recorded", value: noImpact, unit: "%", limit: q.noImpactStories, status: level(noImpact, q.noImpactStories), detail: "Sport results and celebrity news legitimately have none; a very high share can mean the headline gave the reader too little to work with." });

  // topics whose stories are spread across unrelated areas
  const big = topicRows.filter((t) => t.count >= 8), low = big.filter((t) => (t.parentShare ?? 0) < 0.4);
  const lowShare = big.length ? low.length / big.length : 0;
  add({ key: "topicConcentration", label: "Topics spread across unrelated areas", value: lowShare, unit: "%", limit: q.lowConcentrationTopics, status: level(lowShare, q.lowConcentrationTopics), detail: `${low.length} of ${big.length} larger topics have fewer than 40% of their stories in one sector area; these are not paired with a sector.` });

  // history depth
  const hist = analysis?.history?.hours ?? 0;
  add({ key: "baselineHours", label: "History available", value: hist, unit: "h", limit: q.baselineHours, status: level(hist, q.baselineHours, false), detail: `${Math.round(hist)} hours of news history against a 168-hour target; write now needs ${cfg.action?.writeNowMinBaselineHours ?? 72}h.` });

  // sources: silent and unknown
  const since = now - 7 * 24 * HOUR, byPub = new Map();
  for (const r of store.db.prepare("SELECT publication, published_at FROM articles WHERE published_at >= ? ORDER BY published_at").all(since)) (byPub.get(r.publication) ?? byPub.set(r.publication, []).get(r.publication)).push(r.published_at);
  const lim = q.silentSourceHours ?? { amber: 6, red: 18, multiple: 3 }, srcRows = [];
  for (const s of sources.list) {
    const ts = byPub.get(s.name) ?? [], last = ts.length ? ts[ts.length - 1] : null, gaps = [];
    for (let i = 1; i < ts.length; i++) gaps.push((ts[i] - ts[i - 1]) / HOUR);
    const typical = median(gaps), p90 = gaps.length ? [...gaps].sort((x, y) => x - y)[Math.floor(0.9 * (gaps.length - 1))] : 0, silentFor = last ? (now - last) / HOUR : null;
    // Official feeds (and any source with too few items to read a rhythm from) publish in bursts, so only a day or more of silence counts.
    const sparse = s.type === "primary" || ts.length < 20, amberH = sparse ? 24 : lim.amber, redH = sparse ? 72 : lim.red;
    const threshold = Math.max(amberH, lim.multiple * p90); // a source that is normally quiet overnight is not flagged for an ordinary night
    srcRows.push({ name: s.name, lastSeen: last, hoursSilent: silentFor == null ? null : Math.round(silentFor * 10) / 10, typicalGapHours: Math.round(typical * 10) / 10, silent: silentFor == null || silentFor > threshold, severe: silentFor == null || silentFor > Math.max(redH, lim.multiple * p90) });
  }
  const silent = srcRows.filter((s) => s.silent), severe = srcRows.filter((s) => s.severe).length;
  add({ key: "silentSources", label: "Sources gone quiet", value: silent.length, unit: "", limit: q.silentSources, status: severe >= (q.silentSources?.red ?? 4) ? "red" : silent.length >= (q.silentSources?.amber ?? 1) ? "amber" : "green", detail: silent.length ? `Quiet: ${silent.map((s) => s.name).slice(0, 6).join(", ")}.` : "Every source has reported within its usual rhythm." });
  const unknown = [];
  for (const r of store.db.prepare("SELECT publication, COUNT(*) AS n FROM articles WHERE published_at >= ? GROUP BY publication").all(since)) if (!sources.find(r.publication)) unknown.push({ name: r.publication, count: r.n });
  add({ key: "unknownOutlets", label: "Outlets missing from the ownership list", value: unknown.length, unit: "", limit: { amber: 1, red: 3 }, status: unknown.length >= 3 ? "red" : unknown.length ? "amber" : "green", detail: unknown.length ? "Each unknown outlet counts as its own independent origin until it is added." : "Every outlet maps to an owner group." });

  // do the stories filed under a topic really belong to it? (measured by the topic-fit check on the topics behind today's opportunities)
  const tf = store.topicFitStats(now - 72 * HOUR), tfShare = tf.checked ? tf.fits / tf.checked : null, tfl = q.topicFit ?? { amber: 0.85, red: 0.65, minChecked: 50 };
  add({ key: "topicFit", label: "Stories that really fit their topic", value: tfShare, unit: "%", limit: tfl, status: "info", detail: tf.checked ? `${tf.fits} of ${tf.checked} checked headlines fit the topic they were filed under; the rest are left out of the topic automatically, so this measures how loosely stories are first labelled, not the data you see.` : "No topic has been checked yet." });

  // human audit and forecast accuracy (informational until enough evidence exists)
  const a = store.auditStats(), au = q.auditAccuracy ?? {};
  add({ key: "auditAccuracy", label: "Reading accuracy (human spot-check)", value: a.accuracy, unit: "%", limit: au, status: a.reviewed + 0 >= (au.minReviewed ?? 20) ? level(a.accuracy, au, false) : "info", detail: a.reviewed ? `${a.correct} correct, ${a.wrong} wrong, ${a.unsure} unsure out of ${a.reviewed} reviewed (needs ${au.minReviewed ?? 20}+ to count).` : "No stories reviewed yet. Open Accuracy → Audit to check a sample." });
  if (forecast) { const fc = q.forecastCoverage ?? {}; add({ key: "forecastCoverage", label: "Forecast band coverage", value: forecast.bandCoverage, unit: "%", limit: fc, status: forecast.evaluated >= (fc.minEvaluated ?? 30) ? level(forecast.bandCoverage, fc, false) : "info", detail: forecast.evaluated ? `${forecast.evaluated} forecasts checked; the 80% band should hold about 80% of outcomes.` : "No forecasts old enough to check yet." }); }

  const status = checks.some((c) => c.status === "red") ? "red" : checks.some((c) => c.status === "amber") ? "amber" : "green";
  return {
    status, generatedAt: now, checks, sources: srcRows, unknownOutlets: unknown,
    duplicates: { rate: dupRate, pairs: pendingDup.length, sample: pendingDup.slice(0, 6).map((d) => ({ a: d.a, b: d.b })) },
    topicsToReview: low.sort((x, y) => y.count - x.count).slice(0, 15).map((t) => ({ key: t.key, name: t.name, count: t.count, parentShare: t.parentShare })),
    flags: checks.filter((c) => c.status === "red" || c.status === "amber").map((c) => c.label),
  };
}
