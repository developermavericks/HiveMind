// Google News RSS per publication, plus best-effort article text retrieval. No dependencies.
// Set HTTPS_PROXY / HTTP_PROXY (and NODE_USE_ENV_PROXY=1 on Node ≥ 24) in .env to route these requests through a proxy.
import { detectWire } from "./origins.mjs";

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
async function getText(url, { timeout = 15000, retries = 3, ...init } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { ...init, headers: { "user-agent": UA, "accept-language": "en-IN,en;q=0.9", ...init.headers }, signal: AbortSignal.timeout(timeout), redirect: "follow" });
    if (res.ok) return res.text();
    if ((res.status === 429 || res.status === 503) && attempt < retries) { await new Promise((r) => setTimeout(r, 3000 * 3 ** attempt)); continue; }
    throw new Error(`HTTP ${res.status}`);
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
  const add = (items) => items.forEach((i) => byUrl.set(i.url, i));
  const first = await queryRss(pub, `when:${hours}h`);
  add(first);
  if (first.length >= RSS_CAP) {
    const today = new Date().toISOString().slice(0, 10);
    const windows = [`after:${today}`, ...[12, 6, 3, 1].filter((h) => h < hours).map((h) => `when:${h}h`)];
    for (const w of windows) {
      try { add(await queryRss(pub, w)); } catch { /* a failed extra window only loses extra coverage */ }
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  const cutoff = Date.now() - hours * 3600e3;
  const all = [...byUrl.values()].filter((i) => i.publishedAt >= cutoff).sort((a, b) => b.publishedAt - a.publishedAt);
  const picked = all.slice(0, perPub);
  picked.available = all.length;
  return picked;
}

// news.google.com/rss/articles/<id> is not a redirect; the real URL comes from an internal RPC.
export async function resolveGoogleUrl(link) {
  const id = new URL(link).pathname.split("/").pop();
  const page = await getText(`https://news.google.com/rss/articles/${id}`);
  const sg = page.match(/data-n-a-sg="([^"]+)"/)?.[1];
  const ts = page.match(/data-n-a-ts="([^"]+)"/)?.[1];
  if (!sg || !ts) throw new Error("no signature on Google News page");
  const inner = JSON.stringify(["garturlreq", [["X", "X", ["X", "X"], null, null, 1, 1, "US:en", null, 1, null, null, null, null, null, 0, 1], "X", "X", 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0], id, Number(ts), sg]);
  const body = "f.req=" + encodeURIComponent(JSON.stringify([[["Fbv4je", inner]]]));
  const text = await getText("https://news.google.com/_/DotsSplashUi/data/batchexecute", {
    method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
  });
  const resp = JSON.parse(JSON.parse(text.split("\n\n")[1])[0][2]);
  if (typeof resp?.[1] !== "string" || !/^https?:/.test(resp[1])) throw new Error("could not decode article URL");
  return resp[1];
}

export function extractArticleText(html, maxChars = 6000) {
  const clean = html.replace(/<(script|style|noscript|svg|nav|header|footer|aside|form)[\s\S]*?<\/\1>/gi, " ");
  const paras = [...clean.matchAll(/<p[\s>][\s\S]*?<\/p>/gi)].map((m) => stripTags(m[0])).filter((p) => p.length > 60);
  return paras.join("\n").slice(0, maxChars);
}

// Returns { text, basis } — basis says what the LLM actually got to read.
export async function fetchArticleBody(article) {
  try {
    const real = await resolveGoogleUrl(article.url);
    const text = extractArticleText(await getText(real, { timeout: 20000 }));
    if (text.length > 400) return { text, basis: "full-text", resolvedUrl: real, wire: detectWire(text) };
    return { text: "", basis: "headline", resolvedUrl: real, wire: null };
  } catch (e) {
    return { text: "", basis: "headline", error: String(e.message || e) };
  }
}
