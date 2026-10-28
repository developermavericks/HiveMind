// Backtest (HiveMind.docx §10): replay past days using only what was observed by each prediction time, and ask
// whether the top-ranked topics went on to meet the trend definition.
//
//   Trend definition (config "success"): in the forecast window the topic's coverage share is ≥ shareMultiple × its
//   preceding seven-day share, with ≥ minOrigins independent reporting origins. A proposal to tune, not a universal definition.
//   Prediction time T: the end of a day. Ranking uses stories observed by T only (prepareItems asOf = T).
//   Baseline method: rank topics by fastest raw growth (recent count − previous count), with no smoothing or evidence rules.
//   Reported: precision@K, recall@K, median lead time, false-alert rate, and editor acceptance of briefs (separately).
import { prepareItems, analyse, HOUR } from "./metrics.mjs";
import { itemsByLabel, labelComponents, pickTrigger } from "./opportunity.mjs";
import { dayOf, dayStart, DAY_MS } from "./db.mjs";

const median = (a) => { const s = a.filter((x) => x != null).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const round = (x, d = 3) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);

export function trendOutcome(items, key, T, cfg, finalAsOf) {
  const s = cfg.success, W = s.windowHours * HOUR, base0 = T - s.baselineDays * DAY_MS;
  const inW = (i) => i.at > T && i.at <= T + W, inB = (i) => i.at > base0 && i.at <= T;
  const totW = items.filter(inW).length, totB = items.filter(inB).length;
  if (totW < 30 || totB < 30) return { evaluable: false };
  const wi = items.filter((i) => inW(i) && i.labels.has(key)), bi = items.filter((i) => inB(i) && i.labels.has(key));
  const shareW = wi.length / totW, shareB = bi.length / totB;
  const origins = new Set(wi.flatMap((i) => i.origins)).size;
  const hit = origins >= s.minOrigins && wi.length >= 3 && shareW >= s.shareMultiple * Math.max(shareB, 1 / (totB + 1));
  // How soon after T the topic's running share first reached the multiple (hours).
  let leadHours = null;
  if (hit) {
    for (let h = 12; h <= s.windowHours; h += 12) {
      const sub = items.filter((i) => i.at > T && i.at <= T + h * HOUR), tot = sub.length;
      const c = sub.filter((i) => i.labels.has(key)).length;
      if (tot && c / tot >= s.shareMultiple * Math.max(shareB, 1 / (totB + 1)) && c >= 3) { leadHours = h; break; }
    }
  }
  return { evaluable: true, hit, shareW, shareB, origins, count: wi.length, leadHours };
}

export function runBacktest({ stories, ctx, asOfNow, days, briefStats = {}, level = "bracket" }) {
  const cfg = ctx.cfg, s = cfg.success;
  const definition = `Coverage share in the next ${s.windowHours}h ≥ ${s.shareMultiple}× its preceding ${s.baselineDays}-day share, with ≥ ${s.minOrigins} independent origins.`;
  const dayList = days.map((d) => d.day).sort();
  const need = s.minHistoryDays;
  if (dayList.length < need) {
    return { ready: false, haveDays: dayList.length, needDays: need, definition, topK: s.topK, reason: `Needs at least ${need} days of stored history (a ${s.baselineDays}-day baseline plus a ${Math.ceil(s.windowHours / 24)}-day forecast window and some days to evaluate); ${dayList.length} stored. Run the pipeline daily, or backfill earlier days from the dashboard's Run button.`, editor: briefStats };
  }
  const all = prepareItems(stories, { registry: ctx.registry, sources: ctx.sources, cfg, asOf: Infinity });
  const lastObs = all.reduce((m, i) => Math.max(m, i.at), 0);
  const points = [];
  for (const day of dayList) {
    const T = dayStart(day) + DAY_MS;
    if (T - dayStart(dayList[0]) < s.baselineDays * DAY_MS || T + s.windowHours * HOUR > lastObs) continue;
    // No leakage: only stories published AND already first-seen by T are known at prediction time.
    const items = all.filter((i) => i.at <= T && i.observedAt <= T);
    const res = analyse(items, ctx, T), byLabel = itemsByLabel(items);
    const cands = [...res.labels.values()].filter((m) => m.level === level && m.count > 0);
    const scored = cands.map((m) => {
      const trigger = pickTrigger(byLabel.get(m.key) ?? [], T);
      const { score } = labelComponents(m, { trigger, sector: { score: 100 * Math.min(1, m.areaCount / 4), raw: m.areaCount, note: `${m.areaCount} impact areas` } }, cfg);
      return { m, score: m.stage === "watch" ? score * 0.5 : score };
    }).sort((a, b) => b.score - a.score);
    const naive = [...cands].sort((a, b) => (b.count - b.countPrev) - (a.count - a.countPrev));
    const truth = new Map();
    for (const m of cands) truth.set(m.key, trendOutcome(all, m.key, T, cfg, lastObs));
    const trending = [...truth].filter(([, o]) => o.evaluable && o.hit).map(([k]) => k);
    const pick = (list) => list.slice(0, s.topK).map((x) => { const m = x.m ?? x; const o = truth.get(m.key); return { key: m.key, id: m.id, score: x.score != null ? round(x.score, 1) : null, stage: m.stage, hit: !!o?.hit, evaluable: !!o?.evaluable, leadHours: o?.leadHours ?? null }; });
    points.push({ day, T, hivemind: pick(scored), baseline: pick(naive), trendingTotal: trending.length, trending });
  }
  if (!points.length) return { ready: false, haveDays: dayList.length, needDays: need, definition, topK: s.topK, reason: "History is long enough but no prediction day has a complete baseline and forecast window yet.", editor: briefStats };
  const summarise = (name) => {
    const picks = points.flatMap((p) => p[name].filter((x) => x.evaluable));
    const hits = picks.filter((x) => x.hit);
    const recalls = points.filter((p) => p.trendingTotal).map((p) => p[name].filter((x) => x.hit).length / p.trendingTotal);
    return { picks: picks.length, hits: hits.length, precision: picks.length ? round(hits.length / picks.length) : null, falseAlertRate: picks.length ? round(1 - hits.length / picks.length) : null, recall: recalls.length ? round(recalls.reduce((a, b) => a + b, 0) / recalls.length) : null, medianLeadHours: median(hits.map((x) => x.leadHours)) };
  };
  const accepted = briefStats.approved ?? 0, decided = accepted + (briefStats.rejected ?? 0) + (briefStats.needs_evidence ?? 0);
  return {
    ready: true, definition, topK: s.topK, level, days: points.length, haveDays: dayList.length, points: points.slice(-30),
    hivemind: summarise("hivemind"), baseline: summarise("baseline"),
    editor: { ...briefStats, acceptanceRate: decided ? round(accepted / decided) : null, decided },
    caveats: [
      "Observation time is the recorded first-seen time when collection was timely, otherwise the publication time: a replay approximation unless collection ran hourly.",
      "Bracket-level (broad) topics only unless stories have been enriched with topic labels.",
      "Weights and the trend definition are pilot assumptions; precision on a short history is noisy.",
    ],
  };
}
