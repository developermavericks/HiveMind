// Copies the whole SQLite database into PostgreSQL and checks the copy.
//
//   cd deploy/postgres && npm install            (once: installs the "pg" driver here; the application itself still has no dependencies)
//   DATABASE_URL=postgres://user:pass@host:5432/hivemind node migrate-sqlite-to-postgres.mjs [--sqlite ../../data/hivemind.db] [--truncate]
//
// Run schema.sql on the target first. The copy is safe to repeat: rows that already exist are left alone (--truncate empties the tables first).
// It reads the SQLite file read-only, so it can run while the application is running; for a final cut-over stop the application first so
// nothing is written between the copy and the switch.
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name, dflt) => { const i = process.argv.indexOf("--" + name); return i < 0 ? dflt : process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : true; };
const sqlitePath = arg("sqlite", join(here, "..", "..", "data", "hivemind.db")), truncate = !!arg("truncate", false);
if (!process.env.DATABASE_URL) { console.error("Set DATABASE_URL, for example postgres://postgres:pw@localhost:5432/hivemind"); process.exit(2); }

const lite = new DatabaseSync(sqlitePath, { readOnly: true });
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const q = (s) => `"${s}"`;
const tables = lite.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
const have = new Set((await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'")).rows.map((r) => r.table_name));
const missing = tables.filter((t) => !have.has(t.name)).map((t) => t.name);
if (missing.length) { console.error("Run schema.sql first: these tables are missing in PostgreSQL: " + missing.join(", ")); process.exit(2); }

console.log(`Copying ${tables.length} tables from ${sqlitePath}${truncate ? " (emptying the PostgreSQL tables first)" : ""}\n`);
if (truncate) await client.query(`TRUNCATE ${tables.map((t) => q(t.name)).join(", ")} RESTART IDENTITY`);
let copiedRows = 0; const t0 = Date.now();
for (const t of tables) {
  const cols = lite.prepare(`PRAGMA table_info(${q(t.name)})`).all().map((c) => c.name), n = lite.prepare(`SELECT COUNT(*) AS n FROM ${q(t.name)}`).get().n;
  if (!n) { console.log(`${t.name.padEnd(20)} 0 rows`); continue; }
  const per = Math.max(1, Math.min(500, Math.floor(60000 / cols.length))); // PostgreSQL allows 65,535 parameters in one statement
  const rows = lite.prepare(`SELECT ${cols.map(q).join(", ")} FROM ${q(t.name)}`).iterate();
  let batch = [], done = 0;
  const flush = async () => {
    if (!batch.length) return;
    const vals = [], tuples = batch.map((r, i) => `(${cols.map((c, j) => { vals.push(r[c] ?? null); return "$" + (i * cols.length + j + 1); }).join(", ")})`);
    const res = await client.query(`INSERT INTO ${q(t.name)} (${cols.map(q).join(", ")}) VALUES ${tuples.join(", ")} ON CONFLICT DO NOTHING`, vals);
    done += res.rowCount; batch = [];
  };
  await client.query("BEGIN");
  try { for (const r of rows) { batch.push(r); if (batch.length >= per) await flush(); } await flush(); await client.query("COMMIT"); }
  catch (e) { await client.query("ROLLBACK"); throw new Error(`${t.name}: ${e.message}`); }
  if (/AUTOINCREMENT/i.test(t.sql)) await client.query(`SELECT setval(pg_get_serial_sequence('${q(t.name)}', 'id'), COALESCE(MAX(id), 1), MAX(id) IS NOT NULL) FROM ${q(t.name)}`);
  copiedRows += done;
  console.log(`${t.name.padEnd(20)} ${String(n).padStart(6)} rows${done !== n ? `, ${done} new (the rest were already there)` : ""}${/AUTOINCREMENT/i.test(t.sql) ? ", id counter reset" : ""}`);
}
await client.query("ANALYZE");
console.log(`\nCopied ${copiedRows} rows in ${((Date.now() - t0) / 1000).toFixed(1)} s. Checking the copy...\n`);

// 1. every table has the same number of rows; 2. a fingerprint of the content matches for the big tables
let bad = 0;
for (const t of tables) {
  const a = lite.prepare(`SELECT COUNT(*) AS n FROM ${q(t.name)}`).get().n, b = Number((await client.query(`SELECT COUNT(*) AS n FROM ${q(t.name)}`)).rows[0].n);
  if (a !== b) { bad++; console.log(`  MISMATCH ${t.name}: SQLite ${a}, PostgreSQL ${b}`); }
}
const prints = [["stories", "key", "title || '|' || published_at"], ["readings", "key", "basis || '|' || length(analysis) || '|' || read_at"], ["ocr_articles", "id", "headline || '|' || length(body) || '|' || COALESCE(kind, '')"], ["articles", "url", "story_key || '|' || title"]];
for (const [tbl, key, expr] of prints) {
  const fp = (rows) => createHash("sha1").update(rows.join("\n")).digest("hex").slice(0, 12);
  const a = lite.prepare(`SELECT ${expr} AS v FROM ${q(tbl)} ORDER BY ${key}`).all().map((r) => r.v);
  const b = (await client.query(`SELECT ${expr} AS v FROM ${q(tbl)} ORDER BY ${key} COLLATE "C"`)).rows.map((r) => r.v);
  const ok = fp(a) === fp(b); if (!ok) bad++;
  console.log(`  content fingerprint ${tbl.padEnd(14)} SQLite ${fp(a)}  PostgreSQL ${fp(b)}  ${ok ? "same" : "DIFFERENT"}`);
}
console.log(bad ? `\n${bad} check(s) FAILED: do not switch over.` : "\nAll checks passed: every table has the same row count and the large tables have identical content.");
await client.end(); process.exit(bad ? 1 : 0);
