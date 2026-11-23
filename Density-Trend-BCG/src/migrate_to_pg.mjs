// Migrates all existing SQLite data to PostgreSQL
// Usage: node src/migrate_to_pg.mjs
import { DatabaseSync } from "node:sqlite";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getPgPool, initPgSchema } from "./pg.mjs";

async function main() {
  const pool = getPgPool();
  if (!pool) {
    console.error("No PostgreSQL connection configured. Set DATABASE_URL=postgres://user:pass@host:5432/db");
    process.exit(1);
  }

  const client = await pool.connect();
  try {
    console.log("Connecting to PostgreSQL and creating schema...");
    const schemaSqlFile = join(process.cwd(), "deploy", "postgres", "schema.sql");
    if (existsSync(schemaSqlFile)) {
      const sql = readFileSync(schemaSqlFile, "utf8");
      await client.query(sql);
      console.log("Schema created from deploy/postgres/schema.sql");
    } else {
      await initPgSchema(pool);
    }
    console.log("PostgreSQL schema ready.");

    const sqlitePath = join(process.cwd(), "data", "hivemind.db");
    if (!existsSync(sqlitePath)) {
      console.error(`SQLite database not found at ${sqlitePath}`);
      process.exit(1);
    }
    const sdb = new DatabaseSync(sqlitePath, { readOnly: true });

    const q = (s) => `"${s}"`;
    const tables = sdb.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    console.log(`Copying ${tables.length} tables from SQLite to PostgreSQL...\n`);

    let totalRows = 0;
    const t0 = Date.now();

    for (const t of tables) {
      const cols = sdb.prepare(`PRAGMA table_info(${q(t.name)})`).all().map((c) => c.name);
      const n = sdb.prepare(`SELECT COUNT(*) AS n FROM ${q(t.name)}`).get().n;
      if (!n) {
        console.log(`${t.name.padEnd(24)} 0 rows (empty)`);
        continue;
      }
      const per = Math.max(1, Math.min(500, Math.floor(60000 / cols.length)));
      const rows = sdb.prepare(`SELECT ${cols.map(q).join(", ")} FROM ${q(t.name)}`).iterate();
      let batch = [], done = 0;

      const flush = async () => {
        if (!batch.length) return;
        const vals = [], tuples = batch.map((r, i) => `(${cols.map((c, j) => { vals.push(r[c] ?? null); return "$" + (i * cols.length + j + 1); }).join(", ")})`);
        const res = await client.query(`INSERT INTO ${q(t.name)} (${cols.map(q).join(", ")}) VALUES ${tuples.join(", ")} ON CONFLICT DO NOTHING`, vals);
        done += res.rowCount;
        batch = [];
      };

      await client.query("BEGIN");
      try {
        for (const r of rows) {
          batch.push(r);
          if (batch.length >= per) await flush();
        }
        await flush();
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        console.error(`Error migrating table ${t.name}:`, e.message);
      }

      if (/AUTOINCREMENT/i.test(t.sql)) {
        try {
          await client.query(`SELECT setval(pg_get_serial_sequence('${q(t.name)}', 'id'), COALESCE(MAX(id), 1), MAX(id) IS NOT NULL) FROM ${q(t.name)}`);
        } catch {}
      }
      totalRows += done;
      console.log(`${t.name.padEnd(24)} ${String(n).padStart(7)} rows (${done} newly inserted)`);
    }

    console.log(`\n--- MIGRATION TO POSTGRESQL COMPLETE! (${totalRows} total rows migrated in ${((Date.now() - t0)/1000).toFixed(1)}s) ---`);
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1]?.endsWith("migrate_to_pg.mjs")) {
  main().catch(console.error);
}
