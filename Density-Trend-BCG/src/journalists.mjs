// Journalist directory (HiveMind.docx §7: "match opportunities to the right author"). The directory comes from an
// external endpoint, is cached in the local database, and each opportunity is matched to journalists using ONLY what
// their record states: beat, publication, location and their recent articles. Nothing about a journalist is inferred
// or invented. Contact details are shown to the editor but never sent to an LLM, and nothing is ever sent TO a
// journalist: outreach is a human decision.
import { norm } from "./brackets.mjs";

export const DEFAULT_URL = "https://us-central1-anexar-9820c.cloudfunctions.net/getJournalists";
const PAGE = 1000;
const s = (x, n = 200) => (typeof x === "string" ? x.trim().slice(0, n) : "");

// A record is kept only if it has an id and a name; everything else is trimmed text. Only the first 12 articles are kept.
export function normalizeRecord(r) {
  const id = s(String(r?.id ?? r?.journalistId ?? ""), 80), name = s(r?.name, 120);
  if (!id || !name) return null;
  return {
    id, name, publication: s(r.publication), beat: s(r.beat, 300), designation: s(r.designation ?? r.title, 120), city: s(r.city, 80), state: s(r.state, 80), country: s(r.country, 60),
    email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email ?? "") ? r.email.trim().toLowerCase() : "", phone: s(r.phone, 40),
    linkedin: /^https?:\/\//.test(r.linkedin ?? "") ? r.linkedin.trim() : "", twitter: s(r.twitter, 120), profileUrl: /^https?:\/\//.test(r.scribeProfile ?? "") ? r.scribeProfile.trim() : "",
    articles: (Array.isArray(r.articles) ? r.articles : []).slice(0, 12).filter((a) => a && a.title).map((a) => ({ title: s(a.title, 220), url: /^https?:\/\//.test(a.url ?? "") ? a.url : "", publishDate: s(a.publishDate, 40), summary: s(a.summary, 400), website: s(a.website, 80) })),
  };
}

async function getPage(url, page, signal) {
  const u = new URL(url);
  u.searchParams.set("limit", String(PAGE)); u.searchParams.set("page", String(page));
  const res = await fetch(u, { signal: signal ?? AbortSignal.timeout(90000) });
  if (!res.ok) throw new Error(`Journalist endpoint returned ${res.status}`);
  const j = await res.json();
  if (!j || j.success === false || !Array.isArray(j.data)) throw new Error("Journalist endpoint returned an unexpected response");
  return j;
}

// Walks every page (records are de-duplicated by id) and stores them. Resumable: a failed sync keeps what it already saved.
export async function syncJournalists(store, { url = DEFAULT_URL, onProgress = () => {} } = {}) {
  let page = 1, saved = 0, total = null;
  const seen = new Set();
  for (;;) {
    const j = await getPage(url, page);
    total ??= j.totalRecords ?? null;
    const fresh = j.data.map(normalizeRecord).filter((r) => r && !seen.has(r.id));
    fresh.forEach((r) => seen.add(r.id));
    saved += store.upsertJournalists(fresh);
    onProgress({ page, pages: j.totalPages ?? null, saved, total });
    if (!j.hasMore || !j.data.length || page >= (j.totalPages ?? 1000)) break;
    page++;
  }
  store.setMeta("journalists.lastSync", String(Date.now()));
  store.setMeta("journalists.lastCount", String(store.journalistCount()));
  return { saved, total: store.journalistCount() };
}

// ---------------------------------------------------------------- matching
const STOP = new Set("and the of for in on to with a an or by at from as is are was be this that it its news india indian says said new".split(" "));
const stem = (w) => (w.length > 4 ? w.replace(/ies$/, "y").replace(/s$/, "") : w);
export const toks = (t) => new Set(norm(t ?? "").split(" ").filter((w) => w.length > 2 && !STOP.has(w)).map(stem));
const DAY = 86400e3;

// ctx: { topicTokens:Set (bracket keywords + story titles), outlets:Set(norm outlet names covering the topic), geography:[places], now }
export function journalistFit(j, opp, ctx) {
  const now = ctx.now ?? Date.now(), core = new Set([...toks(opp.sector), ...toks(opp.label.name), ...toks(opp.label.parentName)]);
  const topic = new Set([...core, ...(ctx.topicTokens ?? [])]);
  const why = [], missing = [];

  // Beat: the journalist's own declared beats (comma-separated), against the sector, topic and area names.
  const tags = (j.beat || "").split(",").map((b) => b.trim()).filter(Boolean);
  const hitTags = tags.filter((t) => { const tt = toks(t); return tt.size && [...tt].some((x) => core.has(x) || (ctx.topicTokens?.has(x) && tt.size === 1)); });
  if (!tags.length) missing.push("beat");
  else if (hitTags.length) why.push(`Beat: ${hitTags.slice(0, 3).join(", ")}`);
  const beat = tags.length ? 100 * Math.min(1, hitTags.length / 2) : 0;

  // Recent articles: how many topic terms an article touches, weighted by how recent it is.
  const scored = (j.articles ?? []).map((a) => {
    const at = toks(`${a.title} ${a.summary}`);
    const hits = [...at].filter((x) => topic.has(x)).length;
    const core2 = [...at].filter((x) => core.has(x)).length;
    const age = a.publishDate ? (now - Date.parse(a.publishDate)) / DAY : null;
    const recency = age == null || Number.isNaN(age) ? 0.6 : age <= 90 ? 1 : age <= 365 ? 0.7 : 0.4;
    return { a, score: Math.min(1, (hits + core2) / 5) * recency, hits };
  }).filter((x) => x.hits > 0).sort((x, y) => y.score - x.score);
  if (!j.articles?.length) missing.push("recent articles");
  const articles = scored.length ? 100 * Math.min(1, scored[0].score + (scored[1] ? 0.25 * scored[1].score : 0)) : 0;
  if (scored.length) why.push(`${scored.length} recent article${scored.length > 1 ? "s" : ""} on related subjects`);

  // Place: any story location mentioned in the journalist's city, state or location.
  const place = norm(`${j.city} ${j.state}`), geo = (ctx.geography ?? []).map(norm).filter((g) => g && g !== "india");
  const geoHit = geo.find((g) => place.includes(g) || g.includes(norm(j.city)) && norm(j.city));
  const geography = geoHit ? 100 : j.city || j.state ? 25 : 0;
  if (geoHit) why.push(`Based in ${[j.city, j.state].filter(Boolean).join(", ")}, where the story is`);
  if (!j.city && !j.state) missing.push("location");

  // Outlet: their publication is already carrying this topic (a sign the desk is interested).
  const pubs = (j.publication || "").split(",").map(norm).filter(Boolean);
  const outlet = pubs.some((p) => [...(ctx.outlets ?? [])].some((o) => o && (o.includes(p) || p.includes(o)))) ? 100 : 0;
  if (outlet) why.push(`${j.publication} is already covering this topic`);

  const parts = { beat: { score: beat, weight: 35 }, articles: { score: articles, weight: 35 }, geography: { score: geography, weight: 15 }, outlet: { score: outlet, weight: 15 } };
  const score = Object.values(parts).reduce((t, p) => t + (p.score * p.weight) / 100, 0);
  return {
    id: j.id, name: j.name, publication: j.publication, beat: j.beat, designation: j.designation, city: j.city, state: j.state, score, parts, why, missing,
    evidence: scored.slice(0, 3).map((x) => ({ title: x.a.title, url: x.a.url, publishDate: x.a.publishDate })),
    contact: { email: j.email, phone: j.phone, linkedin: j.linkedin, twitter: j.twitter, profile: j.profileUrl },
  };
}

// The shape the brief drafter expects. Only declared fields are passed (no contact details).
export const toAuthor = (j) => ({
  id: j.id, name: j.name, expertise: (j.beat || "").split(",").map((b) => b.trim()).filter(Boolean), sectors: [], audience: j.publication ? `readers of ${j.publication}` : "",
  geography: [j.city, j.state].filter(Boolean), publications: [j.publication].filter(Boolean),
  evidence: (j.articles ?? []).slice(0, 5).map((a) => `Wrote: ${a.title}`),
});
