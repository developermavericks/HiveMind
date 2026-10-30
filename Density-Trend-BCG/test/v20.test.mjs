// Groq sometimes answers HTTP 400 "tool_use_failed": the model's tool call could not be parsed. That used to end a whole job ("No LLM provider available").
import test from "node:test";
import assert from "node:assert/strict";
import { Reader, salvageToolCall } from "../src/llm.mjs";

const mk = (opts = {}) => new Reader({ impact_areas: ["economy"], fronts: {}, practice_areas: [] }, { list: () => [] }, null, opts);
const withEnv = async (env, fn) => { const saved = {}; for (const k of Object.keys(env)) { saved[k] = process.env[k]; if (env[k] === null) delete process.env[k]; else process.env[k] = env[k]; } try { return await fn(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } } };
const KEYS = { GROQ_API_KEY: "g", OPENAI_API_KEY: "o", ANTHROPIC_API_KEY: "sk-ant-test", HIVEMIND_LLM: "auto" };
const claudeOff = { enabled: (n) => n !== "anthropic", recordEvent() {} };
const toolFailed = (generation) => ({ ok: false, status: 400, text: async () => JSON.stringify({ error: { message: "Failed to parse tool call arguments as JSON", type: "invalid_request_error", code: "tool_use_failed", failed_generation: generation } }), headers: new Headers(), json: async () => ({}) });
const groqOk = (obj) => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { tool_calls: [{ function: { arguments: JSON.stringify(obj) } }] } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), text: async () => "", headers: new Headers() });
const openaiOk = (obj) => ({ ok: true, status: 200, json: async () => ({ output: [{ type: "function_call", arguments: JSON.stringify(obj) }], usage: { input_tokens: 10, output_tokens: 5 } }), text: async () => "", headers: new Headers() });
const ITEMS = { items: [{ n: 1, fits: true }, { n: 2, fits: false, why: "only mentions it" }] };
const headlines = [{ key: "a", title: "Police arrest two men" }, { key: "b", title: "Custodial death probe" }];

test("salvage: the model's own tool call is used when it is valid JSON that Groq's parser rejected", () => {
  const body = (g) => JSON.stringify({ error: { code: "tool_use_failed", failed_generation: g } });
  assert.deepEqual(salvageToolCall(body('{"name": "judge_fit", "arguments": {"items":[{"n":1,"fits":true}]}}'), "judge_fit"), { items: [{ n: 1, fits: true }] }, "arguments written as an object");
  assert.deepEqual(salvageToolCall(body(JSON.stringify({ name: "judge_fit", arguments: JSON.stringify({ items: [{ n: 1, fits: false }] }) })), "judge_fit"), { items: [{ n: 1, fits: false }] }, "arguments written as a string");
  assert.deepEqual(salvageToolCall(body('<think>hmm</think>```json\n{"name":"judge_fit","arguments":{"items":[]}}\n```'), "judge_fit"), { items: [] }, "wrapped in thinking or a code fence");
  assert.equal(salvageToolCall(body('{"name": "some_other_tool", "arguments": {"items":[]}}'), "judge_fit"), null, "a call to a different tool is not used");
  assert.equal(salvageToolCall(body('{"name": "judge_fit", "arguments": {"items":[{"n":1,"fits":tr'), "judge_fit"), null, "a cut-off answer is not usable");
  assert.equal(salvageToolCall(body('{"name": "judge_fit", "arguments": [1, 2]}'), "judge_fit"), null, "arguments that are not an object");
  assert.equal(salvageToolCall("not json at all", "judge_fit"), null); assert.equal(salvageToolCall(JSON.stringify({ error: { code: "other" } }), "judge_fit"), null);
});

test("groq: a rejected tool call that is valid JSON is used at once, with no second request", async () => {
  const urls = [], real = globalThis.fetch;
  await withEnv(KEYS, async () => {
    const r = mk({ integrations: claudeOff, routingNoClaude: {} }); await r.detect();
    try {
      globalThis.fetch = async (url) => { urls.push(String(url)); return toolFailed(JSON.stringify({ name: "judge_fit", arguments: ITEMS })); };
      const out = await r.verifyTopicFit("police misconduct", [], headlines);
      assert.deepEqual(out.map((x) => [x.key, x.fits]), [["a", true], ["b", false]]);
    } finally { globalThis.fetch = real; }
  });
  assert.equal(urls.length, 1, "salvaged from the failed answer");
});

test("groq: an unusable failed tool call is asked again, and the second answer is used", async () => {
  const urls = [], real = globalThis.fetch; let n = 0;
  await withEnv(KEYS, async () => {
    const r = mk({ integrations: claudeOff, routingNoClaude: {} }); await r.detect();
    try {
      globalThis.fetch = async (url) => { urls.push(String(url)); return ++n === 1 ? toolFailed('{"name": "judge_fit", "arguments": {"items":[{"n":1,"fi') : groqOk(ITEMS); };
      const out = await r.verifyTopicFit("police misconduct", [], headlines);
      assert.equal(out.length, 2);
    } finally { globalThis.fetch = real; }
  });
  assert.deepEqual(urls.map((u) => new URL(u).hostname), ["api.groq.com", "api.groq.com"], "retried on Groq, no other provider needed");
});

test("fallback: when Groq keeps failing and Claude is off, OpenAI answers; Anthropic is never contacted", async () => {
  const urls = [], real = globalThis.fetch;
  await withEnv(KEYS, async () => {
    const r = mk({ integrations: claudeOff, routingNoClaude: {} }); await r.detect();
    try {
      globalThis.fetch = async (url) => { urls.push(String(url)); return String(url).includes("openai.com") ? openaiOk(ITEMS) : toolFailed('{"name": "judge_fit", "arguments": {"items":[{"n'); };
      const out = await r.verifyTopicFit("police misconduct", [], headlines);
      assert.deepEqual(out.map((x) => [x.key, x.fits]), [["a", true], ["b", false]], "the answer came from OpenAI");
    } finally { globalThis.fetch = real; }
  });
  const hosts = urls.map((u) => new URL(u).hostname);
  assert.deepEqual(hosts, ["api.groq.com", "api.groq.com", "api.groq.com", "api.openai.com"], "three tries on Groq, then OpenAI");
  assert.ok(!hosts.some((h) => h.includes("anthropic")));
});

test("fallback: it respects OpenAI's daily cap, and with both providers failing the error is clear", async () => {
  const urls = [], real = globalThis.fetch;
  await withEnv(KEYS, async () => {
    const capped = mk({ integrations: claudeOff, routingNoClaude: {}, overBudget: (p) => p === "openai" }); await capped.detect();
    const open = mk({ integrations: claudeOff, routingNoClaude: {} }); await open.detect();
    try {
      globalThis.fetch = async (url) => { urls.push(String(url)); return toolFailed('{"name": "judge_fit", "arguments": {"items":[{"n'); };
      await assert.rejects(() => capped.verifyTopicFit("t", [], headlines), /Groq 400|tool_use_failed|No LLM provider/);
      assert.ok(urls.every((u) => u.includes("groq.com")), "over its cap, OpenAI is not used even as a fallback");
      urls.length = 0; globalThis.fetch = async (url) => { urls.push(String(url)); return String(url).includes("openai.com") ? { ok: false, status: 400, text: async () => "refused", headers: new Headers(), json: async () => ({}) } : toolFailed("{"); };
      await assert.rejects(() => open.verifyTopicFit("t", [], headlines), /No LLM provider|OpenAI|Groq/);
      assert.ok(urls.some((u) => u.includes("openai.com")), "with room under the cap, OpenAI was tried");
    } finally { globalThis.fetch = real; }
  });
});

test("claude on: the old order is unchanged (a Groq job still falls back to Claude, not to OpenAI)", async () => {
  const urls = [], real = globalThis.fetch;
  await withEnv(KEYS, async () => {
    const r = mk({ routing: { topicFit: "groq" } }); await r.detect(); // no integrations object: Claude is on
    try {
      globalThis.fetch = async (url) => { urls.push(String(url)); return String(url).includes("anthropic.com") ? { ok: true, status: 200, json: async () => ({ content: [{ type: "tool_use", input: ITEMS }], usage: {} }), text: async () => "", headers: new Headers() } : toolFailed("{"); };
      assert.equal((await r.verifyTopicFit("t", [], headlines)).length, 2);
    } finally { globalThis.fetch = real; }
  });
  const hosts = urls.map((u) => new URL(u).hostname); assert.equal(hosts.at(-1), "api.anthropic.com"); assert.ok(!hosts.includes("api.openai.com"));
});
