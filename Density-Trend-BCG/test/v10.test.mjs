// Groq-only mode: every job goes to Groq, and a Groq failure is an error, never a Claude call.
import test from "node:test";
import assert from "node:assert/strict";
import { Reader } from "../src/llm.mjs";

const mk = (opts = {}) => new Reader({ impact_areas: ["economy"], fronts: {}, practice_areas: [] }, { list: () => [] }, null, opts);
const withEnv = async (env, fn) => { const saved = {}; for (const k of Object.keys(env)) { saved[k] = process.env[k]; if (env[k] === null) delete process.env[k]; else process.env[k] = env[k]; } try { return await fn(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } } };

test("groq-only: detection needs Groq, switches Claude and the local model off, and routes every job to Groq", async () => {
  await withEnv({ GROQ_API_KEY: "g", ANTHROPIC_API_KEY: "sk-ant-test", HIVEMIND_LLM: "auto" }, async () => {
    const r = mk({ groqOnly: true, routing: { ocrAssemble: "claude" } }); // even a job configured for Claude
    const msg = await r.detect();
    assert.match(msg, /^groq:/); assert.match(msg, /Claude and the local model are switched off/);
    assert.deepEqual(r.chain, []); assert.equal(r.provider, "groq"); assert.match(r.label, /^groq:/);
    for (const job of ["ocrAssemble", "ocrClassify", "ocrMatch", "readHeadlines", "anything"]) assert.equal(r.routeFor(job), "groq", job);
  });
  await withEnv({ GROQ_API_KEY: null, ANTHROPIC_API_KEY: "sk-ant-test", HIVEMIND_LLM: "auto" }, async () => {
    await assert.rejects(() => mk({ groqOnly: true }).detect(), /Groq is not available/, "no Groq key: an error, not a quiet switch to Claude");
  });
});

test("groq-only: when Groq fails the call fails, and Anthropic is never contacted (also when Groq is cooling down)", async () => {
  const urls = [], real = globalThis.fetch;
  await withEnv({ GROQ_API_KEY: "g", ANTHROPIC_API_KEY: "sk-ant-test", HIVEMIND_LLM: "auto" }, async () => {
    const r = mk({ groqOnly: true }); await r.detect();
    try {
      globalThis.fetch = async (url) => { urls.push(String(url)); return { ok: false, status: 400, text: async () => "bad request", headers: new Headers(), json: async () => ({}) }; };
      const blocks = [{ id: "a", words: 5, body: "one two" }, { id: "b", words: 5, body: "three" }];
      await assert.rejects(() => r.groupBlocks(blocks), /Groq|No LLM provider/);
      await assert.rejects(() => r.groupBlocks(blocks), /Groq|No LLM provider/, "a second call still tries Groq rather than reporting a cooldown");
      await assert.rejects(() => r.classifyArticles([{ id: "x", source: "s", page: 1, headline: "h", signals: [], excerpt: "e" }]), /Groq|No LLM provider/);
    } finally { globalThis.fetch = real; }
  });
  assert.ok(urls.length >= 3 && urls.every((u) => u.includes("api.groq.com")), "only Groq was called: " + [...new Set(urls)].join(", "));
});

test("groq-only: a good Groq answer is used as normal", async () => {
  const urls = [], real = globalThis.fetch;
  await withEnv({ GROQ_API_KEY: "g", ANTHROPIC_API_KEY: "sk-ant-test", HIVEMIND_LLM: "auto" }, async () => {
    const r = mk({ groqOnly: true }); await r.detect();
    try {
      globalThis.fetch = async (url) => { urls.push(String(url)); return { ok: true, status: 200, json: async () => ({ choices: [{ message: { tool_calls: [{ function: { arguments: JSON.stringify({ groups: [{ blocks: [1, 2], headline: "", writer: "" }] }) } }] } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), text: async () => "" }; };
      const out = await r.groupBlocks([{ id: "a", words: 5, body: "one two" }, { id: "b", words: 5, body: "three" }]);
      assert.deepEqual(out, [{ ids: ["a", "b"], headline: "", writer: "" }]);
    } finally { globalThis.fetch = real; }
  });
  assert.deepEqual([...new Set(urls)], ["https://api.groq.com/openai/v1/chat/completions"]);
});
