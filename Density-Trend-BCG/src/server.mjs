// Local dashboard server: serves the page, answers /api/state (latest rolling window, or any past day), accepts
// company-sector uploads, and keeps matching new brackets against every company while the pipeline runs.
import { createServer } from "node:http";
import { spawn as nodeSpawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSectors, slugify, CompanyStore, matchPending } from "./companies.mjs";
import { Reader } from "./llm.mjs";
import { BracketRegistry } from "./brackets.mjs";
import { buildState, registryCache } from "./state.mjs";
import { buildBracketDensity } from "./density.mjs";
import { Store, dayStart, DAY_MS } from "./db.mjs";

const MAX_BODY = 1_000_000;
const LIVE_FRESH_MS = 90_000; // a run that hasn't touched the database for this long is treated as stopped

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > MAX_BODY) { reject(new Error("Upload too large (1 MB max)")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const validDay = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) && dayStart(s) <= Date.now();

// `spawn` is injectable so tests can check the Run button without launching a real pipeline.
export async function serve({ root, bcg, port = 8788, log = console.log, spawn = nodeSpawn }) {
  const store = new Store(join(root, "data", "hivemind.db"));
  const imported = store.importLegacy(join(root, "data"));
  if (imported) log(`Imported earlier data into the database: ${imported.readings} readings, ${imported.stories} stories`);

  let seed = [], pubNames = [];
  try { seed = JSON.parse(readFileSync(join(root, "config", "brackets.seed.json"), "utf8")); } catch { /* registry starts empty */ }
  try { pubNames = JSON.parse(readFileSync(join(root, "config", "publications.json"), "utf8")).map((p) => p.name); } catch { /* names come from the data */ }
  const registryFile = registryCache(join(root, "data", "brackets-v3.json"), seed);
  const seedRegistry = new BracketRegistry(null, seed);
  const registry = () => registryFile.get() ?? seedRegistry;
  const companies = new CompanyStore(join(root, "data", "companies"));

  // BCG ships as a ready-made company whose sectors are its practice areas.
  if (!companies.get("bcg")) {
    companies.put({ name: "BCG", builtin: true, sectors: bcg.practice_areas.map((p) => ({ name: p.name, description: p.sub.join(", ") })) });
  }

  const reader = new Reader(bcg, new BracketRegistry(null));
  let llm = { ok: false, message: "" };
  try { llm = { ok: true, message: await reader.detect() }; } catch (e) { llm = { ok: false, message: e.message }; }
  log(llm.ok ? `Matching LLM: ${llm.message}` : `Matching disabled: ${llm.message}`);

  // The Run button: starts `cli.mjs run` as a child process (one at a time) and keeps its last output for error messages.
  const runner = { running: false, date: null, startedAt: 0, lastExit: null, lastMessage: "", tail: "", child: null };
  function startRun(date) {
    if (runner.running) return { code: 409, error: "A run is already in progress." };
    if (!llm.ok) return { code: 400, error: `Can't run: ${llm.message}. Start the server with ANTHROPIC_API_KEY set.` };
    const args = [join(root, "src", "cli.mjs"), "run", ...(date ? ["--date", date] : [])];
    const child = spawn(process.execPath, args, { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    Object.assign(runner, { running: true, date, startedAt: Date.now(), lastExit: null, lastMessage: "", tail: "", child });
    const collect = (b) => { runner.tail = (runner.tail + b.toString()).slice(-2000); };
    child.stdout?.on("data", collect); child.stderr?.on("data", collect);
    child.on("error", (e) => { Object.assign(runner, { running: false, lastExit: -1, lastMessage: e.message, child: null }); });
    child.on("close", (code) => {
      const lines = runner.tail.split(/\r?\n/).filter((l) => l.trim() && !/ExperimentalWarning|trace-warnings/.test(l));
      const message = code === 0
        ? lines.filter((l) => /^Read |^Database/.test(l)).join(" · ") || "Finished"
        : [...lines].reverse().find((l) => /^Error:/.test(l)) ?? lines.at(-1) ?? `Exited with code ${code}`;
      Object.assign(runner, { running: false, lastExit: code, lastMessage: message, child: null });
      log(`run ${date ?? "latest"} finished (exit ${code}): ${message}`);
    });
    log(`run started from the dashboard: ${date ?? "latest 24h"}`);
    return { ok: true };
  }
  const runnerState = () => {
    const run = store.latestRun();
    const ours = run && run.updatedAt >= runner.startedAt - 1000; // the database row this process's run is writing
    return { running: runner.running, date: runner.date, startedAt: runner.startedAt, lastExit: runner.lastExit, lastMessage: runner.lastMessage,
      done: runner.running && ours ? run.done : null, total: runner.running && ours ? run.total : null };
  };
  // A run started from a terminal shows up too: any run that touched the database recently and hasn't finished.
  const liveRun = () => {
    const run = store.latestRun();
    return run && !run.finishedAt && Date.now() - run.updatedAt < LIVE_FRESH_MS ? { done: run.done, total: run.total, date: run.targetDate } : null;
  };

  // The stories to show: the latest rolling window, or one local calendar day (stories first published that day).
  function dataFor(date, hours) {
    const run = store.latestRun("rolling");
    const live = null; // progress is reported separately (liveRun), because a backfill can run while another view is open
    const base = { model: run?.model ?? "", articles: run?.headlines ?? 0, publications: run?.publications ?? 0 };
    if (date) {
      const from = dayStart(date), to = from + DAY_MS;
      const stories = store.loadStories({ from, to });
      // Per-publication counts for a past day come from the stored headlines; Google's own "available" count exists only per run.
      const polled = {};
      for (const s of stories) for (const a of s.articles) polled[a.publication] = (polled[a.publication] || 0) + 1;
      const names = pubNames.length ? pubNames : Object.keys(polled);
      return {
        hours: 24,
        data: { meta: { ...base, articles: stories.reduce((n, s) => n + s.articles.length, 0), generatedAt: to, live: null, perPublication: names.map((name) => ({ name, available: null, polled: polled[name] || 0 })) }, stories },
      };
    }
    const now = run?.startedAt ?? Date.now();
    return { hours, data: { meta: { ...base, generatedAt: now, live, perPublication: run?.perPublication ?? [] }, stories: store.loadStories({ from: now - hours * 3600e3, to: now + 1 }) } };
  }

  let matching = false;
  async function matchNow() {
    if (matching || !llm.ok) return;
    matching = true;
    try {
      const { data } = dataFor(null, 48);
      const analysed = data.stories.filter((s) => s.analysis);
      if (analysed.length) {
        // What is in the news right now, per bracket — the matcher writes its angles from these stories.
        const dens = buildBracketDensity(analysed, registry(), { now: data.meta.generatedAt });
        const evidence = new Map(dens.brackets.map((b) => [b.id, { storyCount: b.storyCount, stories: b.drivers }]));
        const n = await matchPending(companies, registry(), reader, { evidence, log });
        if (n) log(`matched ${n} bracket×company judgements`);
      }
    } catch (e) { log(`matching error: ${e.message}`); }
    finally { matching = false; }
  }
  matchNow();
  setInterval(matchNow, 8000).unref();

  const json = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(obj)); };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return res.end(readFileSync(join(root, "src", "dashboard.html")));
      }
      if (req.method === "GET" && url.pathname === "/api/state") {
        const date = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get("date") || "") ? url.searchParams.get("date") : null;
        const { data, hours } = dataFor(date, Math.min(168, Math.max(6, +url.searchParams.get("window") || 48)));
        return json(res, 200, buildState({
          data, registry: registry(), companies: companies.list(), companyId: url.searchParams.get("company") || "bcg", bcg, hours, llm,
          dates: store.days(), view: { date }, runner: runnerState(), live: liveRun(),
        }));
      }
      if (req.method === "POST" && url.pathname === "/api/run") {
        if (!(req.headers["content-type"] || "").startsWith("application/json")) return json(res, 415, { error: "Send application/json" });
        const body = JSON.parse(await readBody(req) || "{}");
        const date = body.date ?? null;
        if (date !== null && !validDay(date)) return json(res, 400, { error: "Pick a valid date (YYYY-MM-DD) that isn't in the future." });
        const r = startRun(date);
        return r.ok ? json(res, 200, { ok: true, date }) : json(res, r.code, { error: r.error });
      }
      if (req.method === "GET" && url.pathname === "/api/dates") return json(res, 200, store.days());
      if (req.method === "POST" && url.pathname === "/api/company") {
        // Requiring JSON blocks cross-site form posts: browsers can't send this content type without a CORS preflight.
        if (!(req.headers["content-type"] || "").startsWith("application/json")) return json(res, 415, { error: "Send application/json" });
        const body = JSON.parse(await readBody(req) || "{}");
        const parsed = parseSectors(body.text, String(body.name || "").trim());
        const name = String(body.name || parsed.name || "").trim();
        if (!name) return json(res, 400, { error: "Enter a company name (or add a 'Company: …' first line to the file)." });
        if (!parsed.sectors.length) return json(res, 400, { error: "No sectors found. Use one sector per line, a comma-separated list, a CSV with a 'sector' column, or JSON." });
        const company = companies.put({ name, sectors: parsed.sectors });
        matchNow();
        return json(res, 200, { id: company.id, name: company.name, sectors: company.sectors });
      }
      if (req.method === "DELETE" && url.pathname === "/api/company") {
        const id = slugify(url.searchParams.get("id") || "");
        const c = companies.get(id);
        if (!c) return json(res, 404, { error: "Unknown company" });
        if (c.builtin) return json(res, 400, { error: "The built-in company can't be removed" });
        companies.remove(id);
        return json(res, 200, { ok: true });
      }
      json(res, 404, { error: "Not found" });
    } catch (e) {
      json(res, e instanceof SyntaxError ? 400 : 500, { error: e instanceof SyntaxError ? "Invalid JSON" : e.message });
    }
  });
  server.on("close", () => { runner.child?.kill(); store.close(); });

  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  log(`Dashboard: http://127.0.0.1:${port}`);
  return server;
}
