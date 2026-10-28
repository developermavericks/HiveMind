// Topic metrics (HiveMind.docx §4–§5): the explicit calculations behind every chart and score.
//
// A "label" is either a bracket (broad topic group, key "b:<id>") or a finer topic (key "t:<id>", only for stories
// that have been enriched). For each label and time interval:
//   coverage volume  distinct reporting clusters (stories) mentioning it
//   source breadth   independent origins among them (media groups / wire credit / primary sources, see origins.mjs)
//   coverage share   label clusters ÷ all eligible clusters collected in the same interval
//   momentum         recent coverage share ÷ baseline coverage share, smoothed so 1→3 stories can't look like ×3
//   acceleration     change in log₂ momentum between the previous and the current step
//   impact breadth   distinct impact areas the label's stories affect
// Share (not raw counts) is used so a change in how many articles were collected doesn't read as a trend.
import { dayOf, dayStart, DAY_MS } from "./db.mjs";
import { storyBracketWeights, coverageOf, basisOf } from "./density.mjs";
import { originsOf } from "./origins.mjs";

export const HOUR = 3600e3;
export const floorHour = (ms) => { const d = new Date(ms); d.setMinutes(0, 0, 0); return d.getTime(); };
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const log2 = Math.log2;
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0; };

// ---------------------------------------------------------------- stories → items
// Only stories observed by `asOf` are used, so any past moment can be replayed without seeing the future.
// Two times per story: `at` = publication time, the time axis (when the attention happened), and `observedAt` = when the
// story could have been known to us (recorded first-seen time when collection was timely, else the publication time:
// stories backfilled long after publication are flagged `reconstructed`). Charts bin by `at`; a replay (gate = true)
// additionally requires observedAt <= asOf so late-arriving articles cannot leak into an earlier prediction.
export function prepareItems(stories, { registry, sources, cfg, asOf = Infinity, gate = true }) {
  const lagMs = cfg.intervals.observedLagHours * HOUR;
  const items = [];
  for (const s of stories) {
    if (!s.analysis) continue;
    const lag = s.firstSeen != null ? s.firstSeen - s.publishedAt : Infinity;
    const timely = lag <= lagMs;
    const observedAt = timely ? Math.max(s.firstSeen, s.publishedAt) : s.publishedAt;
    if (s.publishedAt > asOf || (gate && observedAt > asOf)) continue;

    const impacts = s.analysis.impacts ?? [];
    const org = originsOf(s, sources);
    const scale = coverageOf(s) * basisOf(s);
    const maxSev = impacts.reduce((m, i) => Math.max(m, i.severity), 0);
    const labels = new Map(), areas = new Map(), allAreas = new Set();
    for (const [rawId, v] of storyBracketWeights(s)) {
      const meta = registry.get(rawId);
      if (!meta) continue;
      const k = `b:${meta.id}`, cur = labels.get(k);
      if (!cur || v.w > cur.w) labels.set(k, { w: v.w, direction: v.direction });
    }
    for (const i of impacts) {
      if (i.severity >= 0.2) allAreas.add(i.area);
      const meta = i.bracket ? registry.get(i.bracket) : null;
      if (meta && i.severity >= 0.2) (areas.get(`b:${meta.id}`) ?? areas.set(`b:${meta.id}`, new Set()).get(`b:${meta.id}`)).add(i.area);
    }
    for (const tid of s.meta?.topics ?? []) { labels.set(`t:${tid}`, { w: maxSev * scale, direction: "mixed" }); areas.set(`t:${tid}`, allAreas); }
    const horizonRank = { immediate: 0, near: 1, long: 2 };
    const horizon = impacts.length ? impacts.reduce((h, i) => (horizonRank[i.horizon] < horizonRank[h] ? i.horizon : h), "long") : "near";
    items.push({
      id: s.id, title: s.title, url: s.url, summary: s.analysis.summary ?? "", eventType: s.analysis.event_type ?? "",
      geography: s.analysis.geography ?? [], publishedAt: s.publishedAt, at: s.publishedAt, observedAt, reconstructed: !timely, readAt: s.readAt ?? 0, enrichedAt: s.enrichedAt ?? s.readAt ?? 0,
      outletCount: s.outlets.length, outlets: s.outlets, origins: org.origins, originCount: org.count, primary: org.primary, wire: org.wire,
      verified: org.primary || org.count >= cfg.evidence.verifiedTriggerOrigins,
      fullText: s.basis === "full-text", maxSev, horizon, labels, areas, impacts,
      contentType: s.meta?.contentType ?? null, pathways: s.meta?.pathways ?? [], entities: s.meta?.entities ?? [], sentiment: s.meta?.sentiment ?? null, stance: s.meta?.stance ?? null,
    });
  }
  return items;
}

// ---------------------------------------------------------------- weekday patterns
// Some topics are always bigger on certain weekdays (sport at weekends, markets on weekdays). Once there are enough weeks of
// history, a topic's expected share for each weekday is learned and the baseline is scaled by it, so an ordinary Monday spike
// is not mistaken for a rising topic. Until then it is off and says so; nothing is guessed from a few days.
export function buildSeasonality(items, asOf, cfg) {
  const need = cfg.seasonality?.minDays ?? 28;
  const first = items.reduce((m, i) => Math.min(m, i.at), Infinity);
  const haveDays = Number.isFinite(first) ? Math.floor((asOf - first) / DAY_MS) : 0;
  const out = { active: false, haveDays, needDays: need, factors: new Map() };
  if (haveDays < need) return out;
  const dowTotal = new Array(7).fill(0), per = new Map();
  for (const it of items) {
    const d = new Date(it.at).getDay(); dowTotal[d]++;
    for (const k of it.labels.keys()) { let a = per.get(k); if (!a) per.set(k, a = { c: new Array(7).fill(0), n: 0 }); a.c[d]++; a.n++; }
  }
  const all = dowTotal.reduce((a, b) => a + b, 0);
  for (const [k, a] of per) {
    if (a.n < 28) continue;
    const overall = a.n / all;
    out.factors.set(k, a.c.map((c, d) => (dowTotal[d] >= 50 && c >= 3 ? clamp(c / dowTotal[d] / overall, 0.5, 2) : 1)));
  }
  out.active = true;
  return out;
}
// Average weekday factor over the `hours` hours ending at asOf.
export function seasonalFactor(seasonal, key, asOf, hours) {
  const f = seasonal?.factors.get(key);
  if (!f) return 1;
  let s = 0; for (let h = 0; h < hours; h++) s += f[new Date(asOf - h * HOUR).getDay()];
  return s / hours;
}

// ---------------------------------------------------------------- time index
function buildIndex(items, { binMs, end, nBins, cfg, kind, elig = null }) {
  const start = end - nBins * binMs;
  const total = new Array(nBins).fill(0);
  const labels = new Map();
  for (const it of items) {
    const b = Math.floor((it.at - start) / binMs);
    if (b < 0 || b >= nBins) continue;
    total[b]++;
    for (const [k, v] of it.labels) {
      let L = labels.get(k);
      if (!L) labels.set(k, L = { count: new Array(nBins).fill(0), w: new Array(nBins).fill(0), origins: new Array(nBins).fill(null), items: [] });
      L.count[b]++; L.w[b] += v.w; L.items.push({ it, bin: b });
      const set = L.origins[b] ?? (L.origins[b] = new Set());
      for (const o of it.origins) set.add(o);
    }
  }
  // A label created part-way through collection (a bracket the model added, a topic first coined during labelling) could
  // only have been given to stories read after that moment. Its coverage share must be measured against those stories,
  // otherwise its appearance looks like a surge. Labels that always existed share the global per-interval total.
  for (const [k, L] of labels) {
    const e = elig ? elig(k) : null;
    if (!e || !e.from) { L.total = total; continue; }
    L.total = new Array(nBins).fill(0);
    for (const it of items) {
      const b = Math.floor((it.at - start) / binMs);
      if (b >= 0 && b < nBins && it[e.field] >= e.from) L.total[b]++;
    }
    for (let b = 0; b < nBins; b++) L.total[b] = Math.max(L.total[b], L.count[b]);
  }
  // Collection outage: a fully elapsed interval, inside the span that has data, with (almost) nothing collected.
  const iv = cfg.intervals, first = total.findIndex((t) => t > 0);
  let last = -1; total.forEach((t, i) => { if (t > 0) last = i; });
  const med = median(total.slice(Math.max(0, first), last + 1).filter((t) => t > 0));
  const minTotal = kind === "hour" ? iv.minTotalPerHour : 30;
  const frac = kind === "hour" ? iv.outageFractionHour : iv.outageFractionDay;
  const status = total.map((t, i) => {
    if (first < 0 || i < first) return "nodata";
    if (start + (i + 1) * binMs > cfg._asOf) return "open"; // the current, still-filling interval
    return t < Math.max(minTotal, frac * med) ? "low" : "ok";
  });
  return { start, end, binMs, nBins, total, labels, status, kind };
}

function sumRange(arr, from, to, skip = null) {
  let s = 0;
  for (let i = Math.max(0, from); i < to; i++) if (!skip || !skip(i)) s += arr[i];
  return s;
}
function labelWindow(idx, L, from, to, skip = null) {
  let count = 0; const origins = new Set(); let w = 0;
  for (let i = Math.max(0, from); i < to; i++) {
    if (skip && skip(i)) continue;
    count += L.count[i]; w += L.w[i];
    if (L.origins[i]) for (const o of L.origins[i]) origins.add(o);
  }
  return { count, origins, w };
}

// ---------------------------------------------------------------- stage rules
export function stageOf(m, cfg, pct) {
  const st = cfg.stage, ev = cfg.evidence;
  const x = (v) => `×${v.toFixed(2)}`;
  if (m.ratio == null) return { stage: "watch", rule: `Watchlist: only ${m.baselineHours}h of usable baseline (needs ≥ ${cfg.intervals.minBaselineHours}h), so momentum can't be judged yet.` };
  if (m.count < ev.minClusters || m.originsRecent < ev.minOrigins) return { stage: "watch", rule: `Watchlist: ${m.count} stor${m.count === 1 ? "y" : "ies"} from ${m.originsRecent} independent origin${m.originsRecent === 1 ? "" : "s"} in the window (needs ≥ ${ev.minClusters} and ≥ ${ev.minOrigins}).` };
  const sustained = m.ratioPrev != null && m.ratioPrev >= st.sustainedRatio;
  if (pct >= st.crowdedPercentile && m.ratio < st.risingRatio) return { stage: "crowded", rule: `Crowded: coverage share is in the top ${Math.round((1 - st.crowdedPercentile) * 100)}% of topics (percentile ${(pct * 100).toFixed(0)}) and momentum ${x(m.ratio)} is below ${x(st.risingRatio)}.` };
  if (m.ratio <= st.decliningStrongRatio || (m.ratio <= st.decliningRatio && m.ratioPrev != null && m.ratioPrev <= st.decliningRatio + 0.1)) return { stage: "declining", rule: `Declining: momentum ${x(m.ratio)} ≤ ${x(st.decliningRatio)} and the previous step ${m.ratioPrev == null ? "n/a" : x(m.ratioPrev)} was also falling (or momentum ≤ ${x(st.decliningStrongRatio)}).` };
  if (m.ratio >= st.risingRatio && sustained) return { stage: "rising", rule: `Rising: momentum ${x(m.ratio)} ≥ ${x(st.risingRatio)} and the previous step ${x(m.ratioPrev)} ≥ ${x(st.sustainedRatio)}, so the increase is sustained, not one spike.` };
  if (m.ratio >= st.risingRatio && pct < st.emergingPercentile) return { stage: "emerging", rule: `Emerging: momentum ${x(m.ratio)} ≥ ${x(st.risingRatio)} from a below-median coverage share (percentile ${(pct * 100).toFixed(0)}); not yet sustained across two steps.` };
  if (m.ratio >= st.risingRatio) return { stage: "rising", rule: `Rising: momentum ${x(m.ratio)} ≥ ${x(st.risingRatio)} from a ${pct >= 0.5 ? "large" : "mid-sized"} base; the previous step is not yet confirmed.` };
  return { stage: "steady", rule: `Steady: momentum ${x(m.ratio)} is between ${x(st.decliningRatio)} and ${x(st.risingRatio)}.` };
}

export function evidenceStrength(m, cfg) {
  const ev = cfg.evidence, reasons = [];
  const ftShare = m.count ? m.fullTextCount / m.count : 0;
  const needFull = ev.requireFullText !== false && cfg.reading?.mode !== "headline"; // headline reading is the normal mode: independence carries the weight
  if (m.originsRecent >= ev.highOrigins && (!needFull || ftShare >= 0.5) && m.baselineHours >= cfg.intervals.minBaselineHours * 3) return { level: "high", reasons: [`${m.originsRecent} independent origins`, ...(needFull ? [`${Math.round(ftShare * 100)}% read from full text`] : []), `${m.baselineHours}h of baseline`] };
  if (m.originsRecent >= ev.mediumOrigins && m.baselineHours >= cfg.intervals.minBaselineHours) {
    if (needFull && ftShare < 0.5) reasons.push(`only ${Math.round(ftShare * 100)}% read from full text`);
    if (m.baselineHours < cfg.intervals.minBaselineHours * 3) reasons.push(`short baseline (${m.baselineHours}h)`);
    return { level: "medium", reasons: [`${m.originsRecent} independent origins`, ...reasons] };
  }
  if (m.originsRecent < ev.mediumOrigins) reasons.push(`only ${m.originsRecent} independent origin${m.originsRecent === 1 ? "" : "s"}`);
  if (m.baselineHours < cfg.intervals.minBaselineHours) reasons.push(`baseline ${m.baselineHours}h`);
  return { level: "low", reasons };
}

// ---------------------------------------------------------------- the label table (canonical, hourly)
export function analyse(items, ctx, asOf) {
  const cfg = { ...ctx.cfg, _asOf: asOf }, iv = cfg.intervals;
  const firstObs = items.reduce((m, i) => Math.min(m, i.at), Infinity);
  const historyHours = Number.isFinite(firstObs) ? Math.max(0, (asOf - firstObs) / HOUR) : 0;
  const R = historyHours < iv.shortBelowHistoryHours ? iv.recentHoursShort : iv.recentHours;
  const S = iv.stepHours, B = iv.baselineHours, n = R + S + B;
  const end = floorHour(asOf) + HOUR;
  const idx = buildIndex(items, { binMs: HOUR, end, nBins: n, cfg, kind: "hour", elig: ctx.elig });
  const skip = (i) => idx.status[i] === "low" || idx.status[i] === "nodata";
  const baseRange = (hi) => [Math.max(0, hi - B), hi];
  const baseNow = baseRange(n - R), basePrev = baseRange(n - R - S);
  // Hours of usable baseline in a range for a given per-interval total (collection gaps and empty hours don't count).
  const depthOf = (tot, rng) => { let h = 0; for (let i = rng[0]; i < rng[1]; i++) if (!skip(i) && tot[i] > 0) h++; return h; };
  const curT = sumRange(idx.total, n - R, n), prevT = sumRange(idx.total, n - R - S, n - S);
  const baseT = sumRange(idx.total, ...baseNow, skip);
  const baselineHours = depthOf(idx.total, baseNow);

  const labels = new Map();
  for (const [key, L] of idx.labels) {
    const tot = L.total;
    const lCurT = sumRange(tot, n - R, n), lPrevT = sumRange(tot, n - R - S, n - S);
    const lBaseT = sumRange(tot, ...baseNow, skip), lBasePT = sumRange(tot, ...basePrev, skip);
    const lDepth = depthOf(tot, baseNow);
    const cur = labelWindow(idx, L, n - R, n), prev = labelWindow(idx, L, n - R - S, n - S);
    const base = labelWindow(idx, L, ...baseNow, skip), baseP = labelWindow(idx, L, ...basePrev, skip);
    const ok = lBaseT >= iv.minBaselineClusters && lDepth >= iv.minBaselineHours;
    const okP = lBasePT >= iv.minBaselineClusters && depthOf(tot, basePrev) >= iv.minBaselineHours;
    const share = lCurT ? cur.count / lCurT : 0, baseShare = ok ? base.count / lBaseT : null;
    // +1 on both sides: three stories where one was expected is x2, not x3 - small counts cannot dominate.
    // The expected share is scaled by this topic's usual weekday pattern once enough history exists (1 = no adjustment).
    const sf = ctx.seasonal?.active ? seasonalFactor(ctx.seasonal, key, asOf, R) : 1;
    const ratio = ok ? (cur.count + 1) / (baseShare * lCurT * sf + 1) : null;
    const ratioPrev = okP ? (prev.count + 1) / ((baseP.count / lBasePT) * lPrevT + 1) : null;
    const accel = ratio != null && ratioPrev != null ? log2(ratio) - log2(ratioPrev) : null;
    const recentItems = L.items.filter((x) => x.bin >= n - R).map((x) => x.it);
    const areas = new Set();
    for (const it of recentItems) for (const a of it.areas.get(key) ?? []) areas.add(a);
    const lastIt = recentItems.reduce((m, it) => (it.at > (m?.at ?? 0) ? it : m), null);
    // Parent bracket (for topics): the bracket most of the topic's stories are filed under. A topic only inherits a bracket's sector links when
    // that bracket really holds most of its stories (at least minParentShare, and at least two stories); a topic spread across
    // unrelated areas, or made of stories with no real-world impact, has no parent and so cannot be paired with a sector it does not belong to.
    let parent = key.startsWith("b:") ? key.slice(2) : null, parentShare = 1;
    if (!parent) {
      const tally = {};
      for (const { it } of L.items) for (const k of it.labels.keys()) if (k.startsWith("b:")) tally[k] = (tally[k] || 0) + 1;
      const top = Object.entries(tally).sort((x, y) => y[1] - x[1])[0];
      parentShare = top ? top[1] / L.items.length : 0;
      parent = top && top[1] >= 2 && parentShare >= (cfg.topics?.minParentShare ?? 0.5) ? top[0].slice(2) : null;
    }
    const spark = [];
    for (let s = n - Math.min(n, 72); s < n; s += 6) { const t = sumRange(tot, s, Math.min(n, s + 6)); spark.push(t ? sumRange(L.count, s, Math.min(n, s + 6)) / t : 0); }
    const m = {
      key, level: key.startsWith("b:") ? "bracket" : "topic", id: key.slice(2), parent, spark,
      count: cur.count, countPrev: prev.count, total: lCurT, share, baseShare, ratio, ratioPrev, accel,
      weight: cur.w, originsRecent: cur.origins.size, originsTotal: new Set(L.items.flatMap((x) => x.it.origins)).size,
      fullTextCount: recentItems.filter((i) => i.fullText).length, verifiedCount: recentItems.filter((i) => i.verified).length,
      areas: [...areas], areaCount: areas.size, baselineHours: lDepth, windowHours: R, lastObservedAt: lastIt?.at ?? null,
      storiesAll: L.items.length, seasonalFactor: sf, parentShare,
    };
    labels.set(key, m);
  }

  // Share percentile among labels of the same level (how crowded each topic is relative to the others).
  for (const level of ["bracket", "topic"]) {
    const group = [...labels.values()].filter((m) => m.level === level && m.count > 0);
    const shares = group.map((m) => m.share).sort((a, b) => a - b);
    for (const m of group) {
      const below = shares.filter((s) => s < m.share).length;
      m.sharePercentile = shares.length > 1 ? below / (shares.length - 1) : 0.5;
      const st = stageOf(m, cfg, m.sharePercentile);
      m.stage = st.stage; m.stageRule = st.rule;
      m.evidence = evidenceStrength(m, cfg);
    }
  }
  const outages = [];
  idx.status.forEach((s, i) => { if (s === "low") outages.push({ from: idx.start + i * HOUR, to: idx.start + (i + 1) * HOUR, total: idx.total[i] }); });
  return {
    labels, asOf, params: { recentHours: R, stepHours: S, baselineHours: B },
    seasonality: ctx.seasonal ? { active: ctx.seasonal.active, haveDays: ctx.seasonal.haveDays, needDays: ctx.seasonal.needDays } : { active: false, haveDays: Math.floor(historyHours / 24), needDays: cfg.seasonality?.minDays ?? 28 },
    history: { hours: Math.round(historyHours), firstObservedAt: Number.isFinite(firstObs) ? firstObs : null, baselineHours, baselineWanted: B, minBaselineHours: iv.minBaselineHours },
    totals: { recent: curT, previous: prevT, baseline: baseT }, outages, itemCount: items.length,
    reconstructed: items.filter((i) => i.reconstructed).length,
  };
}

// ---------------------------------------------------------------- chart series (hourly or daily)
function rolling(count, total, k) {
  return count.map((_, i) => { let c = 0, t = 0; for (let j = Math.max(0, i - k + 1); j <= i; j++) { c += count[j]; t += total[j]; } return t ? c / t : null; });
}

// Damped-trend (Holt) extrapolation of the rolling share with a residual-based band. A pilot method:
// it extends a trend, it has not been validated, and the UI labels it that way.
export function holtDamped(y, { alpha, beta, phi, z }, h) {
  const pts = y.map((v, i) => [i, v]).filter(([, v]) => v != null);
  if (pts.length < 3) return null;
  let l = pts[0][1], b = pts[1][1] - pts[0][1];
  const resid = [];
  for (let k = 1; k < pts.length; k++) {
    const v = pts[k][1], pred = l + phi * b, e = v - pred;
    resid.push(e);
    const nl = alpha * v + (1 - alpha) * pred;
    b = beta * (nl - l) + (1 - beta) * phi * b; l = nl;
  }
  // Robust spread (median absolute residual), so one spike in the history doesn't inflate the band for ever.
  const mad = median(resid.map(Math.abs)) * 1.4826;
  const sigma = mad > 0 ? mad : Math.sqrt(resid.reduce((a, e) => a + e * e, 0) / resid.length);
  const out = []; let damp = 0, p = 1;
  for (let k = 1; k <= h; k++) {
    p *= phi; damp += p;
    const v = clamp(l + damp * b, 0, 1), band = z * sigma * Math.sqrt(k);
    out.push({ step: k, value: v, lo: clamp(v - band, 0, 1), hi: clamp(v + band, 0, 1) });
  }
  return { points: out, sigma };
}

export function seriesFor(items, key, gran, ctx, asOf) {
  const cfg = { ...ctx.cfg, _asOf: asOf }, iv = cfg.intervals;
  const binMs = gran === "day" ? DAY_MS : HOUR;
  const firstObs = items.reduce((m, i) => Math.min(m, i.at), Infinity);
  const end = gran === "day" ? dayStart(dayOf(asOf)) + DAY_MS : floorHour(asOf) + HOUR;
  const span = Number.isFinite(firstObs) ? Math.ceil((end - firstObs) / binMs) : 1;
  const nBins = gran === "day" ? clamp(span, 2, iv.dayView) : clamp(span, 24, iv.hourView);
  const idx = buildIndex(items, { binMs, end, nBins, cfg, kind: gran === "day" ? "day" : "hour", elig: ctx.elig });
  const L = idx.labels.get(key);
  const tot = L?.total ?? idx.total;
  const zeros = new Array(nBins).fill(0);
  const count = L?.count ?? zeros, w = L?.w ?? zeros;
  const origins = (L?.origins ?? zeros).map((s) => (s ? s.size : 0));
  const share = count.map((c, i) => (tot[i] ? c / tot[i] : null));
  const k = gran === "day" ? iv.rollingDays : iv.rollingHours;
  const avg = rolling(count, tot, k);

  // Verified triggers: a primary source, or enough independent origins. Shown on the chart, with the reason.
  const triggers = (L?.items ?? []).filter((x) => x.it.verified).sort((a, b) => b.it.maxSev * b.it.outletCount - a.it.maxSev * a.it.outletCount).slice(0, 6)
    .map(({ it, bin }) => ({ bin, t: it.at, title: it.title, url: it.url, origins: it.originCount, primary: it.primary, reason: it.primary ? "Primary source" : `${it.originCount} independent origins` }))
    .sort((a, b) => a.t - b.t);

  // Forecast: only with enough clean history, and always labelled as an unvalidated extrapolation.
  const f = cfg.forecast, minPts = gran === "day" ? f.minDayPoints : f.minHourPoints;
  const clean = avg.map((v, i) => (idx.status[i] === "ok" || idx.status[i] === "open" ? v : null));
  const usable = clean.filter((v) => v != null).length;
  let forecast = { available: false, reason: `Needs ≥ ${minPts} clean ${gran === "day" ? "days" : "hours"} of history; have ${usable}.` };
  if (L && usable >= minPts) {
    const h = gran === "day" ? f.dayAhead : f.hourAhead;
    const r = holtDamped(clean, f, h);
    if (r) forecast = { available: true, method: "Damped linear trend on the rolling coverage share", validated: false, sigma: r.sigma, points: r.points.map((p) => ({ ...p, t: idx.end + (p.step - 1) * binMs })) };
  }

  const related = [];
  if (L) {
    const mine = new Set(L.items.map((x) => x.it.id));
    for (const [k2, L2] of idx.labels) {
      if (k2 === key) continue;
      let inter = 0; for (const x of L2.items) if (mine.has(x.it.id)) inter++;
      const j = inter / (mine.size + L2.items.length - inter || 1);
      if (j > 0.02) related.push({ key: k2, overlap: j });
    }
    related.sort((a, b) => b.overlap - a.overlap);
  }
  return {
    granularity: gran, binMs, start: idx.start, end: idx.end, nowMs: asOf, bins: idx.total.map((_, i) => idx.start + i * binMs),
    total: tot, count, share, avg, origins, weight: w, status: idx.status, triggers, forecast,
    related: related.slice(0, 8), rollingWindow: k,
    partialLast: idx.status[nBins - 1] === "open",
  };
}
