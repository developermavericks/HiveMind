import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Store } from "../src/db.mjs";
import { DEFAULT_OUTLETS } from "../src/pitch.mjs";

test("publications.json contains Forbes India, Fortune India, and Business Today with print & online", () => {
  const pubPath = path.resolve("config/publications.json");
  const pubs = JSON.parse(fs.readFileSync(pubPath, "utf8"));
  
  const forbes = pubs.find(p => p.name.toLowerCase().includes("forbes india"));
  const fortune = pubs.find(p => p.name.toLowerCase().includes("fortune india"));
  const bt = pubs.find(p => p.name.toLowerCase().includes("business today"));

  assert.ok(forbes, "Forbes India must exist");
  assert.equal(forbes.print, true, "Forbes India must have print enabled");
  assert.equal(forbes.online, true, "Forbes India must have online enabled");

  assert.ok(fortune, "Fortune India must exist");
  assert.equal(fortune.print, true, "Fortune India must have print enabled");
  assert.equal(fortune.online, true, "Fortune India must have online enabled");

  assert.ok(bt, "Business Today must exist");
  assert.equal(bt.print, true, "Business Today must have print enabled");
  assert.equal(bt.online, true, "Business Today must have online enabled");
});

test("DEFAULT_OUTLETS contains all three new publications", () => {
  assert.ok(DEFAULT_OUTLETS.includes("Forbes India"));
  assert.ok(DEFAULT_OUTLETS.includes("Fortune India"));
  assert.ok(DEFAULT_OUTLETS.includes("Business Today"));
});

test("Store: custom topic mappings CRUD", () => {
  const dbFile = path.resolve(`data/test_features_${Date.now()}.db`);
  const store = new Store(dbFile);
  try {
    const created = store.putCustomTopicMapping({
      topicName: "Semiconductor Fab Infrastructure",
      bracketId: "tmt",
      keywords: ["semiconductor", "fab", "dholera"]
    });
    assert.ok(created.id);
    assert.equal(created.topicName, "Semiconductor Fab Infrastructure");
    assert.equal(created.bracketId, "tmt");

    const list = store.listCustomTopicMappings();
    assert.ok(list.some(m => m.id === created.id));

    store.deleteCustomTopicMapping(created.id);
    const listAfter = store.listCustomTopicMappings();
    assert.ok(!listAfter.some(m => m.id === created.id));
  } finally {
    try { fs.unlinkSync(dbFile); } catch {}
  }
});

test("Store: client priorities get & set", () => {
  const dbFile = path.resolve(`data/test_features_${Date.now()}.db`);
  const store = new Store(dbFile);
  try {
    store.setClientPriorities("bcg", {
      sectors: ["Healthcare", "Energy"],
      topics: ["Semiconductor Fab", "Renewable Power"],
      boostFactor: 1.3
    });

    const res = store.getClientPriorities("bcg");
    assert.equal(res.boostFactor, 1.3);
    assert.deepEqual(res.sectors, ["Healthcare", "Energy"]);
    assert.deepEqual(res.topics, ["Semiconductor Fab", "Renewable Power"]);
  } finally {
    try { fs.unlinkSync(dbFile); } catch {}
  }
});

test("Store: add manual authored op-ed", () => {
  const dbFile = path.resolve(`data/test_features_${Date.now()}.db`);
  const store = new Store(dbFile);
  try {
    const saved = store.addManualAuthoredArticle({
      headline: "The Rise of Indian Clean Energy Supergrids",
      author: "Praveen Sinha",
      source: "Fortune India (Print)",
      date: "2026-11-26",
      page: "18",
      kind: "opinion",
      body: "Comprehensive analysis on high voltage transmission lines and renewable power deployment."
    });

    assert.ok(saved.id);
    assert.equal(saved.headline, "The Rise of Indian Clean Energy Supergrids");
    assert.equal(saved.source, "Fortune India (Print)");
    assert.equal(saved.kind, "opinion");
  } finally {
    try { fs.unlinkSync(dbFile); } catch {}
  }
});

test("Store: searchJournalists supports topic parameter", () => {
  const store = new Store(path.resolve("data/hivemind.db"));
  const res = store.searchJournalists({ topic: "tech", limit: 5 });
  assert.ok(Array.isArray(res.rows));
  assert.ok(typeof res.total === "number");
});
