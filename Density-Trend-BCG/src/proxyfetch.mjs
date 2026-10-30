// A fetch through an HTTP proxy, used for ONE thing: trying again to get an article's text after a direct attempt failed (blocked, throttled, timed
// out). Nothing else in the application uses the proxy: Google News polling, the model APIs and everything else connect directly.
//
// No packages: an HTTPS page is reached by asking the proxy for a tunnel (CONNECT) and speaking TLS to the site through it, so the proxy never sees
// the page and the site's certificate is still checked (pass `ca` to trust a private authority). Plain http pages go to the proxy as absolute requests.
// Returns a standard Response, so callers treat it like fetch().
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import zlib from "node:zlib";

// Which proxy to use for article-text retries: HIVEMIND_BODY_PROXY, else the DataImpulse address already in .env, else HTTPS_PROXY / HTTP_PROXY.
// HIVEMIND_NO_PROXY=1 (set when the proxy is switched off in Settings → Integrations) means none.
export const proxyUrl = () => (process.env.HIVEMIND_NO_PROXY === "1" ? "" : process.env.HIVEMIND_BODY_PROXY || process.env.DATAIMPULSE_PROXY_URL || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "");

const MAX_BYTES = 4_000_000, MAX_REDIRECTS = 5;
const auth = (p) => (p.username ? { "proxy-authorization": "Basic " + Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`).toString("base64") } : {});

function tunnel(proxy, host, port, timeout) {
  return new Promise((resolve, reject) => {
    const p = new URL(proxy), lib = p.protocol === "https:" ? https : http;
    const req = lib.request({ host: p.hostname, port: p.port || (p.protocol === "https:" ? 443 : 80), method: "CONNECT", path: `${host}:${port}`, headers: { host: `${host}:${port}`, ...auth(p) }, timeout });
    req.on("connect", (res, socket) => { socket.on("error", () => {}); /* a failure surfaces through the request that uses it */ if (res.statusCode === 200) resolve(socket); else { socket.destroy(); reject(new Error(`proxy refused the tunnel (HTTP ${res.statusCode})`)); } });
    req.on("timeout", () => req.destroy(new Error("proxy timed out")));
    req.on("error", reject);
    req.end();
  });
}

function send(lib, options, body, timeout) {
  return new Promise((resolve, reject) => {
    const req = lib.request({ ...options, timeout }, (res) => {
      const chunks = []; let size = 0;
      res.on("data", (c) => { size += c.length; if (size > MAX_BYTES) { req.destroy(new Error("page too large")); return; } chunks.push(c); });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

const decode = (buf, enc) => {
  const e = String(enc || "").toLowerCase();
  try { return e.includes("gzip") ? zlib.gunzipSync(buf) : e.includes("br") ? zlib.brotliDecompressSync(buf) : e.includes("deflate") ? zlib.inflateSync(buf) : buf; } catch { return buf; }
};

async function hop(url, { proxy, method, headers, body, timeout, ca }) {
  const u = new URL(url), p = new URL(proxy), h = { "accept-encoding": "identity", ...headers };
  if (body && !h["content-length"]) h["content-length"] = Buffer.byteLength(body);
  if (u.protocol === "http:") return send(http, { host: p.hostname, port: p.port || 80, method, path: url, headers: { ...h, host: u.host, ...auth(p) } }, body, timeout);
  const port = u.port || 443, socket = await tunnel(proxy, u.hostname, port, timeout);
  // The certificate of the site itself is always checked. rejectUnauthorized is set explicitly because Node's default follows the environment
  // variable NODE_TLS_REJECT_UNAUTHORIZED, and a machine with that set to 0 would otherwise silently accept anything.
  const secure = tls.connect({ socket, servername: u.hostname, ca, rejectUnauthorized: true });
  // Nothing is sent until the handshake has finished AND the certificate is trusted. This is checked explicitly (not left to events) so that a
  // failed check can never be swallowed: the connection is dropped and the fetch fails.
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { secure.destroy(); reject(new Error("TLS handshake timed out")); }, timeout);
    secure.once("secureConnect", () => { clearTimeout(timer); if (secure.authorized) resolve(); else { secure.destroy(); reject(new Error(`certificate not trusted (${secure.authorizationError})`)); } });
    secure.once("error", (e) => { clearTimeout(timer); reject(e); });
  });
  secure.on("error", () => {}); // later failures (a reset mid-page) reach the caller through the request
  // No `agent` option: with agent:false Node builds its own agent and ignores createConnection, so the request would leave the tunnel and go out directly.
  return send(https, { createConnection: () => secure, host: u.hostname, port, method, path: u.pathname + u.search, headers: { ...h, host: u.host } }, body, timeout);
}

export async function fetchViaProxy(url, { proxyUrl: proxy = proxyUrl(), method = "GET", headers = {}, body, timeout = 20000, ca } = {}) {
  if (!proxy) throw new Error("no proxy is configured");
  let target = url, m = method, b = body;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const r = await hop(target, { proxy, method: m, headers, body: b, timeout, ca });
    if ([301, 302, 303, 307, 308].includes(r.status) && r.headers.location) {
      target = new URL(r.headers.location, target).href;
      if (r.status === 303 || ((r.status === 301 || r.status === 302) && m === "POST")) { m = "GET"; b = undefined; }
      continue;
    }
    const outHeaders = {}; for (const [k, v] of Object.entries(r.headers)) if (!["content-encoding", "content-length", "transfer-encoding", "connection"].includes(k)) outHeaders[k] = Array.isArray(v) ? v.join(", ") : v;
    return new Response(r.status === 204 || r.status === 304 ? null : decode(r.body, r.headers["content-encoding"]), { status: r.status, headers: outHeaders });
  }
  throw new Error("too many redirects");
}
