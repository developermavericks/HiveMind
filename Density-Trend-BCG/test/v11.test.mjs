// OpenAI as a provider: routing, the request it sends, token tracking, and where it may fall back to.
import test from "node:test";
import assert from "node:assert/strict";
import { Reader } from "../src/llm.mjs";

const mk = (opts = {}) => new Reader({ impact_areas: ["economy"], fronts: {}, practice_areas: [] }, { list: () => [] }, null, opts);
const withEnv = async (env, fn) => { const saved = {}; for (const k of Object.keys(env)) { saved[k] = process.env[k]; if (env[k] === null) delete process.env[k]; else process.env[k] = env[k]; } try { return await fn(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } } };
const KEYS = { GROQ_API_KEY: "g", OPENAI_API_KEY: "o", OPENAI_MODEL: "gpt-5.6-luna", ANTHROPIC_API_KEY: "sk-ant-test", HIVEMIND_LLM: "auto" };
const blocks = [{ id: "a", words: 5, body: "one two" }, { id: "b", words: 5, body: "three" }];
const openaiAnswer = (groups) => ({ ok: true, status: 200, json: async () => ({ output: [{ type: "reasoning" }, { type: "function_call", name: "group_blocks", arguments: JSON.stringify({ groups }) }], usage: { input_tokens: 120, output_tokens: 30, input_tokens_details: { cached_tokens: 100 } } }), text: async () => "", headers: new Headers() });
const groqAnswer = (groups) => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { tool_calls: [{ function: { arguments: JSON.stringify({ groups }) } }] } }], usage: { prompt_tokens: 50, completion_tokens: 10 } }), text: async () => "", headers: new Headers() });
const refuse = (status = 400) => ({ ok: false, status, text: async () => "refused", headers: new Headers(), json: async () => ({}) });

test("openai: detection reads the key and model, and routing sends a job there only when asked", async () => {
  await withEnv(KEYS, async () => {
    const r = mk({ groqOnly: true, routing: { ocrAssemble: "openai", ocrClassify: "groq" } });
    const msg = await r.detect();
    assert.match(msg, /groq:.* \+ openai:gpt-5\.6-luna/); assert.match(msg, /switched off/);
    assert.equal(r.routeFor("ocrAssemble"), "openai"); assert.equal(r.routeFor("ocrClassify"), "groq"); assert.equal(r.routeFor("anythingElse"), "groq");
    const normal = mk({ routing: { ocrAssemble: "openai", ocrClassify: "groq", readHeadlines: "claude" } }); await normal.detect();
    assert.equal(normal.routeFor("ocrAssemble"), "openai"); assert.equal(normal.routeFor("ocrClassify"), "groq"); assert.equal(normal.routeFor("readHeadlines"), null, "a job left on Claude stays on the normal chain");
  });
  await withEnv({ ...KEYS, OPENAI_API_KEY: null }, async () => {
    const r = mk({ groqOnly: true, routing: { ocrAssemble: "openai" } }); await r.detect();
    assert.equal(r.routeFor("ocrAssemble"), "groq", "no OpenAI key: the job goes to Groq");
  });
  await withEnv({ ...KEYS, OPENAI_API_KEY: null, GROQ_API_KEY: null }, async () => {
    await assert.rejects(() => mk({ groqOnly: true }).detect(), /Groq is not available.*nor is OpenAI/);
  });
});

test("openai: the request uses the Responses endpoint with a forced tool and the asked reasoning, and tokens are recorded", async () => {
  const sent = [], usage = [], real = globalThis.fetch;
  await withEnv(KEYS, async () => {
    const r = mk({ groqOnly: true, routing: { ocrAssemble: "openai" }, effort: { ocrAssemble: "medium" }, onUsage: (n, u) => usage.push([n, u]) }); await r.detect();
    try {
      globalThis.fetch = async (url, init) => { sent.push({ url: String(url), body: JSON.parse(init.body), auth: init.headers.authorization }); return openaiAnswer([{ blocks: [1, 2], headline: "", writer: "" }]); };
      const out = await r.groupBlocks(blocks);
      assert.deepEqual(out, [{ ids: ["a", "b"], headline: "", writer: "" }]);
    } finally { globalThis.fetch = real; }
  });
  assert.equal(sent.length, 1); const s = sent[0];
  assert.equal(s.url, "https://api.openai.com/v1/responses"); assert.equal(s.auth, "Bearer o");
  assert.equal(s.body.model, "gpt-5.6-luna"); assert.deepEqual(s.body.reasoning, { effort: "medium" });
  assert.deepEqual(s.body.tool_choice, { type: "function", name: "group_blocks" }); assert.equal(s.body.tools[0].name, "group_blocks");
  assert.ok(!("temperature" in s.body) && !("max_tokens" in s.body), "settings this model refuses are not sent");
  assert.ok(s.body.max_output_tokens > 5000, "room for the reasoning on top of the answer");
  assert.deepEqual(usage.find((u) => u[0] === "openai")[1], { tokensIn: 120, tokensOut: 30, cacheRead: 100 });
});

test("openai: a failure falls back to Groq and never to Claude in no-Claude mode", async () => {
  const urls = [], real = globalThis.fetch;
  await withEnv(KEYS, async () => {
    const r = mk({ groqOnly: true, routing: { ocrAssemble: "openai" } }); await r.detect();
    try {
      globalThis.fetch = async (url) => { urls.push(String(url)); return String(url).includes("openai.com") ? refuse(400) : groqAnswer([{ blocks: [1, 2], headline: "", writer: "" }]); };
      assert.deepEqual(await r.groupBlocks(blocks), [{ ids: ["a", "b"], headline: "", writer: "" }], "Groq answered when OpenAI refused");
      globalThis.fetch = async (url) => { urls.push(String(url)); return refuse(400); };
      await assert.rejects(() => r.groupBlocks(blocks), /Groq|OpenAI|No LLM provider/, "both refusing is an error");
      await assert.rejects(() => r.groupBlocks(blocks), /Groq|OpenAI|No LLM provider/, "and a second call still tries them, rather than reporting a cooldown");
    } finally { globalThis.fetch = real; }
  });
  assert.ok(urls.length >= 5 && urls.every((u) => u.includes("openai.com") || u.includes("groq.com")), "only OpenAI and Groq were contacted: " + [...new Set(urls)].join(", "));
});

test("openai: outside no-Claude mode the old order holds (OpenAI, then Groq, then the normal chain)", async () => {
  const urls = [], real = globalThis.fetch;
  await withEnv(KEYS, async () => {
    const r = mk({ routing: { ocrAssemble: "openai" } }); await r.detect();
    try {
      globalThis.fetch = async (url) => { urls.push(String(url)); return String(url).includes("anthropic.com") ? { ok: true, status: 200, json: async () => ({ content: [{ type: "tool_use", input: { groups: [] } }], usage: {} }), text: async () => "", headers: new Headers() } : refuse(400); };
      assert.deepEqual(await r.groupBlocks(blocks), []);
    } finally { globalThis.fetch = real; }
  });
  const order = urls.map((u) => new URL(u).hostname.split(".")[1]);
  assert.deepEqual(order.slice(0, 3), ["openai", "groq", "anthropic"]);
});
