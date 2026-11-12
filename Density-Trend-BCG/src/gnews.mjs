// Google News RSS per publication, plus best-effort article text retrieval. No dependencies.
// Everything here connects directly. The one exception: an article's text that could not be fetched directly is retried once through a proxy
// (see fetchArticleBody and proxyfetch.mjs); the proxy address comes from HIVEMIND_BODY_PROXY or DATAIMPULSE_PROXY_URL in .env.
import { detectWire } from "./origins.mjs";
import { fetchViaProxy, proxyUrl } from "./proxyfetch.mjs";

const UA = "Mozilla/5.0 (compatible; DensityTrendBCG/1.0; news research)";
const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", ndash: "–", mdash: "—", hellip: "…" };

export function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => chr(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => chr(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => NAMED[n.toLowerCase()] ?? m);
}
const chr = (n) => { try { return String.fromCodePoint(n); } catch { return ""; } };
const stripTags = (s) => decodeEntities(s.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
const tag = (b, n) => b.match(new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)</${n}>`, "i"))?.[1] ?? "";
const unwrap = (s) => decodeEntities(s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")).trim();

export function parseGoogleNews(xml, publication) {
  const items = [];
  for (const b of xml.match(/<item>[\s\S]*?<\/item>/gi) || []) {
    let title = stripTags(unwrap(tag(b, "title")));
    const outlet = stripTags(unwrap(tag(b, "source"))) || publication;
    // Google appends " - Outlet" to every headline.
    const suffix = ` - ${outlet}`;
    if (title.endsWith(suffix)) title = title.slice(0, -suffix.length).trim();
    const published = Date.parse(unwrap(tag(b, "pubDate")));
    const link = unwrap(tag(b, "link"));
    if (!title || !link || !Number.isFinite(published)) continue;
    if (!/\s/.test(title)) continue; // bare domains / one-word placeholders are not headlines
    const snippet = stripTags(unwrap(tag(b, "description")));
    items.push({
      title, url: link, publishedAt: published, publication, outlet,
      snippet: snippet.startsWith(title) ? "" : snippet, // Google usually just repeats the headline
    });
  }
  return items;
}

// Google throttles with 429/503 when polled heavily; back off and retry a few times rather than failing the whole run.
// Requests are direct. With `proxy` set (only ever for an article-text retry, see fetchArticleBody) the same request goes through that proxy.
async function getText(url, { timeout = 8000, retries = 1, proxy = null, proxyFetch = fetchViaProxy, ...init } = {}) {
  for (let attempt = 0; ; attempt++) {
    const headers = { "user-agent": UA, "accept-language": "en-IN,en;q=0.9", ...init.headers };
    try {
      const res = proxy
        ? await proxyFetch(url, { proxyUrl: proxy, method: init.method, body: init.body, headers, timeout })
        : await fetch(url, { ...init, headers, signal: AbortSignal.timeout(timeout), redirect: "follow" });
      if (res.ok) return await res.text();
      if ((res.status === 429 || res.status === 503) && attempt < retries) {
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      if (attempt < retries && (e.name === "TimeoutError" || e.name === "AbortError")) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      throw e;
    }
  }
}

const RSS_CAP = 90; // Google returns ~100 items per query; at or above this we assume the result was truncated

async function queryRss(pub, extra) {
  const q = `site:${pub.domain} ${extra}`;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-IN&gl=IN&ceid=IN:en`;
  return parseGoogleNews(await getText(url), pub.name);
}

// Google's whole-day filter: after:D before:D+1 (dates are calendar days, YYYY-MM-DD).
export function dayQuery(date) {
  const [y, m, d] = date.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  return `after:${date} before:${next}`;
}

// A past day can only be fetched as one query, so it is capped at Google's ~100 items per publication.
async function fetchDay(pub, date) {
  const [y, m, d] = date.split("-").map(Number);
  const from = new Date(y, m - 1, d).getTime(), to = new Date(y, m - 1, d + 1).getTime(); // the server's local day, like the stored days
  const all = (await queryRss(pub, dayQuery(date))).filter((i) => i.publishedAt >= from && i.publishedAt < to).sort((a, b) => b.publishedAt - a.publishedAt);
  return Object.assign([...all], { available: all.length });
}

// perPub defaults to unlimited. One query is capped by Google at ~100 items, so when a publication saturates
// it we add narrower recent windows (and "today") and merge by URL to get past that ceiling.
// With `date` it fetches that whole calendar day instead of the trailing window.
export async function fetchPublication(pub, { hours = 24, perPub = Infinity, date = null } = {}) {
  if (date) return fetchDay(pub, date);
  const byUrl = new Map();
  const add = (items) => (items || []).forEach((i) => byUrl.set(i.url, i));
  const first = await queryRss(pub, `when:${hours}h`).catch(() => []);
  add(first);
  if (first.length >= RSS_CAP && hours > 6) {
    try {
      await new Promise((r) => setTimeout(r, 250));
      const extra = await queryRss(pub, `when:6h`).catch(() => []);
      add(extra);
    } catch { /* graceful fallback */ }
  }
  const cutoff = Date.now() - hours * 3600e3;
  const all = [...byUrl.values()].filter((i) => i.publishedAt >= cutoff).sort((a, b) => b.publishedAt - a.publishedAt);
  const picked = all.slice(0, perPub);
  picked.available = all.length;
  return picked;
}

// news.google.com/rss/articles/<id> is not a redirect; the real URL comes from an internal RPC.
export async function resolveGoogleUrl(link, net = {}) {
  const id = new URL(link).pathname.split("/").pop();
  const page = await getText(`https://news.google.com/rss/articles/${id}`, net);
  const sg = page.match(/data-n-a-sg="([^"]+)"/)?.[1];
  const ts = page.match(/data-n-a-ts="([^"]+)"/)?.[1];
  if (!sg || !ts) throw new Error("no signature on Google News page");
  const inner = JSON.stringify(["garturlreq", [["X", "X", ["X", "X"], null, null, 1, 1, "US:en", null, 1, null, null, null, null, null, 0, 1], "X", "X", 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0], id, Number(ts), sg]);
  const body = "f.req=" + encodeURIComponent(JSON.stringify([[["Fbv4je", inner]]]));
  const text = await getText("https://news.google.com/_/DotsSplashUi/data/batchexecute", {
    method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" }, ...net,
  });
  const resp = JSON.parse(JSON.parse(text.split("\n\n")[1])[0][2]);
  if (typeof resp?.[1] !== "string" || !/^https?:/.test(resp[1])) throw new Error("could not decode article URL");
  return resp[1];
}

export function extractArticleText(html, maxChars = 8000) {
  if (!html || typeof html !== "string") return "";

  // 1. Next.js __NEXT_DATA__ SSR extraction (extracts full content pre-rendered by server before client paywall triggers)
  try {
    const nextMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
    if (nextMatch) {
      const nextJson = JSON.parse(nextMatch[1]);
      const pProps = nextJson?.props?.pageProps;
      const bodyCandidate = 
        pProps?.data?.body || 
        pProps?.article?.body || 
        pProps?.story?.body || 
        pProps?.content?.body ||
        pProps?.post?.content;
      if (bodyCandidate && typeof bodyCandidate === "string") {
        const cleaned = stripTags(bodyCandidate);
        if (cleaned.length > 250) return cleaned.slice(0, maxChars);
      }
    }
  } catch {}

  // 2. Schema.org JSON-LD extraction (NewsArticle / Report articleBody)
  try {
    const ldMatches = html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
    for (const m of ldMatches) {
      try {
        const ld = JSON.parse(m[1]);
        const items = Array.isArray(ld) ? ld : (ld["@graph"] || [ld]);
        for (const item of items) {
          if (item?.articleBody && typeof item.articleBody === "string" && item.articleBody.length > 250) {
            return stripTags(item.articleBody).slice(0, maxChars);
          }
        }
      } catch {}
    }
  } catch {}

  // 3. Structured article body containers
  const articleMatch = html.match(/<(?:article|div itemprop="articleBody"|div class="[^"]*(?:article-body|story-body|content-body|article__body)[^"]*")[^>]*>([\s\S]*?)<\/(?:article|div)>/i);
  const sourceHtml = articleMatch ? articleMatch[1] : html;

  // 4. Clean paragraphs extraction
  const clean = sourceHtml.replace(/<(script|style|noscript|svg|nav|header|footer|aside|form)[\s\S]*?<\/\1>/gi, " ");
  const paras = [...clean.matchAll(/<p[\s>][\s\S]*?<\/p>/gi)]
    .map((m) => stripTags(m[0]))
    .filter((p) => p.length > 50 && !/^(advertisement|read also|also read|subscribe|sign in|follow us|copyright)/i.test(p));

  return paras.join("\n").slice(0, maxChars);
}

async function bodyOnce(article, net) {
  const real = await resolveGoogleUrl(article.url, { timeout: 6000, ...net });
  const text = extractArticleText(await getText(real, { timeout: 7000, ...net }));
  if (text.length > 400) return { text, basis: "full-text", resolvedUrl: real, wire: detectWire(text) };
  return { text: "", basis: "headline", resolvedUrl: real, wire: null };
}

// Returns { text, basis } — basis says what the LLM actually got to read.
// The text is fetched directly. Only when that FAILS (blocked, throttled, timed out) is it tried once more through the proxy, if one is configured;
// the result then carries viaProxy: true. A page that loads but is short (a paywall teaser, a brief) is not retried: a proxy would not change it.
export async function fetchArticleBody(article, { proxy = proxyUrl(), proxyFetch = fetchViaProxy } = {}) {
  try {
    // With a proxy to fall back on, a direct attempt that is refused or throttled fails at once instead of waiting through Google's back-off (3 + 9 + 27 s).
    return await bodyOnce(article, proxy ? { retries: 0 } : {});
  } catch (direct) {
    const why = String(direct.message || direct);
    if (!proxy) return { text: "", basis: "headline", error: why };
    try {
      return { ...(await bodyOnce(article, { proxy, proxyFetch })), viaProxy: true };
    } catch (viaProxy) {
      return { text: "", basis: "headline", error: `${why}; again through the proxy: ${String(viaProxy.message || viaProxy)}`, triedProxy: true };
    }
  }
}
