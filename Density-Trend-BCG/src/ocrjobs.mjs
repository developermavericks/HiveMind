// The print-edition (OCR) pipeline, one step at a time. Each step is resumable and only does work that is not done yet:
//   ingest()    download the editions, keep the raw JSON, store every article
//   classify()  ask the model which candidate articles are opinion / analysis (authored) and which are reported news
//   matchAngles()  for authored articles, which suggested angle (an opportunity's "write about") each one takes up
// The count of authored articles per angle is what the opportunity headroom is made from (see opportunity.mjs).
import { fetchArchive, articleRows, looksAuthored, isCandidate, wordCount, excerpt, isWeakHeadline } from "./ocr.mjs";
import { norm } from "./brackets.mjs";

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }));
}

export async function ingest({ store, from, to, dir, refresh = false, log = () => {} }) {
  const eds = await fetchArchive({ from, to, dir, refresh, log });
  let articles = 0, added = 0;
  for (const e of eds) {
    const rows = articleRows(e.payload, e.source, e.date).map((r) => {
      const a = { ...r, words: 0 }; a.words = wordCount(a);
      const signals = looksAuthored(a);
      return { ...r, words: a.words, candidate: isCandidate(a), signals };
    });
    articles += rows.length; added += store.putOcrArticles(rows);
  }
  store.markOcrNonCandidates();
  return { editions: eds.length, articles, added };
}

// model: label stored with each verdict (which provider answered is not tracked per call, so this is the configured model).
export async function classify({ store, reader, batchSize = 12, concurrency = 4, limit = 1e9, model = "", log = () => {} }) {
  const todo = store.ocrUnclassified(limit);
  const batches = []; for (let i = 0; i < todo.length; i += batchSize) batches.push(todo.slice(i, i + batchSize));
  let done = 0, failed = 0, authored = 0;
  await pool(batches, concurrency, async (b, k) => {
    const items = b.map((a) => ({ id: a.id, source: a.source, page: a.page, headline: a.headline, signals: a.signals ? a.signals.split(",").filter(Boolean) : [], excerpt: excerpt(a) }));
    try {
      const got = await reader.classifyArticles(items);
      store.putOcrKinds(got, model); done += got.length; failed += b.length - got.length; authored += got.filter((g) => g.kind !== "news").length;
    } catch (e) { failed += b.length; if (failed <= 3 * batchSize) log(`  classify batch failed (${e.message})`); }
    if ((k + 1) % 20 === 0) log(`  ${Math.min(todo.length, (k + 1) * batchSize)}/${todo.length} articles judged · ${authored} authored so far`);
  });
  return { todo: todo.length, judged: done, failed, authored };
}

// Puts together articles the OCR cut into columns: a short title block plus body blocks, some starting mid-sentence. One model call per page
// that has such blocks; the pieces of an article become one article (the parts are kept, marked, and no longer counted on their own).
export async function assemble({ store, reader, concurrency = 4, limit = 1e9, log = () => {} }) {
  const pages = store.ocrPagesToAssemble(limit, isWeakHeadline);
  let groups = 0, parts = 0, failed = 0, done = 0;
  await pool(pages, concurrency, async (pg) => {
    try {
      const blocks = store.ocrPageBlocks(pg.source, pg.date, pg.page);
      const found = blocks.length >= 2 ? await reader.groupBlocks(blocks) : [];
      store.putOcrGroups(pg, found, blocks);
      groups += found.length; parts += found.reduce((n, g) => n + g.ids.length, 0);
    } catch (e) { failed++; if (failed <= 3) log(`  page ${pg.source} ${pg.date} p${pg.page} failed (${e.message})`); }
    if (++done % 50 === 0) log(`  ${done}/${pages.length} pages · ${groups} articles put together`);
  });
  return { pages: pages.length, groups, parts, failed };
}

// Replaces headlines the OCR got wrong (a section label, a name, a sentence fragment) with the article's real title. The original is kept.
export async function fixTitles({ store, reader, batchSize = 8, concurrency = 4, limit = 1e9, log = () => {} }) {
  const all = store.ocrNeedingTitle(limit);
  const weak = all.filter((a) => isWeakHeadline(a.headline, a.author));
  // pieces whose headline looks fine are recorded as checked so they are not looked at again
  const fine = all.filter((a) => !isWeakHeadline(a.headline, a.author)).map((a) => ({ id: a.id, title: "", source: "kept" }));
  if (fine.length) store.putOcrTitles(fine);
  const batches = []; for (let i = 0; i < weak.length; i += batchSize) batches.push(weak.slice(i, i + batchSize));
  let printed = 0, generated = 0, kept = 0, failed = 0;
  await pool(batches, concurrency, async (b) => {
    try {
      const got = await reader.fixHeadlines(b);
      store.putOcrTitles(got);
      for (const g of got) g.source === "printed" ? printed++ : g.source === "generated" ? generated++ : kept++;
      failed += b.length - got.length;
    } catch (e) { failed += b.length; log(`  headline batch failed (${e.message})`); }
  });
  return { looked: all.length, weak: weak.length, printed, generated, kept, failed };
}

// Looks for the printed writer of authored pieces that have none yet (the first judgement often leaves it empty).
export async function findAuthors({ store, reader, batchSize = 10, concurrency = 4, limit = 1e9, log = () => {} }) {
  const todo = store.ocrNeedingAuthor(limit);
  const batches = []; for (let i = 0; i < todo.length; i += batchSize) batches.push(todo.slice(i, i + batchSize));
  let named = 0, failed = 0, checked = 0;
  await pool(batches, concurrency, async (b) => {
    try { const got = await reader.findAuthors(b); store.putOcrAuthors(got); checked += got.length; named += got.filter((g) => g.author).length; failed += b.length - got.length; }
    catch (e) { failed += b.length; log(`  author batch failed (${e.message})`); }
  });
  return { todo: todo.length, checked, named, failed };
}

// ---- angle matching ----
const STOP = new Set("the and for with from that this into over amid after about what how why india indian new will says say could would should more than their there have has are was were not but its out all can may year years".split(" "));
const stem = (w) => (w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
const toks = (s) => new Set(norm(s ?? "").split(" ").map(stem).filter((w) => w.length > 2 && !STOP.has(w)));

// A short list of the opportunities whose topic or angle words the article shares. The model then picks among them (or none), so
// the cost is a few candidates per article, not the whole list.
export function shortlist(article, opps, max = 6) {
  const text = toks(article.headline + " " + excerpt(article, 900, 0));
  const scored = [];
  for (const o of opps) {
    const label = toks(o.label.name), angle = toks(o.angle);
    let s = 0, labelHit = 0;
    for (const t of label) if (text.has(t)) { s += 2; labelHit++; }
    for (const t of angle) if (text.has(t)) s += 1;
    if (labelHit && s >= 3) scored.push({ o, s });
  }
  return scored.sort((a, b) => b.s - a.s).slice(0, max).map(({ o }) => o);
}

export async function matchAngles({ store, reader, analytics, companyId = "bcg", windowDays = 7, batchSize = 8, concurrency = 4, minFit = 0.4, rematch = false, log = () => {} }) {
  const last = store.ocrCounts().last;
  if (!last) return { skipped: "no print articles yet" };
  const from = new Date(new Date(last + "T00:00:00").getTime() - windowDays * 864e5), pad = (n) => String(n).padStart(2, "0");
  const fromDay = `${from.getFullYear()}-${pad(from.getMonth() + 1)}-${pad(from.getDate())}`;
  const opps = analytics.opportunities({ company: companyId, limit: 500 }).items ?? [];
  if (!opps.length) return { skipped: "no opportunities to match against" };
  const done = rematch ? new Set() : store.ocrMatchedIds(companyId);
  const todo = store.ocrAuthored({ from: fromDay }).filter((a) => !done.has(a.id));
  const work = [], none = [];
  for (const a of todo) {
    const cands = shortlist(a, opps);
    if (!cands.length) { none.push({ articleId: a.id, oppKey: "-", fit: 0 }); continue; }
    work.push({ id: a.id, headline: a.headline, excerpt: excerpt(a, 700, 250), candidates: cands.map((o, i) => ({ id: "c" + (i + 1), oppKey: o.key, topic: o.label.name, sector: o.sector, angle: o.angle })) });
  }
  const batches = []; for (let i = 0; i < work.length; i += batchSize) batches.push(work.slice(i, i + batchSize));
  const angleOf = new Map(opps.map((o) => [o.key, o.angle]));
  let matched = 0, failed = 0;
  const results = [...none];
  await pool(batches, concurrency, async (b) => {
    try {
      const got = await reader.matchAngles(b, minFit);
      const answered = new Set(got.map((g) => g.id));
      for (const g of got) { results.push({ articleId: g.id, oppKey: g.oppKey, fit: g.fit, angle: angleOf.get(g.oppKey) }); matched++; }
      // an answered batch with no match for an article means "none": remember it so it is not asked again
      for (const a of b) if (!answered.has(a.id)) results.push({ articleId: a.id, oppKey: "-", fit: 0 });
    } catch (e) { failed += b.length; log(`  match batch failed (${e.message})`); }
  });
  if (results.length) store.putOcrMatches(companyId, results);
  analytics.cache?.clear?.();
  return { authored: todo.length, shortlisted: work.length, matched, failed, opportunities: opps.length };
}
