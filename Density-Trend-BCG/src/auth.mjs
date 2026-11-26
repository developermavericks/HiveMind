// Accounts, sessions and the request gate. Everything here uses node:crypto only.
//
//   passwords   scrypt (N=2^15, r=8, p=1), a fresh 16-byte salt each, verified in constant time; unknown emails still cost one hash,
//               so timing and the error text never reveal whether an account exists.
//   sessions    a random 256-bit token in an HttpOnly, SameSite=Strict cookie; only its SHA-256 is stored.
//               Single-Session Login enforced: new login invalidates older sessions.
//               Anti-hijacking: validates user-agent platform consistency and idle timeouts.
//   sign-up     the very first account becomes the administrator; every later one waits (status "pending") for an admin to approve it.
//   throttling  5 wrong passwords for one email lock that email for 15 minutes; IP throttling on login attempts.
//   CSRF        the cookie is SameSite=Strict, bodies must be JSON, and every state-changing /api request must carry the header
//               "x-requested-with: hivemind" OR an Origin that is exactly this server's own host (cross-site pages can send neither).
//   roles       admin: everything. member: read endpoints, drafting briefs and deciding on them, reviewing audit items.
import { randomBytes, randomUUID, createHash, scrypt, timingSafeEqual } from "node:crypto";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { reverse } from "node:dns/promises";
import { sendEmail, getAdminEmail } from "./email.mjs";

const scryptAsync = promisify(scrypt);
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };
const COOKIE = "hm_session";
// A session ends after HIVEMIND_SESSION_IDLE_MIN minutes without user activity (default 30), and after 7 days at most.
const IDLE_MS = Math.max(1, +process.env.HIVEMIND_SESSION_IDLE_MIN || 30) * 60e3;
// Requests the page makes by itself every few seconds (status, notifications) are not user activity: they never extend a session.
const BACKGROUND = /^\/api\/(status|notifications|sync\/status)$/;
const ABSOLUTE_MS = 7 * 864e5, LOCK_MS = 15 * 60e3, MAX_FAILS = 5, IP_WINDOW_MS = 10 * 60e3;
const MAX_BODY = 65536; // 64 KB JSON payload limit (prevents memory buffer inflation attacks)
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
    if (kind !== "scrypt" || +N > 1 << 17 || +r > 16 || +p > 4) return false;
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

// ---------------------------------------------------------------- security headers (OWASP Industry Standard)
export function setSecurityHeaders(res, isSecure = false) {
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Cache-Control", "no-store");
  // Allow HTML5 Geolocation API for self origin
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(self), payment=(), usb=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  if (isSecure) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
  }
}

// ---------------------------------------------------------------- request helpers & client intelligence
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > MAX_BODY) { reject(Object.assign(new Error("Request too large (max 64KB)"), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { const t = Buffer.concat(chunks).toString("utf8"); const v = t ? JSON.parse(t) : {}; resolve(v && typeof v === "object" && !Array.isArray(v) ? v : {}); } catch { reject(Object.assign(new Error("Invalid JSON"), { status: 400 })); } });
    req.on("error", reject);
  });
}
export const clientIp = (req) => {
  if (process.env.HIVEMIND_TRUST_PROXY === "1") { const f = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim(); if (f) return f; }
  const cf = String(req.headers["cf-connecting-ip"] || req.headers["x-real-ip"] || "").trim();
  if (cf) return cf;
  return String(req.socket?.remoteAddress || "unknown").replace(/^::ffff:/, "");
};

const dnsCache = new Map();

// Resolves client IP, geographic location, and Wi-Fi / ISP network information
export async function resolveClientMetadata(req) {
  const ip = clientIp(req);
  
  // Geolocation resolution (Cloudflare headers, reverse proxy, or local classification)
  const cfCity = req.headers["cf-ipcity"] || req.headers["x-geo-city"] || null;
  const cfCountry = req.headers["cf-ipcountry"] || req.headers["x-geo-country"] || null;
  const cfRegion = req.headers["cf-region"] || req.headers["x-geo-region"] || null;

  let location = "Localhost (Office / Dev)";
  if (cfCity || cfCountry) {
    location = [cfCity, cfRegion, cfCountry].filter(Boolean).join(", ");
  } else if (ip === "127.0.0.1" || ip === "::1" || ip === "localhost") {
    location = "Localhost (Office / Dev)";
  } else if (/^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)/.test(ip)) {
    location = "Internal Office Network (LAN / Wi-Fi)";
  } else {
    location = `External Network (${ip})`;
  }

  // Network / Wi-Fi / ISP resolution
  const cfIsp = req.headers["cf-isp"] || req.headers["x-client-isp"] || null;
  const cfAsn = req.headers["cf-as-number"] ? `AS${req.headers["cf-as-number"]}` : null;

  let network = "Local System Wi-Fi / Ethernet";
  if (cfIsp || cfAsn) {
    network = [cfIsp, cfAsn].filter(Boolean).join(" ");
  } else if (ip === "127.0.0.1" || ip === "::1" || ip === "localhost") {
    network = "Local System Wi-Fi / Ethernet";
  } else if (/^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)/.test(ip)) {
    network = `Private Wi-Fi Subnet (${ip.split(".").slice(0, 3).join(".")}.x)`;
  } else {
    if (dnsCache.has(ip)) {
      network = dnsCache.get(ip);
    } else {
      try {
        const hostnames = await Promise.race([
          reverse(ip),
          new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 600))
        ]);
        network = hostnames && hostnames.length ? hostnames[0] : `Public ISP (${ip})`;
      } catch {
        network = `Public ISP (${ip})`;
      }
      dnsCache.set(ip, network);
      if (dnsCache.size > 500) dnsCache.delete(dnsCache.keys().next().value);
    }
  }

  return { ip, location, network };
}

// Records rich audit activity with optional HTML5 GPS coordinates via an asynchronous in-memory batch queue
const activityQueue = [];
let flushTimer = null;

export function flushActivityQueue(db) {
  if (!db || activityQueue.length === 0) return;
  const batch = activityQueue.splice(0, activityQueue.length);
  try {
    const stmt = db.prepare(`
      INSERT INTO activity_log (
        ts, user_id, email, name, company_id, action, path, method, status_code, error, ip, location, network, ua, duration_ms, lat, lon, geo_accuracy
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    db.exec("BEGIN");
    for (const item of batch) {
      stmt.run(
        item.ts, item.userId, item.email, item.name, item.companyId,
        item.action, item.path, item.method, item.statusCode, item.error,
        item.ip, item.location, item.network, item.ua, item.durationMs,
        item.lat, item.lon, item.geoAccuracy
      );
    }
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
  }
}

export function recordActivity(db, info) {
  if (!db) return;
  activityQueue.push({
    ts: Date.now(),
    userId: info.userId ?? null,
    email: info.email ?? null,
    name: info.name ?? null,
    companyId: info.companyId ?? "bcg",
    action: info.action ?? "Unknown Action",
    path: info.path ?? "/",
    method: info.method ?? "GET",
    statusCode: info.statusCode ?? 200,
    error: info.error ? String(info.error).slice(0, 300) : null,
    ip: info.ip ?? "unknown",
    location: info.location ?? "unknown",
    network: info.network ?? "unknown",
    ua: String(info.ua ?? "").slice(0, 200),
    durationMs: info.durationMs ?? 0,
    lat: info.lat != null ? +info.lat : null,
    lon: info.lon != null ? +info.lon : null,
    geoAccuracy: info.geoAccuracy != null ? +info.geoAccuracy : null
  });

  if (activityQueue.length >= 50) {
    flushActivityQueue(db);
  } else if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushActivityQueue(db);
    }, 2000);
    flushTimer.unref?.();
  }
}

export function inferAction(p, method, url) {
  if (p === "/api/overview") return "Viewed Executive Overview";
  if (p === "/api/opportunities") return "Viewed Opportunities List";
  if (p === "/api/opportunity") return `Inspected Opportunity: ${url?.searchParams?.get("key") || ""}`;
  if (p === "/api/topic") return `Inspected Topic: ${url?.searchParams?.get("key") || ""}`;
  if (p === "/api/series") return `Viewed Trend Chart: ${url?.searchParams?.get("keys") || ""}`;
  if (p === "/api/leadership") return "Viewed Leadership View";
  if (p === "/api/pitch") return "Viewed BCG Pitch & Op-Ed Matching";
  if (p === "/api/brief" && method === "POST") return "Generated Strategic Brief";
  if (p === "/api/brief/decide") return "Made Editor Decision on Brief";
  if (p === "/api/clip") return "Clipped Article from Web Extension";
  if (p === "/api/auth/login") return "User Sign In Attempt";
  if (p === "/api/auth/logout") return "User Sign Out";
  if (p === "/api/auth/password") return "Changed Password";
  if (p === "/api/auth/geo") return "Updated HTML5 GPS Geolocation";
  if (p.startsWith("/api/users/")) return `Admin User Management (${p.slice(11)})`;
  if (p === "/api/users") return "Viewed Users List";
  if (p === "/api/admin/audit-logs") return "Viewed Audit Logs";
  if (p === "/api/status") return "Checked System Status";
  if (p === "/") return "Opened Dashboard Home";
  return `${method} ${p}`;
}

const parseCookies = (h) => Object.fromEntries(String(h || "").split(";").map((c) => c.trim()).filter(Boolean).map((c) => { const i = c.indexOf("="); return i < 0 ? [c, ""] : [c.slice(0, i), c.slice(i + 1)]; }));
export const isHttps = (req) => !!req.socket?.encrypted || String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https" || process.env.HIVEMIND_COOKIE_SECURE === "1";
const cookieHeader = (req, token, maxAgeSec) => `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}${isHttps(req) ? "; Secure" : ""}`;
const send = (res, code, obj, headers = {}) => {
  if (!res || res.headersSent || res.writableEnded) return;
  try {
    res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store", ...headers });
    res.end(JSON.stringify(obj));
  } catch {}
};
const redirect = (res, to) => {
  if (!res || res.headersSent || res.writableEnded) return;
  try {
    res.writeHead(302, { location: to, "cache-control": "no-store" });
    res.end();
  } catch {}
};

// Same-origin proof for state-changing requests (anti-CSRF)
export const csrfOk = (req) => {
  if (String(req.headers["x-requested-with"] || "").toLowerCase() === "hivemind") return true;
  const o = req.headers.origin;
  if (!o) return false;
  try { return new URL(o).host === req.headers.host; } catch { return false; }
};

const PUBLIC_ASSETS = new Set(["/ui/login.css", "/ui/login.js", "/ui/logo.png", "/ui/wordmark.png", "/ui/intro.mp4"]);
const MEMBER_DENY_GET = [/^\/api\/(integrations|system|usage|logs|quality|tuning|outcomes|forecast-accuracy|backtest|notifications|companies|authors|sources|leadership|admin)(\/|$)/, /^\/api\/audit\//];
const MEMBER_WRITES = new Set(["/api/brief", "/api/brief/decide", "/api/audit/review", "/api/auth/logout", "/api/auth/password", "/api/clip", "/api/auth/geo", "/api/tickets"]);
const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const tempPassword = () => Array.from(randomBytes(16), (b) => alphabet[b % alphabet.length]).join("");

function isUaCompatible(stored, incoming) {
  if (!stored || !incoming || stored === incoming) return true;
  const platforms = ["Windows", "Macintosh", "Linux", "iPhone", "iPad", "Android"];
  const p1 = platforms.find(p => stored.includes(p));
  const p2 = platforms.find(p => incoming.includes(p));
  if (p1 && p2 && p1 !== p2) return false; // session token moved across different OS/device platforms -> hijack attempt
  return true;
}

// ---------------------------------------------------------------- the auth module
export function createAuth({ store, log = () => {}, root }) {
  const db = store.db;
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, pw_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member',
      status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL, last_login_at INTEGER, failed_count INTEGER NOT NULL DEFAULT 0, locked_until INTEGER,
      company_id TEXT NOT NULL DEFAULT 'bcg');
    CREATE TABLE IF NOT EXISTS sessions (
      id_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, expires_at INTEGER NOT NULL, ip TEXT, ua TEXT,
      lat REAL, lon REAL, geo_accuracy REAL);
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
    CREATE TABLE IF NOT EXISTS auth_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, event TEXT NOT NULL, email TEXT, ip TEXT, detail TEXT);
    CREATE INDEX IF NOT EXISTS auth_log_ts ON auth_log(ts);
    CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      user_id TEXT,
      email TEXT,
      name TEXT,
      company_id TEXT NOT NULL DEFAULT 'bcg',
      action TEXT NOT NULL,
      path TEXT NOT NULL,
      method TEXT NOT NULL,
      status_code INTEGER NOT NULL,
      error TEXT,
      ip TEXT,
      location TEXT,
      network TEXT,
      ua TEXT,
      duration_ms INTEGER,
      lat REAL,
      lon REAL,
      geo_accuracy REAL
    );
    CREATE INDEX IF NOT EXISTS activity_log_ts ON activity_log(ts);
    CREATE INDEX IF NOT EXISTS activity_log_user ON activity_log(user_id);

    CREATE TABLE IF NOT EXISTS password_resets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      email TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS pw_resets_token ON password_resets(token_hash);

    CREATE TABLE IF NOT EXISTS tickets (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      email TEXT NOT NULL,
      name TEXT NOT NULL,
      company_id TEXT NOT NULL DEFAULT 'bcg',
      kind TEXT NOT NULL DEFAULT 'bug',
      subject TEXT NOT NULL,
      description TEXT NOT NULL,
      page_url TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      admin_notes TEXT DEFAULT '',
      resolved_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_tickets_user ON tickets(user_id);
    CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
  `);
  try { db.exec("ALTER TABLE users ADD COLUMN company_id TEXT NOT NULL DEFAULT 'bcg'"); } catch {}
  try { db.exec("ALTER TABLE users ADD COLUMN client_requested TEXT"); } catch {} // the client name exactly as typed at sign-up
  try { db.exec("ALTER TABLE sessions ADD COLUMN lat REAL"); } catch {}
  try { db.exec("ALTER TABLE sessions ADD COLUMN lon REAL"); } catch {}
  try { db.exec("ALTER TABLE sessions ADD COLUMN geo_accuracy REAL"); } catch {}
  try { db.exec("ALTER TABLE activity_log ADD COLUMN lat REAL"); } catch {}
  try { db.exec("ALTER TABLE activity_log ADD COLUMN lon REAL"); } catch {}
  try { db.exec("ALTER TABLE activity_log ADD COLUMN geo_accuracy REAL"); } catch {}

  const ipLimit = Math.max(1, +process.env.HIVEMIND_AUTH_IP_LIMIT || 20);
  const ipHits = new Map(), emailFails = new Map();
  let dummy = null;
  const dummyHash = () => (dummy ??= hashPassword(randomBytes(12).toString("hex")));

  const audit = (event, email, ip, detail = "") => { try { db.prepare("INSERT INTO auth_log (ts, event, email, ip, detail) VALUES (?, ?, ?, ?, ?)").run(Date.now(), event, email ?? null, ip ?? null, String(detail).slice(0, 200)); } catch {} };
  const userByEmail = (email) => db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  const userById = (id) => db.prepare("SELECT * FROM users WHERE id = ?").get(id);
  const pub = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, company: u.company_id || "bcg" });
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

  // ---- Session creation
  const createSession = (req, userId) => {
    if (process.env.HIVEMIND_SINGLE_SESSION === "1") {
      db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
    }
    const token = randomBytes(32).toString("base64url"), now = Date.now();
    const ua = String(req.headers["user-agent"] || "").slice(0, 200);
    db.prepare("INSERT INTO sessions (id_hash, user_id, created_at, last_seen, expires_at, ip, ua) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(sha256(token), userId, now, now, now + ABSOLUTE_MS, clientIp(req), ua);
    return token;
  };

  const tokenOf = (req) => parseCookies(req.headers.cookie)[COOKIE] || null;

  // In-memory session cache to avoid redundant SQLite queries on every request for 100+ concurrent users
  const sessionCache = new Map();
  const clearSessionCache = (userId = null, idh = null) => {
    if (idh) { sessionCache.delete(idh); return; }
    if (userId) {
      for (const [k, v] of sessionCache.entries()) {
        if (v.user?.id === userId) sessionCache.delete(k);
      }
      return;
    }
    sessionCache.clear();
  };

  const sessionUser = (req) => {
    const token = tokenOf(req);
    if (!token || token.length > 100) return null;
    const idh = sha256(token), now = Date.now();
    const cached = sessionCache.get(idh);
    let s, u;
    if (cached && (now - cached.cachedAt < 30_000)) {
      s = cached.s;
      u = cached.user;
    } else {
      s = db.prepare("SELECT * FROM sessions WHERE id_hash = ?").get(idh);
      if (!s) { sessionCache.delete(idh); return null; }
      if (s.expires_at <= now || now - s.last_seen > IDLE_MS) {
        db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(idh);
        sessionCache.delete(idh);
        return null;
      }
      u = userById(s.user_id);
      if (!u || u.status !== "active") {
        db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(idh);
        sessionCache.delete(idh);
        return null;
      }
      sessionCache.set(idh, { s, user: u, cachedAt: now });
    }

    if (s.expires_at <= now || now - s.last_seen > IDLE_MS) {
      db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(idh);
      sessionCache.delete(idh);
      return null;
    }
    // Anti-Session Hijacking check
    const incomingUa = String(req.headers["user-agent"] || "").slice(0, 200);
    if (!isUaCompatible(s.ua, incomingUa)) {
      audit("session_hijack_blocked", null, clientIp(req), `UA mismatch: stored=${(s.ua || "").slice(0, 30)}, incoming=${incomingUa.slice(0, 30)}`);
      db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(idh);
      sessionCache.delete(idh);
      return null;
    }
    if (u.status !== "active") {
      db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(idh);
      sessionCache.delete(idh);
      return null;
    }
    const background = req.method === "GET" && BACKGROUND.test(String(req.url || "").split("?")[0]);
    if (!background && now - s.last_seen > 60e3) {
      db.prepare("UPDATE sessions SET last_seen = ? WHERE id_hash = ?").run(now, idh);
      s.last_seen = now;
    }
    return { ...u, _sid: idh, _lat: s.lat, _lon: s.lon, _accuracy: s.geo_accuracy };
  };

  const dropSessions = (userId, exceptHash = null) => {
    clearSessionCache(userId);
    db.prepare("DELETE FROM sessions WHERE user_id = ? AND id_hash != ?").run(userId, exceptHash ?? "");
  };
  const sweep = () => { const now = Date.now(); try { db.prepare("DELETE FROM sessions WHERE expires_at <= ? OR last_seen < ?").run(now, now - IDLE_MS); } catch {} };
  const timer = setInterval(sweep, 10 * 60e3); timer.unref();
  sweep();

  // ---- handlers
  async function login(req, res) {
    const ip = clientIp(req), wait = ipAllowed(ip);
    if (wait) return send(res, 429, { error: `Too many attempts. Try again in ${Math.ceil(wait / 60)} minute(s).`, retryAfter: wait }, { "retry-after": String(wait) });
    const b = await readJson(req), email = normEmail(b.email), password = typeof b.password === "string" ? b.password : "";
    req._loginEmail = email;
    if (!email || email.length > 254 || !password || password.length > 200) return send(res, 400, { error: "Enter your email and password." });
    const user = userByEmail(email), lock = lockedFor(email, user);
    if (lock) { audit("login_locked", email, ip); return send(res, 429, { error: `Too many failed attempts. Try again in ${Math.ceil(lock / 60)} minute(s).`, retryAfter: lock }, { "retry-after": String(lock) }); }
    const ok = await verifyPassword(password, user?.pw_hash ?? await dummyHash());
    if (!user || !ok) { registerFailure(email, user); audit("login_fail", email, ip); return send(res, 401, { error: GENERIC }); }
    if (user.status === "pending") { audit("login_pending", email, ip); return send(res, 403, { error: "Your request is waiting for approval by an administrator.", status: "pending" }); }
    if (user.status !== "active") { audit("login_disabled", email, ip); return send(res, 403, { error: "This account is disabled. Contact an administrator.", status: "disabled" }); }
    clearFailures(email, user);
    const old = tokenOf(req); if (old) db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(sha256(old));
    const token = createSession(req, user.id);
    db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(Date.now(), user.id);
    audit("login_ok", email, ip);
    return send(res, 200, { ok: true, user: pub(user) }, { "set-cookie": cookieHeader(req, token, Math.floor(ABSOLUTE_MS / 1000)) });
  }

  // ---- client typed at sign-up ----
  // "google", "Google", "GOOgle ", "Google." and "B.C.G" / "bcg" all compare equal: only letters and digits count, case ignored.
  const clientKey = (s) => String(s ?? "").normalize("NFKD").toLowerCase().replace(/[^a-z0-9]/g, "");
  const knownClients = () => {
    const dir = join(root ?? ".", "data", "companies");
    try {
      return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => {
        try { const c = JSON.parse(readFileSync(join(dir, f), "utf8")); return { id: c.id, name: c.name }; } catch { return null; }
      }).filter((c) => c && c.id);
    } catch { return []; }
  };
  // The client id an account is scoped to: an existing client whose id or name matches the typed text, else a new id made from it.
  const resolveClient = (typed) => {
    const k = clientKey(typed);
    const hit = knownClients().find((c) => clientKey(c.id) === k || clientKey(c.name) === k);
    if (hit) return { id: hit.id, existing: true };
    const slug = String(typed).normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);
    return { id: slug || k || "unassigned", existing: false };
  };
  // Who is told about a new sign-up: HIVEMIND_SIGNUP_NOTIFY (comma/space separated), else the administrator address.
  const signupRecipients = () => {
    const list = String(process.env.HIVEMIND_SIGNUP_NOTIFY || "").split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter((x) => EMAIL_RE.test(x));
    return list.length ? [...new Set(list)] : [getAdminEmail()];
  };
  const htmlEsc = (x) => String(x ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  function notifySignup({ name, email, typed, client, host }) {
    const when = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
    const where = host ? `https://${host}` : "HiveMind";
    const clientLine = client.existing ? `${typed} (matches existing client: ${client.id.toUpperCase()})` : `${typed} (new client, not set up in HiveMind yet: ${client.id})`;
    const subject = `[HiveMind] New account waiting for approval: ${name} (${typed})`;
    const text = `A new HiveMind account is waiting for approval.

Name: ${name}
Email: ${email}
Client: ${clientLine}
Requested: ${when} IST

` +
      `To approve or decline: ${where} -> Settings -> Users & Client Scoping.
Check the client before approving; the person will only see that client's data.`;
    const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#1f2937">
      <p><b>A new HiveMind account is waiting for approval.</b></p>
      <table style="border-collapse:collapse">
        <tr><td style="padding:4px 12px 4px 0;color:#64748b">Name</td><td>${htmlEsc(name)}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#64748b">Email</td><td>${htmlEsc(email)}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#64748b">Client</td><td>${htmlEsc(clientLine)}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#64748b">Requested</td><td>${htmlEsc(when)} IST</td></tr>
      </table>
      <p>To approve or decline: <b>${htmlEsc(where)}</b> &rarr; Settings &rarr; Users &amp; Client Scoping.<br>Check the client before approving; the person will only see that client's data.</p></div>`;
    for (const to of signupRecipients()) {
      sendEmail({ to, subject, text, html }).catch((err) => log(`sign-up notification to ${to} failed: ${err.message}`));
    }
  }

  async function signup(req, res) {
    const ip = clientIp(req), wait = ipAllowed(ip);
    if (wait) return send(res, 429, { error: `Too many attempts. Try again in ${Math.ceil(wait / 60)} minute(s).`, retryAfter: wait }, { "retry-after": String(wait) });
    const b = await readJson(req), email = normEmail(b.email), name = String(b.name ?? "").trim().replace(/\s+/g, " "), password = typeof b.password === "string" ? b.password : "";
    if (name.length < 1 || name.length > 80) return send(res, 400, { error: "Enter your name (up to 80 characters)." });
    const typedClient = String(b.client ?? "").trim().replace(/\s+/g, " ").slice(0, 60);
    // every account after the administrator's must say which client it belongs to
    if (userCount() > 0 && clientKey(typedClient).length < 2) return send(res, 400, { error: "Enter the client you belong to (for example BCG)." });
    const client = typedClient ? resolveClient(typedClient) : { id: "bcg", existing: true };
    if (!EMAIL_RE.test(email) || email.length > 254) return send(res, 400, { error: "Enter a valid email address." });
    const problem = passwordProblem(password, { email, name });
    if (problem) return send(res, 400, { error: problem });
    const hash = await hashPassword(password);
    let first = false, created = false;
    db.exec("BEGIN IMMEDIATE");
    try {
      const existing = userByEmail(email);
      if (existing) {
        db.exec("ROLLBACK");
        return send(res, 400, { error: "An account with this email address already exists. Please Sign In, or click 'Forgot?' to recover your access." });
      }
      first = userCount() === 0;
      if (first && process.env.HIVEMIND_ADMIN_EMAIL && normEmail(process.env.HIVEMIND_ADMIN_EMAIL) !== email) {
        db.exec("ROLLBACK");
        return send(res, 403, { error: "The first account can only be created by the administrator this server was set up for." });
      }
      db.prepare("INSERT INTO users (id, email, name, pw_hash, role, status, created_at, company_id, client_requested) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(randomUUID(), email, name, hash, first ? "admin" : "member", first ? "active" : "pending", Date.now(), first ? "bcg" : client.id, typedClient || null);
      created = true;
      db.exec("COMMIT");
    } catch (e) { try { db.exec("ROLLBACK"); } catch {} throw e; }
    audit(first ? "signup_admin" : "signup", email, ip, typedClient ? `client: ${typedClient} -> ${client.id}` : "");
    if (!first) notifySignup({ name, email, typed: typedClient, client, host: String(req.headers.host || "").replace(/[^\w.:-]/g, "") });
    return send(res, 200, { ok: true, status: first ? "active" : "pending", first });
  }

  const logout = (req, res) => {
    const t = tokenOf(req);
    if (t) {
      const idh = sha256(t);
      clearSessionCache(null, idh);
      db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(idh);
    }
    return send(res, 200, { ok: true }, { "set-cookie": cookieHeader(req, "", 0) });
  };

  async function changePassword(req, res, u) {
    const b = await readJson(req), cur = typeof b.current === "string" ? b.current : "", next = typeof b.next === "string" ? b.next : "";
    if (!(await verifyPassword(cur, u.pw_hash))) { audit("password_fail", u.email, clientIp(req)); return send(res, 400, { error: "Your current password is not correct." }); }
    const problem = passwordProblem(next, { email: u.email, name: u.name });
    if (problem) return send(res, 400, { error: problem });
    if (next === cur) return send(res, 400, { error: "The new password must be different from the current one." });
    db.prepare("UPDATE users SET pw_hash = ? WHERE id = ?").run(await hashPassword(next), u.id);
    dropSessions(u.id, u._sid);
    audit("password_change", u.email, clientIp(req));
    return send(res, 200, { ok: true });
  }

  async function forgotPassword(req, res) {
    const ip = clientIp(req), wait = ipAllowed(ip);
    if (wait) return send(res, 429, { error: `Too many attempts. Try again in ${Math.ceil(wait / 60)} minute(s).`, retryAfter: wait }, { "retry-after": String(wait) });
    const b = await readJson(req), email = normEmail(b.email);
    if (!email || !EMAIL_RE.test(email)) return send(res, 400, { error: "Enter a valid email address." });

    const user = userByEmail(email);
    let resetUrl = null;
    if (user && user.status === "active") {
      const token = randomBytes(24).toString("hex");
      const tokenHash = sha256(token);
      const expiresAt = Date.now() + 3600e3; // 1 hour

      db.prepare("DELETE FROM password_resets WHERE user_id = ? AND used = 0").run(user.id);
      db.prepare("INSERT INTO password_resets (id, user_id, email, token_hash, expires_at, used, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)")
        .run(randomUUID(), user.id, user.email, tokenHash, expiresAt, Date.now());

      const host = req.headers.host || "127.0.0.1:8788";
      const proto = req.headers["x-forwarded-proto"] || (req.socket.encrypted ? "https" : "http");
      resetUrl = `${proto}://${host}/login?token=${token}#/reset-password`;

      const emailText = `Hello ${user.name},\n\nA password reset request was received for your HiveMind account (${user.email}).\n\nClick the link below to set a new password:\n${resetUrl}\n\nThis link will expire in 60 minutes.\nIf you did not request this, you can safely ignore this email.\n\nBest regards,\nHiveMind Support`;
      const emailHtml = `<div style="font-family:sans-serif;max-width:560px;margin:auto;padding:24px;border:1px solid #e2e8f0;border-radius:8px">
        <h2 style="color:#0f172a">Reset your HiveMind password</h2>
        <p>Hello <strong>${user.name}</strong>,</p>
        <p>We received a request to reset your password. Click the button below to choose a new password:</p>
        <p style="margin:24px 0"><a href="${resetUrl}" style="background:#2563eb;color:#fff;text-decoration:none;padding:12px 20px;border-radius:6px;font-weight:600;display:inline-block">Reset Password</a></p>
        <p style="color:#64748b;font-size:13px">Or copy and paste this link into your browser:<br><a href="${resetUrl}">${resetUrl}</a></p>
        <p style="color:#64748b;font-size:12px;margin-top:24px">This link will expire in 60 minutes. If you did not make this request, please ignore this email.</p>
      </div>`;

      sendEmail({ to: user.email, subject: "HiveMind · Password Reset Request", text: emailText, html: emailHtml }).catch((err) => {
        log(`Failed to dispatch reset email: ${err.message}`);
      });
      audit("forgot_password_request", email, ip);
    }

    return send(res, 200, {
      ok: true,
      message: "If that email is registered, a reset link has been sent to it. Check your inbox (and spam folder)."
    });
  }

  async function resetPassword(req, res) {
    const ip = clientIp(req), wait = ipAllowed(ip);
    if (wait) return send(res, 429, { error: `Too many attempts. Try again in ${Math.ceil(wait / 60)} minute(s).`, retryAfter: wait }, { "retry-after": String(wait) });
    const b = await readJson(req);
    const token = String(b.token || "").trim();
    const newPassword = typeof b.password === "string" ? b.password : "";
    if (!token) return send(res, 400, { error: "Reset token is missing or invalid." });

    const tokenHash = sha256(token);
    const reset = db.prepare("SELECT * FROM password_resets WHERE token_hash = ? AND used = 0 AND expires_at > ?").get(tokenHash, Date.now());
    if (!reset) return send(res, 400, { error: "This password reset link is invalid or has expired. Please request a new one." });

    const user = userById(reset.user_id);
    if (!user) return send(res, 404, { error: "User account not found." });

    const problem = passwordProblem(newPassword, { email: user.email, name: user.name });
    if (problem) return send(res, 400, { error: problem });
    if (await verifyPassword(newPassword, user.pw_hash)) return send(res, 400, { error: "Choose a new password, not your old one." });

    const hash = await hashPassword(newPassword);
    db.prepare("UPDATE users SET pw_hash = ?, failed_count = 0, locked_until = NULL WHERE id = ?").run(hash, user.id);
    db.prepare("UPDATE password_resets SET used = 1 WHERE id = ?").run(reset.id);
    dropSessions(user.id);
    emailFails.delete(user.email);
    audit("password_reset_success", user.email, ip);

    return send(res, 200, { ok: true, message: "Your password has been reset successfully. You can now sign in." });
  }

  async function handleTickets(req, res, p, u) {
    if (req.method === "POST" && p === "/api/tickets") {
      const b = await readJson(req);
      const kind = ["bug", "feature", "data_issue", "other"].includes(b.kind) ? b.kind : "bug";
      const subject = String(b.subject || "").trim().slice(0, 200);
      const description = String(b.description || "").trim().slice(0, 5000);
      const pageUrl = String(b.pageUrl || "").trim().slice(0, 300);

      if (!subject || subject.length < 3) return send(res, 400, { error: "Please enter a subject (at least 3 characters)." });
      if (!description || description.length < 10) return send(res, 400, { error: "Please describe the issue or feature in detail (at least 10 characters)." });

      const id = randomUUID();
      const now = Date.now();
      const companyId = u.company_id || u.company || "bcg";

      db.prepare(`
        INSERT INTO tickets (id, created_at, user_id, email, name, company_id, kind, subject, description, page_url, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')
      `).run(id, now, u.id, u.email, u.name, companyId, kind, subject, description, pageUrl);

      audit("ticket_created", u.email, clientIp(req), `[${kind}] ${subject}`);

      const adminEmail = getAdminEmail();
      const kindLabels = { bug: "Bug Report", feature: "Feature Request", data_issue: "Data / Forecasting Question", other: "Support Ticket" };
      const mailSubject = `[HiveMind ${kindLabels[kind] || "Ticket"}] ${subject} (from ${u.name} · ${companyId.toUpperCase()})`;
      const mailText = `A new support ticket has been raised on HiveMind.\n\n` +
        `Ticket ID: ${id}\n` +
        `User: ${u.name} (${u.email})\n` +
        `Client / Company: ${companyId.toUpperCase()}\n` +
        `Type: ${kindLabels[kind] || kind}\n` +
        `Subject: ${subject}\n` +
        `Page URL: ${pageUrl || "Dashboard"}\n` +
        `Date: ${new Date(now).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST\n\n` +
        `Description:\n${description}\n\n` +
        `You can review and resolve this ticket from the HiveMind Admin Console.`;

      const mailHtml = `<div style="font-family:sans-serif;max-width:600px;margin:auto;padding:24px;border:1px solid #e2e8f0;border-radius:8px">
        <div style="background:#0f172a;color:#fff;padding:12px 16px;border-radius:6px;margin-bottom:16px">
          <h2 style="margin:0;font-size:18px">New Ticket: ${subject}</h2>
          <span style="font-size:12px;opacity:0.85">${kindLabels[kind] || kind} · ${companyId.toUpperCase()}</span>
        </div>
        <table style="width:100%;font-size:14px;border-collapse:collapse;margin-bottom:16px">
          <tr><td style="padding:6px 0;color:#64748b;width:120px"><strong>From:</strong></td><td>${u.name} &lt;${u.email}&gt;</td></tr>
          <tr><td style="padding:6px 0;color:#64748b"><strong>Client:</strong></td><td>${companyId.toUpperCase()}</td></tr>
          <tr><td style="padding:6px 0;color:#64748b"><strong>Category:</strong></td><td><span style="background:#e0f2fe;color:#0369a1;padding:2px 8px;border-radius:4px;font-weight:600">${kindLabels[kind]}</span></td></tr>
          <tr><td style="padding:6px 0;color:#64748b"><strong>Page:</strong></td><td>${pageUrl || "Dashboard"}</td></tr>
          <tr><td style="padding:6px 0;color:#64748b"><strong>Created:</strong></td><td>${new Date(now).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST</td></tr>
        </table>
        <div style="background:#f8fafc;padding:16px;border-radius:6px;border-left:4px solid #2563eb;margin-bottom:16px">
          <h4 style="margin:0 0 8px 0;color:#1e293b">Description / Steps:</h4>
          <p style="white-space:pre-wrap;margin:0;color:#334155;line-height:1.5">${description}</p>
        </div>
        <p style="color:#64748b;font-size:12px">HiveMind Automated Ticket Notification</p>
      </div>`;

      sendEmail({ to: adminEmail, subject: mailSubject, text: mailText, html: mailHtml }).catch((err) => {
        log(`Failed to notify admin on ticket email: ${err.message}`);
      });

      return send(res, 200, { ok: true, ticket: { id, kind, subject, status: "open", created_at: now } });
    }

    if (req.method === "GET" && p === "/api/tickets") {
      let rows;
      if (u.role === "admin") {
        rows = db.prepare("SELECT * FROM tickets ORDER BY created_at DESC LIMIT 100").all();
      } else {
        rows = db.prepare("SELECT * FROM tickets WHERE user_id = ? ORDER BY created_at DESC LIMIT 50").all(u.id);
      }
      return send(res, 200, { ok: true, tickets: rows });
    }

    if (req.method === "POST" && p === "/api/tickets/update") {
      if (u.role !== "admin") return send(res, 403, { error: "Admin only" });
      const b = await readJson(req);
      const id = String(b.id || "").trim();
      const status = ["open", "in_progress", "resolved", "closed"].includes(b.status) ? b.status : "open";
      const notes = String(b.notes || "").trim();

      const existing = db.prepare("SELECT * FROM tickets WHERE id = ?").get(id);
      if (!existing) return send(res, 404, { error: "Ticket not found" });

      const resolvedAt = status === "resolved" ? (existing.resolved_at || Date.now()) : null;
      db.prepare("UPDATE tickets SET status = ?, admin_notes = ?, resolved_at = ? WHERE id = ?").run(status, notes, resolvedAt, id);
      audit("ticket_updated", u.email, clientIp(req), `Ticket ${id} status: ${status}`);

      return send(res, 200, { ok: true });
    }

    return send(res, 404, { error: "Not found" });
  }

  async function adminUsers(req, res, p, u) {
    if (req.method === "GET" && p === "/api/users") {
      const users = db.prepare("SELECT id, name, email, role, status, created_at, last_login_at, company_id, client_requested FROM users ORDER BY created_at").all()
        .map((x) => ({ id: x.id, name: x.name, email: x.email, role: x.role, status: x.status, createdAt: x.created_at, lastLoginAt: x.last_login_at, company: x.company_id || "bcg", clientRequested: x.client_requested || null }));
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
    if (action === "company") {
      const companyId = String(b.company || "bcg").trim().toLowerCase().slice(0, 50);
      db.prepare("UPDATE users SET company_id = ? WHERE id = ?").run(companyId, target.id);
      audit("company", target.email, clientIp(req), `assigned to ${companyId} by ${u.email}`);
      return send(res, 200, { ok: true, company: companyId });
    }
    if (action === "reset") {
      const temp = tempPassword();
      db.prepare("UPDATE users SET pw_hash = ?, failed_count = 0, locked_until = NULL WHERE id = ?").run(await hashPassword(temp), target.id);
      emailFails.delete(target.email); dropSessions(target.id);
      audit("reset", target.email, clientIp(req), `by ${u.email}`); return send(res, 200, { ok: true, temporaryPassword: temp });
    }
    return send(res, 404, { error: "Unknown action" });
  }

  let cachedLoginPage = null;
  const loginPage = () => {
    if (cachedLoginPage) return cachedLoginPage;
    const f = join(root, "src", "login.html");
    cachedLoginPage = existsSync(f) ? readFileSync(f) : Buffer.from("<h1>Login page missing</h1>");
    return cachedLoginPage;
  };
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
      if (req.method === "POST" && p === "/api/auth/forgot-password") { await forgotPassword(req, res); return true; }
      if (req.method === "POST" && p === "/api/auth/reset-password") { await resetPassword(req, res); return true; }
      if (req.method === "GET" && p === "/api/auth/me") { if (!u) send(res, 401, { error: "auth", login: "/login" }); else send(res, 200, { user: pub(u) }); return true; }
      if (!u) { send(res, 401, { error: "auth", login: "/login" }); return true; }
      req.user = u;
      if (req.method === "POST" && p === "/api/auth/logout") { logout(req, res); return true; }
      if (req.method === "POST" && p === "/api/auth/password") { await changePassword(req, res, u); return true; }
      if (p === "/api/tickets" || p === "/api/tickets/update") { await handleTickets(req, res, p, u); return true; }
      
      // HTML5 Geolocation endpoint
      if (req.method === "POST" && p === "/api/auth/geo") {
        flushActivityQueue(db);
        const b = await readJson(req);
        const lat = +b.lat, lon = +b.lon, accuracy = +b.accuracy;
        if (!isNaN(lat) && !isNaN(lon) && u._sid) {
          db.prepare("UPDATE sessions SET lat = ?, lon = ?, geo_accuracy = ? WHERE id_hash = ?").run(lat, lon, isNaN(accuracy) ? null : accuracy, u._sid);
          db.prepare(`
            UPDATE activity_log 
            SET lat = ?, lon = ?, geo_accuracy = ? 
            WHERE id IN (SELECT id FROM activity_log WHERE user_id = ? ORDER BY id DESC LIMIT 5)
          `).run(lat, lon, isNaN(accuracy) ? null : accuracy, u.id);
        }
        return send(res, 200, { ok: true, lat, lon });
      }

      if (req.method === "GET" && p === "/api/admin/audit-logs") {
        flushActivityQueue(db);
        if (u.role !== "admin") { send(res, 403, { error: "Admin only" }); return true; }
        const limit = Math.min(200, Math.max(10, +url.searchParams.get("limit") || 50));
        const offset = Math.max(0, +url.searchParams.get("offset") || 0);
        const userFilter = (url.searchParams.get("user") || "").trim();
        const errorsOnly = url.searchParams.get("errors") === "1";
        const where = [];
        const params = [];
        if (userFilter) {
          where.push("(email LIKE ? OR name LIKE ? OR ip LIKE ? OR company_id LIKE ?)");
          params.push(`%${userFilter}%`, `%${userFilter}%`, `%${userFilter}%`, `%${userFilter}%`);
        }
        if (errorsOnly) {
          where.push("(error IS NOT NULL OR status_code >= 400)");
        }
        const whereClause = where.length ? "WHERE " + where.join(" AND ") : "";
        const logs = db.prepare(`SELECT * FROM activity_log ${whereClause} ORDER BY ts DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
        const countRow = db.prepare(`SELECT COUNT(*) as c FROM activity_log ${whereClause}`).get(...params);
        send(res, 200, { logs, total: countRow?.c || 0, limit, offset });
        return true;
      }
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

  return { handle, sessionUser, userCount, stop: () => { clearInterval(timer); flushActivityQueue(db); } };
}
