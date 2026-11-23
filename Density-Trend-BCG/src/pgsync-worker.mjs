// Background thread for src/pgsync.mjs: holds the one PostgreSQL connection and runs each query the main thread sends.
// The main thread waits on a shared flag (Atomics.wait) until the answer is posted back, which makes every query synchronous.
import { workerData } from "node:worker_threads";
import pg from "pg";

const { url, schema, port, signal } = workerData;
const DEBUG = process.env.HIVEMIND_PG_DEBUG === "1";
const dbg = (...a) => { if (DEBUG) process.stderr.write("[pg-worker] " + a.join(" ") + "\n"); };
dbg("started");
const flag = new Int32Array(signal);
const done = (msg) => { port.postMessage(msg); Atomics.store(flag, 0, 1); Atomics.notify(flag, 0); };

// SQLite hands back plain JavaScript numbers; do the same for PostgreSQL's 64-bit integers and numerics
// (millisecond timestamps and counts fit well within Number's safe range).
pg.types.setTypeParser(20, (v) => Number(v));   // int8 / bigint
pg.types.setTypeParser(1700, (v) => Number(v)); // numeric (SUM, AVG of bigint)

const client = new pg.Client({ connectionString: url, application_name: "hivemind" });
let ready = null;

async function connect() {
  dbg("connecting"); await client.connect(); dbg("connected");
  if (schema && schema !== "public") await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
  await client.query(`SET search_path TO "${schema || "public"}"`);
  // A read-only stand-in for SQLite's catalogue table, so code that asks "does this table exist?" keeps working.
  await client.query(`CREATE OR REPLACE VIEW sqlite_master AS
    SELECT 'table'::text AS type, c.relname::text AS name, c.relname::text AS tbl_name, NULL::text AS sql
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = current_schema() AND c.relkind = 'r'
    UNION ALL
    SELECT 'index'::text, ic.relname::text, tc.relname::text, NULL::text
      FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid JOIN pg_class tc ON tc.oid = i.indrelid JOIN pg_namespace n ON n.oid = ic.relnamespace
      WHERE n.nspname = current_schema()`);
}

// SQLite answers true/false as 1/0; the application compares with 1/0, so booleans are turned back into numbers.
const plain = (rows) => {
  for (const r of rows) for (const k in r) if (typeof r[k] === "boolean") r[k] = r[k] ? 1 : 0;
  return rows;
};

port.on("message", async (m) => {
  dbg("got", m.op);
  try {
    ready ??= connect();
    await ready;
    if (m.op === "close") { await client.end(); done({ ok: true }); return; }
    if (m.op === "ping") { done({ ok: true }); return; }
    if (m.op === "batch") { // several statements in order (exec); stops at the first error
      for (const s of m.list) await client.query(s);
      done({ ok: true });
      return;
    }
    const r = await client.query({ text: m.sql, values: m.params ?? [] });
    done({ ok: true, rows: plain(r.rows ?? []), rowCount: r.rowCount ?? 0 });
  } catch (e) {
    done({ ok: false, error: e.message, code: e.code ?? null, detail: e.detail ?? null });
  }
});
