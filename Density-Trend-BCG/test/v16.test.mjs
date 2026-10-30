// The proxy policy: no proxy for anything in general; an article's text that could not be fetched directly is retried once through the proxy.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { createServer as createHttps } from "node:https";
import { createServer as createHttp } from "node:http";
import { connect } from "node:net";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchViaProxy, proxyUrl } from "../src/proxyfetch.mjs";
import { fetchArticleBody, fetchPublication } from "../src/gnews.mjs";
import { Integrations, INTEGRATIONS } from "../src/integrations.mjs";
import { Store } from "../src/db.mjs";

const KEY = readFileSync(new URL("./fixtures/localhost.key", import.meta.url)), CERT = readFileSync(new URL("./fixtures/localhost.crt", import.meta.url));
const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));
const withEnv = async (env, fn) => { const saved = {}; for (const k of Object.keys(env)) { saved[k] = process.env[k]; if (env[k] === null) delete process.env[k]; else process.env[k] = env[k]; } try { return await fn(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } } };

// a small test proxy: it answers CONNECT after checking the credentials, and tunnels to whatever host:port was asked for
async function startProxy({ user = "u", pass = "p", refuse = 0 } = {}) {
  const seen = { connects: [], auth: [], plain: [] }, server = createHttp((req, res) => { seen.plain.push({ url: req.url, auth: req.headers["proxy-authorization"] }); res.writeHead(200, { "content-type": "text/plain" }); res.end("plain via proxy: " + req.url); });
  server.on("connect", (req, socket, head) => {
    seen.connects.push(req.url); seen.auth.push(req.headers["proxy-authorization"]);
    if (refuse) { socket.end(`HTTP/1.1 ${refuse} Refused\r\n\r\n`); return; }
    if (req.headers["proxy-authorization"] !== "Basic " + Buffer.from(`${user}:${pass}`).toString("base64")) { socket.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n"); return; }
    // "private.test" does not exist in DNS: only this proxy knows where it is. A client that bypasses the proxy cannot reach it at all.
    const [host, port] = req.url.split(":"), up = connect(+port, host === "private.test" ? "127.0.0.1" : host, () => { socket.write("HTTP/1.1 200 Connection Established\r\n\r\n"); up.write(head); up.pipe(socket); socket.pipe(up); });
    up.on("error", () => socket.destroy()); socket.on("error", () => up.destroy());
  });
  const port = await listen(server);
  return { seen, url: `http://u:p@127.0.0.1:${port}`, badUrl: `http://u:wrong@127.0.0.1:${port}`, plainUrl: `http://127.0.0.1:${port}`, close: () => { server.close(); server.closeAllConnections?.(); } };
}
async function startSite() {
  const hits = [];
  const server = createHttps({ key: KEY, cert: CERT }, (req, res) => {
    let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
      hits.push({ method: req.method, path: req.url, body, ua: req.headers["user-agent"], host: req.headers.host });
      if (req.url === "/old") { res.writeHead(302, { location: "/new" }); return res.end(); }
      if (req.url === "/zipped") { res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" }); return res.end(gzipSync("zipped text")); }
      res.writeHead(200, { "content-type": "text/plain" }); res.end(`site says ${req.method} ${req.url}${body ? " body=" + body : ""}`);
    });
  });
  const port = await listen(server);
  return { hits, port, base: `https://private.test:${port}`, close: () => { server.close(); server.closeAllConnections?.(); } };
}

test("proxy fetch: an https page is reached through a CONNECT tunnel with the proxy's credentials, and the site's own certificate is checked", async () => {
  const site = await startSite(), proxy = await startProxy();
  try {
    const r = await fetchViaProxy(`${site.base}/page?x=1`, { proxyUrl: proxy.url, ca: CERT, headers: { "user-agent": "UA-test" } });
    assert.equal(r.status, 200); assert.equal(await r.text(), "site says GET /page?x=1");
    assert.deepEqual(proxy.seen.connects, [`private.test:${site.port}`]); assert.equal(proxy.seen.auth[0], "Basic " + Buffer.from("u:p").toString("base64"));
    assert.equal(site.hits[0].ua, "UA-test"); assert.equal(site.hits[0].host, `private.test:${site.port}`);
    // the page was reached ONLY through the tunnel (the host name exists nowhere else), and a request that skipped the proxy fails outright
    await assert.rejects(() => fetch(`${site.base}/page`), /fetch failed/);
    // certificate verification is on: the same request without trusting the test certificate must fail
    await assert.rejects(() => fetchViaProxy(`${site.base}/page`, { proxyUrl: proxy.url }), /self.signed|certificate|unable to verify/i);
  } finally { site.close(); proxy.close(); }
});

test("proxy fetch: redirects are followed, a POST body arrives, a gzip answer is decoded, a refusal is an error", async () => {
  const site = await startSite(), proxy = await startProxy();
  try {
    assert.equal(await (await fetchViaProxy(`${site.base}/old`, { proxyUrl: proxy.url, ca: CERT })).text(), "site says GET /new");
    assert.equal(await (await fetchViaProxy(`${site.base}/form`, { proxyUrl: proxy.url, ca: CERT, method: "POST", body: "f.req=abc", headers: { "content-type": "application/x-www-form-urlencoded" } })).text(), "site says POST /form body=f.req=abc");
    assert.equal(await (await fetchViaProxy(`${site.base}/zipped`, { proxyUrl: proxy.url, ca: CERT })).text(), "zipped text");
    await assert.rejects(() => fetchViaProxy(`${site.base}/x`, { proxyUrl: proxy.badUrl, ca: CERT }), /refused the tunnel \(HTTP 407\)/);
    await assert.rejects(() => fetchViaProxy("https://x.example/", { proxyUrl: "" }), /no proxy is configured/);
  } finally { site.close(); proxy.close(); }
  const refusing = await startProxy({ refuse: 403 });
  try { await assert.rejects(() => fetchViaProxy("https://example.com/", { proxyUrl: refusing.url }), /HTTP 403/); } finally { refusing.close(); }
});

test("proxy fetch: a plain http page goes to the proxy as an absolute request", async () => {
  const proxy = await startProxy();
  try {
    const r = await fetchViaProxy("http://news.example.com/story", { proxyUrl: proxy.url });
    assert.equal(await r.text(), "plain via proxy: http://news.example.com/story");
    assert.equal(proxy.seen.plain[0].auth, "Basic " + Buffer.from("u:p").toString("base64"));
  } finally { proxy.close(); }
});

test("proxy address: HIVEMIND_BODY_PROXY, then DATAIMPULSE_PROXY_URL, then HTTPS_PROXY / HTTP_PROXY; HIVEMIND_NO_PROXY=1 means none", async () => {
  const none = { HIVEMIND_BODY_PROXY: null, DATAIMPULSE_PROXY_URL: null, HTTPS_PROXY: null, HTTP_PROXY: null, HIVEMIND_NO_PROXY: null };
  await withEnv(none, () => assert.equal(proxyUrl(), ""));
  await withEnv({ ...none, HTTP_PROXY: "http://c" }, () => assert.equal(proxyUrl(), "http://c"));
  await withEnv({ ...none, HTTP_PROXY: "http://c", HTTPS_PROXY: "http://b" }, () => assert.equal(proxyUrl(), "http://b"));
  await withEnv({ ...none, HTTPS_PROXY: "http://b", DATAIMPULSE_PROXY_URL: "http://a" }, () => assert.equal(proxyUrl(), "http://a"));
  await withEnv({ ...none, DATAIMPULSE_PROXY_URL: "http://a", HIVEMIND_BODY_PROXY: "http://z" }, () => assert.equal(proxyUrl(), "http://z"));
  await withEnv({ ...none, DATAIMPULSE_PROXY_URL: "http://a", HIVEMIND_NO_PROXY: "1" }, () => assert.equal(proxyUrl(), ""));
});

// ---- the article-text flow, with the network stubbed ----
const PARAS = Array.from({ length: 6 }, (_, i) => `<p>Paragraph ${i + 1} of the article, long enough to count as real article text because it is well over sixty characters.</p>`).join("");
const gnewsPage = '<c-wiz data-n-a-sg="SIG" data-n-a-ts="1700000000"></c-wiz>';
const batch = (url) => ")]}'\n\n" + JSON.stringify([["wrb.fr", "Fbv4je", JSON.stringify(["garturlres", url])]]);
const article = { url: "https://news.google.com/rss/articles/CBMiabc" };
// a network where each host can be up or down; records which hosts were reached directly and which through the proxy
function network({ googleOk = true, siteOk = true, html = `<html>${PARAS}</html>` } = {}) {
  const direct = [], viaProxy = [];
  const answer = (url, opts = {}) => {
    const u = new URL(url);
    if (u.hostname === "news.google.com") { if (!googleOk) return new Response("blocked", { status: 429 }); return new Response(u.pathname.includes("batchexecute") ? batch("https://publisher.example/story") : gnewsPage, { status: 200 }); }
    if (!siteOk) return new Response("forbidden", { status: 403 });
    return new Response(html, { status: 200 });
  };
  return { direct, viaProxy, fetch: async (url, init) => { direct.push(String(url)); return answer(url, init); }, proxyFetch: async (url, opts) => { viaProxy.push({ url: String(url), proxy: opts.proxyUrl }); return answer(url, opts); } };
}
const withFetch = async (net, fn) => { const real = globalThis.fetch; globalThis.fetch = net.fetch; try { return await fn(); } finally { globalThis.fetch = real; } };

test("article text: fetched directly, with no proxy involved, when that works", async () => {
  const net = network();
  const r = await withFetch(net, () => fetchArticleBody(article, { proxy: "http://p:1", proxyFetch: net.proxyFetch }));
  assert.equal(r.basis, "full-text"); assert.ok(!r.viaProxy); assert.deepEqual(net.viaProxy, [], "the proxy was not touched");
  assert.ok(net.direct.some((u) => u.startsWith("https://publisher.example/story")));
});

test("article text: when the direct fetch fails, it is tried once through the proxy (both the Google step and the publisher page)", async () => {
  for (const failing of [{ siteOk: false }, { googleOk: false }]) {
    const direct = network(failing), ok = network();
    // direct requests fail; proxied requests succeed
    const r = await withFetch(direct, () => fetchArticleBody(article, { proxy: "http://p:1", proxyFetch: ok.proxyFetch }));
    assert.equal(r.basis, "full-text", JSON.stringify(failing)); assert.equal(r.viaProxy, true);
    assert.deepEqual(ok.viaProxy.map((x) => new URL(x.url).hostname), ["news.google.com", "news.google.com", "publisher.example"], "the retry goes through the proxy from the start: Google's lookup and the publisher page");
    assert.ok(ok.viaProxy.every((x) => x.proxy === "http://p:1"));
  }
});

test("article text: a failure both ways is reported as such, and with no proxy configured nothing is retried", async () => {
  const bad = network({ siteOk: false }), alsoBad = network({ siteOk: false });
  const r = await withFetch(bad, () => fetchArticleBody(article, { proxy: "http://p:1", proxyFetch: alsoBad.proxyFetch }));
  assert.equal(r.basis, "headline"); assert.equal(r.triedProxy, true); assert.match(r.error, /HTTP 403.*again through the proxy.*HTTP 403/);
  const none = network({ siteOk: false }), unused = network();
  const r2 = await withFetch(none, () => fetchArticleBody(article, { proxy: "", proxyFetch: unused.proxyFetch }));
  assert.equal(r2.basis, "headline"); assert.match(r2.error, /HTTP 403/); assert.ok(!r2.triedProxy); assert.deepEqual(unused.viaProxy, []);
});

test("article text: a page that loads but is short (a paywall teaser) is NOT retried through the proxy", async () => {
  const net = network({ html: "<html><p>Subscribe to read the rest of this story, it is behind a paywall for members.</p></html>" });
  const r = await withFetch(net, () => fetchArticleBody(article, { proxy: "http://p:1", proxyFetch: net.proxyFetch }));
  assert.equal(r.basis, "headline"); assert.ok(!r.error); assert.deepEqual(net.viaProxy, [], "a proxy would not change a paywall, so it costs no proxy data");
});

test("google news polling: always direct, even with a proxy configured", async () => {
  const rss = `<?xml version="1.0"?><rss><channel><item><title>Rates held steady - The Hindu</title><link>https://news.google.com/rss/articles/X1</link><pubDate>Wed, 28 Oct 2026 08:00:00 GMT</pubDate><source url="https://thehindu.com">The Hindu</source></item></channel></rss>`;
  const calls = [], real = globalThis.fetch;
  globalThis.fetch = async (url) => { calls.push(String(url)); return new Response(rss, { status: 200 }); };
  try {
    await withEnv({ DATAIMPULSE_PROXY_URL: "http://u:p@127.0.0.1:9", HIVEMIND_BODY_PROXY: "http://u:p@127.0.0.1:9" }, async () => {
      const out = await fetchPublication({ name: "The Hindu", domain: "thehindu.com" }, { hours: 24 });
      assert.ok(calls.length > 0 && calls.every((u) => u.startsWith("https://news.google.com/rss/search")), "every poll was a direct request");
      assert.ok(out, "the poll succeeded although the configured proxy address is unreachable: it was never used");
    });
  } finally { globalThis.fetch = real; }
});

test("no global proxy: the command line no longer re-launches itself with a proxy for everything", () => {
  const src = readFileSync(new URL("../src/cli.mjs", import.meta.url), "utf8");
  assert.ok(!/spawnSync\(/.test(src) && !/NODE_USE_ENV_PROXY:/.test(src) && !/HIVEMIND_REEXEC/.test(src), "the re-launch block is gone");
  const server = readFileSync(new URL("../src/server.mjs", import.meta.url), "utf8");
  assert.ok(!/NODE_USE_ENV_PROXY/.test(server), "and the server no longer switches a proxy on or off per job");
});

test("settings: the proxy integration describes the new role, needs no restart, and its switch touches no .env line", () => {
  const root = mkdtempSync(join(tmpdir(), "px-")), store = new Store(":memory:"), ig = new Integrations({ root, store });
  assert.match(INTEGRATIONS.proxy.role, /one thing only/i);
  const saved = { a: process.env.DATAIMPULSE_PROXY_URL, b: process.env.HIVEMIND_BODY_PROXY }; process.env.DATAIMPULSE_PROXY_URL = "http://user:secret@proxy.example:8080"; delete process.env.HIVEMIND_BODY_PROXY;
  try {
    const row = () => ig.status({}).find((i) => i.name === "proxy");
    assert.equal(row().configured, true); assert.equal(row().needsRestart, false); assert.ok(!row().masked.includes("secret"), "the password is not shown");
    ig.setProxyEnabled(false);
    assert.equal(ig.enabled("proxy"), false); assert.equal(row().needsRestart, false);
    let env = ""; try { env = readFileSync(join(root, ".env"), "utf8"); } catch { /* no .env written at all */ }
    assert.ok(!/NODE_USE_ENV_PROXY/.test(env), "turning the proxy off no longer writes NODE_USE_ENV_PROXY");
  } finally { if (saved.a === undefined) delete process.env.DATAIMPULSE_PROXY_URL; else process.env.DATAIMPULSE_PROXY_URL = saved.a; if (saved.b !== undefined) process.env.HIVEMIND_BODY_PROXY = saved.b; store.close(); }
});
