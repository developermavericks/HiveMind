// Found on the first real collection with Luna: the Groq fallback was sent OpenAI's "none" reasoning setting (400). The other half of that
// incident, OpenAI being sent through the proxy (403, country not supported), is covered by v16: no request uses a proxy except an article-text retry.
import test from "node:test";
import assert from "node:assert/strict";
import { Reader } from "../src/llm.mjs";

const mk = (opts = {}) => new Reader({ impact_areas: ["economy"], fronts: {}, practice_areas: [] }, { list: () => [] }, null, opts);
const withEnv = async (env, fn) => { const saved = {}; for (const k of Object.keys(env)) { saved[k] = process.env[k]; if (env[k] === null) delete process.env[k]; else process.env[k] = env[k]; } try { return await fn(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } } };
const KEYS = { GROQ_API_KEY: "g", OPENAI_API_KEY: "o", OPENAI_MODEL: "gpt-5.6-luna", ANTHROPIC_API_KEY: "sk-ant-test", HIVEMIND_LLM: "auto" };
const claudeOff = { enabled: (n) => n !== "anthropic", recordEvent() {} };
const blocks = [{ id: "a", words: 5, body: "one two" }, { id: "b", words: 5, body: "three" }];

test("groq fallback: OpenAI's reasoning 'none' is turned into a value Groq accepts, and real Groq values pass through", async () => {
  const sent = [], real = globalThis.fetch;
  await withEnv(KEYS, async () => {
    const r = mk({ integrations: claudeOff, routingNoClaude: { ocrAssemble: "openai" }, effort: { ocrAssemble: "none" } }); await r.detect();
    try {
      globalThis.fetch = async (url, init) => {
        const body = JSON.parse(init.body); sent.push({ url: String(url), effort: body.reasoning_effort ?? body.reasoning?.effort });
        if (String(url).includes("openai.com")) return { ok: false, status: 403, text: async () => '{"error":{"code":"unsupported_country_region_territory"}}', headers: new Headers(), json: async () => ({}) };
        // Groq as it really behaves: anything but low, medium or high is a 400
        if (!["low", "medium", "high"].includes(body.reasoning_effort)) return { ok: false, status: 400, text: async () => "`reasoning_effort` must be one of `low`, `medium`, or `high`", headers: new Headers(), json: async () => ({}) };
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { tool_calls: [{ function: { arguments: JSON.stringify({ groups: [{ blocks: [1, 2], headline: "", writer: "" }] }) } }] } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), text: async () => "", headers: new Headers() };
      };
      assert.deepEqual(await r.groupBlocks(blocks), [{ ids: ["a", "b"], headline: "", writer: "" }], "OpenAI refused, and the Groq fallback must answer");
    } finally { globalThis.fetch = real; }
  });
  assert.deepEqual(sent.map((s) => [new URL(s.url).hostname, s.effort]), [["api.openai.com", "none"], ["api.groq.com", "low"]]);
  const seen = [];
  await withEnv(KEYS, async () => {
    for (const effort of ["low", "medium", "high"]) {
      const r = mk({ integrations: claudeOff, routingNoClaude: {}, effort: { ocrAssemble: effort } }); await r.detect();
      globalThis.fetch = async (url, init) => { seen.push(JSON.parse(init.body).reasoning_effort); return { ok: true, status: 200, json: async () => ({ choices: [{ message: { tool_calls: [{ function: { arguments: '{"groups":[]}' } }] } }], usage: {} }), text: async () => "", headers: new Headers() }; };
      try { await r.groupBlocks(blocks); } finally { globalThis.fetch = real; }
    }
  });
  assert.deepEqual(seen, ["low", "medium", "high"]);
});
