// Search interest (HiveMind.docx §4–§5): an optional, separate signal with its own baseline and coverage.
// Google Trends values are RELATIVE scores 0–100, not search volumes, and are only comparable under consistent
// query settings, so every series carries its source label (provider, geography, date range). A topic with no
// series is "unavailable", never zero.
//
// Two ways in:
//   • SERPAPI_KEY in .env  → fetched on demand through SerpApi's Google Trends endpoint (an unofficial route to
//     Google Trends; check SerpApi's terms and pricing) and cached in the database.
//   • an uploaded file     → CSV "topic,date,value" or JSON {topic, points:[{date,value}]} from a Trends export.

const SOURCE_DEFAULT = "upload";

export function searchInterestStatus() {
  return { provider: process.env.SERPAPI_KEY ? "serpapi" : null, configured: !!process.env.SERPAPI_KEY };
}

export async function fetchSerpApi(query, { key = process.env.SERPAPI_KEY, geo = "IN", date = "today 1-m" } = {}) {
  if (!key) throw new Error("SERPAPI_KEY is not set");
  const url = `https://serpapi.com/search.json?engine=google_trends&q=${encodeURIComponent(query)}&geo=${geo}&data_type=TIMESERIES&date=${encodeURIComponent(date)}&api_key=${key}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`SerpApi ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(`SerpApi: ${j.error}`);
  const points = (j.interest_over_time?.timeline_data ?? [])
    .filter((p) => !p.values?.[0]?.partial_data)
    .map((p) => ({ t: Number(p.timestamp) * 1000, value: Number(p.values?.[0]?.extracted_value ?? p.values?.[0]?.value) }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.value));
  return { points, source: `serpapi:${geo}:${date}` };
}

// Upload parser. Returns [{ topic, source, points:[{t, value}] }].
export function parseSearchUpload(text, source = SOURCE_DEFAULT) {
  const t = String(text ?? "").replace(/^﻿/, "").trim();
  if (!t) return [];
  const toMs = (d) => (typeof d === "number" ? (d < 1e12 ? d * 1000 : d) : Date.parse(d));
  if (t[0] === "{" || t[0] === "[") {
    const j = JSON.parse(t);
    return (Array.isArray(j) ? j : [j]).map((s) => ({
      topic: String(s.topic ?? "").trim(), source: s.source || source,
      points: (s.points ?? []).map((p) => ({ t: toMs(p.date ?? p.t), value: Number(p.value) })).filter((p) => Number.isFinite(p.t) && Number.isFinite(p.value)),
    })).filter((s) => s.topic && s.points.length);
  }
  const by = new Map();
  for (const line of t.split(/\r?\n/).slice(1)) {
    const [topic, date, value] = line.split(",").map((s) => s.trim().replace(/^"|"$/g, ""));
    const ms = toMs(date), v = Number(value);
    if (!topic || !Number.isFinite(ms) || !Number.isFinite(v)) continue;
    (by.get(topic) ?? by.set(topic, []).get(topic)).push({ t: ms, value: v });
  }
  return [...by].map(([topic, points]) => ({ topic, source, points }));
}
