// What a container needs from the server: a health check that works before login, a configurable bind address, and a lock on the first admin.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, copyFileSync, cpSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HIVEMIND_LLM = "off";
process.env.HIVEMIND_AUTH_IP_LIMIT = "1000";
const bcg = JSON.parse(readFileSync(new URL("../config/bcg.json", import.meta.url), "utf8"));

async function boot(extra = {}) {
  const root = mkdtempSync(join(tmpdir(), "ctr-"));
  mkdirSync(join(root, "src")); mkdirSync(join(root, "data"));
  cpSync(new URL("../config", import.meta.url), join(root, "config"), { recursive: true });
  cpSync(new URL("../src/ui", import.meta.url), join(root, "src", "ui"), { recursive: true });
  for (const f of ["dashboard.html", "login.html"]) copyFileSync(new URL(`../src/${f}`, import.meta.url), join(root, "src", f));
  const { serve } = await import("../src/server.mjs");
  const logs = [], server = await serve({ root, bcg, port: 0, autoSync: false, log: (m) => logs.push(m), ...extra });
  return { server, logs, port: server.address().port, close: () => { server.close(); server.closeAllConnections?.(); } };
}
// fetch will not let a script set the Host header, so a raw request is used to check the host rules
const raw = (port, path, host, method = "GET", body, headers = {}) => new Promise((resolve, reject) => {
  const req = request({ host: "127.0.0.1", port, path, method, headers: { host, ...(body ? { "content-type": "application/json", "x-requested-with": "hivemind" } : {}), ...headers } }, (res) => { let t = ""; res.on("data", (c) => (t += c)); res.on("end", () => resolve({ status: res.statusCode, body: t, headers: res.headers })); });
  req.on("error", reject); if (body) req.write(JSON.stringify(body)); req.end();
});

test("health: /healthz answers ok with no login, even for a host that is not allowed, and says nothing else", async () => {
  const s = await boot();
  try {
    for (const host of [`127.0.0.1:${s.port}`, "evil.example.com", "reports-api.run.app"]) {
      const r = await raw(s.port, "/healthz", host);
      assert.equal(r.status, 200, host); assert.equal(r.body, '{"ok":true}'); assert.equal(r.headers["cache-control"], "no-store");
    }
    assert.equal((await raw(s.port, "/healthz", "evil.example.com", "HEAD")).status, 200);
    assert.equal((await raw(s.port, "/healthz", "evil.example.com", "POST", {})).status, 403, "only GET and HEAD are health checks; anything else meets the normal host rule");
    assert.equal((await raw(s.port, "/api/overview", "evil.example.com")).status, 403, "other paths still refuse a foreign host (DNS rebinding protection is unchanged)");
    assert.equal((await raw(s.port, "/api/overview", `127.0.0.1:${s.port}`)).status, 401, "and still need a login");
  } finally { s.close(); }
});

test("bind address: local by default, all interfaces only when asked, and the log says which", async () => {
  const saved = process.env.HIVEMIND_HOST; delete process.env.HIVEMIND_HOST;
  try {
    const a = await boot(); try { assert.equal(a.server.address().address, "127.0.0.1"); assert.match(a.logs.join("\n"), /Dashboard: http:\/\/127\.0\.0\.1:\d+$/m); } finally { a.close(); }
    const b = await boot({ host: "0.0.0.0" }); try { assert.equal(b.server.address().address, "0.0.0.0"); assert.match(b.logs.join("\n"), /listening on all interfaces.*HIVEMIND_ALLOWED_HOSTS/); } finally { b.close(); }
    process.env.HIVEMIND_HOST = "0.0.0.0";
    const c = await boot(); try { assert.equal(c.server.address().address, "0.0.0.0", "HIVEMIND_HOST sets it without code changes"); } finally { c.close(); }
  } finally { if (saved === undefined) delete process.env.HIVEMIND_HOST; else process.env.HIVEMIND_HOST = saved; }
});

test("first admin: with HIVEMIND_ADMIN_EMAIL set only that address can create the first account", async () => {
  const saved = process.env.HIVEMIND_ADMIN_EMAIL; process.env.HIVEMIND_ADMIN_EMAIL = "Boss@Example.com";
  const s = await boot(), host = `127.0.0.1:${s.port}`, pw = "correct horse battery staple";
  try {
    const stranger = await raw(s.port, "/api/auth/signup", host, "POST", { email: "stranger@example.com", name: "Stranger", password: pw });
    assert.equal(stranger.status, 403); assert.match(stranger.body, /administrator this server was set up for/);
    const state = JSON.parse((await raw(s.port, "/api/auth/state", host)).body); assert.equal(state.setup, true, "the stranger created nothing, so the server is still waiting for its administrator");
    const boss = await raw(s.port, "/api/auth/signup", host, "POST", { email: "boss@example.com", name: "The Boss", password: pw });
    assert.notEqual(boss.status, 403, "the configured administrator (case-insensitive) is accepted");
    assert.equal(JSON.parse((await raw(s.port, "/api/auth/state", host)).body).setup, false, "the account now exists");
    const later = await raw(s.port, "/api/auth/signup", host, "POST", { email: "colleague@example.com", name: "Colleague", password: pw });
    assert.notEqual(later.status, 403, "after the first account the lock no longer applies: later sign-ups wait for approval as before");
  } finally { s.close(); if (saved === undefined) delete process.env.HIVEMIND_ADMIN_EMAIL; else process.env.HIVEMIND_ADMIN_EMAIL = saved; }
});

test("first admin: with no HIVEMIND_ADMIN_EMAIL the first account is open, as on a local machine", async () => {
  const saved = process.env.HIVEMIND_ADMIN_EMAIL; delete process.env.HIVEMIND_ADMIN_EMAIL;
  const s = await boot(), host = `127.0.0.1:${s.port}`;
  try {
    const r = await raw(s.port, "/api/auth/signup", host, "POST", { email: "anyone@example.com", name: "Anyone", password: "correct horse battery staple" });
    assert.notEqual(r.status, 403); assert.equal(JSON.parse((await raw(s.port, "/api/auth/state", host)).body).setup, false);
  } finally { s.close(); if (saved !== undefined) process.env.HIVEMIND_ADMIN_EMAIL = saved; }
});
