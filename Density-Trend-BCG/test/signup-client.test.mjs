// Tests for the client typed at sign-up: required, matched to an existing client whatever the case/spacing/dots,
// accounts still wait for approval, and the admin sees what was typed.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, copyFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HIVEMIND_LLM = "off";
process.env.HIVEMIND_AUTH_IP_LIMIT = "1000";
const bcg = JSON.parse(readFileSync(new URL("../config/bcg.json", import.meta.url), "utf8"));
const PW = "correct horse battery staple";

async function boot() {
  const root = mkdtempSync(join(tmpdir(), "signup-"));
  mkdirSync(join(root, "src")); mkdirSync(join(root, "data"));
  cpSync(new URL("../config", import.meta.url), join(root, "config"), { recursive: true });
  cpSync(new URL("../src/ui", import.meta.url), join(root, "src", "ui"), { recursive: true });
  for (const f of ["dashboard.html", "login.html"]) copyFileSync(new URL(`../src/${f}`, import.meta.url), join(root, "src", f));
  const { serve } = await import("../src/server.mjs");
  const server = await serve({ root, bcg, port: 0, autoSync: false, log: () => {} });
  const base = `http://127.0.0.1:${server.address().port}`;
  const H = { "content-type": "application/json", "x-requested-with": "hivemind" };
  const call = (method, path, body, cookie) => fetch(base + path, { method, redirect: "manual", headers: { ...(method === "GET" ? {} : H), ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const cookieOf = (r) => (r.headers.get("set-cookie") || "").split(";")[0];
  return { call, cookieOf, close: () => server.close() };
}

test("sign-up client: required, matched case-insensitively, still pending, shown to the admin", async () => {
  delete process.env.HIVEMIND_ADMIN_EMAIL;
  const t = await boot();
  try {
    // the administrator's own first account needs no client
    assert.equal((await t.call("POST", "/api/auth/signup", { name: "Ada Admin", email: "ada@x.com", password: PW })).status, 200);
    // every later account must type a client
    const none = await t.call("POST", "/api/auth/signup", { name: "No Client", email: "nc@x.com", password: PW });
    assert.equal(none.status, 400);
    assert.match((await none.json()).error, /client/i);
    assert.equal((await t.call("POST", "/api/auth/signup", { name: "Dots", email: "dots@x.com", password: PW, client: " . " })).status, 400);
    // different spellings of an existing client all map to it; a new client gets a clean id
    const cases = [["b1@x.com", "BCG"], ["b2@x.com", "bcg"], ["b3@x.com", " B.C.G "], ["b4@x.com", "BcG"], ["g1@x.com", "GOOgle"], ["g2@x.com", " google. "], ["n1@x.com", "Noise"]];
    for (const [email, client] of cases) {
      const r = await t.call("POST", "/api/auth/signup", { name: "Person " + email, email, password: PW, client });
      assert.equal(r.status, 200, email);
      assert.equal((await r.json()).status, "pending", "still waits for approval: " + email);
    }
    // a pending account cannot sign in
    assert.equal((await t.call("POST", "/api/auth/login", { email: "b1@x.com", password: PW })).status, 403);
    // the admin sees the client as typed and the client each account was put under
    const admin = t.cookieOf(await t.call("POST", "/api/auth/login", { email: "ada@x.com", password: PW }));
    const users = (await (await t.call("GET", "/api/users", undefined, admin)).json()).users;
    const by = Object.fromEntries(users.map((u) => [u.email, u]));
    for (const e of ["b1@x.com", "b2@x.com", "b3@x.com", "b4@x.com"]) assert.equal(by[e].company, "bcg", e);
    assert.equal(by["g1@x.com"].company, "google");
    assert.equal(by["g2@x.com"].company, "google");
    assert.equal(by["n1@x.com"].company, "noise");
    assert.equal(by["b3@x.com"].clientRequested, "B.C.G");
    assert.equal(by["g1@x.com"].clientRequested, "GOOgle");
  } finally { t.close(); }
});
