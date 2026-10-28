// Accounts, sessions and the request gate. Everything here uses node:crypto only.
//
//   passwords   scrypt (N=2^15, r=8, p=1), a fresh 16-byte salt each, verified in constant time; unknown emails still cost one hash,
//               so timing and the error text never reveal whether an account exists.
//   sessions    a random 256-bit token in an HttpOnly, SameSite=Strict cookie; only its SHA-256 is stored. Rotated on login,
//               7 days absolute, 12 hours idle, deleted on logout / password change / reset / disable.
//   sign-up     the very first account becomes the administrator; every later one waits (status "pending") for an admin to approve it.
//   throttling  5 wrong passwords for one email lock that email for 15 minutes; 20 sign-in or sign-up attempts per IP per 10 minutes.
//   CSRF        the cookie is SameSite=Strict, bodies must be JSON, and every state-changing /api request must carry the header
//               "x-requested-with: hivemind" OR an Origin that is exactly this server's own host (cross-site pages can send neither).
//   roles       admin: everything. member: read endpoints, drafting briefs and deciding on them, reviewing audit items.
import { randomBytes, randomUUID, createHash, scrypt, timingSafeEqual } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };
const COOKIE = "hm_session";
const ABSOLUTE_MS = 7 * 864e5, IDLE_MS = 12 * 3600e3, LOCK_MS = 15 * 60e3, MAX_FAILS = 5, IP_WINDOW_MS = 10 * 60e3;
const MAX_BODY = 8192;
const GENERIC = "Incorrect email or password.";

// ---------------------------------------------------------------- password hashing and policy
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}
export async function verifyPassword(password, encoded) {
  try {
    const [kind, N, r, p, salt, hash] = String(encoded).split("$");
    if (kind !== "scrypt" || +N > 1 << 17 || +r > 16 || +p > 4) return false; // refuse absurd parameters from a tampered row
    const want = Buffer.from(hash, "base64");
    const got = await scryptAsync(password, Buffer.from(salt, "base64"), want.length, { N: +N, r: +r, p: +p, maxmem: 256 * 1024 * 1024 });
    return got.length === want.length && timingSafeEqual(got, want);
  } catch { return false; }
}
const COMMON = new Set(["password", "password1", "password12", "password123", "passw0rd123", "qwerty123456", "qwertyuiop", "1234567890", "12345678910", "123456789012", "letmein1234", "welcome1234", "iloveyou123", "admin12345", "administrator", "hivemind123", "changeme123", "abcdefghij", "0123456789", "1q2w3e4r5t", "qazwsxedcrfv", "password!23", "trustno1234", "monkey12345"]);
export function passwordProblem(password, { email = "", name = "" } = {}) {
  const pw = String(password ?? "");
  if (pw.length < 10) return "Use at least 10 characters.";
  if (pw.length > 200) return "That password is too long (200 characters at most).";
  const low = pw.toLowerCase(), local = String(email).toLowerCase().split("@")[0];
  if (COMMON.has(low) || /^(.)\1+$/.test(pw) || /^(0123456789|1234567890|abcdefghij)/i.test(pw)) return "That password is too easy to guess. Try a longer phrase.";
  if (low === String(email).toLowerCase() || (local.length >= 4 && low.includes(local)) || (String(name).trim().length >= 4 && low.includes(String(name).trim().toLowerCase()))) return "Don't use your name or email in the password.";
  if (new Set(pw).size < 5) return "Use a more varied password.";
  return null;
}
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const normEmail = (e) => String(e ?? "").trim().toLowerCase();

// ---------------------------------------------------------------- security headers (every response)
export function setSecurityHeaders(res) {
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
}

// ---------------------------------------------------------------- request helpers
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > MAX_BODY) { reject(Object.assign(new Error("Request too large"), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { const t = Buffer.concat(chunks).toString("utf8"); const v = t ? JSON.parse(t) : {}; resolve(v && typeof v === "object" && !Array.isArray(v) ? v : {}); } catch { reject(Object.assign(new Error("Invalid JSON"), { status: 400 })); } });
    req.on("error", reject);
  });
}
const clientIp = (req) => {
  if (process.env.HIVEMIND_TRUST_PROXY === "1") { const f = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim(); if (f) return f; }
  return String(req.socket?.remoteAddress || "unknown").replace(/^::ffff:/, "");
};
const parseCookies = (h) => Object.fromEntries(String(h || "").split(";").map((c) => c.trim()).filter(Boolean).map((c) => { const i = c.indexOf("="); return i < 0 ? [c, ""] : [c.slice(0, i), c.slice(i + 1)]; }));
const isHttps = (req) => !!req.socket?.encrypted || String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https" || process.env.HIVEMIND_COOKIE_SECURE === "1";
const cookieHeader = (req, token, maxAgeSec) => `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}${isHttps(req) ? "; Secure" : ""}`;
const send = (res, code, obj, headers = {}) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store", ...headers }); res.end(JSON.stringify(obj)); };
const redirect = (res, to) => { res.writeHead(302, { location: to, "cache-control": "no-store" }); res.end(); };

// Same-origin proof for state-changing requests (see the header comment).
export const csrfOk = (req) => {
  if (String(req.headers["x-requested-with"] || "").toLowerCase() === "hivemind") return true;
  const o = req.headers.origin;
  if (!o) return false;
  try { return new URL(o).host === req.headers.host; } catch { return false; }
};

const PUBLIC_ASSETS = new Set(["/ui/login.css", "/ui/login.js", "/ui/logo.png", "/ui/wordmark.png"]);
// What a member (non-admin) may change. Everything else that changes state is admin-only.
// Pages and data a normal (member) account must not read, even by calling the API directly.
const MEMBER_DENY_GET = [/^\/api\/(integrations|system|usage|logs|quality|tuning|outcomes|forecast-accuracy|backtest|notifications|companies|authors|journalists|sources)(\/|$)/, /^\/api\/audit\//];
const MEMBER_WRITES = new Set(["/api/brief", "/api/brief/decide", "/api/audit/review", "/api/auth/logout", "/api/auth/password"]);
const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const tempPassword = () => Array.from(randomBytes(16), (b) => alphabet[b % alphabet.length]).join("");

// ---------------------------------------------------------------- the module
export function createAuth({ store, log = () => {}, root }) {
  const db = store.db;
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, pw_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member',
      status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL, last_login_at INTEGER, failed_count INTEGER NOT NULL DEFAULT 0, locked_until INTEGER);
    CREATE TABLE IF NOT EXISTS sessions (
      id_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, expires_at INTEGER NOT NULL, ip TEXT, ua TEXT);
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
    CREATE TABLE IF NOT EXISTS auth_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, event TEXT NOT NULL, email TEXT, ip TEXT, detail TEXT);
    CREATE INDEX IF NOT EXISTS auth_log_ts ON auth_log(ts);
  `);
  const ipLimit = Math.max(1, +process.env.HIVEMIND_AUTH_IP_LIMIT || 20);
  const ipHits = new Map(), emailFails = new Map(); // in-memory throttles (the email lock for real users is also persisted)
  let dummy = null;
  const dummyHash = () => (dummy ??= hashPassword(randomBytes(12).toString("hex")));

  const audit = (event, email, ip, detail = "") => { try { db.prepare("INSERT INTO auth_log (ts, event, email, ip, detail) VALUES (?, ?, ?, ?, ?)").run(Date.now(), event, email ?? null, ip ?? null, String(detail).slice(0, 200)); } catch { /* never block a request on the log */ } };
  const userByEmail = (email) => db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  const userById = (id) => db.prepare("SELECT * FROM users WHERE id = ?").get(id);
  const pub = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role });
  const activeAdmins = () => db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active'").get().n;
  const userCount = () => db.prepare("SELECT COUNT(*) AS n FROM users").get().n;

  const ipAllowed = (ip) => {
    const now = Date.now(), arr = (ipHits.get(ip) ?? []).filter((t) => now - t < IP_WINDOW_MS);
    if (arr.length >= ipLimit) { ipHits.set(ip, arr); return Math.ceil((IP_WINDOW_MS - (now - arr[0])) / 1000); }
    arr.push(now); ipHits.set(ip, arr); return 0;
  };
  const lockedFor = (email, user) => {
    const until = Math.max(user?.locked_until ?? 0, emailFails.get(email)?.until ?? 0);
    return until > Date.now() ? Math.ceil((until - Date.now()) / 1000) : 0;
  };
  const registerFailure = (email, user) => {
    const f = emailFails.get(email) ?? { count: 0, until: 0 };
    if (f.until && f.until <= Date.now()) { f.count = 0; f.until = 0; }
    f.count++;
    if (f.count >= MAX_FAILS) { f.until = Date.now() + LOCK_MS; f.count = 0; }
    emailFails.set(email, f);
    if (user) db.prepare("UPDATE users SET failed_count = ?, locked_until = ? WHERE id = ?").run(f.count, f.until || null, user.id);
  };
  const clearFailures = (email, user) => { emailFails.delete(email); if (user) db.prepare("UPDATE users SET failed_count = 0, locked_until = NULL WHERE id = ?").run(user.id); };

  // ---- sessions
  const createSession = (req, userId) => {
    const token = randomBytes(32).toString("base64url"), now = Date.now();
    db.prepare("INSERT INTO sessions (id_hash, user_id, created_at, last_seen, expires_at, ip, ua) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(sha256(token), userId, now, now, now + ABSOLUTE_MS, clientIp(req), String(req.headers["user-agent"] || "").slice(0, 200));
    return token;
  };
  const tokenOf = (req) => parseCookies(req.headers.cookie)[COOKIE] || null;
  const sessionUser = (req) => {
    const token = tokenOf(req);
    if (!token || token.length > 100) return null;
    const idh = sha256(token), s = db.prepare("SELECT * FROM sessions WHERE id_hash = ?").get(idh), now = Date.now();
    if (!s) return null;
    if (s.expires_at <= now || now - s.last_seen > IDLE_MS) { db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(idh); return null; }
    const u = userById(s.user_id);
    if (!u || u.status !== "active") { db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(idh); return null; }
    if (now - s.last_seen > 60e3) db.prepare("UPDATE sessions SET last_seen = ? WHERE id_hash = ?").run(now, idh);
    return { ...u, _sid: idh };
  };
  const dropSessions = (userId, exceptHash = null) => db.prepare("DELETE FROM sessions WHERE user_id = ? AND id_hash != ?").run(userId, exceptHash ?? "");
  const sweep = () => { const now = Date.now(); try { db.prepare("DELETE FROM sessions WHERE expires_at <= ? OR last_seen < ?").run(now, now - IDLE_MS); } catch { /* closing */ } };
  const timer = setInterval(sweep, 10 * 60e3); timer.unref();
  sweep();

  // ---- handlers
  async function login(req, res) {
    const ip = clientIp(req), wait = ipAllowed(ip);
    if (wait) return send(res, 429, { error: `Too many attempts. Try again in ${Math.ceil(wait / 60)} minute(s).`, retryAfter: wait }, { "retry-after": String(wait) });
    const b = await readJson(req), email = normEmail(b.email), password = typeof b.password === "string" ? b.password : "";
    if (!email || email.length > 254 || !password || password.length > 200) return send(res, 400, { error: "Enter your email and password." });
    const user = userByEmail(email), lock = lockedFor(email, user);
    if (lock) { audit("login_locked", email, ip); return send(res, 429, { error: `Too many failed attempts. Try again in ${Math.ceil(lock / 60)} minute(s).`, retryAfter: lock }, { "retry-after": String(lock) }); }
    const ok = await verifyPassword(password, user?.pw_hash ?? await dummyHash());
    if (!user || !ok) { registerFailure(email, user); audit("login_fail", email, ip); return send(res, 401, { error: GENERIC }); }
    if (user.status === "pending") { audit("login_pending", email, ip); return send(res, 403, { error: "Your request is waiting for approval by an administrator.", status: "pending" }); }
    if (user.status !== "active") { audit("login_disabled", email, ip); return send(res, 403, { error: "This account is disabled. Contact an administrator.", status: "disabled" }); }
    clearFailures(email, user);
    const old = tokenOf(req); if (old) db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(sha256(old)); // rotate: never keep a pre-login token
    const token = createSession(req, user.id);
    db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(Date.now(), user.id);
    audit("login_ok", email, ip);
    return send(res, 200, { ok: true, user: pub(user) }, { "set-cookie": cookieHeader(req, token, Math.floor(ABSOLUTE_MS / 1000)) });
  }

  async function signup(req, res) {
    const ip = clientIp(req), wait = ipAllowed(ip);
    if (wait) return send(res, 429, { error: `Too many attempts. Try again in ${Math.ceil(wait / 60)} minute(s).`, retryAfter: wait }, { "retry-after": String(wait) });
    const b = await readJson(req), email = normEmail(b.email), name = String(b.name ?? "").trim().replace(/\s+/g, " "), password = typeof b.password === "string" ? b.password : "";
    if (name.length < 1 || name.length > 80) return send(res, 400, { error: "Enter your name (up to 80 characters)." });
    if (!EMAIL_RE.test(email) || email.length > 254) return send(res, 400, { error: "Enter a valid email address." });
    const problem = passwordProblem(password, { email, name });
    if (problem) return send(res, 400, { error: problem });
    const hash = await hashPassword(password); // also equalises timing with the "already registered" path below
    let first = false, created = false;
    db.exec("BEGIN IMMEDIATE");
    try {
      if (!userByEmail(email)) {
        first = userCount() === 0;
        db.prepare("INSERT INTO users (id, email, name, pw_hash, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(randomUUID(), email, name, hash, first ? "admin" : "member", first ? "active" : "pending", Date.now());
        created = true;
      }
      db.exec("COMMIT");
    } catch (e) { try { db.exec("ROLLBACK"); } catch { /* none */ } throw e; }
    audit(created ? (first ? "signup_admin" : "signup") : "signup_existing", email, ip);
    // An address that is already registered gets the same answer, so sign-up cannot be used to discover who has an account.
    return send(res, 200, { ok: true, status: first ? "active" : "pending", first });
  }

  const logout = (req, res) => {
    const t = tokenOf(req); if (t) db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(sha256(t));
    return send(res, 200, { ok: true }, { "set-cookie": cookieHeader(req, "", 0) });
  };

  async function changePassword(req, res, u) {
    const b = await readJson(req), cur = typeof b.current === "string" ? b.current : "", next = typeof b.next === "string" ? b.next : "";
    if (!(await verifyPassword(cur, u.pw_hash))) { audit("password_fail", u.email, clientIp(req)); return send(res, 400, { error: "Your current password is not correct." }); }
    const problem = passwordProblem(next, { email: u.email, name: u.name });
    if (problem) return send(res, 400, { error: problem });
    db.prepare("UPDATE users SET pw_hash = ? WHERE id = ?").run(await hashPassword(next), u.id);
    dropSessions(u.id, u._sid);
    audit("password_change", u.email, clientIp(req));
    return send(res, 200, { ok: true });
  }

  async function adminUsers(req, res, p, u) {
    if (req.method === "GET" && p === "/api/users") {
      const users = db.prepare("SELECT id, name, email, role, status, created_at, last_login_at FROM users ORDER BY created_at").all()
        .map((x) => ({ id: x.id, name: x.name, email: x.email, role: x.role, status: x.status, createdAt: x.created_at, lastLoginAt: x.last_login_at }));
      return send(res, 200, { users });
    }
    if (req.method !== "POST") return send(res, 405, { error: "Method not allowed" });
    const b = await readJson(req), target = userById(String(b.id ?? ""));
    if (!target) return send(res, 404, { error: "Unknown user" });
    const action = p.slice("/api/users/".length), self = target.id === u.id, lastAdmin = target.role === "admin" && target.status === "active" && activeAdmins() <= 1;
    if (action === "approve" || action === "enable") {
      db.prepare("UPDATE users SET status = 'active', failed_count = 0, locked_until = NULL WHERE id = ?").run(target.id); emailFails.delete(target.email);
      audit(action, target.email, clientIp(req), `by ${u.email}`); return send(res, 200, { ok: true });
    }
    if (action === "disable") {
      if (self) return send(res, 400, { error: "You can't disable your own account." });
      if (lastAdmin) return send(res, 400, { error: "At least one active administrator is required." });
      db.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(target.id); dropSessions(target.id);
      audit("disable", target.email, clientIp(req), `by ${u.email}`); return send(res, 200, { ok: true });
    }
    if (action === "role") {
      if (!["admin", "member"].includes(b.role)) return send(res, 400, { error: "Role must be admin or member." });
      if (b.role === "member" && (self || lastAdmin)) return send(res, 400, { error: self ? "You can't remove your own administrator role." : "At least one active administrator is required." });
      db.prepare("UPDATE users SET role = ? WHERE id = ?").run(b.role, target.id); dropSessions(target.id);
      audit("role", target.email, clientIp(req), `${b.role} by ${u.email}`); return send(res, 200, { ok: true });
    }
    if (action === "reset") {
      const temp = tempPassword();
      db.prepare("UPDATE users SET pw_hash = ?, failed_count = 0, locked_until = NULL WHERE id = ?").run(await hashPassword(temp), target.id);
      emailFails.delete(target.email); dropSessions(target.id);
      audit("reset", target.email, clientIp(req), `by ${u.email}`); return send(res, 200, { ok: true, temporaryPassword: temp });
    }
    return send(res, 404, { error: "Unknown action" });
  }

  const loginPage = () => { const f = join(root, "src", "login.html"); return existsSync(f) ? readFileSync(f) : Buffer.from("<h1>Login page missing</h1>"); };
  const WRITE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

  // Returns true when the response has been sent (login page, redirect, auth route, or a refusal); false to let the server carry on.
  async function handle(req, res, url, p) {
    try {
      if (p === "/login") {
        if (req.method !== "GET" && req.method !== "HEAD") { send(res, 405, { error: "Method not allowed" }); return true; }
        if (sessionUser(req)) { redirect(res, "/"); return true; }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); res.end(loginPage()); return true;
      }
      if (PUBLIC_ASSETS.has(p)) return false;
      const u = sessionUser(req);
      if (p === "/" || p === "/index.html") { if (!u) { redirect(res, "/login"); return true; } req.user = u; return false; }
      if (p.startsWith("/ui/")) { if (!u) { send(res, 401, { error: "auth", login: "/login" }); return true; } return false; }
      if (!p.startsWith("/api/")) return false;

      if (WRITE.has(req.method) && !csrfOk(req)) { send(res, 403, { error: "Missing same-origin header (X-Requested-With: hivemind)." }); return true; }
      if (req.method === "GET" && p === "/api/auth/state") { send(res, 200, { setup: userCount() === 0 }); return true; }
      if (req.method === "POST" && p === "/api/auth/login") { await login(req, res); return true; }
      if (req.method === "POST" && p === "/api/auth/signup") { await signup(req, res); return true; }
      if (req.method === "GET" && p === "/api/auth/me") { if (!u) send(res, 401, { error: "auth", login: "/login" }); else send(res, 200, { user: pub(u) }); return true; }
      if (!u) { send(res, 401, { error: "auth", login: "/login" }); return true; }
      req.user = u;
      if (req.method === "POST" && p === "/api/auth/logout") { logout(req, res); return true; }
      if (req.method === "POST" && p === "/api/auth/password") { await changePassword(req, res, u); return true; }
      if (req.method === "GET" && u.role !== "admin" && MEMBER_DENY_GET.some((r) => r.test(p))) { send(res, 403, { error: "Admin only" }); return true; }
      const isAdminArea = p === "/api/users" || p.startsWith("/api/users/");
      if (isAdminArea || (WRITE.has(req.method) && !MEMBER_WRITES.has(p))) {
        if (u.role !== "admin") { send(res, 403, { error: "Admin only" }); return true; }
        if (isAdminArea) { await adminUsers(req, res, p, u); return true; }
      }
      return false;
    } catch (e) {
      if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : "Something went wrong." });
      return true;
    }
  }

  return { handle, sessionUser, userCount, stop: () => clearInterval(timer) };
}
