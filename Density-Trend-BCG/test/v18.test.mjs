// A collection is visible on the dashboard from its first second (while Google News is still being polled), however it was started.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, cpSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db.mjs";

process.env.HIVEMIND_LLM = "off";
const bcg = JSON.parse(readFileSync(new URL("../config/bcg.json", import.meta.url), "utf8"));

test("runs: recorded before the plan is known, completed by planRun, and a failed run before reading leaves no trace", () => {
  const s = new Store(":memory:");
  const id = s.startRun({ model: "m", headlines: 0, publications: 19, total: 0, perPublication: [], targetDate: null });
  assert.deepEqual(s.runStats(id), { headlines: 0, total: 0, done: 0, perPublication: [] }, "visible with nothing known yet");
  s.progressRun(id, 0); // a heartbeat while polling
  s.planRun(id, { headlines: 2611, total: 2112, perPublication: [{ name: "The Hindu", available: 203, polled: 203 }] });
  assert.deepEqual(s.runStats(id), { headlines: 2611, total: 2112, done: 0, perPublication: [{ name: "The Hindu", available: 203, polled: 203 }] });
  s.progressRun(id, 400); s.discardRun(id);
  assert.ok(s.latestRun(), "a run that has read stories is never deleted");
  const early = s.startRun({ model: "m", headlines: 0, publications: 19, total: 0, perPublication: [], targetDate: null });
  s.discardRun(early); assert.equal(s.runStats(early), undefined, "a run that failed before reading anything is removed");
  const done = s.startRun({ model: "m", headlines: 1, publications: 1, total: 1, perPublication: [], targetDate: null }); s.finishRun(done, 0); s.discardRun(done);
  assert.ok(s.runStats(done), "a finished run is never deleted");
  s.close();
});

test("dashboard status: a run shows as live from its first second, with total 0 while polling, then with counts; finished or silent runs do not", async () => {
  const root = mkdtempSync(join(tmpdir(), "live-"));
  mkdirSync(join(root, "src")); mkdirSync(join(root, "data"));
  cpSync(new URL("../config", import.meta.url), join(root, "config"), { recursive: true });
  cpSync(new URL("../src/ui", import.meta.url), join(root, "src", "ui"), { recursive: true });
  for (const f of ["dashboard.html", "login.html"]) copyFileSync(new URL(`../src/${f}`, import.meta.url), join(root, "src", f));
  const { serve } = await import("../src/server.mjs");
  const server = await serve({ root, bcg, port: 0, autoSync: false, auth: false, log: () => {} });
  const status = async () => (await fetch(`http://127.0.0.1:${server.address().port}/api/status`)).json();
  const other = new Store(join(root, "data", "hivemind.db")); // the collection runs in another process, sharing the database file
  try {
    assert.equal((await status()).live, null, "nothing running");
    const id = other.startRun({ model: "m", headlines: 0, publications: 19, total: 0, perPublication: [], targetDate: null });
    assert.deepEqual((await status()).live, { done: 0, total: 0, date: null }, "visible at once, while Google News is polled");
    other.planRun(id, { headlines: 2611, total: 2112, perPublication: [] }); other.progressRun(id, 421);
    assert.deepEqual((await status()).live, { done: 421, total: 2112, date: null });
    other.db.prepare("UPDATE runs SET updated_at = ? WHERE id = ?").run(Date.now() - 120000, id);
    assert.equal((await status()).live, null, "a run that has been silent for two minutes is treated as stopped");
    other.progressRun(id, 500); assert.ok((await status()).live, "alive again once it reports");
    other.finishRun(id, 2112); assert.equal((await status()).live, null, "finished");
  } finally { other.close(); server.close(); server.closeAllConnections?.(); }
});

test("dashboard page: a live run with no counts yet draws the 'polling Google News' row instead of nothing", () => {
  const src = readFileSync(new URL("../src/ui/app.js", import.meta.url), "utf8");
  assert.match(src, /if \(r\.running \|\| live\) rows\.push\(col\?\.total \? progressRow\([^\n]*polling Google News/, "the progress code handles live-with-total-0");
});
