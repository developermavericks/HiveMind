// A session ends after 30 minutes without user activity; the page's own background polling does not keep it alive.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, copyFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db.mjs";

process.env.HIVEMIND_LLM = "off";
process.env.HIVEMIND_AUTH_IP_LIMIT = "1000";
const bcg = JSON.parse(readFileSync(new URL("../config/bcg.json", import.meta.url), "utf8"));
const PW = "correct horse battery staple";

test("sessions: 30 minutes idle signs out; background polling does not count as activity", async () => {
  delete process.env.HIVEMIND_ADMIN_EMAIL;
  const root = mkdtempSync(join(tmpdir(), "idle-"));
  mkdirSync(join(root, "src")); mkdirSync(join(root, "data"));
  cpSync(new URL("../config", import.meta.url), join(root, "config"), { recursive: true });
  cpSync(new URL("../src/ui", import.meta.url), join(root, "src", "ui"), { recursive: true });
  for (const f of ["dashboard.html", "login.html"]) copyFileSync(new URL(`../src/${f}`, import.meta.url), join(root, "src", f));
  const { serve } = await import("../src/server.mjs");
  const server = await serve({ root, bcg, port: 0, autoSync: false, log: () => {} });
  const base = `http://127.0.0.1:${server.address().port}`;
  const H = { "content-type": "application/json", "x-requested-with": "hivemind" };
  const call = (method, path, body, cookie) => fetch(base + path, { method, redirect: "manual", headers: { ...(method === "GET" ? {} : H), ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const store = new Store(join(root, "data", "hivemind.db")); // same database the server uses
  const ageSessions = (ms) => store.db.prepare("UPDATE sessions SET last_seen = ?").run(Date.now() - ms);
  try {
    await call("POST", "/api/auth/signup", { name: "Ada Admin", email: "ada@x.com", password: PW });
    const login = await call("POST", "/api/auth/login", { email: "ada@x.com", password: PW });
    const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
    assert.equal((await call("GET", "/api/auth/me", undefined, cookie)).status, 200);

    // 20 minutes idle: still signed in
    ageSessions(20 * 60e3);
    await new Promise((r) => setTimeout(r, 31_000)); // let the 30-second session cache expire so the database is read again
    assert.equal((await call("GET", "/api/status", undefined, cookie)).status, 200, "background poll still answered");
    const lastSeen = store.db.prepare("SELECT last_seen FROM sessions").get().last_seen;
    assert.ok(Date.now() - lastSeen > 19 * 60e3, "a background poll did not refresh the session");

    // 31 minutes idle: signed out, even though the page kept polling
    ageSessions(31 * 60e3);
    await new Promise((r) => setTimeout(r, 31_000));
    assert.equal((await call("GET", "/api/auth/me", undefined, cookie)).status, 401);
  } finally { store.close(); server.close(); }
});
