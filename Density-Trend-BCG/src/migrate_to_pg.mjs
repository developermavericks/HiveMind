// Copies the whole SQLite database into PostgreSQL, once, before the app is switched to PostgreSQL.
//
//   DATABASE_URL=postgres://user:pass@host:5432/hivemind node src/migrate_to_pg.mjs [path/to/hivemind.db] [--replace]
//
// 1. The schema is created by the app's own Store (src/db.mjs through src/pgsync.mjs), so PostgreSQL has exactly the
//    tables, columns and indexes the app uses, including the hidden rowid column.
// 2. Every table is copied in its original row order, in batches, inside one transaction per table.
//    A table that already has rows is refused unless --replace is given (then it is emptied first).
// 3. Id counters are moved past the copied ids, and every table's row count is compared with SQLite.
// Any error stops the script with a non-zero exit code: nothing is silently skipped.
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { Store } from "./db.mjs";
import { createAuth } from "./auth.mjs";

pg.types.setTypeParser(20, (v) => Number(v));
const q = (s) => `"${s}"`;

async function main() {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) throw new Error("Set DATABASE_URL=postgres://user:pass@host:5432/hivemind");
  const args = process.argv.slice(2), replace = args.includes("--replace");
  const sqlitePath = args.find((a) => !a.startsWith("--")) || join(process.cwd(), "data", "hivemind.db");
  if (!existsSync(sqlitePath)) throw new Error(`SQLite database not found at ${sqlitePath}`);
  const schema = process.env.HIVEMIND_PG_SCHEMA || "public";

  console.log(`Source: ${sqlitePath}\nTarget: PostgreSQL, schema "${schema}"\n`);
  // 1. schema, exactly as the app creates it
  const store = new Store(sqlitePath);
  if (!store.isPg) throw new Error("Store did not open PostgreSQL (is HIVEMIND_DB=sqlite set?)");
  createAuth({ store, root: process.cwd() }).stop(); // the sign-in tables (users, sessions, logs, tickets) are created by auth.mjs
  store.getView("migrate-check", "-");             // the saved-views table is created on first use
  store.close();

  const sdb = new DatabaseSync(sqlitePath, { readOnly: true });
  const client = new pg.Client({ connectionString: url, application_name: "hivemind-migrate" });
  await client.connect();
  await client.query(`SET search_path TO "${schema}"`);
  const t0 = Date.now(), report = [];
  try {
    const tables = sdb.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    for (const t of tables) {
      const pgCols = (await client.query("SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2", [schema, t.name])).rows.map((r) => r.column_name);
      if (!pgCols.length) { report.push([t.name, "skipped: not used by the app"]); console.log(`${t.name.padEnd(24)} skipped (table not used by the app)`); continue; }
      const cols = sdb.prepare(`PRAGMA table_info(${q(t.name)})`).all().map((c) => c.name).filter((c) => pgCols.includes(c) && c !== "rowid");
      const n = sdb.prepare(`SELECT COUNT(*) AS n FROM ${q(t.name)}`).get().n;
      const existing = (await client.query(`SELECT COUNT(*) AS n FROM ${q(t.name)}`)).rows[0].n;
      if (existing && !replace) throw new Error(`${t.name} already has ${existing} rows in PostgreSQL. Run again with --replace to empty it first.`);
      await client.query("BEGIN");
      if (existing) await client.query(`TRUNCATE ${q(t.name)}`);
      const per = Math.max(1, Math.min(500, Math.floor(30000 / Math.max(1, cols.length))));
      let batch = [], copied = 0;
      const flush = async () => {
        if (!batch.length) return;
        const vals = [], tuples = batch.map((r, i) => `(${cols.map((c, j) => { vals.push(r[c] ?? null); return "$" + (i * cols.length + j + 1); }).join(", ")})`);
        // identity id columns are copied as they are (OVERRIDING SYSTEM VALUE keeps the same ids)
        const res = await client.query(`INSERT INTO ${q(t.name)} (${cols.map(q).join(", ")}) OVERRIDING SYSTEM VALUE VALUES ${tuples.join(", ")}`, vals);
        copied += res.rowCount;
        batch = [];
      };
      try {
        for (const r of sdb.prepare(`SELECT ${cols.map(q).join(", ")} FROM ${q(t.name)} ORDER BY rowid`).iterate()) {
          batch.push(r);
          if (batch.length >= per) await flush();
        }
        await flush();
        if (pgCols.includes("id") && /AUTOINCREMENT/i.test(t.sql)) {
          await client.query(`SELECT setval(pg_get_serial_sequence('${q(schema)}.${q(t.name)}', 'id'), GREATEST(COALESCE(MAX(id), 0), 1), MAX(id) IS NOT NULL) FROM ${q(t.name)}`);
        }
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw new Error(`${t.name}: ${e.message}`);
      }
      const after = (await client.query(`SELECT COUNT(*) AS n FROM ${q(t.name)}`)).rows[0].n;
      const ok = after === n;
      report.push([t.name, `${n} -> ${after}${ok ? "" : "  MISMATCH"}`]);
      console.log(`${t.name.padEnd(24)} ${String(n).padStart(8)} rows copied${ok ? "" : `  MISMATCH: PostgreSQL has ${after}`}`);
      if (!ok) throw new Error(`row count mismatch in ${t.name}`);
    }
    console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)} s. All row counts match.`);
  } finally {
    await client.end();
    sdb.close();
  }
}

main().catch((e) => { console.error(`\nMIGRATION FAILED: ${e.message}`); process.exit(1); });
