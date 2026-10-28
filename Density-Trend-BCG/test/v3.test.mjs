// Tests for the reliability round: judged topic-sector links, the write-now guardrails, headline-only evidence, duplicate and junk
// handling, wire outlets, entity aliases, size-aware hit bars, data quality, audit and forecast accuracy.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, copyFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, DAY_MS } from "../src/db.mjs";
import { SourceRegistry, originsOf } from "../src/origins.mjs";
import { HOUR, evidenceStrength } from "../src/metrics.mjs";
import { actionFor, buildOpportunities } from "../src/opportunity.mjs";
import { evaluateRecommendation } from "../src/outcomes.mjs";
import { isWeakLabel } from "../src/topics.mjs";
import { junkMatcher, findDuplicates, dedupePass, qualityReport } from "../src/quality.mjs";
import { entityId, buildEntities } from "../src/entities.mjs";
import { BracketRegistry } from "../src/brackets.mjs";

const J = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const cfg = J("../config/hivemind.json"), pubs = J("../config/publications.json"), bcg = J("../config/bcg.json"), seed = J("../config/brackets.seed.json");
const sources = new SourceRegistry(pubs), registry = new BracketRegistry(null, seed);

// ---------- headline-only evidence, history guard, quality guardrail ----------
test("reading mode: headline-only is the normal mode, so evidence rests on independent origins and history", () => {
  assert.equal(cfg.reading.mode, "headline");
  const m = { originsRecent: 6, count: 6, fullTextCount: 0, baselineHours: 80 };
  assert.equal(evidenceStrength(m, cfg).level, "high"); // no full text needed
  assert.equal(evidenceStrength({ ...m, baselineHours: 30 }, cfg).level, "medium");
  assert.equal(evidenceStrength({ ...m, originsRecent: 2 }, cfg).level, "low");
});

test("write now needs history, independent origins and healthy data; otherwise it is held with the reason", () => {
  const base = { score: 80, stage: "rising", evidence: { level: "medium" }, headroom: 60, trigger: { verified: true }, evidenceStatus: "supported" };
  assert.equal(actionFor({ ...base, baselineHours: 100, origins: 6 }, cfg).action, "write now");
  const thin = actionFor({ ...base, baselineHours: 40, origins: 6 }, cfg);
  assert.equal(thin.action, "investigate"); assert.match(thin.why.join(" "), /72h of history/);
  assert.equal(actionFor({ ...base, baselineHours: 100, origins: 2 }, cfg).action, "investigate");
  const held = actionFor({ ...base, baselineHours: 100, origins: 6, qualityRed: true }, cfg);
  assert.equal(held.action, "investigate"); assert.match(held.hold, /data quality/);
});

// ---------- judged topic-sector links ----------
function topicLabel(extra = {}) {
  return { key: "t:ev-charging", level: "topic", id: "ev-charging", parent: null, count: 8, countPrev: 2, total: 400, share: 0.02, baseShare: 0.004, ratio: 5, ratioPrev: 3, accel: 1.2, originsRecent: 6, areaCount: 3, areas: [], fullTextCount: 0, verifiedCount: 2, baselineHours: 100, windowHours: 24, storiesAll: 20,
    sharePercentile: 0.3, stage: "rising", stageRule: "r", evidence: { level: "medium", reasons: [] }, spark: [], weight: 1, ...extra };
}
test("a topic is paired with the sectors it was judged for, flagged judged; without a judgement it stays inherited", () => {
  const company = { id: "acme", name: "Acme", sectors: [{ name: "Energy" }, { name: "Retail" }], matches: {} };
  const items = [{ id: "a", title: "x", url: "u", at: Date.now() - HOUR, verified: true, originCount: 4, outletCount: 4, primary: false, maxSev: 0.7, horizon: "immediate", summary: "", fullText: false, contentType: null }];
  const mk = (topicMatches) => buildOpportunities({ company, matches: {}, analysisResult: { labels: new Map([["t:ev-charging", topicLabel()]]) }, byLabel: new Map([["t:ev-charging", items]]), ctx: { cfg, registry, topics: new Map([["ev-charging", { name: "ev charging" }]]) }, asOf: Date.now(), topicMatches }).items;
  assert.equal(mk(new Map()).length, 0); // no parent bracket and no judgement: nothing to pair it with
  const rows = mk(new Map([["ev-charging", { judgedAt: 1, storyCount: 8, sectors: [{ sector: "Energy", relevance: 0.8, channel: "direct", front: "supply", why: "w", write_about: "EV charging build-out: who pays?" }] }]]));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].fit.mode, "judged"); assert.equal(rows[0].evidenceStatus, "supported"); assert.equal(rows[0].angle, "EV charging build-out: who pays?");
  // a judgement of "no relevant sector" removes the pairing altogether
  assert.equal(mk(new Map([["ev-charging", { judgedAt: 1, storyCount: 8, sectors: [] }]])).length, 0);
});

test("db: judged matches are stored per company and replaced on a refresh; 'none relevant' is remembered", () => {
  const s = new Store(":memory:");
  s.putTopicMatches("acme", "ev", [{ sector: "Energy", relevance: 0.7, why: "w", write_about: "a" }], 9);
  s.putTopicMatches("acme", "jobs", [], 5);
  const m = s.topicMatches("acme");
  assert.equal(m.get("ev").sectors[0].sector, "Energy"); assert.equal(m.get("jobs").sectors.length, 0); assert.equal(m.get("ev").storyCount, 9);
  s.putTopicMatches("acme", "ev", [{ sector: "Retail", relevance: 0.6 }], 12);
  assert.deepEqual(s.topicMatches("acme").get("ev").sectors.map((x) => x.sector), ["Retail"]);
  assert.equal(s.topicMatches("other").size, 0);
  s.close();
});

// ---------- topics, outcomes, origins, entities ----------
test("generic category labels never rank; specific subjects do", () => {
  for (const w of ["cricket news", "market updates", "match highlights", "sports commentary"]) assert.ok(isWeakLabel(w, cfg), w);
  for (const w of ["port disruption", "bank earnings", "ev charging", "fuel prices"]) assert.ok(!isWeakLabel(w, cfg), w);
});

test("hit bar scales with size: a tiny topic needs 3x, a large one 1.5x, and enough stories at the peak", () => {
  const t0 = Date.now() - 100 * HOUR, items = [];
  const mk = (at, label, origins) => ({ id: `q${items.length}`, at, labels: new Map(label ? [[label, { w: 1 }]] : []), origins });
  const run = (baseEvery, afterPerHour) => { items.length = 0;
    for (let h = 168; h > 0; h--) for (let k = 0; k < 10; k++) items.push(mk(t0 - h * HOUR, k === 0 && h % baseEvery === 0 ? "t:x" : null, ["group:A"]));
    for (let h = 0; h < 72; h++) for (let k = 0; k < 10; k++) items.push(mk(t0 + h * HOUR, k < afterPerHour ? "t:x" : null, [`group:${"ABCDEFG"[(h + k) % 7]}`]));
    return evaluateRecommendation({ opp_key: "c|s|t:x", as_of: t0 }, items, cfg); };
  const tiny = run(40, 1);   // baseline ~0.25% -> needs 3x; peak ~10%: far above -> hit
  assert.equal(tiny.hit, true); assert.ok(tiny.needed >= 2);
  const big = run(1, 1);     // baseline 10%; after 10%: no growth -> miss even with many origins
  assert.equal(big.hit, false);
});

test("origins: an article carried by a wire agency counts as that wire, not as the carrier's own reporting", () => {
  const s = { articles: [{ outlet: "Bloomberg", publication: "Business Standard", title: "t", url: "u1" }, { outlet: "The Hindu", publication: "The Hindu", title: "t", url: "u2" }], meta: null };
  const o = originsOf(s, sources);
  assert.ok(o.origins.includes("wire:Bloomberg")); assert.ok(o.origins.includes("group:The Hindu Group") || o.origins.some((x) => x.startsWith("group:")));
  assert.ok(!o.origins.includes("group:Business Standard")); assert.equal(o.count, 2);
});

test("entities: learned aliases fold name variants into one entity", () => {
  const aliases = new Map([["tata motors passenger vehicles", "tata motors"]]);
  assert.equal(entityId("Tata Motors Passenger Vehicles Ltd", aliases), "tata motors");
  const now = Date.now(), items = Array.from({ length: 30 }, (_, i) => ({ id: `e${i}`, at: now - i * HOUR, entities: [i % 2 ? "Tata Motors" : "Tata Motors Passenger Vehicles"], origins: ["group:A", "group:B", "group:C"], labels: new Map(), sentiment: null }));
  const rows = buildEntities(items, now, cfg, { aliases }).rows;
  assert.equal(rows.filter((r) => r.id.startsWith("tata")).length, 1); assert.equal(rows[0].countAll, 30);
});

// ---------- duplicates and junk ----------
test("junk template pages are recognised; real repeats are found but different scoreboard fixtures are not", () => {
  const isJunk = junkMatcher(cfg);
  assert.ok(isJunk("Painting: Latest News, Photos, Videos, Information on Painting"));
  assert.ok(isJunk("MAH vs GUJ Match 48 Commentary | Ball by Ball Commentary MAH"));
  assert.ok(!isJunk("RBI holds repo rate steady, signals cautious stance"));
  const t = Date.now(), r = (key, title, h) => ({ key, title, published_at: t + h * HOUR });
  const dups = findDuplicates([r("a", "Tata Motors, Amazon partner to deploy 3,000 electric trucks for logistics - Mint", 0), r("b", "Tata Motors, Amazon partner to deploy 3,000 electric trucks for logistics - Hindustan Times", 2),
    r("c", "NGR vs UGA T20 highlights today", 3), r("d", "MAH vs GUJ T20 highlights today", 4), r("e", "RBI keeps repo rate unchanged for the sixth time", 5)], cfg);
  assert.deepEqual(dups.map((d) => [d.key, d.canonical]), [["b", "a"]]);
});

test("db: duplicates fold into the earlier story and junk is excluded, reversibly; nothing is deleted", () => {
  const s = new Store(":memory:"), now = Date.now();
  const clusters = [
    { title: "Fuel prices cut by two rupees across metros today", url: "https://x/1", publishedAt: now - 5 * HOUR, articles: [{ title: "Fuel prices cut by two rupees across metros today", outlet: "Mint", publication: "Mint", url: "https://x/1a" }] },
    { title: "Fuel prices cut by two rupees across metros today - NDTV", url: "https://x/2", publishedAt: now - 4 * HOUR, articles: [{ title: "Fuel prices cut by two rupees across metros today - NDTV", outlet: "NDTV", publication: "NDTV", url: "https://x/2a" }] },
    { title: "Cricket: Latest News, Photos, Videos, Information on Cricket", url: "https://x/3", publishedAt: now - 3 * HOUR, articles: [{ title: "Cricket: Latest News, Photos, Videos, Information on Cricket", outlet: "TOI", publication: "Times of India", url: "https://x/3a" }] },
  ];
  const keys = s.upsertClusters(clusters);
  keys.forEach((k) => s.putReading(k, { analysis: { event_type: "x", summary: "s", geography: [], impacts: [] }, basis: "headline" }));
  const r = dedupePass(s, cfg, { since: 0 });
  assert.equal(r.duplicates, 1); assert.equal(r.junk, 1);
  const stories = s.loadStories({ from: 0, to: now + DAY_MS });
  assert.equal(stories.length, 1); assert.equal(stories[0].articles.length, 2); // the repeat's headline now counts toward the first story
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM stories").get().n, 3); // nothing deleted
  assert.equal(dedupePass(s, cfg, { since: 0 }).duplicates, 0); // already marked
  s.clearDupes();
  assert.equal(s.loadStories({ from: 0, to: now + DAY_MS }).length, 3);
  s.close();
});

// ---------- data quality ----------
test("quality: a silent source and thin history raise amber or red; the overall status follows the worst check", () => {
  const s = new Store(":memory:"), now = Date.now();
  const cl = [];
  for (let i = 0; i < 40; i++) cl.push({ title: `Story ${i} about things`, url: `https://x/${i}`, publishedAt: now - (i + 1) * HOUR, articles: [{ title: `Story ${i}`, outlet: "Mint", publication: "Mint", url: `https://x/${i}a` }] });
  cl.push({ title: "Old one about stuff", url: "https://x/old", publishedAt: now - 60 * HOUR, articles: [{ title: "Old one", outlet: "NDTV", publication: "NDTV", url: "https://x/olda" }] });
  s.upsertClusters(cl);
  const q = qualityReport({ store: s, cfg, sources, items: [], analysis: { history: { hours: 20 } }, topicRows: [], now });
  const get = (k) => q.checks.find((c) => c.key === k);
  assert.equal(get("baselineHours").status, "red"); // 20h of history
  assert.ok(q.sources.find((x) => x.name === "NDTV").silent);
  assert.equal(q.status, "red");
  assert.ok(q.flags.includes("History available"));
  assert.equal(get("auditAccuracy").status, "info"); // too few reviews to judge
  s.close();
});

test("db: audit verdicts and second opinions are stored; accuracy counts only judged ones", () => {
  const s = new Store(":memory:");
  s.upsertClusters([{ title: "t", url: "u", publishedAt: Date.now(), articles: [{ title: "t", outlet: "Mint", publication: "Mint", url: "ua" }] }]);
  const key = s.db.prepare("SELECT key FROM stories").get().key;
  s.putAudit({ key, verdict: "correct" });
  s.putAudit({ key: "k2", verdict: "wrong" }); s.putAudit({ key: "k3", verdict: "unsure" });
  const a = s.auditStats();
  assert.equal(a.reviewed, 3); assert.equal(a.accuracy, 0.5);
  s.putReview(key, "claude-sonnet-5-5", false, "overstates severity");
  assert.equal(s.reviews()[0].agrees, false); assert.ok(s.reviewedKeys("claude-sonnet-5-5").has(key));
  s.close();
});

// ---------- API ----------
test("server: quality, audit, forecast accuracy and the new job kinds answer sensibly", async () => {
  process.env.HIVEMIND_LLM = "off";
  const root = mkdtempSync(join(tmpdir(), "v3-"));
  mkdirSync(join(root, "src")); mkdirSync(join(root, "data")); cpSync(new URL("../config", import.meta.url), join(root, "config"), { recursive: true });
  cpSync(new URL("../src/ui", import.meta.url), join(root, "src", "ui"), { recursive: true });
  copyFileSync(new URL("../src/dashboard.html", import.meta.url), join(root, "src", "dashboard.html"));
  const db = new Store(join(root, "data", "hivemind.db")), now = Date.now(), clusters = [];
  for (let i = 0; i < 60; i++) clusters.push({ title: `Distinct story number ${i} on topic ${i % 7}`, url: `https://x/${i}`, publishedAt: now - (i % 30) * HOUR, articles: [{ title: `t${i}`, outlet: "Mint", publication: i % 2 ? "Mint" : "NDTV", url: `https://x/${i}/a` }] });
  const keys = db.upsertClusters(clusters);
  keys.forEach((k) => db.putReading(k, { analysis: { event_type: "x", summary: "s", geography: [], impacts: [{ group: "g", area: "economy", direction: "negative", severity: 0.6, horizon: "near", note: "", bracket: "economy" }] }, basis: "headline" }));
  db.close();
  const { serve } = await import("../src/server.mjs");
  const server = await serve({ root, bcg, port: 0, autoSync: false, auth: false, log: () => {} });
  const base = `http://127.0.0.1:${server.address().port}`, get = async (p) => (await fetch(base + p)).json();
  const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const q = await get("/api/quality");
    assert.ok(["green", "amber", "red"].includes(q.status)); assert.ok(q.checks.length >= 6 && q.sources.length >= 19);
    assert.ok(q.checks.every((c) => c.key && c.label && c.status));
    const ov = await get("/api/overview"); assert.ok(ov.quality && ov.quality.status);
    const queue = await get("/api/audit/queue?limit=5");
    assert.ok(queue.items.length > 0 && queue.items.length <= 5); assert.ok(queue.items[0].impacts.length > 0); assert.equal(queue.stats.target, 0.9);
    const rv = await post("/api/audit/review", { key: queue.items[0].id, verdict: "correct" });
    assert.equal(rv.status, 200); assert.equal((await rv.json()).stats.reviewed, 1);
    assert.equal((await post("/api/audit/review", { key: queue.items[0].id, verdict: "great" })).status, 400);
    assert.equal((await post("/api/audit/review", { key: "nope", verdict: "wrong" })).status, 400);
    assert.ok(!(await get("/api/audit/queue?limit=60")).items.some((i) => i.id === queue.items[0].id)); // reviewed stories leave the queue
    const fa = await get("/api/forecast-accuracy"); assert.equal(fa.evaluated, 0); assert.equal(fa.target, 0.8);
    assert.equal((await get("/api/audit/second-opinion")).summary.checked, 0);
    const dd = await post("/api/job", { kind: "dedupe" }); assert.equal(dd.status, 200);
    assert.equal((await post("/api/job", { kind: "bogus" })).status, 400);
  } finally { server.close(); }
});

// ---------- one opportunity, one row ----------
test("opportunities: the same angle or mostly the same stories within a sector appears once, with the other topics listed", async () => {
  const { Analytics } = await import("../src/analytics.mjs");
  const now = Date.now(), st = (id) => ({ id, at: now - HOUR });
  const byLabel = new Map([["t:a", [st("1"), st("2"), st("3")]], ["t:b", [st("1"), st("2"), st("3")]], ["t:c", [st("7"), st("8")]], ["t:d", [st("9")]]]);
  const mk = (topic, sector, score, angle) => ({ key: `c|${sector}|t:${topic}`, sector, score, angle, action: "investigate", stage: "rising", label: { key: `t:${topic}`, name: topic } });
  const items = [mk("a", "Climate", 81, "Cyclone stress test for coastal firms"), mk("b", "Climate", 77, "A different angle entirely"), mk("c", "Climate", 70, "Cyclone stress test for coastal firms"), mk("d", "Climate", 60, "Unrelated"), mk("a", "Energy", 50, "Same topic, other sector")];
  const counts = { total: 5, action: { investigate: 5 }, stage: { rising: 5 } };
  const kept = Analytics.prototype.dedupeOpportunities.call({}, { byLabel, asOf: now }, items, counts);
  assert.deepEqual(kept.map((o) => `${o.sector}:${o.label.name}`).sort(), ["Climate:a", "Climate:d", "Energy:a"]);
  const top = kept.find((o) => o.sector === "Climate" && o.label.name === "a");
  assert.deepEqual(top.alsoCovers.map((x) => x.reason).sort(), ["same angle", "same stories"]);
  assert.equal(counts.total, 3);
});
