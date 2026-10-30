// Load speed: the slim opportunity list, saved views that are only used while current, and the cache signature. Every store here is in memory.
import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/db.mjs";
import { Analytics } from "../src/analytics.mjs";

const item = (key, over = {}) => ({ key, label: { key: "t:" + key, name: key }, sector: "Energy", score: 70, stories: [{ title: "s" }], components: { momentum: { points: 5 } }, trigger: { id: "x", title: "T", url: "u", verified: true, origins: ["a", "b"] }, authored: { print: 1, online: 2, count: 3, articles: [{ id: "p" }], onlineArticles: [{ url: "u" }], mode: "whitespace" }, otherSectors: [{ sector: "Health" }], moreSectors: [{ sector: "Health" }], ...over });

test("slim list: the heavy parts only an opened row needs are left out, the counts and what the row filters on stay", () => {
  const full = { items: [item("a"), item("b", { trigger: null })], counts: { total: 2 }, asOf: 1 };
  const calls = [];
  const fake = { opportunities: (a) => { calls.push(a); return full; } };
  const out = Analytics.prototype.opportunities.call(fake, { company: "bcg", limit: 1000, group: true, mode: "whitespace", slim: true });
  assert.equal(calls.length, 1, "built from the full (remembered) list, not recomputed");
  assert.equal(calls[0].slim, undefined);
  const [a, b] = out.items;
  assert.ok(a.slim && !("stories" in a) && !("components" in a) && !("otherSectors" in a), "heavy parts and the duplicate sector list are gone");
  assert.deepEqual(a.authored.articles, []); assert.deepEqual(a.authored.onlineArticles, []);
  assert.deepEqual([a.authored.print, a.authored.online, a.authored.count], [1, 2, 3], "the chip's counts remain");
  assert.deepEqual(a.trigger, { verified: true }); assert.equal(b.trigger, null);
  assert.equal(a.moreSectors.length, 1);
  assert.deepEqual(out.counts, { total: 2 }); assert.equal(out.asOf, 1);
  assert.ok(full.items[0].stories && full.items[0].components, "the full list is untouched (it is shared)");
  assert.ok(JSON.stringify(out).length < JSON.stringify(full).length, "smaller (about a third of the size on real data)");
});

test("detail: one opportunity in full, found in either grouping; an unknown key is an error", () => {
  const per = { true: { items: [item("a")] }, false: { items: [item("a"), item("b")] } };
  const fake = { opportunities: (a) => per[a.group] };
  assert.equal(Analytics.prototype.opportunity.call(fake, { key: "b", group: true }).key, "b", "not in the topic list, found in the pair list");
  assert.ok(Analytics.prototype.opportunity.call(fake, { key: "a", group: true }).stories, "full, with the stories");
  assert.equal(Analytics.prototype.opportunity.call(fake, { key: "zzz", group: false }).error, "Unknown opportunity");
});

test("saved views: used only for the signature they were saved with, replaced in place, and old ones are pruned", () => {
  const s = new Store(":memory:");
  assert.equal(s.getView("k", "s1"), null);
  s.putView("k", "s1", '{"a":1}');
  assert.equal(s.getView("k", "s1"), '{"a":1}');
  assert.equal(s.getView("k", "s2"), null, "the data changed: not served");
  s.putView("k", "s2", '{"a":2}');
  assert.equal(s.getView("k", "s1"), null); assert.equal(s.getView("k", "s2"), '{"a":2}');
  assert.equal(s.pruneViews(-1000), 1, "everything is older than a moment in the future");
  assert.equal(s.getView("k", "s2"), null);
  s.close();
});

test("signature: moves on when the cache is cleared (after an edit or a job) and is the same otherwise; null with no data", () => {
  const s = new Store(":memory:");
  const a = new Analytics({ store: s, registry: () => ({ size: 0 }), sources: null, cfg: { weights: {} }, companies: null, reader: null });
  assert.equal(a.signature(null), null, "no stories yet");
  s.db.prepare("INSERT INTO stories (key, title, url, snippet, published_at, day, first_seen, last_seen) VALUES ('s','t','u','',1,'2026-10-29',1,1)").run();
  const readingFor = s.span();
  void readingFor;
  const fakeSig = () => Analytics.prototype.signature.call({ store: { span: () => ({ last: 5, days: 1, lastSeen: 5 }), readingCount: () => 1, enrichmentCount: () => 1, sentimentCount: () => 1, mergedTopicCount: () => 0, jobRev: () => "0:0", getMeta: (k, d) => s.getMeta(k, d) }, registry: () => ({ size: 3 }), cfg: { weights: { m: 1 } } }, null);
  const before = fakeSig();
  assert.equal(fakeSig(), before, "unchanged data, same signature");
  let told = 0; a.cache.onClear = () => told++;
  a.cache.clear();
  assert.notEqual(fakeSig(), before, "clear() moves the revision on, so saved views from before are not served");
  assert.equal(told, 1, "and the worker is told");
  s.close();
});
