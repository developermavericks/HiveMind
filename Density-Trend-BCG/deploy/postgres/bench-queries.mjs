// Does PostgreSQL load the dashboard's data faster than SQLite? Runs the same queries on both (median of several runs).
//   DATABASE_URL=postgres://... node bench-queries.mjs [--sqlite ../../data/hivemind.db]
// Note: PostgreSQL here is reached over the network (a container on this machine), SQLite is read from a local file inside the process.
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const i = process.argv.indexOf("--sqlite"), sqlitePath = i > 0 ? process.argv[i + 1] : join(here, "..", "..", "data", "hivemind.db");
const lite = new DatabaseSync(sqlitePath, { readOnly: true }), client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const asOf = lite.prepare("SELECT MAX(published_at) AS m FROM stories").get().m, from = asOf - 35 * 864e5, to = asOf + 1;
const RUNS = 7;
async function bench(label, sqliteFn, pgFn) {
  const a = [], b = []; let na, nb;
  for (let k = 0; k < RUNS + 1; k++) { // the first run warms caches and is dropped
    let t = performance.now(); na = sqliteFn(); const ta = performance.now() - t;
    t = performance.now(); nb = await pgFn(); const tb = performance.now() - t;
    if (k) { a.push(ta); b.push(tb); }
  }
  console.log(`${label.padEnd(46)} SQLite ${String(Math.round(med(a))).padStart(5)} ms (${na} rows)   PostgreSQL ${String(Math.round(med(b))).padStart(5)} ms (${nb} rows)`);
}
const STORIES = `SELECT s.key, s.title, s.url, s.snippet, s.published_at, s.first_seen, r.basis, r.analysis, r.read_at, e.enriched_at, e.wire, e.content_type, e.entities, e.topics, e.pathways, e.sentiment, e.stance
  FROM stories s LEFT JOIN readings r ON r.key = s.key LEFT JOIN enrichments e ON e.key = s.key WHERE s.published_at >= %1 AND s.published_at < %2 ORDER BY s.published_at`;
const ARTS = `SELECT story_key, title, outlet, publication, url FROM articles WHERE story_key IN (SELECT key FROM stories WHERE published_at >= %1 AND published_at < %2)`;
const sub = (sql, n) => (n === "pg" ? sql.replace("%1", "$1").replace("%2", "$2") : sql.replace("%1", "?").replace("%2", "?"));

console.log(`35 days of data ending ${new Date(asOf).toISOString().slice(0, 10)}; ${RUNS} runs each, median\n`);
await bench("stories + readings + enrichments (35 days)", () => lite.prepare(sub(STORIES, "sqlite")).all(from, to).length, async () => (await client.query(sub(STORIES, "pg"), [from, to])).rows.length);
await bench("articles of those stories", () => lite.prepare(sub(ARTS, "sqlite")).all(from, to).length, async () => (await client.query(sub(ARTS, "pg"), [from, to])).rows.length);
await bench("both together (what loadStories reads)", () => lite.prepare(sub(STORIES, "sqlite")).all(from, to).length + lite.prepare(sub(ARTS, "sqlite")).all(from, to).length, async () => (await client.query(sub(STORIES, "pg"), [from, to])).rows.length + (await client.query(sub(ARTS, "pg"), [from, to])).rows.length);
await bench("authored articles, first page of 25", () => lite.prepare("SELECT id, headline, author, kind, substr(body, 1, 900) AS excerpt FROM ocr_articles WHERE kind IN ('opinion','analysis') ORDER BY edition_date DESC, source, page LIMIT 25").all().length, async () => (await client.query("SELECT id, headline, author, kind, substr(body, 1, 900) AS excerpt FROM ocr_articles WHERE kind IN ('opinion','analysis') ORDER BY edition_date DESC, source, page LIMIT 25")).rows.length);
await bench("one small lookup (story count)", () => lite.prepare("SELECT COUNT(*) AS n FROM stories").get().n, async () => Number((await client.query("SELECT COUNT(*) AS n FROM stories")).rows[0].n));
await bench("100 point lookups by key (one at a time)", () => { const ks = lite.prepare("SELECT key FROM stories LIMIT 100").all(); let n = 0; for (const k of ks) n += lite.prepare("SELECT title FROM stories WHERE key = ?").all(k.key).length; return n; },
  async () => { const ks = (await client.query("SELECT key FROM stories LIMIT 100")).rows; let n = 0; for (const k of ks) n += (await client.query("SELECT title FROM stories WHERE key = $1", [k.key])).rows.length; return n; });
await client.end();
