// Keeping the trend honest: greetings, horoscopes and festival lifestyle items are not news (free rules), and each topic's headlines are
// checked against the topic's angle, not just its name. Every model call here is a fake.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Store } from "../src/db.mjs";
import { junkMatcher } from "../src/quality.mjs";
import { Reader, angleFitSystem, topicFitSystem } from "../src/llm.mjs";
import { Analytics } from "../src/analytics.mjs";

const cfg = JSON.parse(readFileSync(new URL("../config/hivemind.json", import.meta.url), "utf8"));
const NOW = Date.UTC(2026, 9, 29, 12), HOUR = 3600e3;

test("rules: greetings, horoscopes, mehendi and ritual explainers are junk; real festival and market news is not", () => {
  const junk = junkMatcher(cfg);
  for (const t of [
    "Happy Karwa Chauth 2026: Wishes, Messages, Quotes, Images, Facebook & Whatsapp status",
    "Happy Karwa Chauth 2026: 50+ best wishes, quotes and images to share with your women tribe",
    "5 trending Mehendi designs for Karwa Chauth 2026",
    "Priyanka Chopra flaunts her Karwa Chauth special mehendi, calls it 'Piya ke naam ki'",
    "Karwa Chauth 2026 date and time: When will the Moon rise on October 29? Check puja muhurat, fasting...",
    "Karwa Chauth 2026", "'Karwa Chauth Food Rules' -", "Karva Chauth significance",
    "Why Is the Moon Worshipped on Karwa Chauth? The Hidden Spiritual Meaning Behind the Ritual",
    "Valmiki Jayanti 2026: History, Significance And The Story Behind Ramayana",
    "Aries Horoscope Today, October 27, 2026: Financial satisfaction may come", "Aquarius monthly horoscope November 2026 - The Economic Times",
    "Daily rashi Tarot predictions, October 28, 2026; Today's tarot pull for every zodiac sign",
  ]) assert.ok(junk(t), "should be junk: " + t);
  for (const t of [
    "New Ramwadi bridge to be ready ahead of Kumbh Mela, says Nashik civic official",
    "Over 30 lakh devotees expected in Hassan as Hasanamba Jatra begins",
    "Nashik-Trimbakeshwar Simhastha Kumbh Mela 2027: Guide to ₹22,425-cr event, Amrit Snan key dates",
    "Video | Karwa Chauth Fervour Sweeps North India, Markets See Festive Rush",
    "Stock market holidays in November: Will BSE, NSE remain closed for Diwali, Dhanteras? Check Muhurat...",
    "Top Diwali 2026 Muhurat stocks to buy: Axis Securities lists 9 shares for Samvat 2083",
    "Police arrest two men over temple theft", "Stampede at religious gathering kills 6",
  ]) assert.ok(!junk(t), "should stay news: " + t);
});

const mk = () => new Reader({ impact_areas: ["economy"], fronts: {}, practice_areas: [] }, { list: () => [] }, null, { integrations: { enabled: (n) => n !== "anthropic", recordEvent() {} }, routingNoClaude: {} });
const groqOk = (obj) => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { tool_calls: [{ function: { arguments: JSON.stringify(obj) } }] } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), text: async () => "", headers: new Headers() });

test("model: with an angle the stricter prompt and the angle text are sent; without one the old prompt is unchanged", async () => {
  const bodies = [], real = globalThis.fetch, saved = { g: process.env.GROQ_API_KEY, o: process.env.OPENAI_API_KEY, a: process.env.ANTHROPIC_API_KEY };
  process.env.GROQ_API_KEY = "g"; delete process.env.OPENAI_API_KEY; delete process.env.ANTHROPIC_API_KEY;
  try {
    const r = mk(); await r.detect();
    globalThis.fetch = async (url, init) => { bodies.push(JSON.parse(init.body)); return groqOk({ items: [{ n: 1, fits: false, why: "greeting" }, { n: 2, fits: true }] }); };
    const hl = [{ key: "a", title: "Happy Karwa Chauth wishes" }, { key: "b", title: "Kumbh Mela bridge to be ready" }];
    const withAngle = await r.verifyTopicFit("religious festivals", [], hl, "How should cities plan crowd infrastructure for mega pilgrimages?");
    assert.deepEqual(withAngle.map((x) => [x.key, x.fits]), [["a", false], ["b", true]]);
    await r.verifyTopicFit("religious festivals", [], hl);
    const sys = (b) => b.messages.find((m) => m.role === "system").content, usr = (b) => b.messages.find((m) => m.role === "user").content;
    assert.equal(sys(bodies[0]), angleFitSystem); assert.match(usr(bodies[0]), /Angle: How should cities plan crowd infrastructure/);
    assert.equal(sys(bodies[1]), topicFitSystem); assert.doesNotMatch(usr(bodies[1]), /Angle:/);
  } finally {
    globalThis.fetch = real;
    for (const [k, v] of [["GROQ_API_KEY", saved.g], ["OPENAI_API_KEY", saved.o], ["ANTHROPIC_API_KEY", saved.a]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test("db: an angle check drops the story from the topic like a topic check, is counted once, and is kept apart from the topic check", () => {
  const s = new Store(":memory:");
  const ins = s.db.prepare("INSERT INTO stories (key, title, url, snippet, published_at, day, first_seen, last_seen) VALUES (?, ?, ?, '', ?, '2026-10-29', ?, ?)");
  for (const k of ["s1", "s2", "s3"]) ins.run(k, "t " + k, "u", NOW, NOW, NOW);
  s.putTopicChecks([{ key: "s1", topic: "festivals", fits: false }, { key: "s1", topic: "festivals@x1", fits: false }, { key: "s2", topic: "festivals@x1", fits: false }, { key: "s3", topic: "festivals@x1", fits: true }]);
  assert.deepEqual([...s.topicDrops()].sort(), ["s1|festivals", "s2|festivals"], "both kinds of check remove the story from the topic");
  assert.equal(s.topicDropCount("festivals", NOW - HOUR), 2, "s1 failed both checks and counts once");
  assert.ok(s.checkedTopicPairs().has("s3|festivals@x1") && !s.checkedTopicPairs().has("s3|festivals"), "the angle check does not mark the topic check done");
  s.close();
});

test("candidates: best angle per topic, only unchecked recent headlines, the limits hold, a rewritten angle is checked again", () => {
  const items = Array.from({ length: 5 }, (_, i) => ({ id: "s" + i, title: "headline " + i, at: NOW - i * HOUR }));
  const opp = (name, key, angle) => ({ label: { key, level: key.startsWith("t:") ? "topic" : "bracket", name }, angle });
  let angle = "Angle one";
  const store = { checked: new Set(["s0|fest@" + (() => { let h = 0; for (const ch of "Angle one") h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h.toString(36); })()]), checkedTopicPairs() { return this.checked; } };
  const fake = { context: () => ({ asOf: NOW, byLabel: new Map([["t:fest", items], ["t:other", items.slice(0, 2)], ["b:area", items]]), ctx: { topics: new Map() } }), cfg: { angleFit: { maxPerTopic: 3, maxTopics: 2 } }, store,
    companies: { list: () => [{ id: "bcg" }] }, opportunities: () => ({ items: [opp("fest", "t:fest", angle), opp("fest again", "t:fest", "Weaker"), opp("area", "b:area", "A"), opp("other", "t:other", "Angle two")] }), labelName: (c, k) => k.slice(2) };
  const got = Analytics.prototype.angleFitCandidates.call(fake);
  assert.deepEqual(got.map((t) => t.id), ["fest", "other"], "topics only (never a broad area), once each");
  assert.deepEqual(got[0].items.map((i) => i.key), ["s1", "s2", "s3"], "s0 was already checked against this angle; at most 3 per topic");
  assert.ok(got[0].checkId.startsWith("fest@") && got[0].angle === "Angle one");
  angle = "A rewritten angle";
  assert.deepEqual(Analytics.prototype.angleFitCandidates.call(fake)[0].items.map((i) => i.key), ["s0", "s1", "s2"], "a new angle starts afresh");
  assert.deepEqual(Analytics.prototype.angleFitCandidates.call({ ...fake, cfg: { angleFit: { enabled: false } } }), []);
});

test("config: the angle check is on, bounded, and the lifestyle rules are in the junk list", () => {
  assert.equal(cfg.angleFit.enabled, true);
  assert.ok(cfg.angleFit.maxTopics * cfg.angleFit.maxPerTopic <= 2000, "at most 2,000 headlines in one pass");
  assert.ok(cfg.junk.titlePatterns.length >= 30);
});
