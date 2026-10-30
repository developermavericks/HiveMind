// Putting columns back together, second round: junction flags, the stronger model, and undoing an assembly.
import test from "node:test";
import assert from "node:assert/strict";
import { endsMidSentence, startsWithCapsName, normalizeGroups, Reader } from "../src/llm.mjs";
import { Store } from "../src/db.mjs";
import { assemble } from "../src/ocrjobs.mjs";

test("layout: blocks that end or start in the middle of a sentence are recognised", () => {
  assert.equal(endsMidSentence("All this has led to a surge in stock"), true);
  assert.equal(endsMidSentence("A fortnight ago, I"), true);
  for (const done of ["It ends here.", "Is it so?", 'He said "no".', "Really!", "(see above)"]) assert.equal(endsMidSentence(done), false, done);
  assert.equal(startsWithCapsName("ANNIE LOWREY wrote about the strain that reducing public debt"), true);
  assert.equal(startsWithCapsName("DEVINA MEHRA is founder of First Global"), true);
  assert.equal(startsWithCapsName("RBI keeps rates unchanged as inflation eases"), false, "one capitalised word is not a name");
  assert.equal(startsWithCapsName("The Reserve Bank said on Monday"), false);
});

test("reader: the layout step uses the model set for it, with room to think, and the default otherwise", async () => {
  const bodies = [], real = globalThis.fetch;
  const mk = (models) => { const r = new Reader({ impact_areas: ["economy"], fronts: {}, practice_areas: [] }, { list: () => [] }, null, { models }); r.chain = ["anthropic"]; r.provider = "anthropic"; r.apiKey = "k"; return r; };
  try {
    globalThis.fetch = async (url, init) => { bodies.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({ content: [{ type: "tool_use", input: { groups: [] } }], usage: {} }), text: async () => "" }; };
    const blocks = [{ id: "a", words: 5, body: "one two" }, { id: "b", words: 5, body: "three" }];
    await mk({ ocrAssemble: "claude-sonnet-5-5" }).groupBlocks(blocks);
    await mk({}).groupBlocks(blocks);
    assert.equal(bodies[0].model, "claude-sonnet-5-5"); assert.deepEqual(bodies[0].tool_choice, { type: "auto" }, "a stronger model is not forced to call the tool");
    assert.ok(bodies[0].max_tokens > bodies[1].max_tokens + 2000, "more room to think before the tool call");
    assert.notEqual(bodies[1].model, "claude-sonnet-5-5"); assert.equal(bodies[1].tool_choice.type, "tool");
    assert.match(bodies[0].messages[0].content, /ENDS MID-SENTENCE/, "the junction is flagged for the model");
  } finally { globalThis.fetch = real; }
});

test("layout: undoing an assembly releases the parts to be judged again and removes the whole articles", async () => {
  const s = new Store(":memory:");
  const row = (id, body, words) => ({ id, source: "Livemint", date: "2026-10-22", page: 20, headline: "h" + id, body, hash: id, words, candidate: words >= 60, signals: [] });
  s.putOcrArticles([row("Livemint|2026-10-22|1", "Title block", 17), row("Livemint|2026-10-22|2", "albeit the column goes on and on " + "x ".repeat(80), 90), row("Livemint|2026-10-22|3", "A complete other article. " + "y ".repeat(80), 90)]);
  s.putOcrKinds([{ id: "Livemint|2026-10-22|3", kind: "analysis", author: "Keep Me" }], "m");
  const reader = { groupBlocks: async (bl) => normalizeGroups({ groups: [{ blocks: [1, 2], headline: "", writer: "" }] }, bl) };
  await assemble({ store: s, reader });
  assert.equal(s.ocrArticle("Livemint|2026-10-22|g1").kind, null);
  s.putOcrMatches("bcg", [{ articleId: "Livemint|2026-10-22|g1", oppKey: "bcg|X|t:1", fit: 0.9 }, { articleId: "Livemint|2026-10-22|3", oppKey: "bcg|X|t:2", fit: 0.9 }]);
  const r = s.ocrResetAssembly();
  assert.deepEqual(r, { merged: 1, parts: 2 });
  assert.equal(s.ocrArticle("Livemint|2026-10-22|g1"), null, "the assembled article is gone");
  assert.equal(s.ocrArticle("Livemint|2026-10-22|2").kind, null, "a released part is to be judged again");
  assert.equal(s.ocrArticle("Livemint|2026-10-22|1").kind, "news", "a short block that is no candidate is simply news");
  const keep = s.ocrArticle("Livemint|2026-10-22|3"); assert.equal(keep.kind, "analysis"); assert.equal(keep.author, "Keep Me", "blocks that were never parts are untouched");
  assert.equal([...s.ocrMatchedIds("bcg")].join(), "Livemint|2026-10-22|3", "only the whole article's match is dropped");
  assert.equal(s.ocrPagesToAssemble().length, 1, "the page can be looked at again");
  s.close();
});
