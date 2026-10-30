// Opinion and analysis pieces published online. The news reading already labels every story reported / opinion / analysis, so this module
// (1) counts those labels per topic at no cost, (2) leaves out market notes that are not authored pieces, (3) takes a headline cue ("Opinion:")
// as a label too, and (4) when switched on, reads the piece itself: fetch the text, confirm the label, find the writer, and match it to the exact
// suggested angle. Steps 4 only ever use the cheap model (Groq), only for pieces not yet looked at, and stop at a daily cap.
import { fetchPublication, fetchArticleBody } from "./gnews.mjs";
import { shortlist } from "./ocrjobs.mjs";
import { dayOf } from "./db.mjs";

// Stock-market notes ("target price", "stocks to watch") are labelled analysis by the model but are not authored opinion pieces.
export const MARKET_NOTE = /(target price|stocks? to (buy|sell|watch)|buy or sell|death cross|golden cross|technical (analysis|outlook|pick|view)|share price|analysts? (flag|say|see|upgrade|downgrade|pick)|brokerage|buy rating|sell rating|\bltd\.?$|\blimited$|\bq[1-4] ?(fy)?\d* (results|earnings)|stock (jumps|surges|falls|slips|rallies))/i;
// A headline that says what it is: "Opinion: ...", "... | Editorial", "Explained: ..."
export const OPINION_CUE = /^(opinion|editorial|column|comment|view|viewpoint|analysis|explained|perspective|op-ed|my take)\s*[:|\-–—]|\|\s*(opinion|editorial|analysis)\s*$/i;

// Why a collected story counts as an online authored piece, or null. Order: a confirmed reading first, then the model's label, then the cue, then the section.
// `piece` is the stored judgement for the story (online_pieces row) when there is one.
export function onlineKind(item, piece = null) {
  if (piece?.kind === "news") return null;                       // the text was read and it is reported news
  if (piece?.kind === "opinion" || piece?.kind === "analysis") return { kind: piece.kind, by: piece.source === "section" ? "section" : "text" };
  const t = item.title ?? "";
  if (item.contentType === "opinion") return { kind: "opinion", by: "label" };
  if (item.contentType === "analysis" && !MARKET_NOTE.test(t)) return { kind: "analysis", by: "label" };
  if (OPINION_CUE.test(t) && !MARKET_NOTE.test(t)) return { kind: /^(analysis|explained)/i.test(t) ? "analysis" : "opinion", by: "cue" };
  if (piece?.source === "section") return { kind: "opinion", by: "section" };
  return null;
}

// Opinion sections of the newspapers, polled with the same Google News query as the main collection (site:domain/section).
// Returns [{ title, url, publishedAt, publication, outlet, section }]. A paper that fails is skipped.
export async function pollSections(pubs, { hours = 24, date = null, fetchPub = fetchPublication, log = () => {} } = {}) {
  const out = [];
  for (const p of pubs.filter((x) => x.opinionPath)) {
    try {
      const items = await fetchPub({ ...p, domain: p.domain + p.opinionPath }, { hours, date });
      for (const i of items) out.push({ ...i, section: p.opinionPath });
      log(`  ${p.name.padEnd(26)} opinion section: ${items.length}`);
    } catch (e) { log(`  ${p.name.padEnd(26)} opinion section FAILED: ${e.message}`); }
    await new Promise((r) => setTimeout(r, 300));
  }
  return out;
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }));
}

// Candidates for the reading: online authored pieces in the window that have not been looked at, newest first, at most `cap`.
export function candidates({ items, store, windowDays = 7, asOf, cap }) {
  const done = store.onlineChecked(), from = asOf - windowDays * 864e5, sections = store.onlineSectionKeys();
  const out = [];
  for (const it of items) {
    if (it.at < from || done.has(it.id)) continue;
    const k = onlineKind(it, sections.has(it.id) ? { source: "section" } : null);
    if (k) out.push({ item: it, label: k });
  }
  out.sort((a, b) => b.item.at - a.item.at);
  return out.slice(0, cap);
}

// Reads each candidate: fetch the text, confirm the label and find the writer with the same model call the print editions use, keep the
// start of the text for the angle matching. A piece whose text cannot be fetched keeps its label (and no writer) and is not retried.
export async function confirm({ store, reader, picks, concurrency = 6, batchSize = 8, fetchBody = fetchArticleBody, log = () => {} }) {
  const read = [];
  await pool(picks, concurrency, async (p) => {
    const b = await fetchBody({ url: p.item.url });
    read.push({ ...p, text: b.text || "", viaProxy: !!b.viaProxy });
  });
  let confirmed = 0, demoted = 0, named = 0, failed = 0, noText = read.filter((r) => !r.text).length;
  const withText = read.filter((r) => r.text), rows = [];
  for (const r of read.filter((x) => !x.text)) rows.push({ key: r.item.id, kind: r.label.kind, author: "", source: r.label.by, basis: "headline", excerpt: "" });
  for (let i = 0; i < withText.length; i += batchSize) {
    const batch = withText.slice(i, i + batchSize);
    try {
      const got = await reader.classifyArticles(batch.map((r) => ({ id: r.item.id, source: r.item.outlets?.[0] ?? "", page: "", headline: r.item.title, signals: [r.label.by], excerpt: r.text.length > 910 ? `${r.text.slice(0, 650)} […] ${r.text.slice(-260)}` : r.text })));
      const by = new Map(got.map((g) => [g.id, g]));
      for (const r of batch) {
        const g = by.get(r.item.id);
        if (!g) { failed++; continue; }
        if (g.kind === "news") demoted++; else { confirmed++; if (g.author) named++; }
        rows.push({ key: r.item.id, kind: g.kind, author: g.author || "", source: "text", basis: "full-text", excerpt: r.text.slice(0, 1500) });
      }
    } catch (e) { failed += batch.length; log(`  online confirm batch failed (${e.message})`); }
  }
  store.putOnlinePieces(rows);
  return { looked: picks.length, fetched: withText.length, noText, confirmed, demoted, named, failed, viaProxy: read.filter((r) => r.viaProxy).length };
}

// Matches the confirmed (or label-only) pieces to the exact suggested angle they take up. Same shortlist-then-model approach as the print editions.
export async function matchOnline({ store, reader, analytics, companyId = "bcg", batchSize = 8, concurrency = 4, minFit = 0.4, limit = 1e9, log = () => {} }) {
  const opps = analytics.opportunities({ company: companyId, limit: 500 }).items ?? [];
  if (!opps.length) return { skipped: "no opportunities to match against" };
  const todo = store.onlineUnmatched(companyId, limit);
  const work = [], none = [];
  for (const a of todo) {
    const cands = shortlist({ headline: a.title, body: a.excerpt || "" }, opps);
    if (!cands.length) { none.push({ storyKey: a.key, oppKey: "-", fit: 0 }); continue; }
    work.push({ id: a.key, headline: a.title, excerpt: (a.excerpt || "").slice(0, 700), candidates: cands.map((o, i) => ({ id: "c" + (i + 1), oppKey: o.key, topic: o.label.name, sector: o.sector, angle: o.angle })) });
  }
  const angleOf = new Map(opps.map((o) => [o.key, o.angle]));
  const batches = []; for (let i = 0; i < work.length; i += batchSize) batches.push(work.slice(i, i + batchSize));
  let matched = 0, failed = 0; const results = [...none];
  await pool(batches, concurrency, async (b) => {
    try {
      const got = await reader.matchAngles(b, minFit), answered = new Set(got.map((g) => g.id));
      for (const g of got) { results.push({ storyKey: g.id, oppKey: g.oppKey, fit: g.fit, angle: angleOf.get(g.oppKey) }); matched++; }
      for (const a of b) if (!answered.has(a.id)) results.push({ storyKey: a.id, oppKey: "-", fit: 0 });
    } catch (e) { failed += b.length; log(`  online match batch failed (${e.message})`); }
  });
  if (results.length) store.putOnlineMatches(companyId, results);
  analytics.cache?.clear?.();
  return { pieces: todo.length, shortlisted: work.length, matched, failed };
}

// The pieces read today, so the daily cap holds across runs.
export const capLeft = (store, cap, now = Date.now()) => Math.max(0, cap - store.onlineReadOn(dayOf(now)));
