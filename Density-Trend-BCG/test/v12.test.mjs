// Claude switched off (the default): Groq and OpenAI do everything, nothing can fall back to Claude, and switching it on restores the old behaviour.
import test from "node:test";
import assert from "node:assert/strict";
import { Reader, budgetGuard } from "../src/llm.mjs";
import { Integrations } from "../src/integrations.mjs";
import { Store, dayOf } from "../src/db.mjs";

const mk = (opts = {}) => new Reader({ impact_areas: ["economy"], fronts: {}, practice_areas: [] }, { list: () => [] }, null, opts);
const withEnv = async (env, fn) => { const saved = {}; for (const k of Object.keys(env)) { saved[k] = process.env[k]; if (env[k] === null) delete process.env[k]; else process.env[k] = env[k]; } try { return await fn(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } } };
const KEYS = { GROQ_API_KEY: "g", OPENAI_API_KEY: "o", OPENAI_MODEL: "gpt-5.6-luna", ANTHROPIC_API_KEY: "sk-ant-test", HIVEMIND_LLM: "auto" };
const claude = (on) => ({ enabled: (n) => (n === "anthropic" ? on : true), recordEvent() {} });
const ROUTING_NO_CLAUDE = { readHeadlines: "openai", match: "openai", brief: "openai", ocrAssemble: "openai", review: "openai" };
const blocks = [{ id: "a", words: 5, body: "one two" }, { id: "b", words: 5, body: "three" }];
const refuse = (status = 400) => ({ ok: false, status, text: async () => "refused", headers: new Headers(), json: async () => ({}) });
const groqAnswer = (obj) => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { tool_calls: [{ function: { arguments: JSON.stringify(obj) } }] } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), text: async () => "", headers: new Headers() });

test("claude off: no flag needed, the switch alone makes every job go to Groq or OpenAI", async () => {
  await withEnv(KEYS, async () => {
    const r = mk({ integrations: claude(false), routing: { sentiment: "groq" }, routingNoClaude: ROUTING_NO_CLAUDE });
    const msg = await r.detect();
    assert.match(msg, /groq:.* \+ openai:gpt-5\.6-luna/); assert.match(msg, /Claude is switched off.*turn it on in Settings/);
    assert.equal(r.noClaude, true); assert.deepEqual(r.chain, []);
    for (const job of ["readHeadlines", "match", "brief", "ocrAssemble", "review"]) assert.equal(r.routeFor(job), "openai", job);
    for (const job of ["sentiment", "enrich", "mergeTopics", "verifyMerges", "mergeEntities", "consolidate", "topicFit", "readFullText", "somethingNew"]) assert.equal(r.routeFor(job), "groq", job);
  });
});

test("claude on: the old behaviour is back (routing table, Claude chain)", async () => {
  await withEnv(KEYS, async () => {
    const r = mk({ integrations: claude(true), routing: { sentiment: "groq" }, routingNoClaude: ROUTING_NO_CLAUDE });
    assert.match(await r.detect(), /^anthropic:/);
    assert.equal(r.noClaude, false); assert.deepEqual(r.chain, ["anthropic"]);
    assert.equal(r.routeFor("sentiment"), "groq"); assert.equal(r.routeFor("readHeadlines"), null, "left on Claude");
    assert.equal(r.routeFor("match"), null, "the no-Claude table is not used while Claude is on");
  });
});

test("claude off: a failing provider is an error, and Anthropic is never contacted", async () => {
  const urls = [], real = globalThis.fetch;
  await withEnv(KEYS, async () => {
    const r = mk({ integrations: claude(false), routingNoClaude: ROUTING_NO_CLAUDE }); await r.detect();
    try {
      globalThis.fetch = async (url) => { urls.push(String(url)); return refuse(400); }; // a 400 is not retried; a 500 would be, with backoff
      for (const run of [() => r.groupBlocks(blocks), () => r.enrich({ title: "t", analysis: { summary: "s", event_type: "e", impacts: [] } }), () => r.reviewReadings([{ title: "t", analysis: { summary: "s", impacts: [] } }], "claude-sonnet-5-5")])
        await assert.rejects(run, /OpenAI|Groq|No LLM provider/);
    } finally { globalThis.fetch = real; }
  });
  assert.ok(urls.length >= 3 && urls.every((u) => u.includes("openai.com") || u.includes("groq.com")), [...new Set(urls)].join(", "));
});

test("claude off: the second-opinion review is done by Luna, not forced onto Claude", async () => {
  const sent = [], real = globalThis.fetch;
  await withEnv(KEYS, async () => {
    const r = mk({ integrations: claude(false), routingNoClaude: ROUTING_NO_CLAUDE, effort: { review: "medium" } }); await r.detect();
    try {
      globalThis.fetch = async (url, init) => { sent.push({ url: String(url), body: JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => ({ output: [{ type: "function_call", arguments: JSON.stringify({ items: [{ n: 1, agrees: true }] }) }], usage: { input_tokens: 10, output_tokens: 5 } }), text: async () => "", headers: new Headers() }; };
      const out = await r.reviewReadings([{ title: "t", snippet: "", analysis: { summary: "s", impacts: [] }, sentiment: "neutral", stance: "neutral", topics: [] }], "claude-sonnet-5-5");
      assert.deepEqual(out, [{ n: 1, agrees: true, note: "" }]);
    } finally { globalThis.fetch = real; }
  });
  assert.equal(sent.length, 1); assert.equal(sent[0].url, "https://api.openai.com/v1/responses");
  assert.deepEqual(sent[0].body.reasoning, { effort: "medium" }); assert.equal(sent[0].body.model, "gpt-5.6-luna");
});

test("claude off but nothing else available: the old clear message, not a silent failure", async () => {
  await withEnv({ ...KEYS, GROQ_API_KEY: null, OPENAI_API_KEY: null }, async () => {
    await assert.rejects(() => mk({ integrations: claude(false) }).detect(), /Claude is switched off and no local model is available/);
  });
});

test("claude off by default: a fresh database has it off, the toggle turns it on and back off, other integrations stay on", () => {
  const store = new Store(":memory:"), ig = new Integrations({ root: "/nonexistent", store });
  assert.equal(ig.enabled("anthropic"), false);
  for (const n of ["groq", "openai", "ollama", "serper"]) assert.equal(ig.enabled(n), true, n);
  ig.setEnabled("anthropic", true); assert.equal(ig.enabled("anthropic"), true);
  ig.setEnabled("anthropic", false); assert.equal(ig.enabled("anthropic"), false);
  ig.setEnabled("groq", false); assert.equal(ig.enabled("groq"), false);
  store.close();
});

test("spend cap: a paid provider stops taking work for the day once its tokens reach the cap", async () => {
  const store = new Store(":memory:"), today = () => dayOf(Date.now());
  const cfg = { limits: { openaiDailyUsd: 1 }, pricing: { openai: { inPerMTok: 0.2, outPerMTok: 1.2 } } }, guard = budgetGuard(store, cfg, today);
  assert.equal(guard("openai"), false, "nothing spent yet");
  store.addUsage("openai", { tokensIn: 2_000_000, tokensOut: 500_000 }); // 0.40 + 0.60 = $1.00
  assert.equal(guard("openai"), true, "the cap is reached");
  assert.equal(guard("groq"), false, "a provider without a cap is never blocked");
  assert.equal(budgetGuard(store, { pricing: cfg.pricing }, today)("openai"), false, "no limit configured: no cap");
  assert.equal(budgetGuard(store, { limits: cfg.limits }, today)("openai"), false, "no price configured: it cannot be costed, so no cap");
  // and the Reader honours it: the job goes to Groq instead
  const urls = [], real = globalThis.fetch;
  await withEnv(KEYS, async () => {
    const r = mk({ integrations: claude(false), routingNoClaude: ROUTING_NO_CLAUDE, overBudget: guard }); await r.detect();
    try { globalThis.fetch = async (url) => { urls.push(String(url)); return groqAnswer({ groups: [{ blocks: [1, 2], headline: "", writer: "" }] }); }; assert.deepEqual(await r.groupBlocks(blocks), [{ ids: ["a", "b"], headline: "", writer: "" }]); }
    finally { globalThis.fetch = real; }
  });
  assert.deepEqual([...new Set(urls)], ["https://api.groq.com/openai/v1/chat/completions"], "OpenAI was not called");
  store.close();
});

test("openai request: no stored responses, a cache key per job, and no reasoning where it is switched off", async () => {
  const sent = [], real = globalThis.fetch;
  await withEnv(KEYS, async () => {
    const r = mk({ integrations: claude(false), routingNoClaude: ROUTING_NO_CLAUDE, effort: { ocrAssemble: "none" } }); await r.detect();
    try {
      globalThis.fetch = async (url, init) => { sent.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({ output: [{ type: "function_call", arguments: JSON.stringify({ groups: [] }) }], usage: { input_tokens: 10, output_tokens: 5 } }), text: async () => "", headers: new Headers() }; };
      await r.groupBlocks(blocks);
    } finally { globalThis.fetch = real; }
  });
  assert.equal(sent[0].store, false); assert.equal(sent[0].prompt_cache_key, "group_blocks"); assert.deepEqual(sent[0].reasoning, { effort: "none" });
  assert.ok(sent[0].max_output_tokens < 2000, "no room reserved for reasoning that is switched off");
});
