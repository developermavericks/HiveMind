// src/xtrends.mjs
// Real-time Twitter (X) Trends validation for suggested editorial angles (Method A).
// Fetches public Top 70 India and Worldwide trending topics from hourly public mirror feed,
// caches them in SQLite meta (polled every 8 hours by automated scheduler),
// and cross-verifies whether a suggested editorial angle or topic is actively trending on X in India or Worldwide.
//
// Zero Twitter scraping (no headless browser, no Twitter logins, no bot risk)
// Zero additional API cost (uses public mirror feed + deterministic token matching).

const CACHE_KEY = "social.xtrends.cache";
const CACHE_TTL_MS = 8 * 3600 * 1000; // 8 hours cache

let memoryCache = {
  fetchedAt: 0,
  india: [],
  worldwide: [],
  trends: [], // unified list with .region = 'india' | 'worldwide'
  verifiedMatches: new Map(),
};

/**
 * Parses HTML from getdaytrends into clean trend objects.
 */
function parseTrendsHtml(html, region = "india") {
  const regex = /<th scope="row" class="pos">(\d+)<\/th>[\s\S]*?<td class="main"><a [^>]*>([^<]+)<\/a>(?:[\s\S]*?<span class="desc">([^<]+)<\/span>)?/g;
  const trends = [];
  let m;
  while ((m = regex.exec(html)) !== null) {
    const raw = m[2].trim();
    trends.push({
      rank: parseInt(m[1], 10),
      name: raw,
      clean: raw.replace(/^#/, "").replace(/_/g, " ").trim(),
      count: (m[3] || "").trim(),
      region
    });
  }
  return trends;
}

/**
 * Fetches trends for a specific region from public mirror feed.
 */
export async function fetchTrendsForRegion(region = "india", { timeoutMs = 8000 } = {}) {
  try {
    const url = region === "worldwide" ? "https://getdaytrends.com/" : "https://getdaytrends.com/india/";
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) return null;
    const html = await res.text();
    const trends = parseTrendsHtml(html, region);
    if (trends.length >= 5) {
      return {
        fetchedAt: Date.now(),
        region,
        trends
      };
    }
  } catch {
    // Non-blocking
  }
  return null;
}

/**
 * Fetches the current live Twitter trends for India.
 */
export async function fetchIndiaTrends(opts = {}) {
  return await fetchTrendsForRegion("india", opts);
}

/**
 * Fetches both India and Worldwide trends in parallel.
 */
export async function fetchAllTrends({ timeoutMs = 8000 } = {}) {
  const [indRes, worldRes] = await Promise.allSettled([
    fetchTrendsForRegion("india", { timeoutMs }),
    fetchTrendsForRegion("worldwide", { timeoutMs })
  ]);
  const india = (indRes.status === "fulfilled" && indRes.value?.trends) ? indRes.value.trends : [];
  const worldwide = (worldRes.status === "fulfilled" && worldRes.value?.trends) ? worldRes.value.trends : [];

  return {
    fetchedAt: Date.now(),
    india,
    worldwide,
    trends: [
      ...india.map((t) => ({ ...t, region: "india" })),
      ...worldwide.map((t) => ({ ...t, region: "worldwide" }))
    ]
  };
}

/**
 * Refreshes trends (both India & Worldwide) and saves to SQLite store.
 */
export async function refreshTrends(store = null) {
  const fresh = await fetchAllTrends();
  if (fresh.trends?.length) {
    memoryCache.fetchedAt = fresh.fetchedAt;
    memoryCache.india = fresh.india;
    memoryCache.worldwide = fresh.worldwide;
    memoryCache.trends = fresh.trends;
    memoryCache.verifiedMatches.clear();
    if (store?.setJson) {
      try {
        store.setJson(CACHE_KEY, fresh);
      } catch {
        // ignore
      }
    }
    return memoryCache;
  }
  return getCachedTrends(store);
}

// Backward compatible alias
export const refreshIndiaTrends = refreshTrends;

/**
 * Gets cached trends (India & Worldwide) or refreshes if older than maxAgeMs.
 */
export async function getTrends({ store = null, maxAgeMs = CACHE_TTL_MS, forceRefresh = false, region = "all" } = {}) {
  const now = Date.now();
  if (!forceRefresh && memoryCache.trends.length && memoryCache.worldwide?.length && now - memoryCache.fetchedAt < maxAgeMs) {
    return filterTrendsByRegion(memoryCache, region);
  }

  // Check store meta cache (both India and Worldwide streams must be populated)
  if (store && !forceRefresh) {
    try {
      const saved = store.getJson?.(CACHE_KEY, null);
      if (saved && saved.india?.length && saved.worldwide?.length && now - (saved.fetchedAt || 0) < maxAgeMs) {
        memoryCache.fetchedAt = saved.fetchedAt;
        memoryCache.india = saved.india;
        memoryCache.worldwide = saved.worldwide;
        memoryCache.trends = saved.trends || [...saved.india, ...saved.worldwide];
        return filterTrendsByRegion(memoryCache, region);
      }
    } catch {
      // ignore
    }
  }

  // Fetch fresh trends (both streams)
  const fresh = await refreshTrends(store);
  return filterTrendsByRegion(fresh, region);
}

// Backward compatible alias
export const getIndiaTrends = getTrends;

function filterTrendsByRegion(data, region = "all") {
  if (region === "india") return { ...data, trends: data.india?.length ? data.india : (data.trends || []).filter((t) => t.region === "india") };
  if (region === "worldwide") return { ...data, trends: data.worldwide?.length ? data.worldwide : (data.trends || []).filter((t) => t.region === "worldwide") };
  return data;
}

/**
 * Synchronous non-blocking read of cached trends from memory or SQLite meta.
 */
export function getCachedTrends(store = null, { region = "all" } = {}) {
  if (!memoryCache.trends.length && store?.getJson) {
    try {
      const saved = store.getJson(CACHE_KEY, null);
      if (saved) {
        memoryCache.fetchedAt = saved.fetchedAt || 0;
        memoryCache.india = saved.india || saved.trends || [];
        memoryCache.worldwide = saved.worldwide || [];
        memoryCache.trends = saved.trends || [...memoryCache.india, ...memoryCache.worldwide];
      }
    } catch {
      // ignore
    }
  }
  if (region === "india") return memoryCache.india?.length ? memoryCache.india : (memoryCache.trends || []).filter((t) => t.region === "india");
  if (region === "worldwide") return memoryCache.worldwide?.length ? memoryCache.worldwide : (memoryCache.trends || []).filter((t) => t.region === "worldwide");
  return memoryCache.trends;
}

// Backward compatible alias
export const getCachedIndiaTrends = getCachedTrends;

const STOP_WORDS = new Set(
  "and the of for in on to with a an or by at from as is are what how when why which who can should must would could will about into over after than new best top world india daily share today news price market week month year time first last good best high great live look take make".split(" ")
);

function extractTokens(str = "") {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOP_WORDS.has(w));
}

function trendWords(t) {
  const raw = (t.name || "").replace(/^#/, "");
  const splitCamel = raw.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  const words = `${t.clean || ""} ${splitCamel}`
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
  return new Set(words);
}

/**
 * Synchronously checks if an opportunity / suggested angle matches an active Twitter trend.
 */
export function matchOpportunityTrend(opp, trends) {
  if (!opp || !Array.isArray(trends) || !trends.length) return null;

  const topicName = (opp.label?.name || "").trim();
  const angleText = (opp.angle || opp.why || "").trim();
  const angleToks = extractTokens(angleText);
  const topicToks = extractTokens(topicName);
  const allToks = [...new Set([...topicToks, ...angleToks])];

  const matches = [];
  for (const t of trends) {
    const tRaw = (t.name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!tRaw || tRaw.length < 3) continue;

    const tWords = trendWords(t);
    const region = t.region || "india";

    // 1. Topic name direct match
    if (topicName.length >= 4) {
      const topClean = topicName.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (topClean.length >= 4 && (tRaw.includes(topClean) || topClean.includes(tRaw))) {
        matches.push({ rank: t.rank, name: t.name, count: t.count, region, reason: `Topic "${topicName}" trending on X (${region === "worldwide" ? "Worldwide" : "India"})` });
        continue;
      }
    }

    // 2. Exact word boundary match between angle/topic tokens and trend words
    for (const tok of allToks) {
      if (tWords.has(tok)) {
        matches.push({ rank: t.rank, name: t.name, count: t.count, region, reason: `Keyword "${tok}" trending on X (${region === "worldwide" ? "Worldwide" : "India"})` });
        break;
      }
      // Stem match for longer compound themes (e.g. "infrastructure" vs "infra")
      if (tok.length >= 6) {
        for (const tw of tWords) {
          if (tw.length >= 4 && (tok.startsWith(tw) || tw.startsWith(tok))) {
            matches.push({ rank: t.rank, name: t.name, count: t.count, region, reason: `Theme "${tok}" trending on X (${region === "worldwide" ? "Worldwide" : "India"})` });
            break;
          }
        }
      }
    }
  }

  if (!matches.length) return null;
  // Sort by highest trend rank (lowest number). Prefer India if rank is close, but sort primarily by rank.
  matches.sort((a, b) => a.rank - b.rank);
  const best = matches[0];
  return {
    trending: true,
    rank: best.rank,
    name: best.name,
    count: best.count,
    region: best.region || "india",
    reason: best.reason
  };
}
