// Headlines the OCR got wrong: which ones are flagged, how the model's answer is checked, and what the pages read back.
import test from "node:test";
import assert from "node:assert/strict";
import { isWeakHeadline, sameText, textHas } from "../src/ocr.mjs";
import { normalizeTitles, Reader } from "../src/llm.mjs";
import { Store } from "../src/db.mjs";
import { fixTitles } from "../src/ocrjobs.mjs";

test("headlines: section labels, names, fragments and web addresses are flagged; real titles are not", () => {
  for (const bad of ["OPINION 7", "The Edit Page", "MACRO PULSE", "JOSE MOURINHO", "V. Venkatesan I", "Rajesh Kumar", "Penicillin", "P7", "hea",
    "40-month high, according to JP Morgan's aggregated purchasing managers' index.", "Arani.Basu@timesofindia.com A", "see www.thehindu.com for more"]) assert.equal(isWeakHeadline(bad), true, bad);
  for (const good of ["Risk of irrelevance?", "Balanced advantage funds vow to time the market. Did they deliver?", "Unsung heroes of the Union of India", "When tariff walls become a ladder", "Defensive stock buyers desperate as options thin"]) assert.equal(isWeakHeadline(good), false, good);
  assert.equal(isWeakHeadline("Anuj Kumar and friends meet today", "Anuj Kumar"), false, "a longer line that merely contains the writer's name is fine");
  assert.equal(isWeakHeadline("Anuj Kumar", "anuj kumar"), true, "the writer's name on its own is not a title");
  assert.ok(sameText("Risk of  Irrelevance?", "risk of irrelevance") && !sameText("a b", "a c"));
  assert.ok(textHas("The Edit Page\nWhy the rupee matters\nBy A Writer\nThe rupee…", "Why the rupee matters") && !textHas("short text", "not in there at all"));
});

test("headlines: a title claimed as printed must appear in the text, a weak or unchanged answer is kept as it was", () => {
  const batch = [
    { id: "a", headline: "OPINION 7", author: "", start: "OPINION 7 Risk of irrelevance? Anil Writer Markets have changed…" },
    { id: "b", headline: "MACRO PULSE", author: "", start: "MACRO PULSE The body of the piece says nothing like the title below." },
    { id: "c", headline: "JOSE MOURINHO", author: "", start: "JOSE MOURINHO works hard without the ball." },
    { id: "d", headline: "A good headline here", author: "", start: "A good headline here and more" },
    { id: "e", headline: "x", author: "", start: "" },
  ];
  const out = normalizeTitles({ items: [
    { n: 1, title: "“Risk of irrelevance?”", printed: true },
    { n: 2, title: "Why inflation will ease by spring", printed: true },
    { n: 3, title: "JOSE MOURINHO", printed: false },
    { n: 4, title: "A good headline here", printed: true },
    { n: 5, title: "Opinion 3", printed: false },
    { n: 9, title: "ignored", printed: true }, { n: 1, title: "duplicate", printed: false },
  ] }, batch);
  assert.deepEqual(out, [
    { id: "a", title: "Risk of irrelevance?", source: "printed" },
    { id: "b", title: "Why inflation will ease by spring", source: "generated" }, // claimed printed, not in the text: demoted
    { id: "c", title: "", source: "kept" }, // the model gave a name back
    { id: "d", title: "", source: "kept" }, // unchanged
    { id: "e", title: "", source: "kept" }, // still a label
  ]);
});

test("headlines: the pages read the repaired title with the original alongside, and each piece is checked once", async () => {
  const s = new Store(":memory:");
  const row = (id, headline, body = "text ".repeat(60)) => ({ id, source: "Livemint", date: "2026-10-22", page: 20, headline, body, hash: id, words: 60, candidate: true, signals: [] });
  s.putOcrArticles([row("a", "OPINION 7", "OPINION 7 Risk of irrelevance? Anil Writer " + "x ".repeat(80)), row("b", "Risk of irrelevance?"), row("c", "A news item")]);
  s.putOcrKinds([{ id: "a", kind: "opinion", author: "Anil Writer" }, { id: "b", kind: "analysis", author: "" }, { id: "c", kind: "news" }], "m");
  assert.deepEqual(s.ocrNeedingTitle().map((r) => r.id).sort(), ["a", "b"], "only authored pieces");
  const asked = [];
  const reader = { fixHeadlines: async (batch) => { asked.push(...batch.map((x) => x.id)); return normalizeTitles({ items: batch.map((x, i) => ({ n: i + 1, title: "Risk of irrelevance?", printed: true })) }, batch); } };
  const r = await fixTitles({ store: s, reader });
  assert.deepEqual(asked, ["a"], "a headline that already looks fine is not sent to the model");
  assert.deepEqual([r.looked, r.weak, r.printed, r.kept], [2, 1, 1, 0], "kept counts only flagged headlines the model left as they were");
  const a = s.ocrAuthored().find((x) => x.id === "a");
  assert.equal(a.headline, "Risk of irrelevance?"); assert.equal(a.original, "OPINION 7");
  assert.equal(s.ocrAuthored().find((x) => x.id === "b").headline, "Risk of irrelevance?", "an untouched piece keeps its headline");
  assert.equal(s.ocrNeedingTitle().length, 0, "everything is recorded as checked");
  const full = s.ocrArticle("a"); assert.equal(full.headline, "Risk of irrelevance?"); assert.equal(full.original, "OPINION 7"); assert.equal(full.titleSource, "printed");
  s.putOcrMatches("bcg", [{ articleId: "a", oppKey: "bcg|Risk|t:1", fit: 0.9, angle: "x" }]);
  const m = s.ocrMatchesByOpp("bcg", "2026-10-20").get("bcg|Risk|t:1")[0]; assert.equal(m.headline, "Risk of irrelevance?"); assert.equal(m.original, "OPINION 7"); assert.equal(m.titleSource, "printed");
  const found = s.ocrSearch({ q: "OPINION 7" }); assert.equal(found.total, 1, "the original OCR text is still searchable");
  assert.equal(found.rows[0].headline, "Risk of irrelevance?");
  s.close();
});

test("reader: repairing headlines goes to Groq first (routing)", async () => {
  const usage = [], r = new Reader({ impact_areas: ["economy"], fronts: {}, practice_areas: [] }, { list: () => [] }, null, { routing: { ocrTitle: "groq" }, onUsage: (n) => usage.push(n) });
  r.chain = ["anthropic"]; r.provider = "anthropic"; r.apiKey = "k"; r.groqKey = "g"; r.groqOk = true;
  const calls = [], real = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => { calls.push(String(url)); return { ok: true, status: 200, json: async () => ({ choices: [{ message: { tool_calls: [{ function: { arguments: JSON.stringify({ items: [{ n: 1, title: "Real title", printed: false }] }) } }] } }], usage: { prompt_tokens: 50, completion_tokens: 10 } }), text: async () => "" }; };
    const out = await r.fixHeadlines([{ id: "x", source: "The Hindu", headline: "OPINION 7", author: "", start: "OPINION 7 something" }]);
    assert.deepEqual(out, [{ id: "x", title: "Real title", source: "generated" }]);
    assert.match(calls[0], /api\.groq\.com/); assert.deepEqual(usage, ["groq"]);
  } finally { globalThis.fetch = real; }
});
