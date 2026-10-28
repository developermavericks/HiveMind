// Tests for the second round: sentiment, topic merging, entities, weekday patterns, outcomes and tuning, hot topics,
// the job log, usage counters, indexes, full-text upgrades and the new API routes.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, copyFileSync, cpSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store, dayOf, DAY_MS } from "../src/db.mjs";
import { SourceRegistry } from "../src/origins.mjs";
import { HOUR, buildSeasonality, seasonalFactor } from "../src/metrics.mjs";
import { entityId, buildEntities } from "../src/entities.mjs";
import { evaluateRecommendation, tuneWeights, outcomeSummary } from "../src/outcomes.mjs";
import { pickHot, summariseNews } from "../src/hot.mjs";
import { isWeakLabel } from "../src/topics.mjs";
import { normalizeSentiments, normalizeTopicMerges, normalizeEnrichment } from "../src/llm.mjs";

const J = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const cfg = J("../config/hivemind.json"), pubs = J("../config/publications.json"), bcg = J("../config/bcg.json");
const sources = new SourceRegistry(pubs);

const seedStore = (n = 6) => {
  const s = new Store(":memory:");
  const clusters = Array.from({ length: n }, (_, i) => ({ title: `Story ${i}`, url: `https://x/${i}`, publishedAt: Date.now() - i * HOUR, articles: [{ title: `Story ${i}`, outlet: "The Hindu", publication: "The Hindu", url: `https://x/${i}/a` }] }));
  const keys = s.upsertClusters(clusters);
  keys.forEach((k, i) => s.putReading(k, { analysis: { event_type: "x", summary: `summary ${i}`, geography: [], impacts: [] }, basis: i % 2 ? "full-text" : "headline" }));
  return { s, keys };
};

// ---------- database ----------
test("db: every table the dashboard queries has an index, and migrations are idempotent", () => {
  const { s } = seedStore(1);
  const idx = new Set(s.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((r) => r.name));
  for (const want of ["stories_published", "articles_pub", "enrich_at", "enrich_sentiment", "topics_merged", "reclog_ts", "signals_source", "journalists_beat", "joblog_started", "runs_target", "readings_basis"]) assert.ok(idx.has(want), `missing index ${want}`);
  const plan = s.db.prepare("EXPLAIN QUERY PLAN SELECT * FROM stories WHERE published_at >= 1 AND published_at < 2").all().map((r) => r.detail).join(" ");
  assert.match(plan, /USING INDEX stories_published/);
  s.close();
});

test("db: sentiment is stored without touching the topic labels, and counted", () => {
  const { s, keys } = seedStore(4);
  s.putEnrichment(keys[0], { topics: ["fuel-prices"], contentType: "reported", source: "read" });
  assert.equal(s.unsentimentedCount(), 4);
  s.putSentiments([{ key: keys[0], sentiment: "negative", stance: "critical" }, { key: keys[1], sentiment: "positive", stance: "supportive" }]);
  assert.equal(s.unsentimentedCount(), 2);
  assert.equal(s.sentimentCount(), 2);
  const st = s.loadStories({ from: 0, to: Date.now() + DAY_MS }).find((x) => x.id === keys[0]);
  assert.equal(st.meta.sentiment, "negative");
  assert.deepEqual(st.meta.topics, ["fuel-prices"]);
  // a later topic write keeps the sentiment
  s.putEnrichment(keys[0], { topics: ["fuel-prices", "inflation"], source: "enrich" });
  assert.equal(s.loadStories({ from: 0, to: Date.now() + DAY_MS }).find((x) => x.id === keys[0]).meta.sentiment, "negative");
  s.close();
});

test("db: merging topics is reversible, keeps aliases, and stories read under the merged id resolve to the kept one", () => {
  const { s, keys } = seedStore(2);
  s.saveTopic({ id: "ev-manufacturing", name: "ev manufacturing", bracket: "energy", aliases: [], count: 5, createdAt: 1 });
  s.saveTopic({ id: "electric-vehicle-production", name: "electric vehicle production", bracket: "energy", aliases: ["ev output"], count: 3, createdAt: 2 });
  s.putEnrichment(keys[0], { topics: ["electric-vehicle-production"] });
  assert.equal(s.mergeTopics("ev-manufacturing", "electric-vehicle-production"), 1);
  assert.equal(s.mergeTopics("ev-manufacturing", "electric-vehicle-production"), 0); // already merged
  const kept = s.loadTopics().find((t) => t.id === "ev-manufacturing");
  assert.equal(kept.count, 8);
  assert.ok(kept.aliases.includes("electric vehicle production") && kept.aliases.includes("ev output"));
  assert.ok(!s.loadTopics().some((t) => t.id === "electric-vehicle-production"));
  assert.deepEqual(s.loadStories({ from: 0, to: Date.now() + DAY_MS }).find((x) => x.id === keys[0]).meta.topics, ["ev-manufacturing"]);
  // saving the registry again must not undo the merge
  s.saveTopic({ ...kept, count: 9 });
  assert.equal(s.mergedTopicCount(), 1);
  s.unmergeTopic("electric-vehicle-production");
  assert.equal(s.mergedTopicCount(), 0);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM topics").get().n, 2); // nothing was deleted
  s.close();
});

test("db: the job log records start, finish and stale jobs; usage adds up per day", () => {
  const { s } = seedStore(1);
  const a = s.startJob({ kind: "run", trigger: "scheduled", stats: { args: "run --hours 3" } });
  s.finishJob(a, { status: "ok", summary: "Read 5 new stories", stats: { newStories: 5, failed: 1 } });
  const b = s.startJob({ kind: "enrich", trigger: "manual" });
  assert.equal(s.closeStaleJobs(), 1);
  const log = s.jobLog();
  assert.equal(log[0].status, "stopped");
  assert.equal(log.find((e) => e.id === a).stats.newStories, 5);
  assert.equal(log.find((e) => e.id === a).stats.args, "run --hours 3"); // earlier stats survive the merge
  assert.equal(s.jobLog({ trigger: "scheduled" }).length, 1);
  assert.ok(b > a);
  s.addUsage("anthropic", { tokensIn: 100, tokensOut: 10 }); s.addUsage("anthropic", { tokensIn: 50, tokensOut: 5 }); s.addUsage("anthropic", { calls: 0, errors: 1 });
  assert.deepEqual(s.usage("anthropic", dayOf(Date.now())), { calls: 2, errors: 1, tokensIn: 150, tokensOut: 15, cacheRead: 0, batchTokens: 0 });
  s.close();
});

test("db: a full-text upgrade keeps the earlier reading and the read time; tries are limited", () => {
  const { s, keys } = seedStore(4);
  const headlineKey = keys[0]; // i=0 is headline-only
  assert.equal(s.headlineOnlyCount(), 2);
  s.upgradeReading(headlineKey, { analysis: { event_type: "y", summary: "better", geography: [], impacts: [] }, basis: "full-text" });
  assert.equal(s.headlineOnlyCount(), 1);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM reading_versions WHERE key = ?").get(headlineKey).n, 1);
  const cand = s.fulltextCandidates({ limit: 10, maxTries: 2, retryAfterMs: 0 });
  assert.equal(cand.length, 1);
  s.noteFulltextTry(cand[0].key, "short-or-blocked"); s.noteFulltextTry(cand[0].key, "short-or-blocked");
  assert.equal(s.fulltextCandidates({ limit: 10, maxTries: 2, retryAfterMs: 0 }).length, 0);
  s.close();
});

test("db: a database from before v2 gains the new columns without losing rows", () => {
  const path = join(mkdtempSync(join(tmpdir(), "v1-")), "old.db");
  const raw = new DatabaseSync(path);
  raw.exec("CREATE TABLE enrichments (key TEXT PRIMARY KEY, wire TEXT, content_type TEXT, entities TEXT, topics TEXT, pathways TEXT, source TEXT, enriched_at INTEGER NOT NULL)");
  raw.exec("CREATE TABLE topics (id TEXT PRIMARY KEY, name TEXT NOT NULL, bracket TEXT, aliases TEXT NOT NULL DEFAULT '[]', count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)");
  raw.exec("INSERT INTO enrichments (key, topics, enriched_at) VALUES ('k', '[\"t\"]', 1)");
  raw.exec("INSERT INTO topics (id, name, created_at) VALUES ('t', 't', 1)");
  raw.close();
  const s = new Store(path);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM enrichments").get().n, 1);
  assert.equal(s.loadTopics().length, 1);
  assert.equal(s.unsentimentedCount(), 0);
  s.close();
});

// ---------- model output handling ----------
test("llm: sentiment and merge output is validated, never trusted", () => {
  const batch = [{ key: "a" }, { key: "b" }];
  const got = normalizeSentiments({ items: [{ n: 1, sentiment: "negative", stance: "critical" }, { n: 2, sentiment: "great", stance: "x" }, { n: 9, sentiment: "positive", stance: "neutral" }, { n: 1, sentiment: "positive", stance: "neutral" }] }, batch);
  assert.deepEqual(got, [{ key: "a", sentiment: "negative", stance: "critical" }]); // bad label, unknown number and duplicate are dropped
  assert.equal(normalizeSentiments({ items: [{ n: 2, sentiment: "mixed", stance: "weird" }] }, batch)[0].stance, "neutral");
  const pool = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
  const m = normalizeTopicMerges({ merges: [{ keep: "a", drop: ["b", "zzz", "a"] }, { keep: "b", drop: ["c"] }, { keep: "c", drop: ["d"], name: "Fuel Prices!" }, { keep: "x", drop: ["a"] }] }, pool);
  assert.deepEqual(m.map((x) => [x.keep, x.drop]), [["a", ["b"]], ["c", ["d"]]]); // unknown ids, self-merges and a label used twice are dropped
  assert.equal(m[1].name, "fuel prices");
  const e = normalizeEnrichment({ content_type: "reported", sentiment: "positive", stance: "bad", topics: [], entities: ["X"], pathways: [] }, null);
  assert.equal(e.sentiment, "positive"); assert.equal(e.stance, null);
});

// ---------- weak labels and entities ----------
test("topics: vague filler labels never rank", () => {
  for (const w of ["Personal stories", "human interest", "General News", "miscellaneous"]) assert.ok(isWeakLabel(w, cfg), w);
  assert.ok(!isWeakLabel("port disruption", cfg));
  assert.ok(isWeakLabel("one two three four five", cfg)); // too long to be a theme label
});

test("entities: names are normalised and counted once; momentum compares share against the baseline", () => {
  assert.equal(entityId("Tata Motors Ltd."), "tata motors");
  assert.equal(entityId("TML"), "tata motors");
  assert.equal(entityId("India"), null); // too generic to say anything
  const now = Date.now(), items = [];
  const mk = (at, entities) => ({ id: `e${items.length}`, at, entities, origins: ["group:A", "group:B"], labels: new Map(), sentiment: "negative" });
  for (let h = 24 * 7; h > 24; h--) for (let k = 0; k < 2; k++) items.push(mk(now - h * HOUR, k ? ["Others"] : ["Tata Motors Ltd"]));
  for (let h = 0; h < 24; h++) for (let k = 0; k < 3; k++) items.push(mk(now - h * HOUR, ["Tata Motors", "TML", "Others"]));
  const small = { ...cfg, intervals: { ...cfg.intervals, minBaselineClusters: 10 } };
  const r = buildEntities(items, now, small);
  const tata = r.rows.find((x) => x.id === "tata motors");
  assert.ok(tata && tata.count === 72, `count ${tata?.count}`); // "Tata Motors" + "TML" in one story count once
  assert.ok(tata.momentum > 1, `momentum ${tata.momentum}`);
  assert.equal(tata.sentiment.net, -1);
});

// ---------- weekday patterns ----------
test("seasonality: off with under 4 weeks of history, on and weekday-aware after", () => {
  const now = new Date(2026, 9, 28, 12).getTime(); // a Wednesday
  const mk = (days, boostDow) => {
    const items = [];
    for (let d = 0; d < days; d++) for (let h = 0; h < 24; h += 2) {
      const at = now - d * 24 * HOUR - h * HOUR, dow = new Date(at).getDay();
      const labels = new Map([["t:sport", { w: 1 }]]);
      items.push({ id: `${d}-${h}`, at, labels, origins: [] });
      if (dow === boostDow) items.push({ id: `${d}-${h}b`, at, labels: new Map([["t:sport", { w: 1 }]]), origins: [] });
      else items.push({ id: `${d}-${h}c`, at, labels: new Map(), origins: [] });
    }
    return items;
  };
  const short = buildSeasonality(mk(10, 6), now, cfg);
  assert.equal(short.active, false); assert.equal(short.needDays, 28); assert.ok(short.haveDays >= 9);
  const long = buildSeasonality(mk(40, 6), now, cfg);
  assert.equal(long.active, true);
  const f = long.factors.get("t:sport");
  assert.ok(f[6] > f[1], `Saturday ${f[6]} should exceed Monday ${f[1]}`);
  assert.equal(seasonalFactor(short, "t:sport", now, 24), 1); // inactive: no adjustment
});

// ---------- outcomes and tuning ----------
test("outcomes: a recommendation is a hit only if share multiplies with enough independent origins", () => {
  const t0 = Date.now() - 100 * HOUR, items = [];
  const mk = (at, label, origins) => ({ id: `o${items.length}`, at, labels: new Map(label ? [[label, { w: 1 }]] : []), origins });
  for (let h = 168; h > 0; h--) { for (let k = 0; k < 5; k++) items.push(mk(t0 - h * HOUR, k === 0 && h % 6 === 0 ? "t:x" : null, ["group:A"])); }
  for (let h = 0; h < 72; h++) for (let k = 0; k < 5; k++) items.push(mk(t0 + h * HOUR, k < 3 ? "t:x" : null, [`group:${"ABCDEFG"[(h + k) % 7]}`]));
  const rec = { opp_key: "bcg|Energy|t:x", as_of: t0 };
  const hit = evaluateRecommendation(rec, items, cfg);
  assert.equal(hit.hit, true); assert.ok(hit.peakRatio >= 2 && hit.peakOrigins >= 5);
  const flat = evaluateRecommendation({ opp_key: "bcg|Energy|t:never", as_of: t0 }, items, cfg);
  assert.equal(flat.hit, false);
  assert.equal(evaluateRecommendation({ opp_key: "a|b|t:x", as_of: Date.now() - 1000 * HOUR }, items, cfg).skip, true); // no history before it
  const sum = outcomeSummary([{ hit: true, action: "write now", score: 82, ts: 1 }, { hit: false, action: "write now", score: 70, ts: 1 }, { hit: null, action: "investigate", score: 55, ts: Date.now() }]);
  assert.equal(sum.hitRate.overall, 0.5); assert.equal(sum.hitRate.byAction["write now"].n, 2); assert.equal(sum.pending, 1);
});

test("tuning: refuses to suggest anything without enough judged recommendations, and only a change that helps both halves", () => {
  const W = cfg.weights, wSum = Object.values(W).reduce((a, b) => a + b, 0);
  const mkRow = (i, hit, momentumScore) => ({ id: i, ts: i, hit, components: Object.fromEntries(Object.keys(W).map((k) => [k, (W[k] * (k === "momentum" ? momentumScore : 50)) / wSum])) });
  const few = tuneWeights([mkRow(1, true, 90), mkRow(2, false, 20)], cfg);
  assert.equal(few.ready, false); assert.equal(few.suggested, null); assert.match(few.needs, /At least/);
  // momentum predicts hits perfectly, so shifting weight towards it should be suggested
  const rows = Array.from({ length: 60 }, (_, i) => mkRow(i, i % 2 === 0, i % 2 === 0 ? 90 : 10));
  const r = tuneWeights(rows, cfg);
  assert.equal(r.ready, true);
  if (r.suggested) { assert.ok(r.suggested.weights.momentum > W.momentum); assert.equal(Object.values(r.suggested.weights).reduce((a, b) => a + b, 0), wSum); }
  assert.deepEqual(r.current.weights, W); // the shipped weights are never mutated
});

// ---------- hot topics ----------
test("hot topics: only rising or emerging, well-scored, unchecked topics are picked, one per topic", () => {
  const o = (key, score, stage, action = "investigate") => ({ label: { key, name: key.slice(2) }, score, stage, action });
  const picks = pickHot([o("t:a", 80, "rising"), o("t:a", 79, "rising"), o("t:b", 90, "steady"), o("t:c", 40, "rising"), o("t:d", 75, "emerging", "skip"), o("t:e", 70, "emerging"), o("t:f", 70, "rising")], cfg, new Set(["f"]));
  assert.deepEqual(picks.map((p) => p.label.key), ["t:a", "t:e"]);
  const s = summariseNews([{ title: "x", link: "l", source: "Mint", date: "1h" }, { title: "y", link: "m", source: "Some Blog", date: "2h" }], sources);
  assert.equal(s.total, 2); assert.deepEqual(s.outsideOurSources, ["Some Blog"]);
});

// ---------- API ----------
test("server: logs, usage, notifications, origins, entities, sentiment, outcomes and tuning answer sensibly on a small database", async () => {
  process.env.HIVEMIND_LLM = "off";
  const root = mkdtempSync(join(tmpdir(), "v2-"));
  mkdirSync(join(root, "src")); mkdirSync(join(root, "data")); cpSync(new URL("../config", import.meta.url), join(root, "config"), { recursive: true });
  cpSync(new URL("../src/ui", import.meta.url), join(root, "src", "ui"), { recursive: true });
  copyFileSync(new URL("../src/dashboard.html", import.meta.url), join(root, "src", "dashboard.html"));
  const db = new Store(join(root, "data", "hivemind.db"));
  const now = Date.now(), clusters = [];
  for (let i = 0; i < 80; i++) { const at = now - (i % 40) * HOUR; clusters.push({ title: `T${i}`, url: `https://x/${i}`, publishedAt: at, articles: [{ title: `T${i}`, outlet: i % 2 ? "The Hindu" : "NDTV", publication: i % 2 ? "The Hindu" : "NDTV", url: `https://x/${i}/a` }] }); }
  const keys = db.upsertClusters(clusters);
  keys.forEach((k, i) => {
    db.putReading(k, { analysis: { event_type: "x", summary: "s", geography: [], impacts: [{ group: "g", area: "economy", direction: "negative", severity: 0.6, horizon: "near", note: "", bracket: "economy" }] }, basis: "full-text" });
    db.putEnrichment(k, { entities: i % 3 ? ["Tata Motors Ltd", "RBI"] : ["RBI"], sentiment: i % 4 ? "negative" : "positive", stance: "critical", topics: [] });
  });
  const log = db.startJob({ kind: "run", trigger: "scheduled" }); db.finishJob(log, { status: "ok", summary: "Read 3 new stories", stats: { newStories: 3, failed: 0 } });
  db.close();
  const { serve } = await import("../src/server.mjs");
  const server = await serve({ root, bcg, port: 0, autoSync: false, auth: false, log: () => {} });
  const base = `http://127.0.0.1:${server.address().port}`, get = async (p) => (await fetch(base + p)).json();
  try {
    const logs = await get("/api/logs?limit=10");
    assert.equal(logs.entries[0].kind, "run"); assert.equal(logs.entries[0].trigger, "scheduled"); assert.equal(logs.entries[0].stats.newStories, 3);
    assert.equal(logs.summary.last24h.runs, 1);
    assert.equal((await get("/api/logs?status=failed")).entries.length, 0);
    const usage = await get("/api/usage");
    assert.ok(usage.services.find((s) => s.name === "anthropic") && usage.budgets.serper.limit > 0);
    const notes = await get("/api/notifications");
    assert.ok(notes.items.some((i) => /Collection finished \(scheduled\)/.test(i.title)));
    const all = await get("/api/origins?key=all");
    assert.ok(all.total >= 2 && all.origins[0].stories > 0);
    assert.equal((await fetch(`${base}/api/origins?key=bad%27`)).status, 400);
    const ents = await get("/api/entities");
    assert.ok(ents.entities.some((e) => e.id === "reserve bank of india") && ents.entities.some((e) => e.id === "tata motors"));
    const detail = await get("/api/entity?id=tata%20motors");
    assert.ok(detail.series.bins.length > 0 && detail.stories.length > 0);
    assert.equal((await fetch(`${base}/api/entity?id=nobody%20here`)).status, 404);
    const sent = await get("/api/sentiment");
    assert.equal(sent.coverage.labelled, 80); assert.ok(sent.overall.neg > 0 && sent.daily.length >= 1);
    assert.equal((await get("/api/outcomes")).evaluated, 0);
    assert.equal((await get("/api/tuning")).ready, false);
    // applying a tuning that is not ready is refused, and a non-JSON post is rejected
    assert.equal((await fetch(`${base}/api/tuning/apply`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: true }) })).status, 400);
    assert.equal((await fetch(`${base}/api/job`, { method: "POST", headers: { "content-type": "text/plain" }, body: "x" })).status, 415);
    assert.equal((await fetch(`${base}/api/job`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "nope" }) })).status, 400);
    const opps = await get("/api/opportunities?limit=1000&group=topic");
    assert.ok(Array.isArray(opps.items));
    assert.ok(existsSync(join(root, "data", "hivemind.db")));
  } finally { server.close(); }
});

// ---------- topic ↔ sector inheritance ----------
test("a topic only inherits a parent bracket that holds most of its stories", async () => {
  const { analyse } = await import("../src/metrics.mjs");
  const now = Date.now(), items = [];
  const mk = (i, labels) => ({ id: `p${i}`, at: now - i * 600e3, labels: new Map(labels), origins: ["group:A", "group:B"], areas: new Map(), fullText: true, verified: false, maxSev: 0.5, outletCount: 2, originCount: 2, entities: [] });
  for (let i = 0; i < 40; i++) items.push(mk(i, [["b:economy", { w: 1 }]])); // background coverage
  // topic "ev": 5 of 6 stories filed under transport; topic "sci": 6 stories, only 1 filed under tech (the rest have no bracket)
  for (let i = 0; i < 6; i++) items.push(mk(100 + i, [["t:ev", { w: 1 }], ...(i < 5 ? [["b:transport", { w: 1 }]] : [])]));
  for (let i = 0; i < 6; i++) items.push(mk(200 + i, [["t:sci", { w: 1 }], ...(i === 0 ? [["b:ai-tech", { w: 1 }]] : [])]));
  const r = analyse(items, { cfg, registry: null }, now);
  assert.equal(r.labels.get("t:ev").parent, "transport");
  assert.equal(r.labels.get("t:sci").parent, null); // 1 of 6 is not "most of its stories"
  assert.ok(r.labels.get("t:sci").parentShare < 0.5);
});
