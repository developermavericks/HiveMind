// PostgreSQL behind the same synchronous interface the app uses for SQLite (node:sqlite's DatabaseSync):
//   db.exec(sql)                        run one or more statements
//   db.prepare(sql).get / .all / .run   one statement with ? parameters
// so the store and every caller keep working unchanged. Queries run on one connection held by a worker thread
// (pgsync-worker.mjs); the calling thread waits for each answer (Atomics.wait), exactly like a SQLite call.
//
// The SQL the app writes is SQLite's dialect. translate() turns it into PostgreSQL:
//   ?                         -> $1, $2, ...               INSERT OR IGNORE   -> INSERT ... ON CONFLICT DO NOTHING
//   INSERT OR REPLACE         -> INSERT ... ON CONFLICT (primary key) DO UPDATE SET every other column
//   LIKE                      -> ILIKE (SQLite's LIKE ignores case)     x GLOB 'p*'  -> x ~ '^p.*$'
//   MAX(a, b) / MIN(a, b)     -> GREATEST / LEAST (two or more arguments; one argument stays an aggregate)
//   round(x, n)               -> round((x)::numeric, n)::float8          CAST(x AS INTEGER/REAL) -> bigint / float8
//   INTEGER / REAL columns    -> bigint / double precision; INTEGER PRIMARY KEY AUTOINCREMENT -> identity
//   PRAGMA table_info / quick_check / journal_mode -> equivalent queries; other PRAGMAs -> nothing
//   BEGIN IMMEDIATE           -> BEGIN                     ALTER TABLE ... ADD COLUMN -> ADD COLUMN IF NOT EXISTS
// Every table also gets a hidden "rowid" identity column (SQLite has one built in; the export pages by it).
// Column aliases written in camelCase (AS lastAt) come back in that case, as SQLite returns them.
import { Worker, MessageChannel, receiveMessageOnPort } from "node:worker_threads";

const WAIT_MS = +process.env.HIVEMIND_PG_WAIT_MS || 15 * 60e3;
const DEBUG = process.env.HIVEMIND_PG_DEBUG === "1";

export class PgDatabaseSync {
  constructor(url, { schema = "public" } = {}) {
    this.schema = schema;
    this.signal = new SharedArrayBuffer(4);
    this.flag = new Int32Array(this.signal);
    const { port1, port2 } = new MessageChannel();
    this.port = port1;
    this.worker = new Worker(new URL("./pgsync-worker.mjs", import.meta.url), { workerData: { url, schema, port: port2, signal: this.signal }, transferList: [port2] });
    this.worker.unref();
    this.cache = new Map();   // SQLite SQL -> translated plan
    this.pkCache = new Map(); // table -> primary key columns
    this.colCache = new Map();// table -> column names
    this.open = true;
    this.#send({ op: "ping" });
  }

  #send(msg) {
    if (!this.open) throw new Error("database connection is closed");
    if (DEBUG) process.stderr.write(`[pg] ${msg.op} ${(msg.sql ?? (msg.list || []).join(" ; ")).replace(/\s+/g, " ").slice(0, 300)}
`);
    Atomics.store(this.flag, 0, 0);
    this.port.postMessage(msg);
    const r = Atomics.wait(this.flag, 0, 0, WAIT_MS);
    if (r === "timed-out") throw new Error("PostgreSQL did not answer in time");
    const got = receiveMessageOnPort(this.port);
    if (!got) throw new Error("PostgreSQL answer missing");
    const m = got.message;
    if (!m.ok) {
      const e = new Error(`${m.error} [PostgreSQL: ${String(msg.sql ?? (msg.list || []).join("; ")).replace(/\s+/g, " ").slice(0, 400)}]`);
      e.code = m.code; e.detail = m.detail; throw e;
    }
    return m;
  }
  query(sql, params = []) { return this.#send({ op: "query", sql, params: params.map(toParam) }); }

  primaryKey(table) {
    if (!this.pkCache.has(table)) {
      const r = this.query(`SELECT a.attname AS col FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = to_regclass($1) AND i.indisprimary ORDER BY array_position(i.indkey, a.attnum)`, [`"${this.schema}"."${table}"`]);
      this.pkCache.set(table, r.rows.map((x) => x.col));
    }
    return this.pkCache.get(table);
  }
  columns(table) {
    if (!this.colCache.has(table)) {
      const r = this.query("SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position", [table]);
      this.colCache.set(table, r.rows.map((x) => x.name));
    }
    return this.colCache.get(table);
  }
  #schemaChanged() { this.pkCache.clear(); this.colCache.clear(); this.cache.clear(); }

  exec(sql) {
    const list = [];
    for (const s of splitStatements(sql)) {
      const plan = translate(s, this);
      if (plan.skip) continue;
      if (plan.ddl) this.#schemaChanged();
      list.push(...plan.sqls);
    }
    if (list.length === 1) this.query(list[0]);
    else if (list.length) this.#send({ op: "batch", list });
    if (list.some((s) => /^\s*(CREATE|ALTER|DROP)\b/i.test(s))) this.#schemaChanged();
  }

  prepare(sql) {
    let plan = this.cache.get(sql);
    if (!plan) { plan = translate(sql, this); if (!plan.ddl) this.cache.set(sql, plan); }
    const db = this;
    const exec = (params) => {
      if (plan.skip) return { rows: plan.rows ?? [], rowCount: 0 };
      if (plan.ddl) db.#schemaChanged();
      const r = db.query(plan.sql, params);
      if (plan.aliases) for (const row of r.rows) for (const [lo, orig] of plan.aliases) if (lo in row) { row[orig] = row[lo]; delete row[lo]; }
      if (plan.ddl) db.#schemaChanged();
      return r;
    };
    return {
      get: (...params) => exec(params).rows[0],
      all: (...params) => exec(params).rows,
      iterate: (...params) => exec(params).rows[Symbol.iterator](),
      run: (...params) => {
        const r = exec(params);
        const last = r.rows.length ? r.rows[r.rows.length - 1] : null;
        return { changes: r.rowCount, lastInsertRowid: last ? (last.id ?? last.rowid ?? 0) : 0 };
      },
    };
  }

  close() {
    if (!this.open) return;
    try { this.#send({ op: "close" }); } catch { /* already gone */ }
    this.open = false;
    this.worker.terminate();
  }
}

const toParam = (v) => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : typeof v === "bigint" ? Number(v) : v);

// ---------------------------------------------------------------- translation

// Splits a script into statements on ";" outside quotes.
export function splitStatements(sql) {
  const out = []; let cur = "", q = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (q) { cur += ch; if (ch === q) { if (sql[i + 1] === q) { cur += sql[++i]; } else q = null; } continue; }
    if (ch === "'" || ch === '"') { q = ch; cur += ch; continue; }
    if (ch === "-" && sql[i + 1] === "-") { while (i < sql.length && sql[i] !== "\n") i++; cur += " "; continue; }
    if (ch === ";") { if (cur.trim()) out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// Replaces string literals with markers so rewrites never touch text inside quotes; returns [masked, literals].
function mask(sql) {
  const lits = []; let out = "";
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'") {
      let j = i + 1, s = "'";
      for (; j < sql.length; j++) { s += sql[j]; if (sql[j] === "'") { if (sql[j + 1] === "'") { s += sql[++j]; continue; } break; } }
      lits.push(s); out += `\u0001${lits.length - 1}\u0001`; i = j; continue;
    }
    out += ch;
  }
  return [out, lits];
}
const unmask = (s, lits) => s.replace(/\u0001(\d+)\u0001/g, (_, n) => lits[+n]);

// Finds name( ... ) calls at any depth and lets fn rewrite them from their top-level arguments.
function rewriteCalls(s, name, fn) {
  const re = new RegExp(`\\b${name}\\s*\\(`, "gi");
  let out = "", pos = 0, m;
  while ((m = re.exec(s))) {
    const start = m.index, open = re.lastIndex - 1;
    let depth = 0, i = open, args = [], argStart = open + 1;
    for (; i < s.length; i++) {
      if (s[i] === "(") depth++;
      else if (s[i] === ")") { depth--; if (depth === 0) break; }
      else if (s[i] === "," && depth === 1) { args.push(s.slice(argStart, i)); argStart = i + 1; }
    }
    if (i >= s.length) break;
    args.push(s.slice(argStart, i));
    const inner = args.map((a) => rewriteAll(a)); // nested calls inside arguments
    const rep = fn(inner.map((a) => a.trim()), s.slice(start, open));
    out += s.slice(pos, start) + (rep ?? `${s.slice(start, open)}(${inner.join(",")})`);
    pos = i + 1;
    re.lastIndex = i + 1;
  }
  return out + s.slice(pos);
}
function rewriteAll(s) {
  s = rewriteCalls(s, "MAX", (a) => (a.length >= 2 ? `GREATEST(${a.join(", ")})` : null));
  s = rewriteCalls(s, "MIN", (a) => (a.length >= 2 ? `LEAST(${a.join(", ")})` : null));
  s = rewriteCalls(s, "round", (a) => (a.length === 2 ? `round((${a[0]})::numeric, ${a[1]})::float8` : null));
  s = rewriteCalls(s, "ifnull", (a) => `COALESCE(${a.join(", ")})`);
  // SQLite counts with SUM(condition) (true = 1); PostgreSQL cannot add booleans
  s = rewriteCalls(s, "SUM", (a) => (a.length === 1 && /(!=|<>|<=|>=|[=<>]|\bIS\b|\bIN\b|\bLIKE\b|\bGLOB\b|\bBETWEEN\b)/i.test(a[0]) ? `SUM(CASE WHEN ${a[0]} THEN 1 ELSE 0 END)` : null));
  return s;
}

const globToRegex = (lit) => {
  const g = lit.slice(1, -1).replace(/''/g, "'");
  let r = "^";
  for (const ch of g) r += ch === "*" ? ".*" : ch === "?" ? "." : /[.+^${}()|\\]/.test(ch) ? "\\" + ch : ch;
  return `'${(r + "$").replace(/'/g, "''")}'`;
};

const colTypes = (s) => s
  .replace(/\bINTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/gi, "bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY")
  .replace(/\bINTEGER\b/gi, "bigint").replace(/\bREAL\b/gi, "double precision");

export function translate(sql, db) {
  const raw = sql.trim().replace(/;\s*$/, "");
  // ---- PRAGMAs
  let m = raw.match(/^PRAGMA\s+(?:\w+\.)?table_info\s*\(\s*["']?(\w+)["']?\s*\)$/i);
  if (m) return { sql: `SELECT column_name AS name, ordinal_position - 1 AS cid, data_type AS type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = '${m[1]}' AND column_name <> 'rowid' ORDER BY ordinal_position`, sqls: [] };
  if (/^PRAGMA\s+(quick_check|integrity_check)/i.test(raw)) return { sql: "SELECT 'ok' AS quick_check", sqls: [] };
  if (/^PRAGMA\s+journal_mode/i.test(raw)) return { skip: true, rows: [{ journal_mode: "wal" }], sqls: [] };
  if (/^PRAGMA\b/i.test(raw)) return { skip: true, rows: [], sqls: [] };
  if (/^BEGIN\b/i.test(raw)) return { sql: "BEGIN", sqls: ["BEGIN"] };
  if (/^VACUUM\b/i.test(raw)) throw new Error("VACUUM INTO is SQLite-only: in PostgreSQL mode backups are made with pg_dump (the pgbackup service)");
  if (/^(ATTACH|DETACH)\b/i.test(raw)) throw new Error("ATTACH/DETACH is SQLite-only");

  const [masked, lits] = mask(raw);
  let s = masked;

  // ---- schema statements
  if (/^CREATE\s+TABLE/i.test(s)) {
    s = colTypes(s);
    // the hidden rowid column, added before the final ")"
    if (!/\browid\b/i.test(s)) s = s.replace(/\)\s*$/, ", rowid bigint GENERATED ALWAYS AS IDENTITY)");
    const out = unmask(s, lits);
    return { sql: out, sqls: [out], ddl: true };
  }
  if (/^ALTER\s+TABLE\s+\w+\s+ADD\s+COLUMN\s+(?!IF\s+NOT\s+EXISTS)/i.test(s)) {
    s = colTypes(s).replace(/ADD\s+COLUMN\s+/i, "ADD COLUMN IF NOT EXISTS ");
    const out = unmask(s, lits);
    return { sql: out, sqls: [out], ddl: true };
  }
  if (/^(CREATE|DROP|ALTER)\b/i.test(s)) { const out = unmask(colTypes(s), lits); return { sql: out, sqls: [out], ddl: true }; }

  // ---- data statements
  let tail = "";
  m = s.match(/^INSERT\s+OR\s+IGNORE\s+INTO/i);
  if (m) { s = s.replace(/^INSERT\s+OR\s+IGNORE\s+INTO/i, "INSERT INTO"); tail = " ON CONFLICT DO NOTHING"; }
  m = s.match(/^INSERT\s+OR\s+REPLACE\s+INTO\s+"?(\w+)"?\s*\(([^)]*)\)/i);
  if (m) {
    const table = m[1], cols = m[2].split(",").map((c) => c.trim().replace(/"/g, ""));
    const pk = db ? db.primaryKey(table) : [];
    s = s.replace(/^INSERT\s+OR\s+REPLACE\s+INTO/i, "INSERT INTO");
    const rest = cols.filter((c) => !pk.includes(c));
    tail = pk.length ? (rest.length ? ` ON CONFLICT (${pk.map((c) => `"${c}"`).join(", ")}) DO UPDATE SET ${rest.map((c) => `"${c}" = EXCLUDED."${c}"`).join(", ")}` : " ON CONFLICT DO NOTHING") : "";
  }
  s = s.replace(/\bLIKE\b/gi, "ILIKE").replace(/\bNOT\s+ILIKE\b/gi, "NOT ILIKE");
  s = s.replace(/\bNOT\s+GLOB\s+\u0001(\d+)\u0001/gi, (_, n) => `!~ ${globToRegex(lits[+n])}`)
       .replace(/\bGLOB\s+\u0001(\d+)\u0001/gi, (_, n) => `~ ${globToRegex(lits[+n])}`);
  // SQLite accepts an empty list: "x IN ()" is false and "x NOT IN ()" is true; PostgreSQL needs a real (empty) subquery
  s = s.replace(/\bIN\s*\(\s*\)/gi, "IN (SELECT NULL WHERE FALSE)");
  // SQLite's CAST(x AS INTEGER) reads the leading digits and gives 0 for text that is not a number; PostgreSQL would fail
  s = s.replace(/\bCAST\s*\(([\s\S]*?)\s+AS\s+INTEGER\s*\)/gi, (_, x) => `COALESCE(substring(trim(CAST(${x} AS text)) from '^[-+]?[0-9]+')::bigint, 0)`)
       .replace(/\bCAST\s*\(([\s\S]*?)\s+AS\s+REAL\s*\)/gi, (_, x) => `COALESCE(substring(trim(CAST(${x} AS text)) from '^[-+]?[0-9]*\.?[0-9]+([eE][-+]?[0-9]+)?')::float8, 0)`);
  s = rewriteAll(s);
  // SQLite's "a IS b" / "a IS NOT b" compare any values, NULL-safely; PostgreSQL only allows IS [NOT] NULL / TRUE / FALSE there
  s = s.replace(/\bIS\s+NOT\s+(?!NULL\b|TRUE\b|FALSE\b|DISTINCT\b)(\u0001\d+\u0001|\?|-?\d+(?:\.\d+)?)/gi, "IS DISTINCT FROM $1")
       .replace(/\bIS\s+(?!NOT\b|NULL\b|TRUE\b|FALSE\b|DISTINCT\b)(\u0001\d+\u0001|\?|-?\d+(?:\.\d+)?)/gi, "IS NOT DISTINCT FROM $1");
  // "ON CONFLICT ... DO UPDATE SET x = x + excluded.x": PostgreSQL needs the existing row's columns named with the table
  const up = s.match(/^INSERT\s+INTO\s+"?(\w+)"?[\s\S]*?\bDO\s+UPDATE\s+SET\s+/i);
  if (up && db) {
    const table = up[1], cols = new Set(db.columns(table)), head = s.slice(0, up[0].length);
    const body = s.slice(up[0].length).replace(/(^|[^\w."$])([A-Za-z_][A-Za-z0-9_]*)\b(?!\s*\()/g, (m0, pre, id, off, str) => {
      if (!cols.has(id.toLowerCase())) return m0;
      // the column being assigned (left of "=" right after SET or a comma) stays bare
      const before = str.slice(0, off + pre.length).replace(/\s+$/, "");
      const after = str.slice(off + m0.length).replace(/^\s+/, "");
      if ((before === "" || before.endsWith(",")) && after.startsWith("=") && !after.startsWith("==")) return m0;
      return `${pre}"${table}"."${id}"`;
    });
    s = head + body;
  }
  let n = 0;
  s = s.replace(/\?/g, () => `$${++n}`);
  // INSERTs report the new row's id (lastInsertRowid), as SQLite does
  const ins = s.match(/^INSERT\s+INTO\s+"?(\w+)"?/i);
  if (ins && !/\bRETURNING\b/i.test(s)) {
    const cols = db ? db.columns(ins[1]) : [];
    tail += cols.includes("id") ? " RETURNING id" : cols.includes("rowid") ? " RETURNING rowid" : "";
  }
  s += tail;
  const out = unmask(s, lits);
  // camelCase aliases: PostgreSQL folds them to lower case; map them back for the caller
  const aliases = [...new Set([...masked.matchAll(/\bAS\s+([A-Za-z_][A-Za-z0-9_]*)/g)].map((x) => x[1]).filter((a) => a !== a.toLowerCase()))].map((a) => [a.toLowerCase(), a]);
  return { sql: out, sqls: [out], aliases: aliases.length ? aliases : null };
}
