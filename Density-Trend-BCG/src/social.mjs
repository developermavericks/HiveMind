// X (Twitter) post volume as a SOCIAL signal (HiveMind.docx §4: permitted social data, only when available).
// It is kept apart from news coverage: its own series, its own baseline, its own units (posts per hour), and a topic
// with no series is "unavailable", never zero. Uses the official X API v2 "recent tweet counts" endpoint (last 7 days,
// hourly), which needs a Bearer Token on a plan that includes it (Basic or higher). No scraping.
const ENDPOINT = "https://api.twitter.com/2/tweets/counts/recent";
const monthKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const quote = (t) => (/\s/.test(t) ? `"${t}"` : t);

// A broad area becomes its name plus a few keywords; a specific topic becomes its quoted name. `context` (e.g. "India")
// is required to appear, so a global conversation about "inflation" doesn't count as Indian attention.
export function buildQuery({ name, keywords = [], level = "bracket", context = "India" }) {
  const raw = level === "topic" ? [name] : [name, ...keywords.slice(0, 4)];
  const terms = [...new Set(raw.map((t) => String(t).replace(/["()]/g, "").trim()).filter(Boolean))].map(quote);
  const ctx = String(context || "").split(/[,|]/).map((s) => s.trim()).filter(Boolean).map(quote);
  const q = `(${terms.join(" OR ")})${ctx.length ? ` (${ctx.join(" OR ")})` : ""} lang:en -is:retweet`;
  return q.length > 500 ? q.slice(0, 500) : q;
}

export async function fetchCounts(query, token) {
  const points = []; let next = null, rate = {}, total = 0;
  for (let page = 0; page < 3; page++) {
    const u = new URL(ENDPOINT);
    u.searchParams.set("query", query); u.searchParams.set("granularity", "hour");
    if (next) u.searchParams.set("next_token", next);
    const res = await fetch(u, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000) });
    rate = { remaining: Number(res.headers.get("x-rate-limit-remaining")), reset: Number(res.headers.get("x-rate-limit-reset")) * 1000 || null };
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      const why = res.status === 401 ? "the token was rejected" : res.status === 403 ? "your X API plan doesn't include tweet counts" : res.status === 429 ? "rate limit reached, try later" : j.detail || j.title || "request refused";
      throw Object.assign(new Error(`X ${res.status}: ${why}`), { status: res.status, rate });
    }
    for (const d of j.data ?? []) points.push({ t: Date.parse(d.start), value: d.tweet_count });
    total += j.meta?.total_tweet_count ?? 0;
    next = j.meta?.next_token;
    if (!next) break;
  }
  points.sort((a, b) => a.t - b.t);
  return { points, total, rate };
}

// Momentum of the social series on its own terms: last 24h vs the average of the earlier full days.
// The last (still filling) hour is excluded; +1 smoothing keeps tiny counts from looking like surges.
export function socialStats(points) {
  if (!points?.length) return null;
  const full = points.slice(0, -1), h = 3600e3;
  if (full.length < 48) return { available: true, recent24h: full.reduce((a, p) => a + p.value, 0), ratio: null, note: "Needs ≥ 48 hours of data for a baseline." };
  const day = (arr) => arr.reduce((a, p) => a + p.value, 0);
  const recent = full.slice(-24), prev = full.slice(-48, -24), older = full.slice(0, -24);
  const baselineDaily = older.length >= 24 ? (day(older) / older.length) * 24 : day(prev);
  const recentSum = day(recent);
  return {
    available: true, recent24h: recentSum, prev24h: day(prev), baselineDaily, ratio: (recentSum + 1) / (baselineDaily + 1),
    vsPrev: (recentSum + 1) / (day(prev) + 1), peakHour: Math.max(...full.map((p) => p.value)), hours: full.length, from: points[0].t, to: points.at(-1).t + h,
  };
}

export const usageKey = () => `social.usage.${monthKey()}`;
