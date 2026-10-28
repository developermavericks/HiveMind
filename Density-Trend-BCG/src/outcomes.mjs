// Did the recommendations come true? Every logged recommendation is checked once 72 hours have passed: did the topic's
// coverage share reach the success multiple, with enough independent origins? That gives a measured hit rate, and the
// scoring weights can then be tested against it. Nothing here changes a score by itself: a suggested re-weighting is only
// applied when someone confirms it.
import { HOUR } from "./metrics.mjs";

const COMPONENTS = ["momentum", "acceleration", "sourceBreadth", "sectorEvidence", "triggerTiming", "headroom"];

// items: pipeline items (publication time .at, .labels, .origins). rec: a recommendation_log row.
export function evaluateRecommendation(rec, items, cfg) {
  const key = String(rec.opp_key).split("|").pop();
  const win = cfg.success.windowHours * HOUR, t0 = rec.as_of;
  const inBase = (i) => i.at >= t0 - cfg.success.baselineDays * 24 * HOUR && i.at < t0;
  const baseAll = items.filter(inBase), baseLabel = baseAll.filter((i) => i.labels.has(key));
  if (baseAll.length < 50) return { skip: true, reason: "not enough history before the recommendation" };
  const after = items.filter((i) => i.at >= t0 && i.at <= t0 + win);
  if (!after.length) return { skip: true, reason: "no coverage collected afterwards" };
  const baseShare = baseLabel.length / baseAll.length;
  // Best rolling 24h share inside the 72h that followed (hourly steps).
  let peakShare = 0, peakCount = 0, peakTotal = 0;
  for (let s = t0; s + 24 * HOUR <= t0 + win + HOUR; s += HOUR) {
    const w = after.filter((i) => i.at >= s && i.at < s + 24 * HOUR);
    if (w.length < 20) continue;
    const c = w.filter((i) => i.labels.has(key)).length, sh = c / w.length;
    if (sh > peakShare) { peakShare = sh; peakCount = c; peakTotal = w.length; }
  }
  const origins = new Set(after.filter((i) => i.labels.has(key)).flatMap((i) => i.origins));
  const peakRatio = (peakCount + 1) / (baseShare * peakTotal + 1); // same smoothing as the momentum metric
  // A topic that was tiny at baseline must grow more to count (3x) than a large one (1.5x), and needs a minimum of stories at the peak.
  const band = (cfg.success.bands ?? []).find((b) => baseShare <= b.maxBaseShare), need = band?.multiple ?? cfg.success.shareMultiple;
  const hit = peakRatio >= need && origins.size >= cfg.success.minOrigins && peakCount >= (cfg.success.minPeakStories ?? 0);
  return { hit, peakRatio, peakOrigins: origins.size, baseShare, peakShare, needed: need };
}

// Evaluates every recommendation that is at least `windowHours` old and not yet judged. Returns counts.
export function evaluatePending({ store, items, cfg, now = Date.now() }) {
  const pend = store.pendingOutcomes(now - cfg.success.windowHours * HOUR);
  let hits = 0, misses = 0, skipped = 0;
  for (const rec of pend) {
    const r = evaluateRecommendation(rec, items, cfg);
    if (r.skip) { skipped++; continue; }
    store.putOutcome(rec.id, r);
    r.hit ? hits++ : misses++;
  }
  return { evaluated: hits + misses, hits, misses, skipped, pending: pend.length - hits - misses - skipped };
}

const rate = (a) => (a.length ? a.filter((x) => x.hit).length / a.length : null);
export function outcomeSummary(rows, nowMs = Date.now(), windowHours = 72) {
  const done = rows.filter((r) => r.hit !== null);
  const by = (f) => { const o = {}; for (const r of done) { const k = f(r); (o[k] ?? (o[k] = [])).push(r); } return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { n: v.length, hits: v.filter((x) => x.hit).length, rate: rate(v) }])); };
  const band = (r) => (r.score >= 80 ? "80+" : r.score >= 65 ? "65–79" : r.score >= 50 ? "50–64" : "below 50");
  return {
    evaluated: done.length, pending: rows.filter((r) => r.hit === null && nowMs - r.ts < windowHours * HOUR).length,
    awaitingEvaluation: rows.filter((r) => r.hit === null && nowMs - r.ts >= windowHours * HOUR).length,
    hitRate: { overall: rate(done), n: done.length, byAction: by((r) => r.action), byBand: by(band) },
  };
}

// ---------------------------------------------------------------- weight tuning
const rawValues = (r, W, wSum) => Object.fromEntries(COMPONENTS.map((k) => [k, W[k] ? (((r.components?.[k] ?? 0) * wSum) / W[k]) / 100 : 0])); // component score 0..1
const scoreWith = (v, W) => { const s = COMPONENTS.reduce((a, k) => a + W[k], 0); return COMPONENTS.reduce((a, k) => a + (W[k] * v[k]) / s, 0) * 100; };
function auc(rows, W, wSum0, Wc) {
  const pos = [], neg = [];
  for (const r of rows) (r.hit ? pos : neg).push(scoreWith(rawValues(r, Wc, wSum0), W));
  if (!pos.length || !neg.length) return 0.5;
  let w = 0; for (const p of pos) for (const n of neg) w += p > n ? 1 : p === n ? 0.5 : 0;
  return w / (pos.length * neg.length);
}
const topRate = (rows, W, Wc, wSum0, q = 0.25) => {
  const sc = rows.map((r) => ({ r, s: scoreWith(rawValues(r, Wc, wSum0), W) })).sort((a, b) => b.s - a.s).slice(0, Math.max(5, Math.ceil(rows.length * q)));
  return sc.length ? sc.filter((x) => x.r.hit).length / sc.length : null;
};

export function tuneWeights(outcomeRows, cfg) {
  const t = cfg.tuning ?? {}, W = cfg.weights, wSum = Object.values(W).reduce((a, b) => a + b, 0);
  const rows = outcomeRows.filter((r) => r.hit !== null && r.components && Object.keys(r.components).length).sort((a, b) => a.ts - b.ts);
  const hits = rows.filter((r) => r.hit).length, misses = rows.length - hits;
  const base = { current: { weights: { ...W } }, sample: rows.length, hits, misses };
  if (rows.length < (t.minOutcomes ?? 30) || hits < (t.minHits ?? 5) || misses < (t.minHits ?? 5)) {
    return { ready: false, ...base, suggested: null, needs: `At least ${t.minOutcomes ?? 30} judged recommendations with ≥ ${t.minHits ?? 5} hits and ≥ ${t.minHits ?? 5} misses (have ${rows.length}: ${hits} hits, ${misses} misses). Recommendations are judged ${cfg.success.windowHours} hours after they are made.` };
  }
  const step = t.step ?? 5, half = Math.floor(rows.length / 2), A = rows.slice(0, half), B = rows.slice(half);
  let best = null;
  for (const up of COMPONENTS) for (const down of COMPONENTS) {
    if (up === down || W[down] - step < 5) continue;
    const cand = { ...W, [up]: W[up] + step, [down]: W[down] - step };
    // Must improve on both halves of the history (older and newer), not only overall, so it isn't fitted to one stretch.
    const dA = auc(A, cand, wSum, W) - auc(A, W, wSum, W), dB = auc(B, cand, wSum, W) - auc(B, W, wSum, W), d = auc(rows, cand, wSum, W) - auc(rows, W, wSum, W);
    if (dA > 0 && dB > 0 && d > (best?.d ?? 0.02)) best = { cand, d, up, down };
  }
  const cur = topRate(rows, W, W, wSum);
  if (!best) return { ready: true, ...base, suggested: null, hitRateCurrent: cur, note: "No small re-weighting improved the hit rate on both the older and the newer half of the history, so the current weights stay." };
  return { ready: true, ...base, suggested: { weights: best.cand, change: `+${step} ${best.up}, −${step} ${best.down}` }, hitRateCurrent: cur, hitRateSuggested: topRate(rows, best.cand, W, wSum), aucGain: best.d };
}
