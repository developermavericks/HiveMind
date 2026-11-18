// Tests for the fixes on top of 53ab81b: event angles per event kind, practice area from the existing sector match / whole words,
// no angle for non-business events, old sample files never mixed into a database that already has stories.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Analytics } from "../src/analytics.mjs";
import { Store } from "../src/db.mjs";

const HOUR = 3600e3, now = 1793346000000;
const item = (id, title, eventType, extra = {}) => ({
  id, at: now - 2 * HOUR, title, url: `https://x.test/${id}`, summary: title, geography: ["Delhi", "India"], eventType,
  entities: [], outlets: ["Mint"], origins: new Set(["mint"]), outletCount: 1, originCount: 1, maxSev: 0.5, verified: false, pathways: [],
  labels: new Map([["t:x", { w: 1 }]]), ...extra,
});

function topicFor(items, { judged = null, name = "Topic" } = {}) {
  const ctx = {
    asOf: now, items, byLabel: new Map([["t:x", items]]),
    analysis: { labels: new Map([["t:x", { key: "t:x", id: "x", level: "topic", parent: null, stage: "rising" }]]), seasonality: null },
    ctx: { cfg: { intervals: { hourView: 24, dayView: 14, rollingHours: 6, rollingDays: 3, observedLagHours: 12 }, forecast: { minHourPoints: 24 } } },
  };
  const a = new Analytics({
    store: { getSignal: () => [], lastWebCheck: () => null, topicMatches: () => new Map(judged ? [["x", judged]] : []) },
    registry: { get: () => null }, sources: null, cfg: { intervals: ctx.ctx.cfg.intervals, action: {} },
    companies: { get: () => ({ id: "bcg", matches: {} }), list: () => [] },
  });
  a.context = () => ctx; a.labelName = () => name; a.labelRow = () => ({}); a.labelSentiment = () => null; a.opportunities = () => ({ items: [] });
  return a.topic({ key: "t:x" });
}

test("fixes: sport events get no op-ed angle", () => {
  const r = topicFor([item("c1", "Shubman Gill on India's XI for 1st Test vs NZ", "cricket match")], { name: "cricket series" });
  assert.ok(r.eventClusters.length >= 1);
  assert.deepEqual(r.eventClusters[0].mdpAngles, []);
});

test("fixes: a topic the AI judged irrelevant to every sector gets no angle", () => {
  const r = topicFor([item("p1", "Ministry announces new port policy", "policy decision")], { judged: { sectors: [] } });
  assert.deepEqual(r.eventClusters[0].mdpAngles, []);
});

test("fixes: practice area and thesis come from the existing sector match", () => {
  const judged = { sectors: [{ sector: "Financial Institutions", relevance: 0.8, why: "Digital-arrest scams hit bank customers.", write_about: "How banks should stop mule accounts" }] };
  const r = topicFor([item("f1", "Delhi woman loses Rs 71 lakh to digital arrest; three held", "cyber fraud")], { judged });
  const a = r.eventClusters[0].mdpAngles[0];
  assert.equal(a.practice, "Financial Institutions");
  assert.equal(a.eventKind, "crisis");
  assert.match(a.thesis, /Digital-arrest scams hit bank customers/);
  assert.equal(a.pitch, "How banks should stop mule accounts");
});

test("fixes: keyword fallback matches whole words only ('said' is not AI, 'report' is not a port)", () => {
  const r = topicFor([item("k1", "Company said report shows strong quarter", "corporate results")]);
  const a = r.eventClusters[0].mdpAngles[0];
  assert.notEqual(a.practice, "Technology, Media, Telecommunications");
  assert.notEqual(a.practice, "Travel, Cities and Infrastructure");
  assert.equal(a.eventKind, "deal");
});

test("fixes: different kinds of events get different questions", () => {
  const crisis = topicFor([item("a", "Fire at Mumbai warehouse halts deliveries", "fire accident")]).eventClusters[0].mdpAngles[0];
  const policy = topicFor([item("b", "Government notifies new data protection rules", "regulation")]).eventClusters[0].mdpAngles[0];
  assert.equal(crisis.eventKind, "crisis");
  assert.equal(policy.eventKind, "policy");
  assert.notDeepEqual(crisis.boardroomQuestions, policy.boardroomQuestions);
  assert.ok(!policy.title.includes("Crisis"));
});

test("fixes: old sample files are not imported into a database that already has stories", () => {
  const dir = mkdtempSync(join(tmpdir(), "legacy-"));
  writeFileSync(join(dir, "stories-v3.json"), JSON.stringify({ stories: [{ title: "Old sample", url: "https://old.test/1", snippet: "", publishedAt: now, articles: [] }] }));
  writeFileSync(join(dir, "readings-v3.json"), JSON.stringify({}));
  const s = new Store(join(dir, "hivemind.db"));
  s.db.prepare("INSERT INTO stories (key, title, url, snippet, published_at, day, first_seen, last_seen) VALUES ('k', 'Live story', 'https://x.test/k', '', 1, '2026-11-18', 1, 1)").run();
  assert.equal(s.importLegacy(dir), null);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM stories").get().n, 1);
  s.close();
  // an empty database still takes them (first run on a new machine)
  const dir2 = mkdtempSync(join(tmpdir(), "legacy-"));
  writeFileSync(join(dir2, "stories-v3.json"), JSON.stringify({ stories: [{ title: "Old sample", url: "https://old.test/1", snippet: "", publishedAt: now, articles: [] }] }));
  const s2 = new Store(join(dir2, "hivemind.db"));
  assert.equal(s2.importLegacy(dir2).stories, 1);
  s2.close();
});
