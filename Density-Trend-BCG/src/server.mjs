// Local dashboard server: serves the UI, answers the analytics API (overview, opportunities, topic momentum, sources,
// authors, briefs, backtest), accepts company-sector uploads, and keeps matching new brackets against every company
// while the pipeline runs. Also exposes the older /api/state used by the first dashboard.
import { createServer } from "node:http";
import { gzip, gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import { spawn as nodeSpawn } from "node:child_process";
import { readFileSync, existsSync, statSync, createReadStream } from "node:fs";
import { join, extname } from "node:path";
import { parseSectors, slugify, CompanyStore, matchPending } from "./companies.mjs";
import { Reader, budgetGuard } from "./llm.mjs";
import { ocrDue, parseTime } from "./schedule.mjs";
import { BracketRegistry } from "./brackets.mjs";
import { buildState, registryCache } from "./state.mjs";
import { buildBracketDensity } from "./density.mjs";
import { Store, dayStart, DAY_MS, dayOf } from "./db.mjs";
import { SourceRegistry } from "./origins.mjs";
import { TopicRegistry } from "./topics.mjs";
import { Analytics } from "./analytics.mjs";
import { normalizeAuthor, parseAuthors } from "./authors.mjs";
import { fetchSerpApi, parseSearchUpload, searchInterestStatus } from "./signals.mjs";
import { norm } from "./brackets.mjs";
import { entityId } from "./entities.mjs";
import { Integrations } from "./integrations.mjs";
import { detectSystem, detectOllama, machineId } from "./system.mjs";
import { buildQuery, fetchCounts, socialStats } from "./social.mjs";
// JOURNALISTS DISABLED for now: the directory, its sync, matching and API are commented out. Re-enable by removing the comment markers.
// import { syncJournalists, DEFAULT_URL as JOURNALISTS_URL } from "./journalists.mjs";
import { refreshHot } from "./hot.mjs";
import { dedupePass } from "./quality.mjs";
import { usageReport } from "./usage.mjs";
import { writeFileAtomic } from "./atomic.mjs";
import { createAuth, setSecurityHeaders } from "./auth.mjs";

const MAX_BODY = 1_000_000;
const LIVE_FRESH_MS = 90_000; // a run that hasn't touched the database for this long is treated as stopped
const STATIC = { ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".mp4": "video/mp4" };
const DECISIONS = new Set(["approved", "rejected", "needs_evidence", "pending"]);

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > MAX_BODY) { reject(new Error("Upload too large (1 MB max)")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const validDay = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) && dayStart(s) <= Date.now();
const dayParam = (u) => (/^\d{4}-\d{2}-\d{2}$/.test(u.searchParams.get("date") || "") ? u.searchParams.get("date") : null);
const readJson = (p, fallback) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return fallback; } };

// `spawn` is injectable so tests can check the Run button without launching a real pipeline.
export async function serve({ root, bcg, port = 8788, host = process.env.HIVEMIND_HOST || "127.0.0.1", log = console.log, spawn = nodeSpawn, scheduleMinutes = null, autoSync = true, auth = true }) {
  try { process.loadEnvFile?.(join(root, ".env")); } catch (e) { if (e?.code !== "ENOENT") throw e; }
  const store = new Store(join(root, "data", "hivemind.db"));
  const imported = store.importLegacy(join(root, "data"));
  if (imported) log(`Imported earlier data into the database: ${imported.readings} readings, ${imported.stories} stories`);

  const seed = readJson(join(root, "config", "brackets.seed.json"), []);
  const pubs = readJson(join(root, "config", "publications.json"), []);
  const cfg = readJson(join(root, "config", "hivemind.json"), {});
  const sources = new SourceRegistry(pubs);
  const pubNames = pubs.map((p) => p.name);
  const registryFile = registryCache(join(root, "data", "brackets-v3.json"), seed);
  const seedRegistry = new BracketRegistry(null, seed);
  const registry = () => registryFile.get() ?? seedRegistry;
  const companies = new CompanyStore(join(root, "data", "companies"));

  // BCG ships as a ready-made company whose sectors are its practice areas.
  if (!companies.get("bcg")) {
    companies.put({ name: "BCG", builtin: true, sectors: bcg.practice_areas.map((p) => ({ name: p.name, description: p.sub.join(", ") })) });
  }
  // Re-tuned weights (only ever written after someone confirms a suggestion in Accuracy) override the shipped pilot weights.
  const weightsFile = join(root, "data", "weights.override.json");
  const override = readJson(weightsFile, null);
  if (override?.weights && Object.keys(override.weights).length === Object.keys(cfg.weights ?? {}).length) cfg.weights = override.weights;
  store.closeStaleJobs(); // a previous server that was stopped mid-job leaves 'running' rows behind
  const integrations = new Integrations({ root, store });
  const mid = machineId();
  const reader = new Reader(bcg, new BracketRegistry(null), new TopicRegistry(null), {
    integrations,
    settings: () => store.getJson(`llm.settings.${mid}`, { primary: "anthropic", fallback: true, ollamaModel: null }),
    onEvent: (name, ev) => integrations.recordEvent(name, ev),
    onUsage: (name, u) => { try { store.addUsage(name, u); } catch { /* never break a call over a counter */ } },
    routing: cfg.routing ?? {},
    models: cfg.models ?? {},
    effort: cfg.effort ?? {},
    routingNoClaude: cfg.routingNoClaude ?? {},
    overBudget: budgetGuard(store, cfg, () => dayOf(Date.now())),
  });
  let llm = { ok: false, message: "" };
  try { llm = { ok: true, message: await reader.detect() }; } catch (e) { llm = { ok: false, message: e.message }; }
  log(llm.ok ? `Matching LLM: ${llm.message}` : `Matching disabled: ${llm.message}`);

  const analytics = new Analytics({ store, registry, sources, cfg, companies, reader, pubs });

  // Background jobs run as child processes of the CLI, one of each kind at a time.
  // Job kinds (the log's "kind") and the command line each one runs. One job of each kind at a time.
  const KINDS = {
    run: { cmd: "run", summary: /^Read |^Database/ },
    enrich: { cmd: "enrich", summary: /^Labelled / },
    sentiment: { cmd: "sentiment", summary: /^Labelled sentiment/ },
    "topic-merge": { cmd: "topics-merge", summary: /^Merged / },
    "entities-merge": { cmd: "entities-merge", summary: /^Merged \d+ duplicate entity/ },
    fulltext: { cmd: "fulltext", summary: /^Upgraded |^\d+ stories were read/ },
    ocr: { cmd: "ocr", summary: /^Database: .*print articles/ },
    online: { cmd: "online", summary: /^Online pieces:|^Database: .*online pieces|^Daily cap/ },
  };
  const jobs = Object.fromEntries(Object.keys(KINDS).map((k) => [k, { running: false, date: null, startedAt: 0, lastExit: null, lastMessage: "", tail: "", child: null, logId: null }]));
  const anyJobRunning = () => Object.values(jobs).some((j) => j.running);
  // Every job is written to the job log (Settings → Logs): what started it, what it did, and how it ended.
  function startJob(kind, args, { date = null, after = null, trigger = "manual", onDone = null } = {}) {
    const j = jobs[kind], spec = KINDS[kind];
    if (j.running) return { code: 409, error: `A ${kind} job is already in progress.` };
    if (!llm.ok) return { code: 400, error: `Can't ${kind}: ${llm.message}. Add a GROQ_API_KEY or OPENAI_API_KEY, or switch Claude on in Settings → Integrations.` };
    // No job uses a proxy for general traffic. The one use is inside the jobs themselves: article text that could not be fetched directly is retried through it.
    const child = spawn(process.execPath, [join(root, "src", "cli.mjs"), ...args], { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const logId = store.startJob({ kind, trigger, summary: date ? `for ${date}` : "", stats: { args: args.slice(1).join(" ") } });
    Object.assign(j, { running: true, date, startedAt: Date.now(), lastExit: null, lastMessage: "", tail: "", child, logId });
    let carry = "", statsLine = null;
    const collect = (b) => {
      const text = b.toString();
      j.tail = (j.tail + text).slice(-2000);
      carry += text; const parts = carry.split(/\r?\n/); carry = parts.pop();
      for (const l of parts) if (l.startsWith("STATS ")) statsLine = l.slice(6);
    };
    child.stdout?.on("data", collect); child.stderr?.on("data", collect);
    const finish = (code, message) => {
      if (!j.running) return;
      let stats = {}; try { stats = JSON.parse(statsLine ?? "{}"); } catch { /* keep empty */ }
      Object.assign(j, { running: false, lastExit: code, lastMessage: message, child: null });
      try { store.finishJob(j.logId, { status: code === 0 ? "ok" : "failed", summary: message, stats, error: code === 0 ? null : message }); } catch { /* database closing */ }
      log(`${kind} ${date ?? ""} finished (exit ${code}): ${message}`);
      if (code === 0) { try { analytics.snapshot(); } catch (e) { log(`snapshot error: ${e.message}`); } try { after?.(); } catch (e) { log(`post-run step failed: ${e.message}`); } }
      try { onDone?.(code); } catch (e) { log(`follow-up step failed: ${e.message}`); }
    };
    child.on("error", (e) => finish(-1, e.message));
    child.on("close", (code) => {
      const lines = j.tail.split(/\r?\n/).filter((l) => l.trim() && !/ExperimentalWarning|trace-warnings|^STATS /.test(l));
      const message = code === 0
        ? lines.filter((l) => spec.summary.test(l)).join(" · ") || "Finished"
        : [...lines].reverse().find((l) => /^Error:/.test(l)) ?? lines.at(-1) ?? `Exited with code ${code}`;
      finish(code, message);
    });
    log(`${kind} started (${trigger})${date ? `: ${date}` : ""}`);
    return { ok: true };
  }
  const startRun = (date, hours = null, trigger = "manual") => startJob("run", ["run", ...(date ? ["--date", date] : []), ...(hours ? ["--hours", String(hours)] : [])], { date, trigger, onDone: (code) => { if (code === 0) followUps("auto"); } });
  const startEnrich = (limit, trigger = "manual", onDone = null) => startJob("enrich", ["enrich", ...(limit ? ["--limit", String(limit)] : [])], { trigger, onDone });
  const startSentiment = (limit = 0, trigger = "manual", onDone = null) => startJob("sentiment", ["sentiment", ...(limit ? ["--limit", String(limit)] : [])], { trigger, onDone });
  const startEntityMerge = (trigger = "manual", onDone = null) => startJob("entities-merge", ["entities-merge"], { trigger, onDone });
  const startMerge = (trigger = "manual", onDone = null) => startJob("topic-merge", ["topics-merge"], { trigger, onDone });
  // The print editions: download, find the opinion and analysis pieces, match them to angles. It looks back a few days so that an edition that was not out yet is picked up later.
  // A successful run, started by hand or by the schedule, counts as that day's run (so the schedule does not repeat what someone has just done).
  const startOcr = (trigger = "manual") => {
    const today = dayOf(Date.now());
    return startJob("ocr", ["ocr", "--from", dayOf(Date.now() - (cfg.ocr?.scheduledDays ?? 3) * 864e5)], { trigger, onDone: (code) => { if (code === 0) store.setMeta("ocr.okDay", today); } });
  };
  // Online opinion pieces: read the text, confirm, find writers, match to angles. Only reaches the model (Groq) when started: by the Leadership page's button,
  // or after a collection when online.analyze is switched on in the config. The daily cap (online.dailyCap) bounds it either way.
  const startOnline = (trigger = "manual", onDone = null) => startJob("online", ["online"], { trigger, onDone: (code) => { if (code === 0) analytics.cache.clear(); onDone?.(code); } });
  const startFulltext = (trigger = "manual", onDone = null) => startJob("fulltext", ["fulltext"], { trigger, onDone });

  // After a collection (or on start) the follow-up work runs one step at a time, each only if there is something to do:
  // topic labels for stories that have none, sentiment for stories read before it existed, a topic-merge pass when enough new
  // topics have appeared, a second full-text attempt for headline-only stories (within its daily allowance), then the
  // hot-topic web check. One at a time keeps the model's rate limit and the cost predictable.
  let chainRunning = false;
  function followUps(trigger = "auto") {
    if (chainRunning || closed || !llm.ok) return;
    chainRunning = true;
    // A restart should not repeat the optional, paid steps (topic judging, entity merge, second opinion, hot-topic web checks) if the full chain ran recently.
    const light = trigger === "startup" && Date.now() - (+store.getMeta("followups.lastFullAt", 0) || 0) < 6 * 3600e3;
    const steps = [
      () => (store.unenrichedCount() > 0 ? startEnrich(500, trigger, next) : null),
      () => (store.unsentimentedCount() >= 10 ? startSentiment(0, trigger, next) : null), // new stories get it inside their normal reading; this only catches a real backlog
      () => (topicsSinceMerge() >= 40 ? startMerge(trigger, next) : null),
      () => (light ? null : Date.now() - (+store.getMeta("entities.lastMergeAt", 0) || 0) > 24 * 3600e3 ? startEntityMerge(trigger, next) : null),
      () => { dedupeNow(trigger); return null; },
      () => (light ? null : (topicVerifyNow(trigger).finally(next), { ok: true })),
      () => (light ? null : (topicMatchNow(trigger).finally(next), { ok: true })),
      () => (!light && Date.now() - (+store.getMeta("secondOpinion.lastAt", 0) || 0) > 7 * 864e5 ? (secondOpinionNow(trigger).finally(next), { ok: true }) : null),
      () => (cfg.fulltext?.enabled && store.fulltextCandidates({ limit: 1, maxTries: cfg.fulltext?.maxTries ?? 2, retryAfterMs: (cfg.fulltext?.retryAfterHours ?? 12) * 3600e3 }).length && fulltextAllowanceLeft() > 0 ? startFulltext(trigger, next) : null),
      () => (light ? null : (hotNow(trigger).finally(next), { ok: true })),
      () => (cfg.online?.analyze === true && trigger !== "startup" ? startOnline(trigger, next) : null),
    ];
    let i = 0;
    function next() {
      if (closed) { chainRunning = false; return; }
      while (i < steps.length) { const r = steps[i++](); if (r?.ok) return; }
      if (!light) store.setMeta("followups.lastFullAt", String(Date.now()));
      chainRunning = false;
    }
    next();
  }
  const topicsSinceMerge = () => store.loadTopics().filter((t) => t.count > 0).length - (+store.getMeta("topics.afterLastMerge", 0) || 0);
  const fulltextAllowanceLeft = () => Math.max(0, (cfg.fulltext?.dailyRetries ?? 400) - store.usage("fulltext", dayOf(Date.now())).calls);

  // Duplicate stories and template pages are marked (never deleted) and left out of the analysis.
  function dedupeNow(trigger = "auto") {
    try {
      const r = dedupePass(store, cfg, { since: Date.now() - 72 * 3600e3 });
      if (r.duplicates || r.junk) { const id = store.startJob({ kind: "dedupe", trigger, summary: "" }); store.finishJob(id, { status: "ok", summary: `Checked ${r.scanned} recent stories: ${r.duplicates} repeats merged, ${r.junk} template pages excluded`, stats: r }); analytics.cache.clear(); }
      return r;
    } catch (e) { log(`duplicate check failed: ${e.message}`); return { error: e.message }; }
  }

  // Headlines filed under the topics behind today's opportunities are checked against the topic. Those that do not really fit
  // (a police arrest filed under "police misconduct") are left out of that topic, so its counts and origins are not inflated.
  let verifyRunning = false;
  async function topicVerifyNow(trigger = "manual") {
    if (verifyRunning || closed || !llm.ok) return { skipped: "busy or model unavailable" };
    verifyRunning = true;
    let id = null, checked = 0, dropped = 0, topicsDone = 0, badBatches = 0, lastError = "", aChecked = 0, aDropped = 0;
    try {
      const work = analytics.topicVerifyCandidates(), awork = analytics.angleFitCandidates();
      if (!work.length && !awork.length) return { skipped: "nothing new to check" };
      id = store.startJob({ kind: "topic-verify", trigger, summary: "" });
      const size = cfg.topicVerify?.batch ?? 25;
      for (const t of [...work, ...awork]) {
        for (let i = 0; i < t.items.length && !closed; i += size) {
          const batch = t.items.slice(i, i + size);
          // one batch that cannot be answered is skipped (and counted), so a single bad answer does not throw away the whole check
          let res; try { res = await reader.verifyTopicFit(t.name, t.aliases, batch, t.angle ?? null); } catch (e) { badBatches++; lastError = e.message; continue; }
          if (res.length) { store.putTopicChecks(res.map((r) => ({ key: r.key, topic: t.checkId ?? t.id, fits: r.fits, why: r.why }))); if (t.angle) { aChecked += res.length; aDropped += res.filter((r) => !r.fits).length; } else { checked += res.length; dropped += res.filter((r) => !r.fits).length; } }
        }
        topicsDone++;
      }
      if (badBatches && !checked && !aChecked) throw new Error(lastError); // nothing could be answered at all: that is a real failure
      store.finishJob(id, { status: "ok", summary: `Checked ${checked} headlines across ${topicsDone} topics: ${dropped} did not really fit their topic and are left out${aChecked ? `; ${aChecked} checked against the angle, ${aDropped} did not support it and are left out` : ""}${badBatches ? ` (${badBatches} batch${badBatches === 1 ? "" : "es"} skipped after errors; they are checked next time)` : ""}`, stats: { checked, dropped, angleChecked: aChecked, angleDropped: aDropped, topics: topicsDone, skippedBatches: badBatches } });
      analytics.cache.clear(); analytics._q = null;
      return { checked, dropped };
    } catch (e) { if (id != null) { try { store.finishJob(id, { status: "failed", summary: e.message, error: e.message }); } catch { /* closing */ } } return { error: e.message }; }
    finally { verifyRunning = false; }
  }

  // Each top rising topic is judged directly against the client's sectors (relevance, angle) instead of inheriting its parent area's match.
  let matchRunning = false;
  async function topicMatchNow(trigger = "manual", { force = false } = {}) {
    if (matchRunning || closed || !llm.ok) return { skipped: "busy or model unavailable" };
    matchRunning = true;
    let id = null, judged = 0, badBatches = 0, lastError = "";
    try {
      const size = cfg.topicMatch?.batch ?? 6;
      for (const co of companies.list()) {
        const cands = analytics.topicMatchCandidates(co.id, { force });
        if (!cands.length) continue;
        if (id == null) id = store.startJob({ kind: "topic-match", trigger, summary: "" });
        for (let i = 0; i < cands.length && !closed; i += size) {
          const batch = cands.slice(i, i + size);
          let res; try { res = await reader.match(co, batch.map((b) => ({ id: b.key, name: b.name, description: b.description })), new Map(batch.map((b) => [b.key, { storyCount: b.storyCount, stories: b.stories }]))); } catch (e) { badBatches++; lastError = e.message; continue; } // skip one bad batch, keep the rest
          for (const b of batch) { const r = res.get(b.key); if (r) { store.putTopicMatches(co.id, b.id, r.sectors, b.storyCount); judged++; } }
        }
      }
      if (id == null) return { skipped: "nothing to judge" };
      if (badBatches && !judged) throw new Error(lastError);
      store.finishJob(id, { status: "ok", summary: `Judged ${judged} rising topic${judged === 1 ? "" : "s"} against each client's sectors${badBatches ? ` (${badBatches} batch${badBatches === 1 ? "" : "es"} skipped after errors)` : ""}`, stats: { judged, skippedBatches: badBatches } });
      analytics.cache.clear();
      return { judged };
    } catch (e) { if (id != null) { try { store.finishJob(id, { status: "failed", summary: e.message, error: e.message }); } catch { /* closing */ } } return { error: e.message }; }
    finally { matchRunning = false; }
  }

  // A stronger model double-checks the readings behind the top opportunities.
  let reviewRunning = false;
  async function secondOpinionNow(trigger = "manual") {
    const model = reader.noClaude ? (reader.openaiOk ? reader.openaiModel : reader.groqModel) : cfg.audit?.reviewModel; // the reviewer is whichever model answers
    if (reviewRunning || closed || !llm.ok || !model) return { skipped: "busy, unavailable or no review model set" };
    reviewRunning = true;
    const id = store.startJob({ kind: "second-opinion", trigger, summary: "" });
    try {
      const cands = analytics.reviewCandidates({ limit: cfg.audit?.secondOpinionTop ?? 30, model });
      let agree = 0, disagree = 0;
      for (let i = 0; i < cands.length && !closed; i += 10) {
        const batch = cands.slice(i, i + 10);
        for (const r of await reader.reviewReadings(batch, model)) { const s = batch[r.n - 1]; store.putReview(s.key, model, r.agrees, r.note); r.agrees ? agree++ : disagree++; }
      }
      store.setMeta("secondOpinion.lastAt", String(Date.now()));
      store.finishJob(id, { status: "ok", summary: cands.length ? `Second opinion (${model}) on ${agree + disagree} readings: ${agree} agree, ${disagree} disagree` : "Nothing new to review", stats: { agree, disagree, model } });
      return { agree, disagree };
    } catch (e) { try { store.finishJob(id, { status: "failed", summary: e.message, error: e.message }); } catch { /* closing */ } return { error: e.message }; }
    finally { reviewRunning = false; }
  }

  // Hot topics: wider web check (Serper) and search interest (SerpApi) for the few topics that are rising now, within daily budgets.
  let hotRunning = false;
  async function hotNow(trigger = "manual") {
    if (hotRunning || closed) return { skipped: "already running" };
    hotRunning = true;
    const id = store.startJob({ kind: "hot-topics", trigger, summary: "" });
    try {
      const opps = analytics.opportunities({ company: "bcg", limit: 300, group: true }).items;
      const r = await refreshHot({ store, integrations, opps, cfg, sources, log });
      const msg = r.skipped ? `Skipped: ${r.skipped}` : `Checked ${r.checked} hot topic${r.checked === 1 ? "" : "s"}: ${r.serper} Serper search${r.serper === 1 ? "" : "es"}, ${r.serpapi} search-interest fetch${r.serpapi === 1 ? "" : "es"}${r.errors ? `, ${r.errors} failed` : ""}`;
      store.finishJob(id, { status: r.errors && !r.checked ? "failed" : "ok", summary: msg, stats: r, error: r.errors && !r.checked ? msg : null });
      return r;
    } catch (e) { try { store.finishJob(id, { status: "failed", summary: e.message, error: e.message }); } catch { /* closing */ } return { error: e.message }; }
    finally { hotRunning = false; }
  }

  const runnerState = () => {
    const run = store.latestRun();
    const j = jobs.run, ours = run && run.updatedAt >= j.startedAt - 1000; // the database row this process's run is writing
    return { running: j.running, date: j.date, startedAt: j.startedAt, lastExit: j.lastExit, lastMessage: j.lastMessage,
      done: j.running && ours ? run.done : null, total: j.running && ours ? run.total : null };
  };
  // A run started from a terminal shows up too: any run that touched the database recently and hasn't finished.
  const liveRun = () => {
    const run = store.latestRun();
    return run && !run.finishedAt && Date.now() - run.updatedAt < LIVE_FRESH_MS ? { done: run.done, total: run.total, date: run.targetDate } : null;
  };
  let closed = false; // set when the server shuts down, so background work stops instead of writing to a closed database
  // // Journalist directory: pulled from the external endpoint into the local database (resumable; one sync at a time).
  // const journalistsUrl = () => process.env.JOURNALISTS_API_URL || JOURNALISTS_URL;
  // const jsync = { running: false, page: 0, pages: null, saved: 0, total: null, error: null, startedAt: 0, finishedAt: 0 };
  // async function startJournalistSync(trigger = "manual") {
  //   if (jsync.running) return false;
  //   Object.assign(jsync, { running: true, page: 0, pages: null, saved: 0, total: null, error: null, startedAt: Date.now() });
  //   const logId = store.startJob({ kind: "journalists", trigger, summary: "" });
  //   syncJournalists(store, { url: journalistsUrl(), onProgress: (p) => { if (closed) throw new Error("server closed"); Object.assign(jsync, p); } })
  //     .then((r) => { if (closed) return; log(`journalist directory synced: ${r.total} records`); integrations.recordEvent("journalists", { ok: true, detail: `${r.total} records` }); store.finishJob(logId, { status: "ok", summary: `Directory synced: ${r.total} journalists`, stats: { total: r.total } }); })
  //     .catch((e) => { if (closed) return; jsync.error = e.message; log(`journalist sync failed: ${e.message}`); integrations.recordEvent("journalists", { ok: false, error: e.message }); try { store.finishJob(logId, { status: "failed", summary: e.message, error: e.message }); } catch { /* closing */ } })
  //     .finally(() => { jsync.running = false; jsync.finishedAt = Date.now(); });
  //   return true;
  // }
  // const journalistStatus = () => ({ count: store.journalistCount(), lastSync: +store.getMeta("journalists.lastSync", 0) || null, url: journalistsUrl(), ...jsync });
  const status = () => ({
    llm, runner: runnerState(), live: liveRun(),
    jobs: Object.fromEntries(Object.entries(jobs).map(([k, j]) => [k, { running: j.running, startedAt: j.startedAt, lastExit: j.lastExit, lastMessage: j.lastMessage }])),
    sentiment: { running: jobs.sentiment.running, startedAt: jobs.sentiment.startedAt, labelled: store.sentimentCount(), pending: store.unsentimentedCount() },
    topicMerge: { running: jobs["topic-merge"].running, merged: store.mergedTopicCount() },
    activity: { topicVerify: verifyRunning, topicMatch: matchRunning, hot: hotRunning, secondOpinion: reviewRunning, followUps: chainRunning },
    fulltext: { running: jobs.fulltext.running, headlineOnly: store.headlineOnlyCount(), allowanceLeft: fulltextAllowanceLeft() },
    enrich: { running: jobs.enrich.running, startedAt: jobs.enrich.startedAt, lastExit: jobs.enrich.lastExit, lastMessage: jobs.enrich.lastMessage, labelled: store.enrichmentCount(), readings: store.readingCount(), pending: store.unenrichedCount() },
    schedule: { minutes: scheduleMinutes, lastRunAt: store.latestRun("rolling")?.startedAt ?? null, nextRunAt: scheduleMinutes ? (store.latestRun("rolling")?.startedAt ?? Date.now()) + scheduleMinutes * 60e3 : null },
    searchInterest: searchInterestStatus(), serverTime: Date.now(),
    companies: companies.list().map((c) => ({ id: c.id, name: c.name, builtin: !!c.builtin, sectors: c.sectors.length, matched: Object.keys(c.matches).length })),
    dates: store.days(), recommendations: store.recommendationCount(),
    integrations: integrations.status({ ollama: { reachable: reader.chain.includes("ollama") }, journalists: { count: store.journalistCount() } }),
    // journalists: journalistStatus(), // JOURNALISTS DISABLED
    provider: reader.provider, noClaude: reader.noClaude, models: { groq: reader.groqOk ? reader.groqModel : null, openai: reader.openaiOk ? reader.openaiModel : null },
    chain: reader.chain,
    fallbackActive: reader.fallbackActive,
  });

  // The stories for the first dashboard's /api/state: the latest rolling window, or one local calendar day.
  function dataFor(date, hours) {
    const run = store.latestRun("rolling");
    const base = { model: run?.model ?? "", articles: run?.headlines ?? 0, publications: run?.publications ?? 0 };
    if (date) {
      const from = dayStart(date), to = from + DAY_MS;
      const stories = store.loadStories({ from, to });
      const polled = {};
      for (const s of stories) for (const a of s.articles) polled[a.publication] = (polled[a.publication] || 0) + 1;
      const names = pubNames.length ? pubNames : Object.keys(polled);
      return { hours: 24, data: { meta: { ...base, articles: stories.reduce((n, s) => n + s.articles.length, 0), generatedAt: to, live: null, perPublication: names.map((name) => ({ name, available: null, polled: polled[name] || 0 })) }, stories } };
    }
    const now = run?.startedAt ?? Date.now();
    return { hours, data: { meta: { ...base, generatedAt: now, live: null, perPublication: run?.perPublication ?? [] }, stories: store.loadStories({ from: now - hours * 3600e3, to: now + 1 }) } };
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
  // The pairing check is not run on start: it runs when a company or its sectors change.
  // // First start (or a week-old directory): pull the journalist directory in the background.
  // if (autoSync && integrations.enabled("journalists") && (!store.journalistCount() || Date.now() - (+store.getMeta("journalists.lastSync", 0) || 0) > 7 * 864e5)) startJournalistSync("auto");
  const timers = [setInterval(matchNow, 8000)];
  // Recommendation history: re-evaluate every few minutes and log what changed and why.
  timers.push(setInterval(() => { try { analytics.snapshot(); } catch (e) { log(`snapshot error: ${e.message}`); } }, 5 * 60e3));
  setTimeout(() => { try { analytics.snapshot(); } catch (e) { log(`snapshot error: ${e.message}`); } }, 4000).unref();
  // Optional scheduled collection (the document's pilot polls hourly). Off unless HIVEMIND_SCHEDULE_MINUTES / --schedule is set.
  if (scheduleMinutes && scheduleMinutes >= 15) {
    // Each scheduled run polls only the time since the last run (plus an hour of overlap), 3 to 24 hours. That keeps Google queries
    // small and under its ~100-headline cap; stories already stored are never read again.
    const tick = () => {
      if (jobs.run.running || liveRun() || !llm.ok || closed) return;
      const last = store.latestRun("rolling")?.startedAt ?? 0;
      const hours = Math.min(24, Math.max(3, Math.ceil((Date.now() - last) / 3600e3) + 1));
      if (last && Date.now() - last < scheduleMinutes * 60e3 * 0.9) return; // not due yet
      startRun(null, hours, "scheduled");
    };
    timers.push(setInterval(tick, 5 * 60e3));
    setTimeout(tick, 15000).unref(); // catch up right after start if the data is stale
    log(`Scheduled collection: every ${scheduleMinutes} min`);
  }
  // Keep the dashboard's views ready: shortly after start and then every minute, the views the pages ask for are built (in the worker thread) whenever the data
  // has changed, so a person opening a tab reads a finished result. Unchanged data costs almost nothing: the saved answer is still current.
  // The addresses are the ones the pages request (same arguments, so they hit the same saved answers).
  let warming = false;
  const warm = async () => {
    if (closed || warming) return;
    warming = true;
    try {
      const urls = ["/api/leadership?mode=whitespace", "/api/leadership?mode=validated", "/api/labels?level=bracket&limit=300", "/api/labels?level=topic&limit=300", "/api/entities?", "/api/sentiment?", "/api/sources?", "/api/backtest"];
      for (const co of companies.list()) {
        urls.push(`/api/overview?company=${co.id}`);
        for (const g of ["topic", "pair"]) for (const m of ["whitespace", "validated"]) urls.push(`/api/opportunities?company=${co.id}&limit=1000&group=${g}&mode=${m}&slim=1`);
      }
      for (const u of urls) {
        if (closed) break;
        const x = new URL(u, "http://localhost"), v = ROUTES[x.pathname](x, slugify(x.searchParams.get("company") || "bcg") || "bcg");
        try { await viewEntry(v.method, v.args); } catch { /* one view failing must not stop the others */ }
      }
    } catch (e) { log(`warm-up skipped: ${e.message}`); }
    warming = false;
  };
  try { store.pruneViews(); } catch { /* derived data; nothing depends on it */ }
  setTimeout(warm, 3000).unref(); timers.push(setInterval(warm, 60e3));
  // A one-time request (meta "followups.requested") to run the follow-up chain, for when a restart cut it short. Read once at start, then cleared.
  if (store.getMeta("followups.requested", "") === "1") { store.setMeta("followups.requested", ""); setTimeout(() => followUps("auto"), 5000).unref(); log("follow-ups requested: running them once"); }
  // Print editions: once a day from ocr.dailyAt (local time, default 11:15; see schedule.mjs). Part of the same automatic mode as the scheduled
  // collection, so it is off with --no-auto. A time that passed while the server was off is made up when it next runs.
  if (autoSync && cfg.ocr?.dailyAt !== false) {
    const tick = () => {
      if (closed || !llm.ok || jobs.ocr.running) return;
      const now = new Date(), today = dayOf(now.getTime());
      const state = { okDay: store.getMeta("ocr.okDay"), tries: +store.getMeta(`ocr.tries.${today}`, 0) || 0, lastTryAt: +store.getMeta("ocr.lastTryAt", 0) || 0 };
      if (!ocrDue(now, cfg.ocr?.dailyAt, state)) return;
      const r = startOcr("scheduled");
      if (r?.error) { log(`print editions not started: ${r.error}`); return; }
      store.setMeta(`ocr.tries.${today}`, String(state.tries + 1)); store.setMeta("ocr.lastTryAt", String(now.getTime()));
    };
    timers.push(setInterval(tick, 5 * 60e3));
    setTimeout(tick, 30000).unref();
    log(`Print editions: once a day from ${parseTime(cfg.ocr?.dailyAt).label}`);
  }
  // Nothing that reaches a model runs just because the server started (restarts are frequent while developing); the follow-ups run after each collection.
  if (autoSync) {
    // One-time clean-up after an upgrade: mark old duplicates and template pages, and void recommendations whose pairing no longer exists.
    setTimeout(() => {
      if (closed) return;
      try {
        if (!store.getMeta("dedupe.initial")) { const r = dedupePass(store, cfg, { since: 0 }); store.setMeta("dedupe.initial", String(Date.now())); analytics.cache.clear(); log(`initial duplicate check: ${r.duplicates} repeats merged, ${r.junk} template pages excluded`); }
        if (!store.getMeta("recs.voided.v2")) { const n = analytics.voidStalePairings(); store.setMeta("recs.voided.v2", String(Date.now())); log(`voided ${n} recommendations whose sector pairing no longer exists`); }
      } catch (e) { log(`start-up clean-up failed: ${e.message}`); }
    }, 8000).unref();
    // Judge recommendations once their 72 hours are up (a live hit rate), every half hour.
    const judge = () => { if (closed) return; try { analytics.judgeForecasts(); } catch (e) { log(`forecast check failed: ${e.message}`); } try { const r = analytics.judgeOutcomes(); if (r.evaluated) { const id = store.startJob({ kind: "outcomes", trigger: "auto" }); store.finishJob(id, { status: "ok", summary: `Judged ${r.evaluated} recommendations: ${r.hits} hit, ${r.misses} did not`, stats: r }); } } catch (e) { log(`outcome check failed: ${e.message}`); } };
    timers.push(setInterval(judge, 30 * 60e3)); setTimeout(judge, 30000).unref();
  }
  timers.forEach((t) => t.unref());

  // What the bell shows: recent finished jobs and any service that needs attention. Derived, never stored separately.
  function notifications() {
    const items = [];
    const LABEL = { run: "Collection", enrich: "Topic labelling", sentiment: "Sentiment labelling", "topic-merge": "Topic merge", fulltext: "Full-text retry", ocr: "Print editions", online: "Online opinion pieces", "hot-topics": "Hot-topic check", journalists: "Journalist sync", outcomes: "Recommendation check", "topic-match": "Topic-sector judgement", "topic-verify": "Topic fit check", "second-opinion": "Second opinion", "entities-merge": "Entity merge", dedupe: "Duplicate check" };
    for (const e of store.jobLog({ limit: 40 })) {
      if (e.status === "running") continue;
      const how = e.trigger === "scheduled" ? "scheduled" : e.trigger === "manual" ? "manual" : "automatic";
      items.push({ id: `job-${e.id}`, ts: e.finishedAt ?? e.startedAt, level: e.status === "ok" ? "ok" : e.status === "failed" ? "bad" : "warn", kind: e.kind,
        title: `${LABEL[e.kind] ?? e.kind} ${e.status === "ok" ? "finished" : e.status === "failed" ? "failed" : "stopped"} (${how})`, text: e.summary || e.error || "" });
    }
    for (const i of integrations.status({ ollama: { reachable: reader.chain.includes("ollama") }, journalists: { count: store.journalistCount() } })) {
      if (i.health === "exhausted") items.push({ id: `int-${i.name}-exhausted`, ts: i.state.exhaustedAt ?? Date.now(), level: "bad", kind: "credit", title: `${i.label}: credit exhausted`, text: "Add credit or a new key in Settings; this service is paused until a call succeeds again." });
      else if (i.health === "error" && i.state.lastErrorAt && Date.now() - i.state.lastErrorAt < 6 * 3600e3) items.push({ id: `int-${i.name}-err-${i.state.lastErrorAt}`, ts: i.state.lastErrorAt, level: "warn", kind: "service", title: `${i.label}: recent errors`, text: String(i.state.lastError ?? "").slice(0, 160) });
    }
    try {
      const q = analytics.quality();
      for (const s of q.sources.filter((x) => x.silent)) items.push({ id: `src-${s.name}-${s.lastSeen ?? 0}`, ts: s.lastSeen ?? Date.now(), level: s.severe ? "bad" : "warn", kind: "source", title: `Source quiet: ${s.name}`, text: s.hoursSilent == null ? "No stories seen in the last 7 days." : `No new stories for ${s.hoursSilent} hours (usual gap ${s.typicalGapHours} h).` });
      if (q.status === "red") items.push({ id: `quality-red-${q.generatedAt}`, ts: q.generatedAt, level: "bad", kind: "quality", title: "Data quality is below the safe threshold", text: `Write now is held back. ${q.flags.join("; ")}.` });
    } catch { /* no data yet */ }
    return items.sort((a, b) => b.ts - a.ts).slice(0, 40);
  }
  // Larger answers are gzipped for browsers that accept it (the opportunity lists are 0.5 to 1.3 MB of text; they shrink about tenfold).
  const json = (res, code, obj) => {
    const body = JSON.stringify(obj), head = { "content-type": "application/json", "cache-control": "no-store" };
    if (body.length > 2048 && /\bgzip\b/.test(String(res.req?.headers["accept-encoding"] || ""))) {
      return gzip(body, { level: 5 }, (err, buf) => { if (err) { res.writeHead(code, head); return res.end(body); } res.writeHead(code, { ...head, "content-encoding": "gzip", vary: "accept-encoding" }); res.end(buf); });
    }
    res.writeHead(code, head); res.end(body);
  };
  const needJson = (req, res) => { if (!(req.headers["content-type"] || "").startsWith("application/json")) { json(res, 415, { error: "Send application/json" }); return false; } return true; };
  const allowedHosts = new Set(["127.0.0.1", "localhost", "::1", ...String(process.env.HIVEMIND_ALLOWED_HOSTS || "").split(",").map((h) => h.trim()).filter(Boolean)]);
  const labelKey = (k) => (typeof k === "string" && /^[bt]:[a-z0-9&-]+$/i.test(k) ? k : null);
  // Sign-in: on by default. HIVEMIND_AUTH=off (or serve({auth:false})) is an explicit escape hatch for a single-user, localhost-only machine.
  const authOn = auth && String(process.env.HIVEMIND_AUTH || "").toLowerCase() !== "off";
  if (!authOn) log("WARNING: sign-in is switched OFF (HIVEMIND_AUTH=off). Anyone who can reach this server has full access, including the API keys. Use only on a private, single-user machine.");
  const authz = authOn ? createAuth({ store, log, root }) : null;

  // ---------------------------------------------------------------- the dashboard's views: built off the main thread, saved, shared and revalidated
  // Each read-only view is asked for by name and arguments. Its answer is kept (1) in memory, (2) in the database, so a restart or a second copy starts
  // warm, and (3) as an ETag, so a browser that already has it gets a tiny "not modified". An answer is current only while the data signature
  // (analytics.signature) is unchanged. Heavy ones are built in a worker thread with its own read connection; if it is unavailable the server builds them itself.
  const ROUTES = {
    "/api/overview": (u, c) => ({ method: "overview", args: { company: c, date: dayParam(u) } }),
    "/api/leadership": (u, c) => ({ method: "leadership", args: { company: c, date: dayParam(u), mode: u.searchParams.get("mode") } }),
    "/api/opportunities": (u, c) => ({ method: "opportunities", args: { company: c, date: dayParam(u), limit: Math.min(1000, +u.searchParams.get("limit") || 60), group: u.searchParams.get("group") === "topic", mode: u.searchParams.get("mode"), slim: u.searchParams.get("slim") === "1" } }),
    "/api/opportunity": (u, c) => { const key = (u.searchParams.get("key") || "").slice(0, 200); return key ? { method: "opportunity", args: { company: c, key, date: dayParam(u), mode: u.searchParams.get("mode"), group: u.searchParams.get("group") === "topic" } } : { error: "Pass key=<opportunity key>" }; },
    "/api/labels": (u) => ({ method: "labels", args: { date: dayParam(u), level: u.searchParams.get("level") === "topic" ? "topic" : "bracket", limit: Math.min(300, +u.searchParams.get("limit") || 80) } }),
    "/api/series": (u) => { const keys = (u.searchParams.get("keys") || "").split(",").map(labelKey).filter(Boolean); return keys.length ? { method: "series", args: { keys, gran: u.searchParams.get("gran") === "day" ? "day" : "hour", date: dayParam(u) } } : { error: "Pass keys=b:economy,t:port-disruption" }; },
    "/api/topic": (u, c) => { const key = labelKey(u.searchParams.get("key")); return key ? { method: "topic", args: { key, company: c, date: dayParam(u) } } : { error: "Bad topic key" }; },
    "/api/origins": (u) => { const raw = u.searchParams.get("key"), key = !raw || raw === "all" ? "all" : labelKey(raw); return key ? { method: "origins", args: { key, date: dayParam(u) } } : { error: "Pass key=t:port-disruption, b:economy or all" }; },
    "/api/sources": (u) => ({ method: "sourcesView", args: { date: dayParam(u) } }),
    "/api/backtest": () => ({ method: "backtest", args: {} }),
    "/api/entities": (u) => ({ method: "entities", args: { date: dayParam(u), limit: Math.min(500, +u.searchParams.get("limit") || 150) } }),
    "/api/sentiment": (u) => ({ method: "sentiment", args: { date: dayParam(u) } }),
  };
  let worker = null, workerRef = null, wseq = 0;
  const wait = new Map();
  const dropWorker = (why) => { if (why) log(`view worker stopped (${why}): the server builds views itself`); worker = null; for (const [, w] of wait) w.reject(new Error(why || "worker stopped")); wait.clear(); };
  if (process.env.HIVEMIND_NO_WORKER !== "1") {
    try {
      const w = new Worker(new URL("./viewworker.mjs", import.meta.url), { workerData: { root } });
      w.unref();
      w.on("message", (m) => { if (m.ready) { worker = w; return; } const p = wait.get(m.id); if (p) { wait.delete(m.id); clearTimeout(p.t); m.ok ? p.resolve(m) : p.reject(new Error(m.error)); } });
      w.on("error", (e) => dropWorker(e.message));
      w.on("exit", () => { if (!closed) dropWorker("exited"); });
      analytics.cache.onClear = () => { try { worker?.postMessage({ type: "clear" }); } catch { /* the worker is gone; the server builds views itself */ } };
      workerRef = w;
    } catch (e) { log(`view worker not started: ${e.message}`); }
  }
  const build = async (method, args) => {
    if (worker) {
      try { const m = await new Promise((resolve, reject) => { const id = ++wseq, t = setTimeout(() => { wait.delete(id); reject(new Error("worker timed out")); }, 90e3); wait.set(id, { resolve, reject, t }); worker.postMessage({ id, method, args }); }); return { body: m.body, failed: m.failed }; }
      catch (e) { log(`view worker failed for ${method} (${e.message}); building it in the server`); }
    }
    const v = analytics[method](args);
    return { body: JSON.stringify(v), failed: !!(v && v.error) };
  };
  const mem = new Map(), inflight = new Map();
  // The answer for (method, args): from memory, else the database, else built once (concurrent askers share the build).
  async function viewEntry(method, args) {
    const k = method + "|" + JSON.stringify(args), sig = analytics.signature(args.date ?? null);
    if (sig == null) { const v = analytics[method](args); return { body: JSON.stringify(v), failed: !!(v && v.error), etag: null }; }
    let e = mem.get(k);
    if (e && e.sig === sig) return e;
    let body = store.getView(k, sig), failed = false;
    if (body == null) {
      const ik = k + "@" + sig;
      let p = inflight.get(ik);
      if (!p) { p = build(method, args).finally(() => inflight.delete(ik)); inflight.set(ik, p); }
      ({ body, failed } = await p);
      if (!failed && body.length < 4e6) { try { store.putView(k, sig, body); } catch { /* a saved copy is only a convenience */ } }
    }
    e = { sig, body, failed, etag: `"${createHash("sha1").update(body).digest("base64url").slice(0, 22)}"` };
    if (mem.size > 300) mem.clear();
    mem.set(k, e);
    return e;
  }
  async function view(req, res, method, args) {
    const e = await viewEntry(method, args);
    const head = { "content-type": "application/json", "cache-control": e.etag ? "private, no-cache" : "no-store", vary: "accept-encoding", ...(e.etag ? { etag: e.etag } : {}) };
    if (e.etag && !e.failed && req.headers["if-none-match"] === e.etag) { res.writeHead(304, head); return res.end(); }
    const code = e.failed ? 404 : 200;
    if (e.body.length > 2048 && /\bgzip\b/.test(String(req.headers["accept-encoding"] || ""))) { e.gz ??= gzipSync(e.body, { level: 5 }); res.writeHead(code, { ...head, "content-encoding": "gzip" }); return res.end(e.gz); }
    res.writeHead(code, head); res.end(e.body);
  }

  const server = createServer(async (req, res) => {
    setSecurityHeaders(res);
    const url = new URL(req.url, "http://localhost");
    const p = url.pathname, company = slugify(url.searchParams.get("company") || "bcg") || "bcg";
    // Anything that changes data (matching, briefs, edits, tuning) drops the cached views once it is done; logging in or out does not.
    if (req.method !== "GET" && req.method !== "HEAD" && !p.startsWith("/api/auth")) res.on("finish", () => { if (res.statusCode < 400) analytics.cache.clear(); });
    // Liveness and readiness for containers and load balancers. It answers before the host check and the login, and says nothing but ok / not ok.
    if (p === "/healthz" && (req.method === "GET" || req.method === "HEAD")) {
      try { store.db.prepare("SELECT 1").get(); res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); return res.end(req.method === "HEAD" ? undefined : '{"ok":true}'); }
      catch { res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" }); return res.end('{"ok":false}'); }
    }
    // The server holds API keys and contact details with no login, so it must only answer the local machine. A web page
    // on another site can point its own domain at 127.0.0.1 ("DNS rebinding"); refusing foreign Host/Origin values stops that.
    // To serve other machines deliberately, put them in HIVEMIND_ALLOWED_HOSTS (and put a login in front).
    const hostName = String(req.headers.host || "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
    if (!allowedHosts.has(hostName)) return json(res, 403, { error: "Host not allowed" });
    const origin = req.headers.origin;
    if (origin && req.method !== "GET" && req.method !== "HEAD") {
      let oh = ""; try { oh = new URL(origin).hostname.replace(/^\[|\]$/g, ""); } catch { /* malformed */ }
      if (!allowedHosts.has(oh)) return json(res, 403, { error: "Origin not allowed" });
    }
    try {
      if (authz ? await authz.handle(req, res, url, p) : p === "/login" && req.method === "GET" && (res.writeHead(302, { location: "/" }), res.end(), true)) return; // sign-in gate (see auth.mjs)
      if (req.method === "GET" && (p === "/" || p === "/index.html")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return res.end(readFileSync(join(root, "src", "dashboard.html")));
      }
      if (req.method === "GET" && p.startsWith("/ui/")) {
        const name = p.slice(4), file = join(root, "src", "ui", name);
        if (!/^[\w.-]+$/.test(name) || !STATIC[extname(name)] || !existsSync(file)) return json(res, 404, { error: "Not found" });
        if (extname(name) === ".mp4") { // video is streamed in ranges (browsers seek and loop with them; Safari requires them) and cached for a day
          const size = statSync(file).size, m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
          let start = 0, end = size - 1;
          if (m) { if (m[1] !== "") { start = +m[1]; if (m[2] !== "") end = Math.min(+m[2], size - 1); } else if (m[2] !== "") start = Math.max(0, size - +m[2]); }
          if (m && (start > end || start >= size)) { res.writeHead(416, { "content-range": `bytes */${size}` }); return res.end(); }
          res.writeHead(m ? 206 : 200, { "content-type": STATIC[".mp4"], "accept-ranges": "bytes", "cache-control": "public, max-age=86400", "content-length": end - start + 1, ...(m ? { "content-range": `bytes ${start}-${end}/${size}` } : {}) });
          if (req.method === "HEAD") return res.end();
          return createReadStream(file, { start, end }).on("error", () => res.destroy()).pipe(res);
        }
        res.writeHead(200, { "content-type": STATIC[extname(name)], "cache-control": "no-store" });
        return res.end(readFileSync(file));
      }

      // ---- analytics ----
      if (req.method === "GET" && p === "/api/status") {
        const st = status();
        if (req.user && req.user.role !== "admin") { for (const k of ["integrations", "jobs", "activity", "journalists", "llm", "provider", "chain", "fallbackActive", "enrich", "sentiment", "topicMerge", "fulltext", "live", "runner"]) delete st[k]; st.llm = { ok: true }; st.runner = { running: false }; st.live = null; st.enrich = { running: false }; st.integrations = []; }
        return json(res, 200, st);
      }
      if (req.method === "GET" && ROUTES[p]) { const v = ROUTES[p](url, company); return v.error ? json(res, 400, { error: v.error }) : view(req, res, v.method, v.args); }
      if (req.method === "GET" && p === "/api/leadership/pieces") return json(res, 200, analytics.pieces({ company, key: (url.searchParams.get("key") || "").slice(0, 200), date: dayParam(url) }));
      if (req.method === "GET" && p === "/api/config") return json(res, 200, { weights: cfg.weights, stage: cfg.stage, action: cfg.action, evidence: cfg.evidence, windows: cfg.windows, success: cfg.success, intervals: cfg.intervals, forecast: cfg.forecast });
      if (req.method === "GET" && p === "/api/recommendations") {
        const key = url.searchParams.get("key");
        return json(res, 200, { history: key ? store.recommendationHistory(company, key) : [], total: store.recommendationCount() });
      }

      // ---- authors, briefs, editor decisions ----
      if (req.method === "GET" && p === "/api/authors") return json(res, 200, { authors: store.listAuthors() });
      if (req.method === "POST" && p === "/api/author") {
        if (!needJson(req, res)) return;
        const body = JSON.parse(await readBody(req) || "{}");
        const prev = body.id ? store.listAuthors().find((a) => a.id === body.id) : null;
        const a = normalizeAuthor(body, prev);
        store.putAuthor(a);
        return json(res, 200, { author: a });
      }
      if (req.method === "POST" && p === "/api/authors/import") {
        if (!needJson(req, res)) return;
        const body = JSON.parse(await readBody(req) || "{}");
        const list = parseAuthors(body.text);
        if (!list.length) return json(res, 400, { error: "No authors found. Use a CSV with a 'name' column, or a JSON array." });
        for (const a of list) store.putAuthor(a);
        return json(res, 200, { imported: list.length });
      }
      if (req.method === "DELETE" && p === "/api/author") {
        const n = store.removeAuthor(String(url.searchParams.get("id") || ""));
        return json(res, n ? 200 : 404, n ? { ok: true } : { error: "Unknown author" });
      }
      if (req.method === "GET" && p === "/api/briefs") return json(res, 200, { briefs: store.listBriefs({ oppKey: url.searchParams.get("opp") || null }), stats: store.briefStats() });
      if (req.method === "POST" && p === "/api/brief") {
        if (!needJson(req, res)) return;
        const body = JSON.parse(await readBody(req) || "{}");
        try { return json(res, 200, await analytics.makeBrief({ oppKey: String(body.oppKey || ""), company: slugify(body.company || "bcg") || "bcg", authorId: body.authorId || null, journalistId: body.journalistId ? String(body.journalistId) : null, date: validDay(body.date) ? body.date : null })); }
        catch (e) { return json(res, 400, { error: e.message }); }
      }
      if (req.method === "POST" && p === "/api/brief/decide") {
        if (!needJson(req, res)) return;
        const body = JSON.parse(await readBody(req) || "{}");
        if (!DECISIONS.has(body.status)) return json(res, 400, { error: "status must be approved, rejected, needs_evidence or pending" });
        const n = store.decideBrief(+body.id, body.status, String(body.note || "").slice(0, 500));
        return json(res, n ? 200 : 404, n ? { ok: true, stats: store.briefStats() } : { error: "Unknown brief" });
      }

      // ---- v2 analytics: origins, entities, sentiment, outcomes, tuning ----
      if (req.method === "GET" && p === "/api/entity") {
        const id = entityId(url.searchParams.get("id") ?? "");
        if (!id) return json(res, 400, { error: "Bad entity" });
        const r = analytics.entity({ id, date: dayParam(url) });
        return json(res, r.error ? 404 : 200, r);
      }
      if (req.method === "GET" && p === "/api/outcomes") return json(res, 200, analytics.outcomes());
      if (req.method === "GET" && p === "/api/tuning") return json(res, 200, analytics.tuning());
      if (req.method === "POST" && p === "/api/tuning/apply") {
        if (!needJson(req, res)) return;
        const body = JSON.parse(await readBody(req) || "{}");
        const t = analytics.tuning();
        if (body.confirm !== true || !t.ready || !t.suggested) return json(res, 400, { error: "Nothing to apply: there is no confirmed suggestion ready." });
        const history = store.getJson("weights.history", []);
        history.push({ at: Date.now(), previous: { ...cfg.weights }, applied: t.suggested.weights, change: t.suggested.change, sample: t.sample, hitRateBefore: t.hitRateCurrent, hitRateAfter: t.hitRateSuggested });
        store.setJson("weights.history", history.slice(-20));
        writeFileAtomic(weightsFile, JSON.stringify({ weights: t.suggested.weights, appliedAt: Date.now(), change: t.suggested.change }, null, 2));
        cfg.weights = t.suggested.weights;
        return json(res, 200, { ok: true, weights: cfg.weights });
      }

      // ---- data quality, audit, forecast accuracy ----
      if (req.method === "GET" && p === "/api/quality") return json(res, 200, analytics.quality());
      if (req.method === "GET" && p === "/api/audit/queue") return json(res, 200, analytics.auditQueue({ limit: Math.min(100, +url.searchParams.get("limit") || 50), company }));
      if (req.method === "POST" && p === "/api/audit/review") {
        if (!needJson(req, res)) return;
        const body = JSON.parse(await readBody(req) || "{}");
        try { return json(res, 200, analytics.reviewAudit({ key: String(body.key || ""), verdict: body.verdict, note: String(body.note || ""), reviewer: req.user?.email ?? "" })); }
        catch (e) { return json(res, 400, { error: e.message }); }
      }
      if (req.method === "GET" && p === "/api/audit/second-opinion") return json(res, 200, analytics.secondOpinion());
      if (req.method === "GET" && p === "/api/forecast-accuracy") return json(res, 200, analytics.forecastAccuracy());

      // ---- logs, usage, notifications ----
      if (req.method === "GET" && p === "/api/logs") {
        const limit = Math.min(500, Math.max(1, +url.searchParams.get("limit") || 100));
        const entries = store.jobLog({ limit, kind: url.searchParams.get("kind") || null, status: url.searchParams.get("status") || null, trigger: url.searchParams.get("trigger") || null });
        const day = store.jobLog({ limit: 500 }).filter((e) => Date.now() - e.startedAt <= 864e5), runs = day.filter((e) => e.kind === "run");
        const st = status().schedule;
        return json(res, 200, { entries, summary: { last24h: { runs: runs.length, ok: runs.filter((e) => e.status === "ok").length, failed: runs.filter((e) => e.status === "failed").length, newStories: runs.reduce((a, e) => a + (e.stats?.newStories ?? 0), 0) } }, schedule: st });
      }
      if (req.method === "GET" && p === "/api/usage") return json(res, 200, await usageReport({ store, integrations, cfg }));
      if (req.method === "POST" && p === "/api/usage/refresh") { if (!needJson(req, res)) return; return json(res, 200, await usageReport({ store, integrations, cfg, refresh: true })); }
      if (req.method === "GET" && p === "/api/notifications") return json(res, 200, { items: notifications() });
      // Manual starts of the background jobs (each is logged as a manual run).
      if (req.method === "POST" && p === "/api/job") {
        if (!needJson(req, res)) return;
        const body = JSON.parse(await readBody(req) || "{}");
        const k = String(body.kind || "");
        if (k === "hot-topics") { hotNow("manual"); return json(res, 200, { ok: true }); }
        if (k === "topic-verify") { topicVerifyNow("manual"); return json(res, 200, { ok: true }); }
        if (k === "topic-match") { topicMatchNow("manual", { force: true }); return json(res, 200, { ok: true }); }
        if (k === "second-opinion") { secondOpinionNow("manual"); return json(res, 200, { ok: true }); }
        if (k === "dedupe") return json(res, 200, { ok: true, ...dedupeNow("manual") });
        const starter = { "entities-merge": () => startEntityMerge("manual"), sentiment: () => startSentiment(0, "manual"), "topic-merge": () => startMerge("manual"), fulltext: () => startFulltext("manual"), ocr: () => startOcr("manual"), online: () => startOnline("manual"), enrich: () => startEnrich(+body.limit || 0, "manual") }[k];
        if (!starter) return json(res, 400, { error: "Unknown job. Use sentiment, topic-merge, fulltext, ocr, enrich or hot-topics." });
        const r = starter();
        return r.ok ? json(res, 200, { ok: true }) : json(res, r.code, { error: r.error });
      }

      // ---- authored articles (opinion / analysis in the print editions): where the journalist directory used to be ----
      if (req.method === "GET" && p === "/api/authored/status") return json(res, 200, { ...store.ocrFacets(), window: cfg.ocr?.windowDays ?? 7, saturation: cfg.ocr?.saturationCount ?? 5, mode: cfg.ocr?.mode ?? "whitespace" });
      if (req.method === "GET" && p === "/api/authored/article") {
        const a = store.ocrArticle((url.searchParams.get("id") || "").slice(0, 300), company);
        return a ? json(res, 200, a) : json(res, 404, { error: "That article is not in the database." });
      }
      if (req.method === "GET" && p === "/api/authored") {
        const g = (k, n) => (url.searchParams.get(k) || "").slice(0, n), lim = Math.min(100, Math.max(1, +url.searchParams.get("limit") || 25));
        return json(res, 200, { ...store.ocrSearch({ q: g("q", 80), source: g("source", 40), kind: g("kind", 10) || "authored", matched: g("matched", 1), limit: lim, offset: Math.max(0, +url.searchParams.get("offset") || 0), company }), facets: url.searchParams.get("facets") === "1" ? store.ocrFacets() : undefined });
      }

      // // ---- journalist directory ----
      // if (req.method === "GET" && p === "/api/journalists/status") return json(res, 200, journalistStatus());
      // if (req.method === "POST" && p === "/api/journalists/sync") {
      //   if (!needJson(req, res)) return;
      //   return (await startJournalistSync()) ? json(res, 200, { ok: true }) : json(res, 409, { error: "A sync is already running." });
      // }
      // if (req.method === "GET" && p === "/api/journalists") {
      //   const lim = Math.min(200, Math.max(1, +url.searchParams.get("limit") || 50));
      //   const r = store.searchJournalists({ q: (url.searchParams.get("q") || "").slice(0, 80), beat: (url.searchParams.get("beat") || "").slice(0, 60), publication: (url.searchParams.get("publication") || "").slice(0, 80), limit: lim, offset: Math.max(0, +url.searchParams.get("offset") || 0) });
      //   return json(res, 200, { ...r, facets: url.searchParams.get("facets") === "1" ? store.journalistFacets() : undefined });
      // }
      // if (req.method === "GET" && p === "/api/journalists/matches") {
      //   const r = analytics.journalistMatches({ oppKey: String(url.searchParams.get("opp") || ""), company, date: dayParam(url), limit: Math.min(20, +url.searchParams.get("limit") || 8) });
      //   return json(res, r.error ? 404 : 200, r);
      // }

      // ---- search interest (separate signal) ----
      if (req.method === "POST" && p === "/api/search-interest") {
        if (!needJson(req, res)) return;
        const body = JSON.parse(await readBody(req) || "{}");
        if (body.text) {
          const sets = parseSearchUpload(body.text);
          if (!sets.length) return json(res, 400, { error: "No series found. Use CSV 'topic,date,value' or JSON {topic, points:[{date,value}]}." });
          for (const s of sets) store.putSignal(norm(s.topic), s.source, s.points);
          return json(res, 200, { imported: sets.length });
        }
        const topic = String(body.topic || "").trim();
        if (!topic) return json(res, 400, { error: "Give a topic, or upload a file." });
        try { const r = await fetchSerpApi(topic); store.addUsage("serpapi", { calls: 1 }); store.putSignal(norm(topic), r.source, r.points); return json(res, 200, { points: r.points.length, source: r.source }); }
        catch (e) { store.addUsage("serpapi", { calls: 0, errors: 1 }); return json(res, 400, { error: e.message }); }
      }

      // ---- run / enrich ----
      if (req.method === "POST" && p === "/api/run") {
        if (!needJson(req, res)) return;
        const body = JSON.parse(await readBody(req) || "{}");
        const date = body.date ?? null;
        if (date !== null && !validDay(date)) return json(res, 400, { error: "Pick a valid date (YYYY-MM-DD) that isn't in the future." });
        const r = startRun(date);
        return r.ok ? json(res, 200, { ok: true, date }) : json(res, r.code, { error: r.error });
      }
      if (req.method === "POST" && p === "/api/enrich") {
        if (!needJson(req, res)) return;
        const body = JSON.parse(await readBody(req) || "{}");
        const r = startEnrich(Math.max(0, Math.min(50000, +body.limit || 0)));
        return r.ok ? json(res, 200, { ok: true }) : json(res, r.code, { error: r.error });
      }
      if (req.method === "GET" && p === "/api/dates") return json(res, 200, store.days());

      // ---- first dashboard's state payload (kept for compatibility) ----
      if (req.method === "GET" && p === "/api/state") {
        const date = dayParam(url);
        const { data, hours } = dataFor(date, Math.min(168, Math.max(6, +url.searchParams.get("window") || 48)));
        return json(res, 200, buildState({
          data, registry: registry(), companies: companies.list(), companyId: url.searchParams.get("company") || "bcg", bcg, hours, llm,
          dates: store.days(), view: { date }, runner: runnerState(), live: liveRun(),
        }));
      }

      // ---- companies ----
      if (req.method === "GET" && p === "/api/companies") {
        return json(res, 200, { companies: companies.list() });
      }
      if (req.method === "POST" && p === "/api/company/match") {
        matchNow();
        return json(res, 200, { ok: true, message: "Matching started" });
      }
      if (req.method === "POST" && p === "/api/company") {
        // Requiring JSON blocks cross-site form posts: browsers can't send this content type without a CORS preflight.
        if (!needJson(req, res)) return;
        const body = JSON.parse(await readBody(req) || "{}");
        const parsed = parseSectors(body.text, String(body.name || "").trim());
        const name = String(body.name || parsed.name || "").trim();
        if (!name) return json(res, 400, { error: "Enter a company name (or add a 'Company: …' first line to the file)." });
        if (!parsed.sectors.length) return json(res, 400, { error: "No sectors found. Use one sector per line, a comma-separated list, a CSV with a 'sector' column, or JSON." });
        const c = companies.put({ name, sectors: parsed.sectors });
        matchNow();
        return json(res, 200, { id: c.id, name: c.name, sectors: c.sectors });
      }
      if (req.method === "DELETE" && p === "/api/company") {
        const id = slugify(url.searchParams.get("id") || "");
        const c = companies.get(id);
        if (!c) return json(res, 404, { error: "Unknown company" });
        if (c.builtin) return json(res, 400, { error: "The built-in company can't be removed" });
        companies.remove(id);
        return json(res, 200, { ok: true });
      }

      // ---- integrations & API keys ----
      if (req.method === "GET" && p === "/api/integrations") {
        const ollamaInfo = await detectOllama().catch(() => null);
        return json(res, 200, {
          integrations: integrations.status({ ollama: ollamaInfo, journalists: { count: store.journalistCount() } }),
          provider: reader.provider, noClaude: reader.noClaude, models: { groq: reader.groqOk ? reader.groqModel : null, openai: reader.openaiOk ? reader.openaiModel : null },
          chain: reader.chain,
          label: reader.label,
          fallbackActive: reader.fallbackActive,
        });
      }
      if (req.method === "POST" && p === "/api/integrations/key") {
        if (!needJson(req, res)) return;
        const body = JSON.parse(await readBody(req) || "{}");
        const { name, value } = body;
        if (!name || value == null) return json(res, 400, { error: "Integration name and key value are required." });
        try {
          integrations.setKey(name, String(value).trim());
          try { llm = { ok: true, message: await reader.detect() }; } catch (e) { llm = { ok: false, message: e.message }; }
          return json(res, 200, { ok: true, message: `Key saved for ${name}` });
        } catch (e) {
          return json(res, 400, { error: e.message });
        }
      }
      if (req.method === "POST" && p === "/api/integrations/remove") {
        if (!needJson(req, res)) return;
        const body = JSON.parse(await readBody(req) || "{}");
        if (!body.name) return json(res, 400, { error: "Integration name is required." });
        integrations.removeKey(body.name);
        try { llm = { ok: true, message: await reader.detect() }; } catch (e) { llm = { ok: false, message: e.message }; }
        return json(res, 200, { ok: true, message: `Key removed for ${body.name}` });
      }
      if (req.method === "POST" && p === "/api/integrations/toggle") {
        if (!needJson(req, res)) return;
        const body = JSON.parse(await readBody(req) || "{}");
        if (!body.name) return json(res, 400, { error: "Integration name is required." });
        integrations.setEnabled(body.name, !!body.enabled);
        try { llm = { ok: true, message: await reader.detect() }; } catch (e) { llm = { ok: false, message: e.message }; }
        return json(res, 200, { ok: true, enabled: integrations.enabled(body.name) });
      }
      if (req.method === "POST" && p === "/api/integrations/test") {
        if (!needJson(req, res)) return;
        const body = JSON.parse(await readBody(req) || "{}");
        if (!body.name) return json(res, 400, { error: "Integration name is required." });
        const result = await integrations.test(body.name);
        return json(res, 200, result);
      }

      // ---- system profile & local LLM fallback ----
      if (req.method === "GET" && p === "/api/system") {
        const sys = await detectSystem({ refresh: url.searchParams.get("refresh") === "1" });
        const settings = store.getJson(`llm.settings.${mid}`, { primary: "anthropic", fallback: true, ollamaModel: null });
        return json(res, 200, { system: sys, settings });
      }
      if (req.method === "POST" && p === "/api/system/settings") {
        if (!needJson(req, res)) return;
        const body = JSON.parse(await readBody(req) || "{}");
        const prev = store.getJson(`llm.settings.${mid}`, {});
        const next = { ...prev, ...body };
        store.setJson(`llm.settings.${mid}`, next);
        try { llm = { ok: true, message: await reader.detect() }; } catch (e) { llm = { ok: false, message: e.message }; }
        return json(res, 200, { ok: true, settings: next, llm });
      }

      // ---- X (Twitter) social data ----
      if (req.method === "GET" && p === "/api/social") {
        const key = url.searchParams.get("key");
        const name = url.searchParams.get("name") || (key?.startsWith("b:") ? registry().get(key.slice(2))?.name : null) || key;
        if (!name) return json(res, 400, { error: "Topic name required" });
        const active = integrations.active("x");
        const pts = store.getSignal(norm(name), "x:counts");
        if (pts.length) {
          const stats = socialStats(pts);
          return json(res, 200, { available: true, active, topic: name, source: "x:counts", stats, points: pts });
        }
        return json(res, 200, {
          available: false, active, configured: integrations.configured("x"), enabled: integrations.enabled("x"),
          topic: name, reason: active ? "No X count data fetched yet. Click 'Fetch from X' to query." : "X API is not configured or disabled in Settings."
        });
      }
      if (req.method === "POST" && p === "/api/social/fetch") {
        if (!needJson(req, res)) return;
        const body = JSON.parse(await readBody(req) || "{}");
        const name = body.name;
        if (!name) return json(res, 400, { error: "Topic name required" });
        const token = integrations.key("x");
        if (!token || !integrations.enabled("x")) return json(res, 400, { error: "X API integration is not active or token is missing in .env" });
        const q = buildQuery({ name, keywords: body.keywords || [], level: body.level || "bracket", context: body.context || "India" });
        try {
          const r = await fetchCounts(q, token);
          store.putSignal(norm(name), "x:counts", r.points);
          integrations.recordEvent("x", { ok: true, detail: `Fetched ${r.points.length} points` });
          const stats = socialStats(r.points);
          return json(res, 200, { ok: true, points: r.points, stats, total: r.total });
        } catch (e) {
          integrations.recordEvent("x", { ok: false, error: e.message });
          return json(res, 400, { error: e.message });
        }
      }
      json(res, 404, { error: "Not found" });
    } catch (e) {
      json(res, e instanceof SyntaxError ? 400 : 500, { error: e instanceof SyntaxError ? "Invalid JSON" : e.message });
    }
  });
  server.on("close", () => { closed = true; workerRef?.terminate(); authz?.stop(); timers.forEach(clearInterval); for (const j of Object.values(jobs)) j.child?.kill(); try { store.closeStaleJobs(); } catch { /* ignore */ } store.close(); });

  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); });
  log(`Dashboard: http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}${host === "0.0.0.0" ? " (listening on all interfaces: allowed hosts are set by HIVEMIND_ALLOWED_HOSTS)" : ""}`);
  return server;
}
