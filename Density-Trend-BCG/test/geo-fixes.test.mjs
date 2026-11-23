// Live-audit fixes: place filter matches its count, spelling variants are one place, all places are shown, outlets come from coverage.
import test from "node:test";
import assert from "node:assert/strict";
import { Analytics } from "../src/analytics.mjs";

const HOUR = 3600e3, now = 1793346000000;
const item = (id, at, geography, outlets, eventType = "research finding") => ({
  id, at, title: `Story ${id} about lab research`, url: `https://x.test/${id}`, summary: `Story ${id}`, geography, eventType,
  entities: [], outlets, origins: new Set(outlets), outletCount: outlets.length, originCount: outlets.length, maxSev: 0.4, verified: false, pathways: [],
  labels: new Map([["t:science", { w: 1 }]]),
});

function topicOf(items) {
  const ctx = {
    asOf: now, items, byLabel: new Map([["t:science", items]]),
    analysis: { labels: new Map([["t:science", { key: "t:science", id: "science", level: "topic", parent: null, stage: "rising" }]]), seasonality: null },
    ctx: { cfg: { intervals: { hourView: 24, dayView: 14, rollingHours: 6, rollingDays: 3, observedLagHours: 12 }, forecast: { minHourPoints: 24 } } },
  };
  const a = new Analytics({
    store: { getSignal: () => [], lastWebCheck: () => null, topicMatches: () => new Map() },
    registry: { get: () => null }, sources: null, cfg: { intervals: ctx.ctx.cfg.intervals, action: {} },
    companies: { get: () => ({ id: "bcg", matches: {} }), list: () => [] },
  });
  a.context = () => ctx; a.labelName = () => "Science research"; a.labelRow = () => ({ name: "Science research" }); a.labelSentiment = () => null;
  a.opportunities = () => ({ items: [] });
  return (args) => a.topic({ key: "t:science", ...args });
}

test("geo fixes: filter shows the stories its count promises, spellings merge, all places shown", () => {
  const topic = topicOf([
    item("recent", now - 2 * HOUR, ["Geneva", "Global"], ["Reuters"]),           // recent, not India
    item("old1", now - 200 * HOUR, ["Bengaluru", "Karnataka", "India"], ["Mint"]), // older than 72 h
    item("old2", now - 300 * HOUR, ["global."], ["Mint"]),                          // same place, other spelling
    item("old3", now - 400 * HOUR, ["Pune", "Maharashtra", "Western India", "India"], ["The Hindu"]),
  ]);
  const t = topic({});
  const india = t.geoBreakdown.find((g) => g.name === "India");
  assert.equal(india.count, 2);
  // clicking India shows those 2 stories, even though both are older than 72 hours (before: 0 stories)
  const f = topic({ geo: "India" });
  assert.equal(f.stories.length, 2);
  assert.deepEqual(f.stories.map((s) => s.id).sort(), ["old1", "old3"]);
  // "Global" and "global." are one place with both stories
  const globals = t.geoBreakdown.filter((g) => g.name.toLowerCase() === "global");
  assert.equal(globals.length, 1);
  assert.equal(globals[0].name, "Global");
  assert.equal(globals[0].count, 2);
  assert.equal(topic({ geo: "GLOBAL" }).stories.length, 2);
  // a story shows all its places, not only the first 3
  assert.deepEqual(f.stories.find((s) => s.id === "old3").geography, ["Pune", "Maharashtra", "Western India", "India"]);
});

test("geo fixes: target outlets are the publications that covered the event", () => {
  const topic = topicOf([
    item("e1", now - 3 * HOUR, ["Delhi", "India"], ["Mint", "Business Standard"], "policy announcement"),
    item("e2", now - 2 * HOUR, ["Delhi", "India"], ["Mint", "The Hindu"], "policy announcement"),
  ]);
  const ev = topic({}).eventClusters[0];
  assert.ok(ev.mdpAngles.length);
  assert.ok(ev.mdpAngles[0].targetOutlets.startsWith("Mint"), ev.mdpAngles[0].targetOutlets);
  assert.ok(!/Henderson/.test(ev.mdpAngles[0].targetOutlets), "no fixed outlet list");
});
