// Tests for the data export API (src/export.mjs): key check, datasets, paging, incremental sync, private data kept out.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, copyFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db.mjs";

process.env.HIVEMIND_LLM = "off";
process.env.HIVEMIND_AUTH_IP_LIMIT = "1000";
const bcg = JSON.parse(readFileSync(new URL("../config/bcg.json", import.meta.url), "utf8"));
const KEY = "test-export-key-0123456789abcdef0123456789";

async function boot() {
  const root = mkdtempSync(join(tmpdir(), "export-"));
  mkdirSync(join(root, "src")); mkdirSync(join(root, "data"));
  cpSync(new URL("../config", import.meta.url), join(root, "config"), { recursive: true });
  cpSync(new URL("../src/ui", import.meta.url), join(root, "src", "ui"), { recursive: true });
  for (const f of ["dashboard.html", "login.html"]) copyFileSync(new URL(`../src/${f}`, import.meta.url), join(root, "src", f));
  // five stories changed at t = 1000..5000, one reading with JSON analysis
  const s = new Store(join(root, "data", "hivemind.db"));
  const ins = s.db.prepare("INSERT INTO stories (key, title, url, snippet, published_at, day, first_seen, last_seen) VALUES (?, ?, ?, '', ?, '2026-11-16', ?, ?)");
  for (let i = 1; i <= 5; i++) ins.run(`k${i}`, `Story ${i}`, `https://x.test/${i}`, i * 1000, i * 1000, i * 1000);
  s.db.prepare("INSERT INTO readings (key, basis, analysis, read_at) VALUES ('k1', 'headline', ?, 1500)").run(JSON.stringify({ what: "x", impacts: [] }));
  s.close();
  const { serve } = await import("../src/server.mjs");
  const server = await serve({ root, bcg, port: 0, autoSync: false, log: () => {} });
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (path, key = KEY, extra = {}) => fetch(base + path, { headers: { ...(key ? { "x-api-key": key } : {}), ...extra } });
  return { root, server, base, get, close: () => server.close() };
}

test("export: switched off without a key, refuses missing/wrong keys and writes", async () => {
  delete process.env.HIVEMIND_EXPORT_KEY;
  let t = await boot();
  try { assert.equal((await t.get("/api/export")).status, 404); } finally { t.close(); }
  process.env.HIVEMIND_EXPORT_KEY = KEY;
  t = await boot();
  try {
    assert.equal((await t.get("/api/export", null)).status, 401);
    assert.equal((await t.get("/api/export", "wrong-key")).status, 401);
    assert.equal((await t.get(`/api/export?key=${KEY}`, null)).status, 401); // never in the URL
    assert.equal((await t.get("/api/export", null, { authorization: `Bearer ${KEY}` })).status, 200);
    assert.equal((await fetch(t.base + "/api/export/stories", { method: "POST", headers: { "x-api-key": KEY } })).status, 405);
    // the website API still needs a sign-in; the export key does not open it
    assert.notEqual((await t.get("/api/overview")).status, 200);
  } finally { t.close(); }
});

test("export: index, paging, incremental sync, JSON decoding, private tables absent", async () => {
  process.env.HIVEMIND_EXPORT_KEY = KEY;
  const t = await boot();
  try {
    const idx = await (await t.get("/api/export")).json();
    const st = idx.datasets.find((d) => d.name === "stories");
    assert.equal(st.rows, 5);
    for (const priv of ["users", "sessions", "auth_log", "activity_log", "password_resets", "tickets", "journalists", "usage_daily", "job_log", "meta"]) {
      assert.ok(!idx.datasets.some((d) => d.name === priv), priv);
      assert.equal((await t.get(`/api/export/${priv}`)).status, 404, priv);
    }
    // full sync in pages of 2
    let seen = [], cursor = null, page, pages = 0;
    do {
      page = await (await t.get(`/api/export/stories?limit=2${cursor ? `&cursor=${cursor}` : ""}`)).json();
      seen.push(...page.rows.map((r) => r.key)); cursor = page.next_cursor; pages++;
    } while (page.has_more);
    assert.deepEqual(seen, ["k1", "k2", "k3", "k4", "k5"]);
    assert.equal(pages, 3);
    assert.equal(page.next_since, 5000);
    // incremental: since=4000 gives k4, k5; a re-seen story comes back
    const inc = await (await t.get("/api/export/stories?since=4000")).json();
    assert.deepEqual(inc.rows.map((r) => r.key), ["k4", "k5"]);
    const s = new Store(join(t.root, "data", "hivemind.db"));
    s.db.prepare("UPDATE stories SET last_seen = 9000 WHERE key = 'k2'").run(); s.close();
    const inc2 = await (await t.get("/api/export/stories?since=5001")).json();
    assert.deepEqual(inc2.rows.map((r) => r.key), ["k2"]);
    assert.equal((await (await t.get("/api/export/stories?since=2026-01-01T00:00:00Z")).json()).count, 0);
    assert.equal((await t.get("/api/export/stories?since=not-a-date")).status, 400);
    assert.equal((await t.get("/api/export/stories?cursor=garbage")).status, 400);
    // JSON text comes back as JSON
    const rd = await (await t.get("/api/export/readings")).json();
    assert.deepEqual(rd.rows[0].analysis, { what: "x", impacts: [] });
    assert.equal((await t.get("/api/export/nope")).status, 404);
    assert.equal((await t.get("/api/export/views/nope")).status, 404);
  } finally { t.close(); }
});
