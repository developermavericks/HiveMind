// Tests for sign-in: accounts, sessions, throttling, roles, CSRF and security headers.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, copyFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashPassword, verifyPassword, passwordProblem } from "../src/auth.mjs";

process.env.HIVEMIND_LLM = "off";
process.env.HIVEMIND_AUTH_IP_LIMIT = "1000"; // generous, so ordinary tests never trip the per-IP limit (one test lowers it)
const bcg = JSON.parse(readFileSync(new URL("../config/bcg.json", import.meta.url), "utf8"));

async function boot() {
  const root = mkdtempSync(join(tmpdir(), "auth-"));
  mkdirSync(join(root, "src")); mkdirSync(join(root, "data"));
  cpSync(new URL("../config", import.meta.url), join(root, "config"), { recursive: true });
  cpSync(new URL("../src/ui", import.meta.url), join(root, "src", "ui"), { recursive: true });
  for (const f of ["dashboard.html", "login.html"]) copyFileSync(new URL(`../src/${f}`, import.meta.url), join(root, "src", f));
  const { serve } = await import("../src/server.mjs");
  const server = await serve({ root, bcg, port: 0, autoSync: false, log: () => {} });
  const base = `http://127.0.0.1:${server.address().port}`;
  const H = { "content-type": "application/json", "x-requested-with": "hivemind" };
  const call = (method, path, body, cookie, extra = {}) => fetch(base + path, { method, redirect: "manual", headers: { ...(method === "GET" ? {} : H), ...(cookie ? { cookie } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  const cookieOf = (r) => (r.headers.get("set-cookie") || "").split(";")[0];
  return { server, base, call, cookieOf, close: () => server.close() };
}
const PW = "correct horse battery staple";

test("passwords: scrypt hashes verify, differ per salt, and weak ones are refused", async () => {
  const a = await hashPassword(PW), b = await hashPassword(PW);
  assert.match(a, /^scrypt\$32768\$8\$1\$/);
  assert.notEqual(a, b);
  assert.equal(await verifyPassword(PW, a), true);
  assert.equal(await verifyPassword(PW + "x", a), false);
  assert.equal(await verifyPassword(PW, "scrypt$999999999$8$1$AA==$AA=="), false); // absurd parameters are refused, not computed
  assert.match(passwordProblem("short"), /10 characters/);
  assert.ok(passwordProblem("password123"));
  assert.ok(passwordProblem("aaaaaaaaaaaa"));
  assert.ok(passwordProblem("alexander-the-great", { email: "x@y.com", name: "Alexander" }));
  assert.equal(passwordProblem(PW, { email: "a@b.com", name: "Ann Lee" }), null);
});

test("auth: first account is the admin, later ones wait for approval, and the whole flow holds", async () => {
  const t = await boot();
  try {
    assert.equal((await (await t.call("GET", "/api/auth/state")).json()).setup, true);
    // weak password and bad email are rejected
    assert.equal((await t.call("POST", "/api/auth/signup", { name: "Ada", email: "ada@x.com", password: "short" })).status, 400);
    assert.equal((await t.call("POST", "/api/auth/signup", { name: "Ada", email: "nope", password: PW })).status, 400);
    const s1 = await (await t.call("POST", "/api/auth/signup", { name: "Ada Admin", email: "Ada@X.com", password: PW })).json();
    assert.deepEqual([s1.status, s1.first], ["active", true]);
    assert.equal((await (await t.call("GET", "/api/auth/state")).json()).setup, false);
    // second sign-up is pending and cannot log in, even with the right password
    const s2 = await (await t.call("POST", "/api/auth/signup", { name: "Bob Member", email: "bob@x.com", password: PW })).json();
    assert.deepEqual([s2.status, s2.first], ["pending", false]);
    const pend = await t.call("POST", "/api/auth/login", { email: "bob@x.com", password: PW });
    assert.equal(pend.status, 403); assert.equal((await pend.json()).status, "pending");
    // wrong password and unknown email give the same message
    const w1 = await t.call("POST", "/api/auth/login", { email: "ada@x.com", password: "wrong-password-1" });
    const w2 = await t.call("POST", "/api/auth/login", { email: "ghost@x.com", password: "wrong-password-1" });
    assert.equal(w1.status, 401); assert.equal(w2.status, 401);
    assert.equal((await w1.json()).error, (await w2.json()).error);
    // admin logs in; cookie flags
    const li = await t.call("POST", "/api/auth/login", { email: "ada@x.com", password: PW });
    assert.equal(li.status, 200);
    const raw = li.headers.get("set-cookie");
    assert.match(raw, /^hm_session=/); assert.match(raw, /HttpOnly/); assert.match(raw, /SameSite=Strict/); assert.match(raw, /Path=\//); assert.match(raw, /Max-Age=604800/);
    assert.ok(!/Secure/.test(raw)); // plain http on localhost
    const adminC = t.cookieOf(li);
    assert.equal((await (await t.call("GET", "/api/auth/me", undefined, adminC)).json()).user.role, "admin");
    // admin sees the pending user and approves
    const list = (await (await t.call("GET", "/api/users", undefined, adminC)).json()).users;
    const bob = list.find((u) => u.email === "bob@x.com");
    assert.equal(bob.status, "pending");
    assert.equal((await t.call("POST", "/api/users/approve", { id: bob.id }, adminC)).status, 200);
    const bl = await t.call("POST", "/api/auth/login", { email: "bob@x.com", password: PW });
    assert.equal(bl.status, 200);
    const bobC = t.cookieOf(bl);
    // member: can read, cannot do admin things
    assert.equal((await t.call("GET", "/api/status", undefined, bobC)).status, 200);
    assert.equal((await t.call("POST", "/api/run", {}, bobC)).status, 403);
    assert.equal((await t.call("POST", "/api/integrations/toggle", { name: "x", enabled: true }, bobC)).status, 403);
    assert.equal((await t.call("GET", "/api/users", undefined, bobC)).status, 403);
    assert.equal((await t.call("POST", "/api/tuning/apply", { confirm: true }, bobC)).status, 403);
    // the last admin cannot be disabled or demoted, and nobody can disable themselves
    const adminRow = list.find((u) => u.email === "ada@x.com");
    assert.equal((await t.call("POST", "/api/users/disable", { id: adminRow.id }, adminC)).status, 400);
    assert.equal((await t.call("POST", "/api/users/role", { id: adminRow.id, role: "member" }, adminC)).status, 400);
    // reset gives a one-time password, kills sessions, and the member can sign in with it
    const rs = await (await t.call("POST", "/api/users/reset", { id: bob.id }, adminC)).json();
    assert.equal(rs.temporaryPassword.length, 16);
    assert.equal((await t.call("GET", "/api/status", undefined, bobC)).status, 401);
    assert.equal((await t.call("POST", "/api/auth/login", { email: "bob@x.com", password: rs.temporaryPassword })).status, 200);
  } finally { t.close(); }
});

test("auth: five wrong passwords lock the account, even for the right password", async () => {
  const t = await boot();
  try {
    await t.call("POST", "/api/auth/signup", { name: "Ada", email: "ada@x.com", password: PW });
    for (let i = 0; i < 5; i++) assert.equal((await t.call("POST", "/api/auth/login", { email: "ada@x.com", password: `wrong-password-${i}` })).status, 401);
    const locked = await t.call("POST", "/api/auth/login", { email: "ada@x.com", password: PW });
    assert.equal(locked.status, 429);
    assert.ok(+locked.headers.get("retry-after") > 0);
    assert.match((await locked.json()).error, /minute/);
    // an address that does not exist locks the same way (no way to tell it apart)
    for (let i = 0; i < 5; i++) await t.call("POST", "/api/auth/login", { email: "ghost@x.com", password: `wrong-password-${i}` });
    assert.equal((await t.call("POST", "/api/auth/login", { email: "ghost@x.com", password: PW })).status, 429);
  } finally { t.close(); }
});

test("auth: sessions end on logout and on password change, which also keeps the current session", async () => {
  const t = await boot();
  try {
    await t.call("POST", "/api/auth/signup", { name: "Ada", email: "ada@x.com", password: PW });
    const c1 = t.cookieOf(await t.call("POST", "/api/auth/login", { email: "ada@x.com", password: PW }));
    const c2 = t.cookieOf(await t.call("POST", "/api/auth/login", { email: "ada@x.com", password: PW }));
    assert.notEqual(c1, c2);
    assert.equal((await t.call("GET", "/api/status", undefined, c1)).status, 200);
    // wrong current password is refused; a weak new one too
    assert.equal((await t.call("POST", "/api/auth/password", { current: "nope-nope-nope", next: "another long passphrase 1" }, c1)).status, 400);
    assert.equal((await t.call("POST", "/api/auth/password", { current: PW, next: "short" }, c1)).status, 400);
    assert.equal((await t.call("POST", "/api/auth/password", { current: PW, next: "another long passphrase 1" }, c1)).status, 200);
    assert.equal((await t.call("GET", "/api/status", undefined, c1)).status, 200); // this session stays
    assert.equal((await t.call("GET", "/api/status", undefined, c2)).status, 401); // the other one is gone
    assert.equal((await t.call("POST", "/api/auth/login", { email: "ada@x.com", password: PW })).status, 401);
    const lo = await t.call("POST", "/api/auth/logout", {}, c1);
    assert.equal(lo.status, 200); assert.match(lo.headers.get("set-cookie"), /Max-Age=0/);
    assert.equal((await t.call("GET", "/api/status", undefined, c1)).status, 401);
  } finally { t.close(); }
});

test("auth: the gate - no cookie means 401 on the API, a redirect on the page, and the login page and its assets stay public", async () => {
  const t = await boot();
  try {
    assert.equal((await t.call("GET", "/api/status")).status, 401);
    assert.equal((await (await t.call("GET", "/api/status")).json()).login, "/login");
    assert.equal((await t.call("GET", "/api/auth/me")).status, 401);
    const home = await t.call("GET", "/");
    assert.equal(home.status, 302); assert.equal(home.headers.get("location"), "/login");
    const page = await t.call("GET", "/login");
    assert.equal(page.status, 200); assert.match(await page.text(), /<script src="\/ui\/login\.js">/);
    for (const a of ["/ui/login.css", "/ui/login.js", "/ui/logo.png"]) assert.equal((await t.call("GET", a)).status, 200, a);
    assert.equal((await t.call("GET", "/ui/app.js")).status, 401); // the dashboard's own code needs a session
    // signed in: the page loads and /login bounces back to it
    await t.call("POST", "/api/auth/signup", { name: "Ada", email: "ada@x.com", password: PW });
    const c = t.cookieOf(await t.call("POST", "/api/auth/login", { email: "ada@x.com", password: PW }));
    assert.equal((await t.call("GET", "/", undefined, c)).status, 200);
    assert.equal((await t.call("GET", "/ui/app.js", undefined, c)).status, 200);
    const back = await t.call("GET", "/login", undefined, c);
    assert.equal(back.status, 302); assert.equal(back.headers.get("location"), "/");
  } finally { t.close(); }
});

test("auth: cross-site and header-less state changes are refused; every response carries the security headers", async () => {
  const t = await boot();
  try {
    await t.call("POST", "/api/auth/signup", { name: "Ada", email: "ada@x.com", password: PW });
    const c = t.cookieOf(await t.call("POST", "/api/auth/login", { email: "ada@x.com", password: PW }));
    // foreign Origin: refused by the host allowlist
    assert.equal((await t.call("POST", "/api/auth/logout", {}, c, { origin: "https://evil.example" })).status, 403);
    // no X-Requested-With and no Origin: refused
    const bare = await fetch(t.base + "/api/auth/logout", { method: "POST", headers: { "content-type": "application/json", cookie: c }, body: "{}" });
    assert.equal(bare.status, 403);
    // a same-host Origin is accepted without the header (what a browser sends from the dashboard)
    const own = await fetch(t.base + "/api/auth/password", { method: "POST", headers: { "content-type": "application/json", cookie: c, origin: t.base }, body: JSON.stringify({ current: "x", next: "y" }) });
    assert.equal(own.status, 400); // got past the CSRF check; the password itself was wrong
    const r = await t.call("GET", "/login");
    assert.match(r.headers.get("content-security-policy"), /script-src 'self'/);
    assert.match(r.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    assert.equal(r.headers.get("x-frame-options"), "DENY");
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.equal(r.headers.get("referrer-policy"), "no-referrer");
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.ok((await t.call("GET", "/api/status")).headers.get("content-security-policy")); // on API errors too
    // a non-JSON body is not accepted for an admin write
    assert.equal((await fetch(t.base + "/api/run", { method: "POST", headers: { "content-type": "text/plain", "x-requested-with": "hivemind", cookie: c }, body: "x" })).status, 415);
  } finally { t.close(); }
});

test("auth: a per-IP limit stops floods of sign-in and sign-up attempts", async () => {
  const keep = process.env.HIVEMIND_AUTH_IP_LIMIT;
  process.env.HIVEMIND_AUTH_IP_LIMIT = "4";
  const t = await boot();
  try {
    let last;
    for (let i = 0; i < 6; i++) last = await t.call("POST", "/api/auth/login", { email: `u${i}@x.com`, password: "wrong-password" });
    assert.equal(last.status, 429);
    assert.ok(+last.headers.get("retry-after") > 0);
  } finally { t.close(); process.env.HIVEMIND_AUTH_IP_LIMIT = keep; }
});

test("auth: sign-in can be switched off explicitly, and then behaves as before", async () => {
  const root = mkdtempSync(join(tmpdir(), "noauth-"));
  mkdirSync(join(root, "src")); mkdirSync(join(root, "data"));
  cpSync(new URL("../config", import.meta.url), join(root, "config"), { recursive: true });
  copyFileSync(new URL("../src/dashboard.html", import.meta.url), join(root, "src", "dashboard.html"));
  const { serve } = await import("../src/server.mjs");
  const warnings = [];
  const server = await serve({ root, bcg, port: 0, autoSync: false, auth: false, log: (m) => warnings.push(m) });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(base + "/api/status")).status, 200);
    assert.ok(warnings.some((m) => /sign-in is switched OFF/.test(m)));
    assert.ok((await fetch(base + "/api/status")).headers.get("x-frame-options")); // headers still apply
  } finally { server.close(); }
});

test("members: pages and data meant for administrators are closed to normal accounts, and the status they get carries no service details", async () => {
  const t = await boot();
  try {
    await t.call("POST", "/api/auth/signup", { name: "Ada Admin", email: "ada@x.com", password: PW });
    await t.call("POST", "/api/auth/signup", { name: "Bob Member", email: "bob@x.com", password: PW });
    const adminC = t.cookieOf(await t.call("POST", "/api/auth/login", { email: "ada@x.com", password: PW }));
    const bob = (await (await t.call("GET", "/api/users", undefined, adminC)).json()).users.find((u) => u.email === "bob@x.com");
    await t.call("POST", "/api/users/approve", { id: bob.id }, adminC);
    const memC = t.cookieOf(await t.call("POST", "/api/auth/login", { email: "bob@x.com", password: PW }));
    for (const p of ["/api/integrations", "/api/usage", "/api/logs", "/api/quality", "/api/sources", "/api/journalists", "/api/journalists/status", "/api/notifications", "/api/system", "/api/companies", "/api/audit/queue", "/api/backtest", "/api/tuning"]) {
      assert.equal((await t.call("GET", p, undefined, memC)).status, 403, `${p} should be closed to members`);
      assert.notEqual((await t.call("GET", p, undefined, adminC)).status, 403, `${p} should be open to admins`);
    }
    // what a member may read still works
    for (const p of ["/api/overview", "/api/opportunities", "/api/labels?level=topic", "/api/entities", "/api/sentiment"]) assert.equal((await t.call("GET", p, undefined, memC)).status, 200, p);
    const ms = await (await t.call("GET", "/api/status", undefined, memC)).json(), as = await (await t.call("GET", "/api/status", undefined, adminC)).json();
    assert.deepEqual(ms.integrations, []); assert.ok(as.integrations.length > 0);
    assert.equal(ms.journalists, undefined);
  } finally { t.close(); }
});

test("members: every read endpoint the Trends and Opportunities pages call answers them (no 403 and no missing status fields)", async () => {
  const t = await boot();
  try {
    await t.call("POST", "/api/auth/signup", { name: "Ada Admin", email: "ada@x.com", password: PW });
    await t.call("POST", "/api/auth/signup", { name: "Pooja Rana", email: "pooja@x.com", password: PW });
    const adminC = t.cookieOf(await t.call("POST", "/api/auth/login", { email: "ada@x.com", password: PW }));
    const id = (await (await t.call("GET", "/api/users", undefined, adminC)).json()).users.find((u) => u.email === "pooja@x.com").id;
    await t.call("POST", "/api/users/approve", { id }, adminC);
    const memC = t.cookieOf(await t.call("POST", "/api/auth/login", { email: "pooja@x.com", password: PW }));
    const st = await (await t.call("GET", "/api/status", undefined, memC)).json();
    assert.ok(st.searchInterest && "configured" in st.searchInterest, "the page reads searchInterest.configured");
    for (const p of ["/api/labels?level=topic", "/api/labels?level=bracket", "/api/series?keys=b:economy", "/api/social?name=economy", "/api/entities", "/api/sentiment", "/api/origins?key=all", "/api/dates", "/api/config"]) {
      const r = await t.call("GET", p, undefined, memC);
      assert.notEqual(r.status, 403, `${p} must stay open to members`); assert.notEqual(r.status, 401, p);
    }
  } finally { t.close(); }
});
