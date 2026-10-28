// Entity tracking: how often each named organisation, person or place appears in the news, and whether that is rising.
// Entities are the names the reader recorded for each story ("Tata Motors", "RBI"). They are normalised (case, "Ltd",
// well-known abbreviations) so one name is counted once, then measured like topics: coverage share now against the share
// over the previous week, with the same smoothing, so a few stories cannot look like a surge.
import { norm } from "./brackets.mjs";
import { HOUR, floorHour } from "./metrics.mjs";

const SUFFIX = new Set(["ltd", "limited", "pvt", "private", "inc", "corp", "corporation", "co", "plc", "llp", "the"]);
// A short list of unambiguous short forms. Anything else is left exactly as the reader wrote it (never guessed).
const ALIASES = {
  rbi: "reserve bank of india", sebi: "securities and exchange board of india", tml: "tata motors", "tata motors passenger vehicles": "tata motors",
  "pm modi": "narendra modi", "prime minister modi": "narendra modi", modi: "narendra modi", "prime minister narendra modi": "narendra modi",
  isro: "indian space research organisation", ioc: "indian oil corporation", iocl: "indian oil corporation", ongc: "oil and natural gas corporation",
  sc: "supreme court", "supreme court of india": "supreme court", "union government": "government of india", "central government": "government of india", centre: "government of india",
  "us": "united states", usa: "united states", "united states of america": "united states", uk: "united kingdom", uae: "united arab emirates", "who": "world health organization",
  imf: "international monetary fund", opec: "opec", nse: "national stock exchange", bse: "bombay stock exchange", lic: "life insurance corporation of india", sbi: "state bank of india",
};
// Names too generic to say anything about (they appear in half of all stories).
const GENERIC = new Set(["india", "indian", "government", "state government", "police", "centre", "government of india"]);

export const entityId = (name, aliases = null) => {
  const id = entityIdRaw(name);
  return id && aliases ? aliases.get(id) ?? id : id;
};
const entityIdRaw = (name) => {
  let n = norm(String(name ?? "")).split(" ").filter((w) => !SUFFIX.has(w)).join(" ").trim();
  if (!n || n.length < 2) return null;
  n = ALIASES[n] ?? n;
  return GENERIC.has(n) ? null : n.slice(0, 60);
};

const sentimentNet = (arr) => {
  const lab = arr.filter((i) => i.sentiment);
  if (lab.length < 3) return null;
  const p = lab.filter((i) => i.sentiment === "positive").length, n = lab.filter((i) => i.sentiment === "negative").length;
  return { net: (p - n) / lab.length, labelled: lab.length };
};

// All entities seen, with momentum. items = the pipeline items (each has .entities, .origins, .at, .sentiment, .id).
export function buildEntities(items, asOf, cfg, { recentHours = 24, minStories = 3, aliases = null } = {}) {
  const iv = cfg.intervals, B = iv.baselineHours;
  const recentFrom = asOf - recentHours * HOUR, baseFrom = recentFrom - B * HOUR;
  const byEntity = new Map();
  let totRecent = 0, totBase = 0;
  const firstAt = items.reduce((m, i) => Math.min(m, i.at), Infinity);
  for (const it of items) {
    const recent = it.at >= recentFrom && it.at <= asOf, base = it.at >= baseFrom && it.at < recentFrom;
    if (recent) totRecent++; else if (base) totBase++;
    const seen = new Set();
    for (const raw of it.entities ?? []) {
      const id = entityId(raw, aliases);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      let e = byEntity.get(id);
      if (!e) byEntity.set(id, e = { id, names: new Map(), items: [] });
      e.names.set(raw.trim(), (e.names.get(raw.trim()) || 0) + 1);
      e.items.push(it);
    }
  }
  const baseDepth = Number.isFinite(firstAt) ? Math.min(B, Math.max(0, (recentFrom - firstAt) / HOUR)) : 0;
  const baselineOk = totBase >= iv.minBaselineClusters && baseDepth >= iv.minBaselineHours;
  const rows = [];
  for (const e of byEntity.values()) {
    if (e.items.length < minStories) continue;
    const cur = e.items.filter((i) => i.at >= recentFrom && i.at <= asOf), base = e.items.filter((i) => i.at >= baseFrom && i.at < recentFrom);
    const share = totRecent ? cur.length / totRecent : 0, baseShare = baselineOk && totBase ? base.length / totBase : null;
    const ratio = baseShare == null ? null : (cur.length + 1) / (baseShare * totRecent + 1);
    const origins = new Set(cur.flatMap((i) => i.origins));
    const spark = [];
    for (let h = 72; h > 0; h -= 6) {
      const a = asOf - h * HOUR, b = a + 6 * HOUR;
      const tot = items.reduce((n, i) => n + (i.at >= a && i.at < b ? 1 : 0), 0);
      spark.push(tot ? e.items.filter((i) => i.at >= a && i.at < b).length / tot : 0);
    }
    const stage = ratio == null || cur.length < 2 || origins.size < (cfg.topics?.minOrigins ?? 3) ? "watch" : ratio >= cfg.stage.risingRatio ? "rising" : ratio <= cfg.stage.decliningRatio ? "declining" : "steady";
    const topicCount = {};
    for (const i of cur.length ? cur : e.items) for (const k of i.labels.keys()) if (k.startsWith("t:")) topicCount[k] = (topicCount[k] || 0) + 1;
    rows.push({
      id: e.id, name: [...e.names.entries()].sort((a, b) => b[1] - a[1])[0][0], count: cur.length, countAll: e.items.length, share, baselineShare: baseShare, momentum: ratio,
      stage, origins: origins.size, sentiment: sentimentNet(cur.length >= 3 ? cur : e.items), spark,
      topTopics: Object.entries(topicCount).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([key, n]) => ({ key, n })),
    });
  }
  rows.sort((a, b) => (b.momentum ?? 0) - (a.momentum ?? 0) || b.count - a.count);
  return { rows, totals: { recent: totRecent, baseline: totBase }, baselineOk, recentHours };
}

// One entity's items, plus the items re-labelled so the standard chart series (coverage share, rolling average) work for it.
export function itemsWithEntity(items, id, aliases = null) {
  const key = `e:${id}`;
  const mine = [];
  const all = items.map((it) => {
    if (!(it.entities ?? []).some((n) => entityId(n, aliases) === id)) return it;
    const copy = { ...it, labels: new Map([...it.labels, [key, { w: it.maxSev, direction: "mixed" }]]) };
    mine.push(copy);
    return copy;
  });
  return { key, all, mine };
}

export { floorHour };
