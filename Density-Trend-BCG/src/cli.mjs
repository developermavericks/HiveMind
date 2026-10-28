#!/usr/bin/env node
// node src/cli.mjs run   [--date YYYY-MM-DD] [--hours 24] [--per-pub N] [--limit N] [--no-fulltext] [--concurrency 6]
//     poll Google News (the last 24h, or one whole past day with --date) → cluster → read each story (company-agnostic,
//     into keyword brackets) → data/hivemind.db, live. The dashboard's Run button starts this for you.
// node src/cli.mjs serve [--port 8788]
//     dashboard + date picker + company-sector upload + bracket→sector matching, reads the database
// node src/cli.mjs enrich [--limit N] [--concurrency 6]
//     add topic labels / content type / pathways to stories read earlier (one small LLM call each; never re-reads)
// node src/cli.mjs consolidate
//     merge duplicate brackets the model added
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { parseEnv } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchPublication, fetchArticleBody } from "./gnews.mjs";
import { clusterArticles } from "./cluster.mjs";
import { Reader } from "./llm.mjs";
import { BracketRegistry } from "./brackets.mjs";
import { Store, dayStart, DAY_MS } from "./db.mjs";
import { junkMatcher, dedupePass } from "./quality.mjs";
import { entityId } from "./entities.mjs";
import { TopicRegistry } from "./topics.mjs";
import { Integrations } from "./integrations.mjs";
import { detectSystem, machineId } from "./system.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// Node reads NODE_USE_ENV_PROXY only at startup, so a proxy configured in .env would be ignored. If .env asks for it and
// this process wasn't started with it, relaunch once with the .env values in place (NO_PROXY keeps Anthropic calls direct).
{
  const envPath = join(root, ".env");
  if (!process.env.NODE_USE_ENV_PROXY && !process.env.HIVEMIND_REEXEC && existsSync(envPath)) {
    const parsed = parseEnv(readFileSync(envPath, "utf8"));
    if (parsed.NODE_USE_ENV_PROXY) {
      // Only Google News needs the proxy. The APIs below are refused from many proxy exit IPs (Anthropic answers 403 "Request not
      // allowed"), so they are ALWAYS kept direct. The shell may already define its own NO_PROXY, so merge rather than let either win.
      let publishers = []; try { publishers = JSON.parse(readFileSync(join(root, "config", "publications.json"), "utf8")).map((p) => p.domain).filter(Boolean); } catch { /* none */ }
      const direct = ["api.anthropic.com", "api.groq.com", "google.serper.dev", "serpapi.com", "api.twitter.com", "api.x.com", "cloudfunctions.net", "localhost", "127.0.0.1", ...publishers];
      const noProxy = [...new Set([process.env.NO_PROXY, process.env.no_proxy, parsed.NO_PROXY, ...direct].flatMap((v) => String(v ?? "").split(",")).map((h) => h.trim()).filter(Boolean))].join(",");
      const r = spawnSync(process.execPath, process.argv.slice(1), { stdio: "inherit", env: { ...parsed, ...process.env, NODE_USE_ENV_PROXY: parsed.NODE_USE_ENV_PROXY, NO_PROXY: noProxy, no_proxy: noProxy, HIVEMIND_REEXEC: "1" } });
      process.exit(r.status ?? 1);
    }
  }
}
try { process.loadEnvFile?.(join(root, ".env")); } catch (e) { if (e?.code !== "ENOENT") throw e; }
const readJson = (p) => JSON.parse(readFileSync(join(root, p), "utf8"));
const DATA = join(root, "data");
const BRACKETS = join(DATA, "brackets-v3.json");
const loadRegistry = () => new BracketRegistry(BRACKETS, readJson("config/brackets.seed.json"));

function openStore() {
  const store = new Store(join(DATA, "hivemind.db"));
  const imported = store.importLegacy(DATA); // one time: pulls in the earlier readings-v3.json / stories-v3.json
  if (imported) console.log(`Imported earlier data into the database: ${imported.readings} readings, ${imported.stories} stories`);
  return store;
}

// Background jobs obey the same on/off switches, provider order and Ollama fallback as the dashboard, and record
// usage and failures (credit exhaustion included) where the Settings page can show them.
function makeReader(bcg, registry, topics, store) {
  const integrations = new Integrations({ root, store });
  return new Reader(bcg, registry, topics, {
    integrations,
    settings: () => store.getJson(`llm.settings.${machineId()}`, { primary: "anthropic", fallback: true, ollamaModel: null }),
    onEvent: (name, ev) => integrations.recordEvent(name, ev),
    onUsage: (name, u) => store.addUsage(name, u),
    routing: readJson("config/hivemind.json").routing ?? {},
  });
}
// The last line a job prints: the server reads it into the job log (Settings -> Logs).
const stats = (o) => console.log(`STATS ${JSON.stringify(o)}`);
// A local model serves few requests at once; the right number depends on this machine's GPU memory.
async function concurrencyFor(reader, opts) {
  if (+opts.concurrency) return +opts.concurrency;
  return reader.provider === "ollama" ? (await detectSystem()).localConcurrency : 6;
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const k = argv[i].slice(2);
    o[k] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
  }
  return o;
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

// Ask the LLM which brackets are really the same theme and fold them together (old ids stay valid as aliases).
// Seeded (taxonomy) brackets are never merged away, so this only matters once the LLM has added extras.
async function consolidate(reader, registry) {
  if (registry.list().filter((b) => !b.seed).length < 2) return;
  try {
    const merges = await reader.consolidate(registry.list());
    let n = 0;
    for (const m of merges) n += registry.merge(m.keep, m.drop, m.name);
    if (n) { registry.save(); console.log(`  consolidated: merged ${n} duplicate brackets → ${registry.size} remain`); }
  } catch (e) { console.warn(`  consolidation skipped: ${e.message}`); }
}

async function run(opts) {
  const bcg = readJson("config/bcg.json");
  const pubs = readJson("config/publications.json");
  const hours = +opts.hours || 24, perPub = +opts["per-pub"] || Infinity;
  const date = opts.date === undefined ? null : String(opts.date);
  if (date !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)))) throw new Error(`--date must be YYYY-MM-DD, got "${opts.date}"`);
  if (date !== null && dayStart(date) > Date.now()) throw new Error(`--date ${date} is in the future`);
  const registry = loadRegistry();
  const store = openStore();
  const topics = new TopicRegistry(store);
  const reader = makeReader(bcg, registry, topics, store);
  console.log(`LLM: ${await reader.detect()}   (${registry.size} brackets in the taxonomy, ${store.readingCount()} readings already in the database)`);

  console.log(`Polling Google News for ${pubs.length} publications (${date ? `the day ${date}` : `last ${hours}h`})…`);
  const polled = await pool(pubs, 4, async (p) => {
    try { const items = await fetchPublication(p, { hours, perPub, date }); console.log(`  ${p.name.padEnd(26)} ${items.length}`); return items; }
    catch (e) { console.warn(`  ${p.name.padEnd(26)} FAILED: ${e.message}`); return Object.assign([], { available: 0 }); }
  });
  const articles = polled.flat();
  if (!articles.length) throw new Error("No articles retrieved from any publication.");
  let clusters = clusterArticles(articles).sort((a, b) => b.outlets.length - a.outlets.length || b.publishedAt - a.publishedAt);
  // --window HH:MM-HH:MM (with --date) keeps only stories published in that part of the day: used to fill a collection gap without re-reading the whole day.
  if (opts.window) {
    const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(String(opts.window));
    if (!m || date === null) throw new Error('--window needs --date and the form HH:MM-HH:MM, e.g. --date 2026-10-26 --window 03:00-04:00');
    const from = dayStart(date) + (+m[1] * 60 + +m[2]) * 60e3, to = dayStart(date) + (+m[3] * 60 + +m[4]) * 60e3;
    const before = clusters.length;
    clusters = clusters.filter((c) => c.publishedAt >= from && c.publishedAt < to);
    console.log(`  window ${opts.window}: kept ${clusters.length} of ${before} stories published in that period`);
  }
  console.log(`${articles.length} headlines → ${clusters.length} distinct stories`);
  const cfgAll = readJson("config/hivemind.json"), isJunk = junkMatcher(cfgAll), before = clusters.length;
  clusters = clusters.filter((c) => !isJunk(c.title)); // topic landing pages and scoreboards are not news
  if (clusters.length !== before) console.log(`  skipped ${before - clusters.length} template pages (not news)`);
  const useFull = opts.fulltext === true || process.env.HIVEMIND_FULLTEXT === "1"; // default: read headline + snippet only, which keeps model cost down
  if (opts.limit) clusters = clusters.slice(0, +opts.limit);

  // Stories and headlines are stored before reading, so they are already filed under their day.
  const keys = store.upsertClusters(clusters);
  const runId = store.startRun({
    model: reader.label, headlines: articles.length, publications: pubs.length, total: clusters.length, targetDate: date,
    perPublication: pubs.map((p, i) => ({ name: p.name, available: polled[i].available ?? 0, polled: polled[i].length })),
  });

  let fresh = 0, failed = 0, finished = 0, lastFlush = 0, consolidating = null, knownBrackets = registry.size;
  const flush = (final = false) => {
    if (!final && Date.now() - lastFlush < 3000) return;
    lastFlush = Date.now();
    registry.save();
    store.progressRun(runId, finished);
  };

  // A repeat of a story already stored is marked BEFORE reading, so it is never paid for twice.
  let dedupeEarly = { junk: 0, duplicates: 0 };
  try { dedupeEarly = dedupePass(store, cfgAll, { since: Date.now() - 72 * 3600e3 }); } catch (e) { console.warn(`  duplicate check skipped: ${e.message}`); }
  const skipKeys = store.dupeMap();
  const todo = [];
  clusters.forEach((c, i) => { if (!store.hasReading(keys[i]) && !skipKeys.has(keys[i])) todo.push(i); });
  finished = clusters.length - todo.length; // already read, or a repeat/template page that is not read
  if (dedupeEarly.duplicates) console.log(`  ${dedupeEarly.duplicates} repeats of stories already stored will not be read again`);

  // Headlines are read several per call (the shared instructions are sent once, not once per story). A story the model skips, or a
  // failed batch, falls back to a single read. Article text (opt-in) is always read one story at a time.
  // Whole articles are read by the low-cost model when it is set up: the article texts are fetched first; a story with a text is read
  // in full (one per call), the rest are read from their headlines in batches by Claude.
  const wantFull = !opts["no-fulltext"] && (useFull || (cfgAll.reading?.fullText === "groq" && reader.routeFor("readFullText") === "groq"));
  const bodies = new Map();
  if (wantFull) {
    await pool(todo, 8, async (i) => { bodies.set(i, await fetchArticleBody(clusters[i])); });
    console.log(`  article text fetched for ${[...bodies.values()].filter((b) => b.basis === "full-text").length} of ${todo.length} stories`);
  }
  const batchSize = Math.max(1, Math.min(8, +opts.batch || cfgAll.reading?.batchSize || 4));
  const withText = todo.filter((i) => bodies.get(i)?.basis === "full-text"), noText = todo.filter((i) => bodies.get(i)?.basis !== "full-text");
  const groups = withText.map((i) => ({ idx: [i], full: true }));
  for (let g = 0; g < noText.length; g += batchSize) groups.push({ idx: noText.slice(g, g + batchSize), full: false });
  const workers = await concurrencyFor(reader, opts);
  if (workers !== 6) console.log(`Using ${workers} parallel request${workers > 1 ? "s" : ""} (local model)`);
  console.log(`${todo.length} stories to read${batchSize > 1 ? `, ${batchSize} per request` : ""}`);
  await pool(groups, workers, async (g) => {
    const idx = g.idx, group = idx.map((i) => clusters[i]);
    let results = new Array(group.length).fill(null);
    if (!g.full && batchSize > 1 && group.length > 1) { try { results = await reader.readBatch(group); } catch (e) { console.warn(`  batch read failed (${e.message}); reading one by one`); } }
    for (let k = 0; k < group.length; k++) {
      const i = idx[k], c = clusters[i];
      try {
        let full = results[k], body = g.full ? bodies.get(i) : { text: "", basis: "headline" };
        if (!full) full = await reader.readFull(c, body);
        if (full) {
          const { analysis, enrichment } = full;
          if (registry.size !== knownBrackets) { registry.save(); knownBrackets = registry.size; } // a reading never outlives its bracket
          topics.save(); // topic labels are saved before the reading that refers to them
          store.putReading(keys[i], { analysis, basis: body.basis });
          store.putEnrichment(keys[i], { wire: body.wire ?? null, source: "read", ...(enrichment ?? {}) });
          fresh++;
        } else failed++;
      } catch (e) { failed++; console.warn(`  read failed: ${c.title.slice(0, 60)} (${e.message})`); }
      finished++;
      if (finished % 25 === 0) console.log(`  ${finished}/${clusters.length} stories read · ${registry.size} brackets`);
      if (finished % 300 === 0 && !consolidating) { consolidating = consolidate(reader, registry).finally(() => { consolidating = null; }); }
      flush();
    }
  });
  await consolidating;
  await consolidate(reader, registry);
  registry.save();
  topics.save();
  store.pruneOrphans();
  let dedupe = { junk: 0, duplicates: 0 };
  try { dedupe = dedupePass(store, cfgAll, { since: Date.now() - 72 * 3600e3 }); } catch (e) { console.warn(`  duplicate check skipped: ${e.message}`); }
  if (dedupe.duplicates || dedupe.junk) console.log(`  merged ${dedupe.duplicates} repeated stories and excluded ${dedupe.junk} template pages`);
  store.finishRun(runId, finished);
  console.log(`Read ${fresh} new stories (${failed} failed, ${clusters.length - fresh - failed} already in the database) · ${registry.size} brackets`);
  stats({ headlines: articles.length, publications: pubs.length, total: clusters.length, newStories: fresh, failed, existing: clusters.length - fresh - failed, repeatsMerged: dedupe.duplicates + dedupeEarly.duplicates, templatePagesExcluded: dedupe.junk + dedupeEarly.junk, readingMode: wantFull ? "full text where available, else headline" : "headline", fullTextStories: withText.length, brackets: registry.size, window: date ? `day ${date}` : `last ${hours}h`, publicationsFailed: polled.map((p, i) => (p.length ? null : pubs[i].name)).filter(Boolean), perPublication: pubs.map((p, i) => ({ name: p.name, available: polled[i].available ?? 0, polled: polled[i].length })) });
  console.log(`Database: ${store.path} — ${store.days().length} day(s) of history`);
  store.close();
}

// Label stories that were read before topic labels existed (topics, content type, entities, causal pathways).
// It never re-reads a story or changes its impact reading. One small LLM call per story; resumable (labelled stories are skipped).
async function enrich(opts) {
  const bcg = readJson("config/bcg.json");
  const store = openStore();
  const topics = new TopicRegistry(store);
  const reader = makeReader(bcg, loadRegistry(), topics, store);
  console.log(`LLM: ${await reader.detect()}`);
  const todo = store.unenriched(+opts.limit || 1e9);
  console.log(`${todo.length} stories without topic labels (${store.enrichmentCount()} already labelled, ${topics.size} topics known)`);
  let done = 0, failed = 0, pending = todo;
  const cfgB = readJson("config/hivemind.json").batchApi ?? {};
  if (!opts.live && reader.chain.includes("anthropic") && todo.length >= (cfgB.minItems ?? 150)) {
    // A backlog is not urgent: the batch service costs about half as much and returns within hours.
    try {
      console.log(`Using the batch service for ${todo.length} stories (about half price; results usually within an hour)`);
      for (let i = 0; i < todo.length; i += 1500) {
        const chunk = todo.slice(i, i + 1500);
        const res = await reader.enrichViaBatchApi(chunk, { pollMs: (cfgB.pollSeconds ?? 20) * 1000, maxWaitMs: (cfgB.maxWaitMinutes ?? 180) * 60e3 });
        chunk.forEach((s, k) => { if (res[k]) { topics.save(); store.putEnrichment(s.key, { ...res[k], source: "enrich" }); done++; } });
      }
      pending = store.unenriched(+opts.limit || 1e9); // anything the batch did not return is labelled with live calls
    } catch (err) { console.warn(`  batch service unavailable (${err.message}); using live calls`); pending = store.unenriched(+opts.limit || 1e9); }
  }
  await pool(pending, await concurrencyFor(reader, opts), async (s) => {
    try {
      const e = await reader.enrich(s);
      if (e) { topics.save(); store.putEnrichment(s.key, { ...e, source: "enrich" }); done++; } else failed++;
    } catch (err) { failed++; if (failed <= 5) console.warn(`  enrich failed: ${s.title.slice(0, 60)} (${err.message})`); }
    if ((done + failed) % 50 === 0) console.log(`  ${done + failed}/${todo.length} labelled · ${topics.size} topics`);
  });
  topics.save();
  console.log(`Labelled ${done} stories (${failed} failed) · ${topics.size} topics`);
  stats({ labelled: done, failed, topics: topics.size });
  store.close();
}

// Sentiment and stance for stories read earlier. Batched (many stories per call), newest first, resumable.
async function sentiment(opts) {
  const bcg = readJson("config/bcg.json"), cfg = readJson("config/hivemind.json");
  const store = openStore();
  const reader = makeReader(bcg, loadRegistry(), null, store);
  console.log(`LLM: ${await reader.detect()}`);
  const size = Math.max(1, Math.min(20, +opts.batch || cfg.sentiment?.batchSize || 12));
  const todo = store.unsentimented(+opts.limit || 1e9);
  console.log(`${todo.length} stories without sentiment (${store.sentimentCount()} already labelled), ${size} per request`);
  let batches = []; for (let i = 0; i < todo.length; i += size) batches.push(todo.slice(i, i + size));
  let done = 0, failed = 0, finished = 0;
  const cfgB = cfg.batchApi ?? {};
  if (!opts.live && reader.chain.includes("anthropic") && todo.length >= (cfgB.minItems ?? 150)) {
    try {
      console.log(`Using the batch service for ${todo.length} stories (about half price; results usually within an hour)`);
      for (let i = 0; i < batches.length; i += 1500) {
        const chunk = batches.slice(i, i + 1500);
        const res = await reader.sentimentsViaBatchApi(chunk, { pollMs: (cfgB.pollSeconds ?? 20) * 1000, maxWaitMs: (cfgB.maxWaitMinutes ?? 180) * 60e3 });
        res.forEach((got) => { if (got?.length) { store.putSentiments(got); done += got.length; } });
      }
      const left = store.unsentimented(+opts.limit || 1e9); // anything the batch did not return is labelled with live calls
      batches = []; for (let i = 0; i < left.length; i += size) batches.push(left.slice(i, i + size));
    } catch (err) { console.warn(`  batch service unavailable (${err.message}); using live calls`); }
  }
  await pool(batches, await concurrencyFor(reader, { concurrency: opts.concurrency || 4 }), async (batch) => {
    try {
      const got = await reader.sentiments(batch);
      store.putSentiments(got); done += got.length; failed += batch.length - got.length;
    } catch (err) { failed += batch.length; if (failed <= 3 * size) console.warn(`  sentiment batch failed (${err.message})`); }
    finished += batch.length;
    if (Math.floor(finished / 120) !== Math.floor((finished - batch.length) / 120)) console.log(`  ${finished}/${todo.length} stories processed`);
  });
  console.log(`Labelled sentiment for ${done} stories (${failed} failed)`);
  stats({ sentiment: done, failed, batches: batches.length });
  store.close();
}

// Merge topics that name the same subject. Within each broad bracket first (small, focused lists), then across the biggest topics.
async function topicsMerge(opts) {
  const bcg = readJson("config/bcg.json");
  const store = openStore();
  const topics = new TopicRegistry(store);
  const reader = makeReader(bcg, loadRegistry(), topics, store);
  console.log(`LLM: ${await reader.detect()}`);
  const live = () => store.loadTopics().filter((t) => t.count > 0);
  const before = live().length;
  let merged = 0, calls = 0;
  const proposals = []; // { keep, drop, name } from the grouping step; applied only after a second, strict review
  const collect = (ms) => { for (const m of ms) for (const d of m.drop) proposals.push({ keep: m.keep, drop: d, name: m.name }); };
  const groups = new Map();
  for (const t of live()) (groups.get(t.bracket ?? "-") ?? groups.set(t.bracket ?? "-", []).get(t.bracket ?? "-")).push(t);
  const jobs = [];
  for (const [, list] of groups) { list.sort((a, b) => a.name.localeCompare(b.name)); for (let i = 0; i < list.length; i += 150) if (list.length - i >= 2) jobs.push(list.slice(i, i + 150)); }
  console.log(`${before} topics in ${groups.size} groups → ${jobs.length} requests (within broad areas), then one across the biggest`);
  await pool(jobs, 3, async (pool_) => { try { calls++; collect(await reader.mergeTopics(pool_)); } catch (e) { console.warn(`  merge request failed (${e.message})`); } });
  try { calls++; collect(await reader.mergeTopics(live().sort((a, b) => b.count - a.count).slice(0, 200).sort((a, b) => a.name.localeCompare(b.name)))); } catch (e) { console.warn(`  cross-area merge failed (${e.message})`); }
  // Second opinion: only pairs a strict reviewer also calls interchangeable are merged.
  const nameOf = new Map(store.loadTopics().map((t) => [t.id, t.name]));
  const toCheck = proposals.filter((p) => nameOf.has(p.keep) && nameOf.has(p.drop));
  let accepted = 0;
  const chunks = []; for (let i = 0; i < toCheck.length; i += 60) chunks.push(toCheck.slice(i, i + 60));
  await pool(chunks, 3, async (chunk) => {
    try {
      calls++;
      const ok = await reader.verifyMerges(chunk.map((p) => ({ a: nameOf.get(p.drop), b: nameOf.get(p.keep) })));
      chunk.forEach((p, i) => { if (ok.has(i + 1)) { merged += store.mergeTopics(p.keep, p.drop, { name: p.name }); accepted++; } });
    } catch (e) { console.warn(`  review failed, nothing merged from this batch (${e.message})`); }
  });
  console.log(`${proposals.length} merges proposed, ${accepted} confirmed by the second review`);
  const after = live().length;
  store.setMeta("topics.afterLastMerge", String(after)); // the server starts another pass only after enough new topics appear
  console.log(`Merged ${merged} duplicate topics → ${after} remain (was ${before}); old names kept as aliases, nothing deleted`);
  stats({ merged, proposed: proposals.length, before, after, requests: calls });
  store.close();
}

// A second attempt at articles that were only read from the headline: fetch the text directly, then read the story once more.
// The earlier reading is kept (reading_versions) and topic labels are left as they were.
async function fulltext(opts) {
  const bcg = readJson("config/bcg.json"), cfg = readJson("config/hivemind.json"), ft = cfg.fulltext ?? {};
  const registry = loadRegistry(), store = openStore();
  const topics = new TopicRegistry(store);
  const reader = makeReader(bcg, registry, topics, store);
  console.log(`LLM: ${await reader.detect()}`);
  const day = new Date(), today = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
  const left = Math.max(0, (ft.dailyRetries ?? 400) - store.usage("fulltext", today).calls);
  const limit = Math.min(+opts.limit || ft.perPass || 120, left);
  const todo = limit > 0 ? store.fulltextCandidates({ limit, maxTries: ft.maxTries ?? 2, retryAfterMs: (ft.retryAfterHours ?? 12) * 3600e3 }) : [];
  console.log(`${store.headlineOnlyCount()} stories were read from the headline only; trying ${todo.length} now (daily allowance left: ${left})`);
  let upgraded = 0, blocked = 0, failed = 0;
  await pool(todo, 4, async (s) => {
    store.addUsage("fulltext", { calls: 1 });
    try {
      const body = await fetchArticleBody({ url: s.url });
      if (body.basis !== "full-text") { blocked++; store.noteFulltextTry(s.key, body.error ? "fetch-error" : "short-or-blocked"); return; }
      const arts = store.articlesOf(s.key);
      const cluster = { title: s.title, url: s.url, snippet: s.snippet, outlets: [...new Set(arts.map((a) => a.outlet))], articles: arts };
      const full = await reader.readFull(cluster, body, { skipTopics: true }); // topic labels stay as first assigned (consistent with the registry)
      if (!full) { failed++; store.noteFulltextTry(s.key, "read-failed"); return; }
      registry.save(); topics.save();
      store.upgradeReading(s.key, { analysis: full.analysis, basis: "full-text" });
      store.putEnrichment(s.key, { wire: body.wire ?? null, ...(full.enrichment ?? {}), topics: null, source: "fulltext" });
      store.noteFulltextTry(s.key, "upgraded"); upgraded++;
    } catch (e) { failed++; store.noteFulltextTry(s.key, "error"); }
  });
  console.log(`Upgraded ${upgraded} stories to full text (${blocked} paywalled or too short, ${failed} failed)`);
  stats({ upgraded, blocked, failed, tried: todo.length, remainingHeadlineOnly: store.headlineOnlyCount() });
  store.close();
}

// Merge entity names that are the same organisation, person or place (e.g. "Tata Motors Ltd" / "TML"). Aliases are stored, nothing is rewritten.
async function entitiesMerge() {
  const bcg = readJson("config/bcg.json");
  const store = openStore();
  const reader = makeReader(bcg, loadRegistry(), null, store);
  console.log(`LLM: ${await reader.detect()}`);
  const aliases = store.entityAliases(), counts = new Map();
  for (const s of store.loadStories({ from: Date.now() - 15 * DAY_MS, to: Date.now() + 1 })) {
    const seen = new Set();
    for (const raw of s.meta?.entities ?? []) {
      const id = entityId(raw, aliases);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const e = counts.get(id) ?? counts.set(id, { id, count: 0, names: new Map() }).get(id);
      e.count++; e.names.set(raw, (e.names.get(raw) || 0) + 1);
    }
  }
  const pool = [...counts.values()].filter((e) => e.count >= 3).map((e) => ({ id: e.id, name: [...e.names.entries()].sort((a, b) => b[1] - a[1])[0][0], count: e.count })).sort((a, b) => b.count - a.count).slice(0, 450);
  const chunks = []; const sorted = [...pool].sort((a, b) => a.name.localeCompare(b.name)); for (let i = 0; i < sorted.length; i += 150) chunks.push(sorted.slice(i, i + 150));
  console.log(`${pool.length} entities in ${chunks.length} requests`);
  const proposals = [];
  await pool_(chunks, 3, async (c) => { try { for (const m of await reader.mergeEntities(c)) for (const d of m.drop) proposals.push({ keep: m.keep, drop: d }); } catch (e) { console.warn(`  grouping failed (${e.message})`); } });
  const nameOf = new Map(pool.map((e) => [e.id, e.name]));
  const checks = []; for (let i = 0; i < proposals.length; i += 60) checks.push(proposals.slice(i, i + 60));
  let accepted = 0;
  await pool_(checks, 3, async (chunk) => {
    try { const ok = await reader.verifyMerges(chunk.map((p) => ({ a: nameOf.get(p.drop), b: nameOf.get(p.keep) }))); chunk.forEach((p, i) => { if (ok.has(i + 1)) { store.putEntityAlias(p.drop, p.keep); accepted++; } }); }
    catch (e) { console.warn(`  review failed (${e.message})`); }
  });
  store.setMeta("entities.afterLastMerge", String(pool.length)); store.setMeta("entities.lastMergeAt", String(Date.now()));
  console.log(`Merged ${accepted} duplicate entity names (${proposals.length} proposed); nothing deleted`);
  stats({ merged: accepted, proposed: proposals.length, entities: pool.length });
  store.close();
}
const pool_ = pool;

const [cmd = "run", ...rest] = process.argv.slice(2);
const opts = parseArgs(rest);
try {
  if (cmd === "run") await run(opts);
  else if (cmd === "enrich") await enrich(opts);
  else if (cmd === "sentiment") await sentiment(opts);
  else if (cmd === "topics-merge") await topicsMerge(opts);
  else if (cmd === "fulltext") await fulltext(opts);
  else if (cmd === "entities-merge") await entitiesMerge();
  else if (cmd === "consolidate") {
    const registry = loadRegistry(), reader = new Reader(readJson("config/bcg.json"), registry);
    console.log(`LLM: ${await reader.detect()}   (${registry.size} brackets)`);
    await consolidate(reader, registry);
  }
  else if (cmd === "serve") {
    const { serve } = await import("./server.mjs");
    const scheduleMinutes = +opts.schedule || +process.env.HIVEMIND_SCHEDULE_MINUTES || null; // e.g. 60 = collect hourly while the server runs
    await serve({ root, bcg: readJson("config/bcg.json"), port: +opts.port || 8788, scheduleMinutes });
  }
  else { console.error("usage: run | enrich | sentiment | topics-merge | fulltext | consolidate | serve"); process.exit(2); }
} catch (e) { console.error(`Error: ${e.message}`); process.exit(1); }
