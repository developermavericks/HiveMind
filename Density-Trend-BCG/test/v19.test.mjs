// The print editions run once a day, around 11:15 local time, as part of the automatic mode.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, cpSync, copyFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ocrDue, parseTime } from "../src/schedule.mjs";

const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi, 0);

test("schedule: the time is read leniently and falls back to 11:15", () => {
  assert.deepEqual(parseTime("11:15"), { hh: 11, mm: 15, label: "11:15" });
  assert.equal(parseTime("9:05").label, "09:05"); assert.equal(parseTime(" 23:59 ").label, "23:59");
  for (const bad of [undefined, null, "", "noon", "11", "11:5", "ab:cd"]) assert.equal(parseTime(bad).label, "11:15", String(bad));
  assert.equal(parseTime("27:99").label, "23:59", "out-of-range values are clamped, not trusted");
});

test("schedule: due from the set time, once a day, made up if the server was off, retried an hour later at most three times", () => {
  const T = "11:15";
  assert.equal(ocrDue(at(2026, 10, 29, 6, 0), T), false, "early morning: not yet");
  assert.equal(ocrDue(at(2026, 10, 29, 11, 14), T), false, "a minute before");
  assert.equal(ocrDue(at(2026, 10, 29, 11, 15), T), true, "at the time");
  assert.equal(ocrDue(at(2026, 10, 29, 15, 40), T), true, "the server was off at 11:15 and is running now: made up");
  assert.equal(ocrDue(at(2026, 10, 29, 23, 59), T), true, "still today");
  assert.equal(ocrDue(at(2026, 10, 29, 12, 0), T, { okDay: "2026-10-29" }), false, "already done today");
  assert.equal(ocrDue(at(2026, 10, 30, 11, 20), T, { okDay: "2026-10-29" }), true, "done yesterday is not done today");
  assert.equal(ocrDue(at(2026, 10, 30, 8, 0), T, { okDay: "2026-10-29" }), false, "and tomorrow's run waits for its own time");
  const failed = (now) => ocrDue(now, T, { tries: 1, lastTryAt: at(2026, 10, 29, 11, 15).getTime() });
  assert.equal(failed(at(2026, 10, 29, 11, 40)), false, "a failed run waits an hour");
  assert.equal(failed(at(2026, 10, 29, 12, 15)), true, "then tries again");
  assert.equal(ocrDue(at(2026, 10, 29, 20, 0), T, { tries: 3, lastTryAt: at(2026, 10, 29, 17, 0).getTime() }), false, "three attempts, then it stops for the day");
  assert.equal(ocrDue(at(2026, 10, 29, 11, 0), "11:00"), true, "another time is honoured");
  assert.equal(ocrDue(at(2026, 10, 29, 11, 0), "13:30"), false);
});

async function boot(extra = {}) {
  const saved = { llm: process.env.HIVEMIND_LLM, groq: process.env.GROQ_API_KEY }; process.env.HIVEMIND_LLM = "auto"; process.env.GROQ_API_KEY = "test-key-not-real";
  const root = mkdtempSync(join(tmpdir(), "ocrs-"));
  mkdirSync(join(root, "src")); mkdirSync(join(root, "data"));
  cpSync(new URL("../config", import.meta.url), join(root, "config"), { recursive: true });
  cpSync(new URL("../src/ui", import.meta.url), join(root, "src", "ui"), { recursive: true });
  for (const f of ["dashboard.html", "login.html"]) copyFileSync(new URL(`../src/${f}`, import.meta.url), join(root, "src", f));
  const calls = [], logs = [], children = []; // a fake job runs until the test ends it, so timing can never decide the outcome
  const spawn = (cmd, args) => { calls.push(args); const c = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill() {} }); children.push(c); return c; };
  const { serve } = await import("../src/server.mjs");
  const bcg = JSON.parse(readFileSync(new URL("../config/bcg.json", import.meta.url), "utf8"));
  const server = await serve({ root, bcg, port: 0, auth: false, log: (m) => logs.push(m), spawn, ...extra });
  return { server, calls, logs, children, root, base: `http://127.0.0.1:${server.address().port}`, close: () => { server.close(); server.closeAllConnections?.(); for (const [k, v] of Object.entries({ HIVEMIND_LLM: saved.llm, GROQ_API_KEY: saved.groq })) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } } };
}

test("server: the schedule is announced in automatic mode and absent with --no-auto", async () => {
  const on = await boot({ autoSync: true });
  try { assert.ok(on.logs.some((l) => /Print editions: once a day from 11:15/.test(l)), on.logs.join(" | ")); } finally { on.close(); }
  const off = await boot({ autoSync: false });
  try { assert.ok(!off.logs.some((l) => /Print editions: once a day/.test(l)), "dashboard-only mode schedules nothing"); } finally { off.close(); }
});

test("server: the print editions can be started by hand, look back three days, and run one at a time", async () => {
  const s = await boot({ autoSync: false });
  try {
    const post = (kind) => fetch(`${s.base}/api/job`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind }) });
    const r = await post("ocr"); assert.equal(r.status, 200);
    const args = s.calls[0].slice(-3); assert.equal(args[0], "ocr"); assert.equal(args[1], "--from");
    const d = new Date(Date.now() - 3 * 864e5), want = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    assert.equal(args[2], want, "from three days back, so a paper that was not out yet is picked up");
    assert.equal((await post("ocr")).status, 409, "a second start while one is running is refused");
    const st = await (await fetch(`${s.base}/api/status`)).json(); assert.equal(st.jobs.ocr.running, true, "the dashboard sees it as a running job");
    const { Store } = await import("../src/db.mjs"), peek = () => { const st = new Store(join(s.root, "data", "hivemind.db")); try { return st.getMeta("ocr.okDay"); } finally { st.close(); } };
    assert.ok(!peek(), "nothing is marked done while it runs");
    s.children[0].emit("close", 1); await new Promise((r) => setTimeout(r, 50));
    assert.ok(!peek(), "a failed run does not count as the day's run");
    assert.equal((await post("ocr")).status, 200, "so it can be started again"); 
    s.children[1].emit("close", 0); await new Promise((r) => setTimeout(r, 50)); // this one succeeds
    const d0 = new Date(), today = `${d0.getFullYear()}-${String(d0.getMonth() + 1).padStart(2, "0")}-${String(d0.getDate()).padStart(2, "0")}`;
    assert.equal(peek(), today, "a successful run counts as today's, so the schedule will not repeat it");
    assert.equal((await (await fetch(`${s.base}/api/status`)).json()).jobs.ocr.running, false, "and can be started again once it has finished");
  } finally { s.close(); }
});

test("dashboard: the print-edition job has a name in the job log and a progress row", () => {
  assert.match(readFileSync(new URL("../src/ui/extra.js", import.meta.url), "utf8"), /ocr: "Print editions"/);
  assert.match(readFileSync(new URL("../src/ui/app.js", import.meta.url), "utf8"), /J\.ocr\?\.running\) rows\.push\(live2\("Reading the print editions"/);
});
