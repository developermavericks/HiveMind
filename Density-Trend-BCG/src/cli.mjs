#!/usr/bin/env node
// node src/cli.mjs run   [--hours 24] [--per-pub N] [--limit N] [--no-fulltext] [--concurrency 6]
//     poll Google News → cluster → read each story (company-agnostic, into keyword brackets) → data/*.json, live
// node src/cli.mjs serve [--port 8788]
//     dashboard + company-sector upload + bracket→sector matching, reads what `run` writes
import { readFileSync, existsSync } from "node:fs";
import { writeFileAtomic } from "./atomic.mjs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchPublication, fetchArticleBody } from "./gnews.mjs";
import { clusterArticles } from "./cluster.mjs";
import { Reader } from "./llm.mjs";
import { BracketRegistry } from "./brackets.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (p) => JSON.parse(readFileSync(join(root, p), "utf8"));
const CACHE = join(root, "data", "readings-v3.json");
const STORIES = join(root, "data", "stories-v3.json");
const BRACKETS = join(root, "data", "brackets-v3.json");
const loadRegistry = () => new BracketRegistry(BRACKETS, readJson("config/brackets.seed.json"));

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

const key = (title) => createHash("sha1").update(title.toLowerCase().replace(/\W+/g, " ").trim()).digest("hex").slice(0, 16);
const writeAtomic = writeFileAtomic;

async function run(opts) {
  const bcg = readJson("config/bcg.json");
  const pubs = readJson("config/publications.json");
  const hours = +opts.hours || 24, perPub = +opts["per-pub"] || Infinity;
  const registry = loadRegistry();
  const reader = new Reader(bcg, registry);
  console.log(`LLM: ${await reader.detect()}   (${registry.size} brackets in the taxonomy)`);

  console.log(`Polling Google News for ${pubs.length} publications (last ${hours}h)…`);
  const polled = await pool(pubs, 4, async (p) => {
    try { const items = await fetchPublication(p, { hours, perPub }); console.log(`  ${p.name.padEnd(26)} ${items.length}`); return items; }
    catch (e) { console.warn(`  ${p.name.padEnd(26)} FAILED: ${e.message}`); return Object.assign([], { available: 0 }); }
  });
  const articles = polled.flat();
  if (!articles.length) throw new Error("No articles retrieved from any publication.");
  let clusters = clusterArticles(articles).sort((a, b) => b.outlets.length - a.outlets.length || b.publishedAt - a.publishedAt);
  console.log(`${articles.length} headlines → ${clusters.length} distinct stories`);
  if (opts.limit) clusters = clusters.slice(0, +opts.limit);

  const cache = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, "utf8")) : {};
  const meta = {
    perPublication: pubs.map((p, i) => ({ name: p.name, available: polled[i].available ?? 0, polled: polled[i].length })),
    articles: articles.length, publications: pubs.length, model: reader.label, generatedAt: Date.now(),
  };
  const done = new Array(clusters.length).fill(null);
  let fresh = 0, failed = 0, finished = 0, lastFlush = 0, consolidating = null;

  // Everything the dashboard reads is rewritten as stories complete, so it fills in live.
  const flush = (final = false) => {
    if (!final && Date.now() - lastFlush < 3000) return;
    lastFlush = Date.now();
    writeAtomic(CACHE, JSON.stringify(cache));
    registry.save();
    writeAtomic(STORIES, JSON.stringify({ meta: { ...meta, live: final ? null : { done: finished, total: clusters.length } }, stories: done.filter(Boolean) }));
  };

  await pool(clusters, +opts.concurrency || 6, async (c, i) => {
    const k = key(c.title);
    if (!cache[k]) {
      try {
        const body = opts["no-fulltext"] ? { text: "", basis: "headline" } : await fetchArticleBody(c);
        const analysis = await reader.read(c, body);
        if (analysis) { cache[k] = { analysis, basis: body.basis, readAt: Date.now() }; fresh++; } else failed++;
      } catch (e) { failed++; console.warn(`  read failed: ${c.title.slice(0, 60)} (${e.message})`); }
    }
    done[i] = { ...c, analysis: cache[k]?.analysis ?? null, basis: cache[k]?.basis ?? "headline" };
    finished++;
    if (finished % 25 === 0) console.log(`  ${finished}/${clusters.length} stories read · ${registry.size} brackets`);
    if (finished % 300 === 0 && !consolidating) { consolidating = consolidate(reader, registry).finally(() => { consolidating = null; }); }
    flush();
  });
  await consolidating;
  await consolidate(reader, registry);
  flush(true);
  console.log(`Read ${fresh} new stories (${failed} failed, ${clusters.length - fresh - failed} from cache) · ${registry.size} brackets`);
}

const [cmd = "run", ...rest] = process.argv.slice(2);
const opts = parseArgs(rest);
try {
  if (cmd === "run") await run(opts);
  else if (cmd === "consolidate") {
    const registry = loadRegistry(), reader = new Reader(readJson("config/bcg.json"), registry);
    console.log(`LLM: ${await reader.detect()}   (${registry.size} brackets)`);
    await consolidate(reader, registry);
  }
  else if (cmd === "serve") { const { serve } = await import("./server.mjs"); await serve({ root, bcg: readJson("config/bcg.json"), port: +opts.port || 8788 }); }
  else { console.error("usage: run | consolidate | serve"); process.exit(2); }
} catch (e) { console.error(`Error: ${e.message}`); process.exit(1); }
