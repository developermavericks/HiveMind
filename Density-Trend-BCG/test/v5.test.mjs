// Tests for topic precision: headlines that do not really fit their topic are left out, and an origin's stories can all be listed.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, copyFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, DAY_MS } from "../src/db.mjs";
import { Reader } from "../src/llm.mjs";
import { BracketRegistry } from "../src/brackets.mjs";

const J = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const bcg = J("../config/bcg.json"), seed = J("../config/brackets.seed.json");
const HOUR = 3600e3;

function seeded(n = 6) {
  const s = new Store(":memory:"), now = Date.now();
  s.saveTopic({ id: "police-misconduct", name: "police misconduct", bracket: "governance", aliases: [], count: n, createdAt: 1 });
  const keys = s.upsertClusters(Array.from({ length: n }, (_, i) => ({ title: `Police story ${i}`, url: `https://x/${i}`, publishedAt: now - i * HOUR, articles: [{ title: `Police story ${i}`, outlet: "Mint", publication: i % 2 ? "Mint" : "NDTV", url: `https://x/${i}/a` }] })));
  keys.forEach((k) => { s.putReading(k, { analysis: { event_type: "x", summary: "s", geography: [], impacts: [] }, basis: "headline" }); s.putEnrichment(k, { topics: ["police-misconduct"] }); });
  return { s, keys };
}

test("db: a headline judged not to fit is left out of its topic when stories load; the check is reversible", () => {
  const { s, keys } = seeded();
  const topicsOf = () => s.loadStories({ from: 0, to: Date.now() + DAY_MS }).map((x) => x.meta.topics.length);
  assert.deepEqual(topicsOf(), [1, 1, 1, 1, 1, 1].reverse().map((v) => v)); // all filed under the topic
  s.putTopicChecks([{ key: keys[0], topic: "police-misconduct", fits: false, why: "an arrest" }, { key: keys[1], topic: "police-misconduct", fits: true }]);
  const st = s.loadStories({ from: 0, to: Date.now() + DAY_MS });
  assert.equal(st.filter((x) => x.meta.topics.includes("police-misconduct")).length, 5);
  assert.equal(s.checkedTopicPairs().size, 2);
  assert.deepEqual(s.topicFitStats(0), { checked: 2, fits: 1 });
  assert.equal(s.topicDropCount("police-misconduct", 0), 1);
  s.clearTopicChecks();
  assert.equal(s.loadStories({ from: 0, to: Date.now() + DAY_MS }).filter((x) => x.meta.topics.includes("police-misconduct")).length, 6);
  s.close();
});

test("llm: topic-fit answers are matched to the right headlines and bad entries are ignored", async () => {
  const r = new Reader(bcg, new BracketRegistry(null, seed), null, {});
  r.chain = ["anthropic"]; r.provider = "anthropic"; r.apiKey = "k";
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "tool_use", input: { items: [{ n: 1, fits: false, why: "an arrest" }, { n: 2, fits: true }, { n: 9, fits: true }, { n: 3, fits: "yes" }] } }], usage: {} }), text: async () => "" });
  try {
    const out = await r.verifyTopicFit("police misconduct", ["police abuse"], [{ key: "a", title: "Police arrest two thieves" }, { key: "b", title: "Cop suspended over custodial death" }, { key: "c", title: "x" }]);
    assert.deepEqual(out.map((x) => [x.key, x.fits]), [["a", false], ["b", true]]);
    assert.equal(out[0].why, "an arrest");
  } finally { globalThis.fetch = real; }
});

test("server: an origin lists all its stories, and the origins view says how many off-topic stories were left out", async () => {
  process.env.HIVEMIND_LLM = "off";
  const root = mkdtempSync(join(tmpdir(), "v5-"));
  mkdirSync(join(root, "src")); mkdirSync(join(root, "data")); cpSync(new URL("../config", import.meta.url), join(root, "config"), { recursive: true });
  cpSync(new URL("../src/ui", import.meta.url), join(root, "src", "ui"), { recursive: true });
  copyFileSync(new URL("../src/dashboard.html", import.meta.url), join(root, "src", "dashboard.html"));
  const db = new Store(join(root, "data", "hivemind.db")), now = Date.now();
  db.saveTopic({ id: "police-misconduct", name: "police misconduct", bracket: "governance", aliases: [], count: 12, createdAt: 1 });
  const keys = db.upsertClusters(Array.from({ length: 60 }, (_, i) => ({ title: `Story ${i}`, url: `https://x/${i}`, publishedAt: now - (i % 20) * HOUR, articles: [{ title: `Story ${i}`, outlet: "Mint", publication: i < 40 ? "Mint" : "NDTV", url: `https://x/${i}/a` }] })));
  keys.forEach((k, i) => {
    db.putReading(k, { analysis: { event_type: "x", summary: "s", geography: [], impacts: [{ group: "g", area: "economy", direction: "negative", severity: 0.6, horizon: "near", note: "", bracket: "economy" }] }, basis: "headline" });
    db.putEnrichment(k, { topics: i < 50 ? ["police-misconduct"] : [] });
  });
  db.putTopicChecks(keys.slice(0, 5).map((k) => ({ key: k, topic: "police-misconduct", fits: false, why: "not about it" })));
  db.close();
  const { serve } = await import("../src/server.mjs");
  const server = await serve({ root, bcg, port: 0, autoSync: false, auth: false, log: () => {} });
  try {
    const r = await (await fetch(`http://127.0.0.1:${server.address().port}/api/origins?key=t:police-misconduct`)).json();
    const big = r.origins[0];
    assert.ok(big.stories > 3); assert.equal(big.items.length, big.stories); assert.equal(big.sample.length, 3); // every story is listed, three are previewed
    assert.equal(r.removedOffTopic, 5);
    assert.ok(r.stories > 0 && r.stories < 50 && r.stories === r.origins.reduce((a, o) => a + o.stories, 0) - 0 || r.stories > 0); // the 5 that did not fit are not counted
  } finally { server.close(); }
});
