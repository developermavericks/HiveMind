// Certificate checking is switched back on when the machine's environment has turned it off.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:https";
import { spawn } from "node:child_process";
import { enforceTls } from "../src/tls.mjs";

test("tls: NODE_TLS_REJECT_UNAUTHORIZED=0 is removed with a warning; anything else is left alone", () => {
  const warns = [], warn = (m) => warns.push(m);
  const off = { NODE_TLS_REJECT_UNAUTHORIZED: "0" }; assert.equal(enforceTls(off, warn), true); assert.ok(!("NODE_TLS_REJECT_UNAUTHORIZED" in off)); assert.match(warns[0], /switched back on/);
  const unset = {}; assert.equal(enforceTls(unset, warn), false); assert.equal(warns.length, 1, "no warning when nothing was wrong");
  const on = { NODE_TLS_REJECT_UNAUTHORIZED: "1" }; assert.equal(enforceTls(on, warn), false); assert.equal(on.NODE_TLS_REJECT_UNAUTHORIZED, "1");
  const optOut = { NODE_TLS_REJECT_UNAUTHORIZED: "0", HIVEMIND_ALLOW_INSECURE_TLS: "1" }; assert.equal(enforceTls(optOut, warn), false); assert.equal(optOut.NODE_TLS_REJECT_UNAUTHORIZED, "0", "the explicit opt-out keeps the machine's setting");
});

test("tls: in a real process started with checking off, fetch() refuses a self-signed server after enforceTls(), and accepts it with the opt-out", async () => {
  const server = createServer({ key: readFileSync(new URL("./fixtures/localhost.key", import.meta.url)), cert: readFileSync(new URL("./fixtures/localhost.crt", import.meta.url)) }, (q, r) => r.end("hello"));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `https://localhost:${server.address().port}/`;
  const code = `import { enforceTls } from ${JSON.stringify(new URL("../src/tls.mjs", import.meta.url).href)};
    enforceTls(process.env, () => {});
    try { const r = await fetch(${JSON.stringify(url)}); console.log("REACHED " + r.status); } catch (e) { console.log("REFUSED " + (e.cause?.code || e.message)); }`;
  // spawn, not spawnSync: this process also runs the test server, and a blocked process could not answer the child
  const run = (extra) => new Promise((resolve) => { let out = ""; const c = spawn(process.execPath, ["--no-warnings", "--input-type=module", "-e", code], { env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: "0", ...extra } }); c.stdout.on("data", (d) => (out += d)); c.on("close", () => resolve(out.trim())); setTimeout(() => c.kill(), 20000).unref(); });
  try {
    assert.match(await run({}), /REFUSED DEPTH_ZERO_SELF_SIGNED_CERT/, "checking was off in the environment, and the program turned it back on");
    assert.match(await run({ HIVEMIND_ALLOW_INSECURE_TLS: "1" }), /REACHED 200/, "with the explicit opt-out the machine's setting stands");
  } finally { server.close(); server.closeAllConnections?.(); }
});

test("tls: the command line applies it after .env is read, before any request", () => {
  const src = readFileSync(new URL("../src/cli.mjs", import.meta.url), "utf8");
  assert.ok(src.indexOf("enforceTls();") > src.indexOf("process.loadEnvFile") && src.indexOf("enforceTls();") < src.indexOf("const readJson"), "enforceTls() runs right after .env is loaded");
});
