// Tests for the topic-forecasting layer: origins, metrics, stages, opportunity scoring, authors, briefs, backtest and API.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, copyFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SourceRegistry, detectWire, originsOf } from "../src/origins.mjs";
import { prepareItems, analyse, seriesFor, stageOf, holtDamped, HOUR } from "../src/metrics.mjs";
import { buildOpportunities, itemsByLabel, actionFor, authorFit } from "../src/opportunity.mjs";
import { runBacktest } from "../src/backtest.mjs";
import { normalizeAuthor, parseAuthors } from "../src/authors.mjs";
import { normalizeBrief, normalizeEnrichment } from "../src/llm.mjs";
import { TopicRegistry } from "../src/topics.mjs";
import { BracketRegistry } from "../src/brackets.mjs";
import { parseSearchUpload } from "../src/signals.mjs";
import { Store, dayOf, dayStart, DAY_MS } from "../src/db.mjs";
import { explainChange } from "../src/analytics.mjs";

const J = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const cfg = J("../config/hivemind.json"), pubs = J("../config/publications.json"), bcg = J("../config/bcg.json"), seed = J("../config/brackets.seed.json");
const sources = new SourceRegistry(pubs);
const registry = new BracketRegistry(null, seed);
const ctxFor = (extra = {}) => ({ cfg, registry, sources, topics: new Map(), ...extra });

// A synthetic story: `pub` is the queried publication name; `bracket` is the bracket id it is filed under.
let seq = 0;
function story({ at, bracket = "economy", pubsList = ["The Hindu"], full = true, firstSeen = null, severity = 0.5, readAt = 0, meta = null, area = "economy" }) {
  const id = `s${seq++}`;
  return {
    id, title: `Story ${id}`, url: `https://x/${id}`, snippet: "", publishedAt: at, firstSeen: firstSeen ?? at + 1000, readAt, enrichedAt: null,
    outlets: pubsList, articles: pubsList.map((p) => ({ title: `Story ${id}`, outlet: p, publication: p, url: `https://x/${id}/${p}` })),
    basis: full ? "full-text" : "headline", meta,
    analysis: { event_type: "x", summary: "s", geography: ["India"], impacts: [{ group: "g", area, direction: "negative", severity, horizon: "immediate", note: "", bracket }] },
  };
}

// ---------- origins ----------
test("origins: ownership groups collapse, wire credit is one origin, primary sources stand alone", () => {
  const s = story({ at: 1, pubsList: ["Times of India", "The Economic Times", "Hindustan Times"] });
  assert.equal(originsOf(s, sources).count, 2); // Times Group counts once
  const wired = { ...s, meta: { wire: "PTI" } };
  assert.equal(originsOf(wired, sources).count, 1);
  const prim = story({ at: 1, pubsList: ["RBI", "Mint"] });
  const o = originsOf(prim, sources);
  assert.equal(o.primary, true);
  assert.equal(o.count, 2);
});

test("detectWire finds agency credits near the top of an article, not deep in the body", () => {
  assert.equal(detectWire("New Delhi, Oct 26 (PTI) The government said…"), "PTI");
  assert.equal(detectWire("MUMBAI: Prices rose. — Reuters\nMore text"), "Reuters");
  assert.equal(detectWire("No credit here. ".repeat(200) + "(PTI)"), null);
});

// ---------- metrics: binning, momentum, eligibility ----------
const T0 = dayStart("2026-10-20");
function history({ days = 4, risingFrom = null, bracket = "climate", base = 0.05, risen = 0.3, perHour = 40, pubsFor = (i) => (i % 2 ? ["The Hindu"] : ["NDTV", "Mint"]) } = {}) {
  const out = [];
  for (let h = 0; h < days * 24; h++) {
    const at = T0 + h * HOUR + 600e3;
    const share = risingFrom != null && h >= risingFrom ? risen : base;
    for (let i = 0; i < perHour; i++) out.push(story({ at: at + i * 1000, bracket: i < perHour * share ? bracket : "economy", pubsList: pubsFor(i) }));
  }
  return out;
}

test("metrics: bins by publication time, so a once-a-day batch doesn't pile up in one hour", () => {
  const asOf = T0 + 3 * DAY_MS;
  const batch = history({ days: 3 }).map((s) => ({ ...s, firstSeen: asOf })); // everything first seen at the same instant
  const items = prepareItems(batch, { registry, sources, cfg, asOf, gate: false });
  const sr = seriesFor(items, "b:economy", "hour", ctxFor(), asOf);
  assert.ok(Math.max(...sr.total) <= 40, "no hour holds the whole batch");
});

test("metrics: a rising topic gets momentum above 1 and a rising/emerging stage; a flat one is steady", () => {
  const stories = history({ days: 4, risingFrom: 4 * 24 - 12 });
  const asOf = T0 + 4 * DAY_MS;
  const items = prepareItems(stories, { registry, sources, cfg, asOf });
  const res = analyse(items, ctxFor(), asOf);
  const climate = res.labels.get("b:climate"), econ = res.labels.get("b:economy");
  assert.ok(climate.ratio > 2.5, `ratio ${climate.ratio}`);
  assert.ok(["rising", "emerging"].includes(climate.stage), climate.stage);
  assert.ok(econ.ratio < 1);
  assert.match(climate.stageRule, /momentum/i);
  assert.ok(climate.originsRecent >= 2);
});

test("metrics: small counts cannot dominate (1 → 3 stories is not ×3)", () => {
  const stories = history({ days: 4, base: 0.0 });
  const asOf = T0 + 4 * DAY_MS;
  for (let i = 0; i < 3; i++) stories.push(story({ at: asOf - 3600e3 + i * 1000, bracket: "health", pubsList: ["The Hindu"] }));
  const res = analyse(prepareItems(stories, { registry, sources, cfg, asOf }), ctxFor(), asOf);
  const h = res.labels.get("b:health");
  assert.ok(h.ratio <= 4.01);
  assert.equal(h.stage, "watch"); // 3 stories but one origin → watchlist
});

test("metrics: a label created mid-collection is judged only against stories that could carry it", () => {
  const stories = history({ days: 4, base: 0.1, bracket: "governance" });
  const created = T0 + 3 * DAY_MS; // the bracket came into being on day 3
  stories.forEach((s) => { s.readAt = s.publishedAt; });
  // Before creation nobody could file under it, so strip it from older stories
  const kept = stories.map((s) => (s.publishedAt < created ? { ...s, analysis: { ...s.analysis, impacts: s.analysis.impacts.map((i) => ({ ...i, bracket: "economy" })) } } : s));
  const reg = new BracketRegistry(null, seed);
  const id = reg.resolve({ name: "Governance", keywords: ["election commission", "court ruling", "institutions"] });
  reg.get(id).createdAt = created;
  const asOf = T0 + 4 * DAY_MS;
  const ctx = { ...ctxFor({ registry: reg }), elig: (k) => (k === `b:${id}` ? { from: created, field: "readAt" } : null) };
  const withElig = analyse(prepareItems(kept, { registry: reg, sources, cfg, asOf }), ctx, asOf).labels.get(`b:${id}`);
  const naive = analyse(prepareItems(kept, { registry: reg, sources, cfg, asOf }), { ...ctx, elig: null }, asOf).labels.get(`b:${id}`);
  assert.ok(naive.ratio > 1.3, "without eligibility the new bracket looks like a surge");
  assert.ok(withElig.ratio < 1.3, `with eligibility it is steady (${withElig.ratio})`);
});

test("metrics: collection gaps are flagged and excluded from the baseline", () => {
  const stories = history({ days: 4 }).filter((s) => !(s.publishedAt >= T0 + 30 * HOUR && s.publishedAt < T0 + 34 * HOUR));
  const asOf = T0 + 4 * DAY_MS;
  const res = analyse(prepareItems(stories, { registry, sources, cfg, asOf }), ctxFor(), asOf);
  assert.ok(res.outages.length >= 4);
});

test("replay: with gate on, stories first seen after the prediction time are invisible", () => {
  const asOf = T0 + 2 * DAY_MS;
  const late = story({ at: asOf - HOUR, firstSeen: asOf + 5 * HOUR });
  assert.equal(prepareItems([late], { registry, sources, cfg, asOf, gate: true }).length, 0);
  assert.equal(prepareItems([late], { registry, sources, cfg, asOf, gate: false }).length, 1);
});

test("forecast: damped trend extrapolates and widens its band; too little history gives none", () => {
  const y = Array.from({ length: 30 }, (_, i) => 0.1 + 0.002 * i + (i % 2) * 0.004);
  const f = holtDamped(y, cfg.forecast, 6);
  assert.equal(f.points.length, 6);
  assert.ok(f.points[5].hi - f.points[5].lo > f.points[0].hi - f.points[0].lo);
  assert.ok(f.points.every((p) => p.lo >= 0 && p.hi <= 1));
  assert.equal(holtDamped([0.1, 0.2], cfg.forecast, 3), null);
  const asOf = T0 + DAY_MS / 2;
  const items = prepareItems(history({ days: 1 }).slice(0, 100), { registry, sources, cfg, asOf: T0 + 3 * HOUR });
  assert.equal(seriesFor(items, "b:climate", "hour", ctxFor(), T0 + 3 * HOUR).forecast.available, false);
  assert.ok(asOf);
});

test("stage rules carry their numbers", () => {
  const m = (o) => ({ ratio: 2, ratioPrev: 1.5, count: 10, originsRecent: 5, baselineHours: 48, ...o });
  assert.equal(stageOf(m({}), cfg, 0.3).stage, "rising");
  assert.equal(stageOf(m({ ratioPrev: 0.9 }), cfg, 0.3).stage, "emerging");
  assert.equal(stageOf(m({ ratio: 1.1, ratioPrev: 1.1 }), cfg, 0.9).stage, "crowded");
  assert.equal(stageOf(m({ ratio: 0.5, ratioPrev: 0.7 }), cfg, 0.5).stage, "declining");
  assert.equal(stageOf(m({ ratio: null }), cfg, 0.5).stage, "watch");
  assert.equal(stageOf(m({ count: 1 }), cfg, 0.5).stage, "watch");
  assert.match(stageOf(m({}), cfg, 0.3).rule, /×2\.00/);
});

// ---------- opportunities ----------
function fakeCompany(rel = 0.8) { return { id: "acme", name: "Acme", matches: { climate: { sectors: [{ sector: "Logistics", relevance: rel, channel: "direct", front: "supply_chain", why: "ports", write_about: "Plan for port closures" }] } } }; }
function opportunitiesFor(stories, asOf, rel) {
  const items = prepareItems(stories, { registry, sources, cfg, asOf });
  const analysisResult = analyse(items, ctxFor(), asOf);
  return buildOpportunities({ company: fakeCompany(rel), matches: fakeCompany(rel).matches, analysisResult, byLabel: itemsByLabel(items), ctx: ctxFor(), asOf });
}

test("opportunity: score is the weighted sum of its six components and stays within 0–100", () => {
  const asOf = T0 + 4 * DAY_MS;
  const { items } = opportunitiesFor(history({ days: 4, risingFrom: 4 * 24 - 12 }), asOf, 0.8);
  const o = items.find((x) => x.label.key === "b:climate");
  assert.ok(o);
  const sum = Object.values(o.components).reduce((a, c) => a + c.points, 0);
  assert.ok(Math.abs(sum - o.score) < 1e-9);
  assert.ok(o.score > 0 && o.score <= 100);
  assert.deepEqual(Object.keys(o.components).sort(), ["acceleration", "headroom", "momentum", "sectorEvidence", "sourceBreadth", "triggerTiming"]);
  assert.ok(["write now", "investigate", "monitor", "skip"].includes(o.action));
  assert.ok(o.review.length > 20 && o.window.label);
});

test("opportunity: weak sector relevance lowers the score; a hypothesis link blocks write-now", () => {
  const asOf = T0 + 4 * DAY_MS, st = history({ days: 4, risingFrom: 4 * 24 - 12 });
  const hi = opportunitiesFor(st, asOf, 0.9).items.find((x) => x.label.key === "b:climate");
  const lo = opportunitiesFor(st, asOf, 0.35).items.find((x) => x.label.key === "b:climate");
  assert.ok(hi.score > lo.score);
  assert.equal(lo.evidenceStatus, "hypothesis");
  assert.notEqual(lo.action, "write now");
});

test("actionFor: write-now needs every condition; declining and crowded-without-headroom skip", () => {
  const base = { score: 80, stage: "rising", evidence: { level: "high" }, headroom: 60, trigger: { verified: true }, evidenceStatus: "supported" };
  assert.equal(actionFor(base, cfg).action, "write now");
  assert.equal(actionFor({ ...base, trigger: { verified: false } }, cfg).action, "investigate");
  assert.equal(actionFor({ ...base, evidence: { level: "low" } }, cfg).action, "investigate");
  assert.equal(actionFor({ ...base, stage: "declining" }, cfg).action, "skip");
  assert.equal(actionFor({ ...base, stage: "crowded", headroom: 10 }, cfg).action, "skip");
  assert.equal(actionFor({ ...base, stage: "watch" }, cfg).action, "monitor");
  assert.equal(actionFor({ ...base, score: 20 }, cfg).action, "skip");
});

test("explainChange says what moved", () => {
  const o = { score: 72, action: "write now", stage: "rising", kind: "forecast", metrics: { originsRecent: 6 }, components: { momentum: { points: 20 }, headroom: { points: 5 } } };
  assert.match(explainChange(null, o), /First flagged/);
  const last = { score: 55, action: "investigate", stage: "emerging", components: { momentum: 10, headroom: 5 } };
  const t = explainChange(last, o);
  assert.match(t, /investigate → write now/);
  assert.match(t, /momentum \+10\.0 pts/);
});

// ---------- authors and briefs ----------
test("authors: normalised from forms and CSV; fit uses only profile fields and is separate from momentum", () => {
  const a = normalizeAuthor({ name: "Asha Rao", expertise: "logistics, port operations", sectors: "Logistics", audience: "manufacturing CFOs", geography: "India", turnaroundHours: 24, evidence: ["Operating data from 12 plants"] });
  assert.equal(a.id, "asha-rao");
  assert.throws(() => normalizeAuthor({ name: " " }));
  const csv = parseAuthors("name,expertise,sectors,turnaround_hours\nBo Lin,energy; power,Energy,48");
  assert.deepEqual(csv[0].expertise, ["energy", "power"]);
  assert.equal(csv[0].turnaroundHours, 48);
  const opp = { sector: "Logistics", label: { name: "Climate", parentName: "Climate" }, stories: [] };
  const fit = authorFit(a, opp, { geography: ["India"], windowHours: 72 });
  assert.ok(fit.score > 60);
  assert.ok(fit.why.some((w) => /Logistics/.test(w)));
  const bare = authorFit({ id: "x", name: "No profile" }, opp, {});
  assert.equal(bare.score, 0);
  assert.ok(bare.missing.includes("expertise / sectors"));
});

test("briefs: a fact without a supplied source is demoted to an assumption", () => {
  const raw = { headline: "H", core_argument: "A", audience: "CFOs", reason_now: "R", publication_window: "24h", review_condition: "x", evidence_needed: ["data"],
    confirmed_facts: [{ fact: "Port closed", source_url: "https://x/1" }, { fact: "Prices will rise 10%", source_url: "https://invented" }], assumptions: ["a"] };
  const b = normalizeBrief(raw, ["https://x/1", "https://x/2"]);
  assert.equal(b.confirmed_facts.length, 1);
  assert.ok(b.assumptions.some((x) => /Not source-backed: Prices will rise/.test(x)));
  assert.deepEqual(b.source_links.slice(0, 2), ["https://x/1", "https://x/2"]);
  assert.equal(normalizeBrief({}, []), null);
});

// ---------- topics ----------
test("topics: reused by exact name, alias or overlap; new topics are created; bad names dropped", () => {
  const t = new TopicRegistry(null);
  const a = t.resolve("Port disruption", "transport");
  assert.equal(t.resolve("port disruption"), a);
  assert.equal(t.resolve("port disruptions at coast"), a);
  assert.notEqual(t.resolve("crop damage"), a);
  assert.equal(t.resolve("   "), null);
  assert.equal(t.resolve("one two three four five six seven"), null);
  const e = normalizeEnrichment({ content_type: "opinion", topics: ["Port disruption", "insurance claims", 5], entities: ["IMD", ""], pathways: [{ disruption: "port", sector: "logistics", question: "delays?", status: "observed" }, { bad: 1 }] }, t, "transport");
  assert.equal(e.contentType, "opinion");
  assert.equal(e.topics.length, 2);
  assert.deepEqual(e.entities, ["IMD"]);
  assert.equal(e.pathways.length, 1);
  assert.equal(normalizeEnrichment({ content_type: "bogus" }, t).contentType, null);
});

test("topics and enrichments persist; labelled stories load with their labels; unlabelled ones are listed", () => {
  const db = new Store(":memory:");
  const keys = db.upsertClusters([{ title: "Cyclone hits coast", url: "u1", publishedAt: Date.now() - 1000, articles: [{ url: "u1", title: "Cyclone hits coast", outlet: "The Hindu", publication: "The Hindu" }] }]);
  db.putReading(keys[0], { analysis: { event_type: "e", summary: "s", geography: [], impacts: [] }, basis: "headline" });
  assert.equal(db.unenriched().length, 1);
  const t = new TopicRegistry(db); const id = t.resolve("port disruption"); t.save();
  db.putEnrichment(keys[0], { topics: [id], contentType: "reported", wire: "PTI", source: "enrich" });
  assert.equal(db.unenriched().length, 0);
  const [s] = db.loadStories({ from: 0, to: Date.now() + 1e6 });
  assert.deepEqual(s.meta.topics, [id]);
  assert.equal(s.meta.wire, "PTI");
  assert.ok(s.readAt && s.enrichedAt && s.firstSeen);
  assert.equal(new TopicRegistry(db).get(id).name, "port disruption");
  db.putAuthor({ id: "a", name: "A", expertise: ["x"] });
  assert.equal(db.listAuthors()[0].expertise[0], "x");
  const bid = db.addBrief({ company: "c", oppKey: "k", sector: "s", topic: "t", brief: { headline: "h" }, model: "m" });
  assert.equal(db.decideBrief(bid, "approved", "ok"), 1);
  assert.equal(db.briefStats().approved, 1);
  db.close();
});

test("search upload: CSV and JSON parse; nothing is zero-filled", () => {
  const a = parseSearchUpload("topic,date,value\nport disruption,2026-10-20,35\nport disruption,2026-10-21,50\nbad,x,y");
  assert.equal(a.length, 1);
  assert.equal(a[0].points.length, 2);
  const b = parseSearchUpload(JSON.stringify({ topic: "t", points: [{ date: "2026-10-20", value: 10 }] }));
  assert.equal(b[0].points[0].value, 10);
});

// ---------- backtest ----------
test("backtest: not ready on a short history; on a long one it scores picks against the trend definition and a baseline", () => {
  const ctx = ctxFor();
  const short = runBacktest({ stories: [], ctx, asOfNow: 0, days: [{ day: "2026-10-20" }] });
  assert.equal(short.ready, false);
  assert.match(short.reason, /at least 10 days/);

  // 16 days; "climate" rises after day 9 so there is something to detect.
  const wide = ["The Hindu", "NDTV", "Mint", "Moneycontrol", "ThePrint", "Deccan Herald", "Telegraph India"].map((p) => (p === "Telegraph India" ? "The Telegraph India" : p));
  const stories = history({ days: 16, risingFrom: 9 * 24, perHour: 21, pubsFor: (i) => wide.slice(0, 1 + (i % 7)) });
  const days = []; for (let d = 0; d < 16; d++) days.push({ day: dayOf(T0 + d * DAY_MS) });
  const r = runBacktest({ stories, ctx, asOfNow: T0 + 16 * DAY_MS, days, briefStats: { approved: 1, rejected: 1 } });
  assert.equal(r.ready, true);
  assert.ok(r.points.length >= 1);
  assert.ok(r.hivemind.picks > 0 && r.baseline.picks > 0);
  assert.equal(r.editor.acceptanceRate, 0.5);
  assert.ok(r.points.some((p) => p.trendingTotal >= 1), "the planted rise meets the trend definition");
  assert.ok(r.points.every((p) => p.T <= T0 + 16 * DAY_MS));
});

// ---------- API ----------
test("server: analytics API answers, authors and briefs round-trip, invalid input is rejected", async () => {
  process.env.HIVEMIND_LLM = "off";
  const root = mkdtempSync(join(tmpdir(), "hm-"));
  mkdirSync(join(root, "src")); cpSync(new URL("../src/ui", import.meta.url), join(root, "src", "ui"), { recursive: true });
  copyFileSync(new URL("../src/dashboard.html", import.meta.url), join(root, "src", "dashboard.html"));
  cpSync(new URL("../config", import.meta.url), join(root, "config"), { recursive: true });
  // seed a small database
  mkdirSync(join(root, "data"));
  const db = new Store(join(root, "data", "hivemind.db"));
  const now = Date.now(), reg = new BracketRegistry(null, seed);
  const clusters = [], reads = [];
  for (let i = 0; i < 60; i++) {
    const at = now - (i % 30) * HOUR; const sv = story({ at, bracket: i % 3 ? "economy" : "climate", pubsList: i % 2 ? ["The Hindu"] : ["NDTV", "Mint"] });
    clusters.push({ title: sv.title, url: sv.url, publishedAt: at, articles: sv.articles }); reads.push(sv.analysis);
  }
  const keys = db.upsertClusters(clusters); keys.forEach((k, i) => db.putReading(k, { analysis: reads[i], basis: "full-text" }));
  db.close(); void reg;
  const { serve } = await import("../src/server.mjs");
  const server = await serve({ root, bcg, port: 0, autoSync: false, auth: false, log: () => {} });
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (p) => (await fetch(base + p)).json();
  const post = (p, body, type = "application/json") => fetch(base + p, { method: "POST", headers: { "content-type": type }, body: JSON.stringify(body) });
  try {
    const ov = await get("/api/overview?company=bcg");
    assert.equal(ov.kpis.stories, 60);
    assert.ok(ov.stages.bracket);
    assert.ok(ov.history.days >= 1);
    assert.ok((await get("/api/labels?level=bracket")).rows.length >= 2);
    const topics = await get("/api/labels?level=topic");
    assert.equal(topics.rows.length, 0);
    const ser = await get("/api/series?keys=b:climate&gran=hour");
    assert.equal(ser.series["b:climate"].bins.length, ser.series["b:climate"].count.length);
    assert.equal((await fetch(`${base}/api/series?keys=bad`)).status, 400);
    assert.equal((await fetch(`${base}/api/topic?key=%27%3B`)).status, 400);
    assert.equal((await get("/api/backtest")).ready, false);
    assert.ok((await get("/api/sources")).sources.length >= 19);
    assert.ok((await get("/api/config")).weights.momentum);
    // authors
    assert.equal((await post("/api/author", { name: "" })).status, 500);
    const a = await (await post("/api/author", { name: "Asha Rao", sectors: "Energy", turnaroundHours: 24 })).json();
    assert.equal(a.author.id, "asha-rao");
    assert.equal((await get("/api/authors")).authors.length, 1);
    assert.equal((await post("/api/authors/import", { text: "" })).status, 400);
    assert.equal((await post("/api/author", { name: "X" }, "text/plain")).status, 415);
    // brief without an LLM is refused clearly; decisions on unknown briefs 404
    const b = await post("/api/brief", { oppKey: "bcg|Energy|b:energy" });
    assert.equal(b.status, 400);
    assert.match((await b.json()).error, /LLM|ranked/);
    assert.equal((await post("/api/brief/decide", { id: 999, status: "approved" })).status, 404);
    assert.equal((await post("/api/brief/decide", { id: 1, status: "bogus" })).status, 400);
    assert.equal((await fetch(`${base}/api/author?id=asha-rao`, { method: "DELETE" })).status, 200);
    // static assets are whitelisted
    assert.equal((await fetch(`${base}/ui/app.js`)).status, 200);
    assert.equal((await fetch(`${base}/ui/..%2Fserver.mjs`)).status, 404);
    assert.equal((await fetch(`${base}/ui/nope.js`)).status, 404);
  } finally { server.close(); server.closeAllConnections?.(); }
});

// ---------- journalists ----------
import { normalizeRecord, journalistFit, toAuthor, toks } from "../src/journalists.mjs";
import { Reader } from "../src/llm.mjs";

test("journalists: records are sanitised (bad email, script URLs and nameless rows dropped)", () => {
  const j = normalizeRecord({ id: 7, name: " Asha Rao ", email: "not-an-email", linkedin: "javascript:alert(1)", scribeProfile: "https://x/p/7", beat: "Energy & Power", articles: [{ title: "Crude", url: "javascript:x", publishDate: "2026-10-01" }, { url: "no title" }] });
  assert.equal(j.name, "Asha Rao");
  assert.equal(j.email, ""); assert.equal(j.linkedin, ""); assert.equal(j.profileUrl, "https://x/p/7");
  assert.equal(j.articles.length, 1); assert.equal(j.articles[0].url, "");
  assert.equal(normalizeRecord({ id: "1" }), null);
  assert.equal(normalizeRecord({ name: "No id" }), null);
});

test("journalists: fit uses beat, recent articles, place and outlet; place alone is not a topical link; contact is never in the brief author", () => {
  const opp = { sector: "Energy", label: { name: "Energy", parentName: "Energy" } };
  const ctx = { topicTokens: toks("crude oil petrol diesel fuel price opec"), geography: ["Delhi"], outlets: new Set(["business standard"]), now: Date.parse("2026-10-27") };
  const good = { id: "1", name: "A", publication: "Business Standard", beat: "Energy & Power", city: "NEW DELHI", state: "DELHI", email: "a@x.com", phone: "999",
    articles: [{ title: "Crude oil tops 100 as OPEC cuts", summary: "Fuel prices rise", publishDate: "2026-10-10" }] };
  const other = { id: "2", name: "B", publication: "Rediff", beat: "Sports", city: "NEW DELHI", state: "DELHI", articles: [] };
  const a = journalistFit(good, opp, ctx), b = journalistFit(other, opp, ctx);
  assert.ok(a.score > 60, `score ${a.score}`);
  assert.ok(a.parts.beat.score > 0 && a.parts.articles.score > 0 && a.parts.outlet.score === 100);
  assert.ok(b.parts.beat.score === 0 && b.parts.articles.score === 0, "place alone is not a topical link");
  assert.ok(a.evidence.length === 1 && a.contact.email === "a@x.com");
  const author = toAuthor(good);
  assert.ok(!JSON.stringify(author).includes("a@x.com") && !JSON.stringify(author).includes("999"));
  assert.ok(journalistFit({ ...good, articles: [{ ...good.articles[0], publishDate: "2024-01-01" }] }, opp, ctx).parts.articles.score < a.parts.articles.score, "old articles count for less");
});

test("journalists: stored, searchable and faceted in the database", () => {
  const db = new Store(":memory:");
  db.upsertJournalists([normalizeRecord({ id: "1", name: "Asha Rao", publication: "The Hindu", beat: "Energy & Power", email: "a@x.com", articles: [{ title: "Crude rally" }] }), normalizeRecord({ id: "2", name: "Bo Lin", publication: "Mint", beat: "Sports" })]);
  assert.equal(db.journalistCount(), 2);
  assert.equal(db.searchJournalists({ q: "crude" }).total, 1);
  assert.equal(db.searchJournalists({ beat: "Sports" }).rows[0].name, "Bo Lin");
  assert.equal(db.journalistFacets().coverage.email, 1);
  assert.equal(db.getJournalist("1").articles[0].title, "Crude rally");
  db.upsertJournalists([normalizeRecord({ id: "1", name: "Asha R", publication: "The Hindu" })]); // re-sync updates, never duplicates
  assert.equal(db.journalistCount(), 2);
  db.close();
});

// ---------- LLM fallback ----------
test("llm: when Claude fails hard the local model takes over, and Claude is skipped for a while", async () => {
  const realFetch = globalThis.fetch, calls = [];
  const saved = { k: process.env.ANTHROPIC_API_KEY, m: process.env.HIVEMIND_LLM };
  process.env.ANTHROPIC_API_KEY = "sk-test-key"; process.env.HIVEMIND_LLM = "auto";
  globalThis.fetch = async (url, init) => {
    const u = String(url); calls.push(u.includes("anthropic") ? "claude" : "ollama");
    if (u.includes("anthropic")) return new Response(JSON.stringify({ error: { message: "Your credit balance is too low" } }), { status: 400 });
    if (u.endsWith("/api/tags")) return new Response(JSON.stringify({ models: [{ name: "qwen2.5:7b-instruct" }] }));
    return new Response(JSON.stringify({ message: { content: JSON.stringify({ matches: [{ bracket_id: "economy", sectors: [] }] }) } }));
  };
  try {
    const events = [];
    const r = new Reader(bcg, new BracketRegistry(null, seed), null, { settings: () => ({ fallback: true }), onEvent: (n, e) => events.push([n, e.ok]) });
    assert.match(await r.detect(), /anthropic.*→.*ollama/);
    const company = { name: "C", sectors: [{ name: "Banks", description: "" }] };
    const batch = [{ id: "economy", name: "Economy", description: "", keywords: [] }];
    const res = await r.match(company, batch, null);
    assert.equal(res.has("economy"), true);
    assert.equal(r.provider, "ollama");
    assert.equal(r.fallbackActive, true);
    assert.ok(events.some(([n, ok]) => n === "anthropic" && !ok), "the failure is recorded for the integrations panel");
    const before = calls.filter((c) => c === "claude").length;
    await r.match(company, batch, null);
    assert.equal(calls.filter((c) => c === "claude").length, before, "Claude is not retried while it is cooling down");
  } finally { globalThis.fetch = realFetch; for (const [k, v] of [["ANTHROPIC_API_KEY", saved.k], ["HIVEMIND_LLM", saved.m]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
});

// ---------- host guard ----------
test("server: requests carrying a foreign Host or Origin are refused (DNS-rebinding guard)", async () => {
  process.env.HIVEMIND_LLM = "off";
  const http = await import("node:http");
  const root = mkdtempSync(join(tmpdir(), "hg-"));
  mkdirSync(join(root, "src")); copyFileSync(new URL("../src/dashboard.html", import.meta.url), join(root, "src", "dashboard.html"));
  cpSync(new URL("../config", import.meta.url), join(root, "config"), { recursive: true });
  const { serve } = await import("../src/server.mjs");
  const server = await serve({ root, bcg, port: 0, autoSync: false, auth: false, log: () => {} });
  const port = server.address().port;
  const req = (headers, method = "GET", path = "/api/status") => new Promise((res) => { const q = http.request({ host: "127.0.0.1", port, path, method, headers }, (r) => { r.resume(); res(r.statusCode); }); q.end(method === "POST" ? "{}" : undefined); });
  try {
    assert.equal(await req({}), 200);
    assert.equal(await req({ host: "evil.example.com" }), 403);
    assert.equal(await req({ host: `localhost:${port}` }), 200);
    assert.equal(await req({ origin: "https://evil.example.com", "content-type": "application/json" }, "POST", "/api/journalists/sync"), 403);
  } finally { server.close(); server.closeAllConnections?.(); }
});
