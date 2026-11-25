// AI-written op-ed angles for new events: answers are checked, saved angles replace the template, earlier events are left alone.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Analytics } from "../src/analytics.mjs";
import { Store } from "../src/db.mjs";
import { normalizeEventAngles, eventAngleUser } from "../src/llm.mjs";

const HOUR = 3600e3, now = 1793346000000;
const item = (id, title, eventType, at, place = "Mumbai", entity = "Air India") => ({
  id, at, title, url: `https://x.test/${id}`, summary: title, geography: [place, "India"], eventType,
  entities: [entity], outlets: ["Mint"], origins: new Set(["mint"]), outletCount: 1, originCount: 1, maxSev: 0.6, verified: false, pathways: [],
  labels: new Map([["t:aviation", { w: 1 }]]),
});

function analyticsWith(items, store) {
  const ctx = {
    asOf: now, items, byLabel: new Map([["t:aviation", items]]),
    analysis: { labels: new Map([["t:aviation", { key: "t:aviation", id: "aviation", level: "topic", parent: null, stage: "rising" }]]), seasonality: null },
    ctx: { cfg: { intervals: { hourView: 24, dayView: 14, rollingHours: 6, rollingDays: 3, observedLagHours: 12 }, forecast: { minHourPoints: 24 } } },
  };
  const a = new Analytics({
    store: { getSignal: () => [], lastWebCheck: () => null, topicMatches: () => new Map(), eventAnglesFor: (k) => store.eventAnglesFor(k) },
    registry: { get: () => null }, sources: null, cfg: { intervals: ctx.ctx.cfg.intervals, action: {} },
    companies: { get: () => ({ id: "bcg", matches: {} }), list: () => [] },
  });
  a.context = () => ctx; a.labelName = () => "Aviation"; a.labelRow = () => ({ name: "Aviation" }); a.labelSentiment = () => null;
  a.opportunities = () => ({ items: [{ label: { key: "t:aviation" } }] });
  return a;
}

test("event angles: only complete AI answers are kept", () => {
  const batch = [{}, {}];
  const raw = { items: [
    { n: 1, title: " Runway safety is a board issue ", thesis: "Two sentences.", questions: ["a", "b", "c", "d", "e", "f"], pitch: "Now.", audience: "CEOs" },
    { n: 2, title: "No questions", thesis: "x", questions: ["only one"] },
    { n: 9, title: "out of range", thesis: "x", questions: ["a", "b", "c"] },
  ] };
  const out = normalizeEventAngles(raw, batch);
  assert.equal(out.length, 1);
  assert.equal(out[0].title, "Runway safety is a board issue");
  assert.equal(out[0].questions.length, 5);
  assert.match(eventAngleUser([{ topic: "Aviation", practice: "Travel", kind: "crisis", location: "Mumbai", stories: [{ title: "Flight skids", summary: "A flight skidded." }] }]), /Topic: Aviation .*Event type: crisis/);
});

test("event angles: a saved AI angle replaces the template; new events without one are candidates, earlier events are not", () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), "angles-")), "hivemind.db"));
  const items = [
    item("old1", "Air India flight skids off runway in Mumbai", "aviation accident", now - 60 * HOUR),
    item("new1", "Delhi airport radar glitch delays 40 flights", "technical outage", now - 5 * HOUR, "Delhi", "AAI"),
    item("new2", "Delhi radar outage: AAI orders probe into glitch", "outage investigation", now - 4 * HOUR, "Delhi", "AAI"),
  ];
  const a = analyticsWith(items, store);
  const since = now - 24 * HOUR; // the feature was switched on 24 h ago

  // before any angle is written: templates everywhere, and only the new event is a candidate
  let t = a.topic({ key: "t:aviation" });
  assert.ok(t.eventClusters.every((e) => !e.mdpAngles[0]?.aiWritten));
  let cands = a.eventAngleCandidates({ since, limit: 50 });
  assert.deepEqual(cands.map((c) => c.anchorKey), ["new1"]);
  assert.equal(cands[0].kind, "crisis");
  assert.ok(cands[0].stories.length >= 1);

  // the job saves the AI answer under the event's first story; the topic page now shows it
  store.putEventAngle({ storyKey: "new1", topic: "t:aviation", kind: "crisis", title: "When radar fails, who owns the delay?", thesis: "T.", questions: ["q1", "q2", "q3", "q4", "q5"], pitch: "P.", audience: "Airline CEOs", model: "groq:test" });
  a.cache.clear(); // the server's job clears the cache after saving angles
  t = a.topic({ key: "t:aviation" });
  const delhi = t.eventClusters.find((e) => e.anchorKey === "new1");
  assert.equal(delhi.mdpAngles[0].aiWritten, true);
  assert.equal(delhi.mdpAngles[0].title, "When radar fails, who owns the delay?");
  assert.equal(delhi.mdpAngles[0].basedOn, "AI, written for this event");
  const mumbai = t.eventClusters.find((e) => e.anchorKey === "old1");
  assert.ok(!mumbai.mdpAngles[0].aiWritten, "earlier event keeps the template");

  // nothing left to write
  assert.equal(a.eventAngleCandidates({ since, limit: 50 }).length, 0);
  assert.equal(store.eventAnglesSince(now - HOUR * 1000), 1);
  store.close();
});
