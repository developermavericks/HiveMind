// Tests for the cost round: a cached shared prompt, several headlines per call, the discounted batch service, and skipping work that is not needed.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Reader } from "../src/llm.mjs";
import { BracketRegistry } from "../src/brackets.mjs";
import { TopicRegistry } from "../src/topics.mjs";
import { Store } from "../src/db.mjs";
import { junkMatcher } from "../src/quality.mjs";

const J = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const cfg = J("../config/hivemind.json"), bcg = J("../config/bcg.json"), seed = J("../config/brackets.seed.json");

const mkReader = (usage = []) => {
  const topics = new TopicRegistry(null);
  for (const n of ["fuel prices", "air pollution", "bank earnings"]) { const id = topics.resolve(n); topics.touch(id); topics.touch(id); }
  const r = new Reader(bcg, new BracketRegistry(null, seed), topics, { onUsage: (n, u) => usage.push([n, u]) });
  r.chain = ["anthropic"]; r.provider = "anthropic"; r.apiKey = "test-key";
  return r;
};
const cluster = (title, snippet = "") => ({ title, url: "https://x/" + title.length, snippet, outlets: ["The Hindu"], articles: [{ title, outlet: "The Hindu", publication: "The Hindu", url: "https://x/" + title }] });
const withFetch = async (handler, fn) => { const real = globalThis.fetch; globalThis.fetch = handler; try { return await fn(); } finally { globalThis.fetch = real; } };
const msg = (input, usage = {}) => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "tool_use", name: "t", input }], usage: { input_tokens: 100, output_tokens: 50, ...usage } }), text: async () => "" });
const reading = (n, extra = {}) => ({ n, event_type: "policy", summary: `s${n}`, geography: ["India"], impacts: [{ group: "borrowers", area: "economy", direction: "negative", severity: 0.5, horizon: "near", bracket_id: "economy" }], topics: ["fuel prices"], entities: [], sentiment: "negative", ...extra });

test("cached context: brackets, common topics and examples are one stable block that changes only when the lists change", () => {
  const r = mkReader(), a = r.staticContext(), b = r.staticContext();
  assert.equal(a, b); // memoised: identical text on every call, so it can be cached
  assert.match(a.text, /Existing keyword brackets/); assert.match(a.text, /fuel prices/); assert.match(a.text, /EMPTY impacts list/);
  r.registry.resolve({ name: "Space", keywords: ["isro", "rocket", "satellite", "launch", "orbit", "mission"], description: "space" });
  assert.notEqual(r.staticContext().key, a.key);
});

test("a single read sends the shared context as a cached system block and only the story in the user message", async () => {
  const r = mkReader(), seen = [];
  const out = await withFetch(async (url, init) => { seen.push(JSON.parse(init.body)); return msg(reading(1)); }, () => r.readFull(cluster("Fuel prices cut by two rupees"), { text: "", basis: "headline" }));
  assert.ok(out.analysis.impacts.length === 1);
  const body = seen[0];
  assert.equal(body.system.length, 2); assert.equal(body.system[1].cache_control.type, "ephemeral"); assert.match(body.system[1].text, /Existing keyword brackets/);
  assert.doesNotMatch(body.messages[0].content, /Existing keyword brackets/); assert.match(body.messages[0].content, /Fuel prices cut/);
});

test("several headlines per call: results line up by number, a skipped story comes back null, and it is one request", async () => {
  const usage = [], r = mkReader(usage), seen = [];
  const cs = [cluster("Story one about fuel"), cluster("Story two about banks"), cluster("Story three about air")];
  const out = await withFetch(async (url, init) => { seen.push(JSON.parse(init.body)); return msg({ stories: [reading(1), reading(3, { summary: "third" })] }, { cache_read_input_tokens: 80 }); }, () => r.readBatch(cs));
  assert.equal(seen.length, 1); assert.equal(seen[0].tools[0].name, "record_impacts");
  assert.match(seen[0].messages[0].content, /Story 3/); assert.match(seen[0].system[0].text, /several numbered stories/);
  assert.ok(out[0] && out[2] && out[1] === null); assert.equal(out[2].analysis.summary, "third");
  assert.equal(usage[0][1].cacheRead, 80); // cache hits are counted
});

test("batch service: submit, wait, read results; failed items come back null; tokens counted as discounted", async () => {
  const usage = [], r = mkReader(usage), calls = [];
  const items = [{ id: "a", system: "sys", tool: { name: "t", input_schema: { type: "object", properties: {} } }, user: "u1", maxTokens: 10 }, { id: "b", system: "sys", tool: { name: "t", input_schema: { type: "object", properties: {} } }, user: "u2", maxTokens: 10 }];
  const out = await withFetch(async (url, init) => {
    calls.push([init?.method ?? "GET", String(url)]);
    if (String(url).endsWith("/batches")) return { ok: true, json: async () => ({ id: "bt1", processing_status: "in_progress" }) };
    if (String(url).endsWith("/batches/bt1")) return { ok: true, json: async () => ({ id: "bt1", processing_status: "ended", results_url: "https://api.anthropic.com/results/bt1", request_counts: {} }) };
    return { ok: true, text: async () => [JSON.stringify({ custom_id: "a", result: { type: "succeeded", message: { content: [{ type: "tool_use", input: { ok: 1 } }], usage: { input_tokens: 10, output_tokens: 5 } } } }), JSON.stringify({ custom_id: "b", result: { type: "errored" } })].join("\n") };
  }, () => r.batchMessages(items, { pollMs: 1 }));
  assert.deepEqual(out.get("a"), { ok: 1 }); assert.equal(out.get("b"), null);
  assert.deepEqual(calls.map((c) => c[0]), ["POST", "GET", "GET"]);
  assert.equal(usage.find((u) => u[1].batchTokens)[1].batchTokens, 15);
});

test("db: cache reads and discounted tokens are tracked per day", () => {
  const s = new Store(":memory:");
  s.addUsage("anthropic", { tokensIn: 1000, tokensOut: 100, cacheRead: 700 }); s.addUsage("anthropic", { calls: 0, tokensIn: 50, batchTokens: 50 });
  const u = s.usage("anthropic", "2000-01-01");
  assert.equal(u.cacheRead, 700); assert.equal(u.batchTokens, 50); assert.equal(u.calls, 1);
  s.close();
});

test("noise that can never matter (horoscopes, puzzles, fantasy tips) is skipped; real news is not", () => {
  const isJunk = junkMatcher(cfg);
  for (const t of ["Horoscope today: Aries, Taurus daily predictions", "Wordle 1,234 answer today", "Dream11 prediction for IND vs AUS", "Bigg Boss 19 eviction tonight"]) assert.ok(isJunk(t), t);
  for (const t of ["RBI holds repo rate, flags inflation risk", "Gold rate today rises on weak rupee", "Cabinet approves new semiconductor policy"]) assert.ok(!isJunk(t), t);
});

// ---------- the low-cost provider ----------
test("routing: a job routed to Groq uses it first, records its tokens, and falls back to Claude when it fails", async () => {
  const usage = [], topics = new TopicRegistry(null);
  const r = new Reader(bcg, new BracketRegistry(null, seed), topics, { routing: { readFullText: "groq" }, onUsage: (n, u) => usage.push([n, u]) });
  r.chain = ["anthropic"]; r.provider = "anthropic"; r.apiKey = "k"; r.groqKey = "g"; r.groqOk = true;
  assert.equal(r.routeFor("readFullText"), "groq"); assert.equal(r.routeFor("readHeadlines"), null);
  const reading1 = { event_type: "x", summary: "from groq", geography: [], impacts: [] };
  const calls = [];
  const real = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) => { calls.push(String(url)); return { ok: true, status: 200, json: async () => ({ choices: [{ message: { tool_calls: [{ function: { arguments: JSON.stringify(reading1) } }] } }], usage: { prompt_tokens: 900, completion_tokens: 120 } }), text: async () => "" }; };
    const a = await r.readFull(cluster("A long article headline"), { text: "x".repeat(600), basis: "full-text" });
    assert.equal(a.analysis.summary, "from groq"); assert.match(calls[0], /api\.groq\.com/);
    assert.deepEqual(usage.find((u) => u[0] === "groq")[1], { tokensIn: 900, tokensOut: 120 });
    // Groq fails -> Claude answers the same call
    globalThis.fetch = async (url) => (String(url).includes("groq") ? { ok: false, status: 400, text: async () => "bad tool call", headers: new Headers() } : { ok: true, status: 200, json: async () => ({ content: [{ type: "tool_use", input: { ...reading1, summary: "from claude" } }], usage: {} }), text: async () => "" });
    const b = await r.readFull(cluster("Another long article headline"), { text: "y".repeat(600), basis: "full-text" });
    assert.equal(b.analysis.summary, "from claude");
    // headlines are not routed to Groq
    calls.length = 0;
    globalThis.fetch = async (url) => { calls.push(String(url)); return { ok: true, status: 200, json: async () => ({ content: [{ type: "tool_use", input: reading1 }], usage: {} }), text: async () => "" }; };
    await r.readFull(cluster("A headline only"), { text: "", basis: "headline" });
    assert.match(calls[0], /api\.anthropic\.com/);
  } finally { globalThis.fetch = real; }
});

test("Groq requests carry no enums (it rejects a whole answer for one off-list value); the allowed values move into the description", async () => {
  const { relaxEnums } = await import("../src/llm.mjs");
  const out = relaxEnums({ type: "object", properties: { area: { type: "string", enum: ["people", "economy"], description: "where" }, list: { type: "array", items: { type: "object", properties: { d: { enum: ["a", "b"] } } } } } });
  assert.equal(out.properties.area.enum, undefined); assert.match(out.properties.area.description, /where One of: people, economy\./);
  assert.equal(out.properties.list.items.properties.d.enum, undefined); assert.match(out.properties.list.items.properties.d.description, /One of: a, b\./);
});

test("re-reading a story with skipTopics neither coins nor counts topic labels", async () => {
  const topics = new TopicRegistry(null), before = topics.size;
  const r = new Reader(bcg, new BracketRegistry(null, seed), topics, {});
  r.chain = ["anthropic"]; r.provider = "anthropic"; r.apiKey = "k";
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "tool_use", input: { event_type: "x", summary: "s", geography: [], impacts: [], topics: ["brand new label"], sentiment: "neutral" } }], usage: {} }), text: async () => "" });
  try {
    const a = await r.readFull(cluster("Some story"), { text: "t".repeat(500), basis: "full-text" }, { skipTopics: true });
    assert.equal(a.enrichment.topics, null); assert.equal(topics.size, before);
    await r.readFull(cluster("Some story"), { text: "", basis: "headline" });
    assert.equal(topics.size, before + 1); // a normal first reading does coin it
  } finally { globalThis.fetch = real; }
});
