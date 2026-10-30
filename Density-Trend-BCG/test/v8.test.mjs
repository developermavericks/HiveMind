// Articles the OCR cut into columns: grouping the blocks back together, and what that does to the stored pieces.
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeGroups, Reader } from "../src/llm.mjs";
import { textHasLoose, startsMidSentence, isWeakHeadline } from "../src/ocr.mjs";
import { Store } from "../src/db.mjs";
import { assemble } from "../src/ocrjobs.mjs";

const title = { id: "Mint|2026-10-22|1", words: 17, headline: "Why the global economy is facing an unusual paradox RAHULJACOB", body: "Why the global economy is facing an unusual paradox\n\nRAHULJACOB\n\nis a former Financial Times foreign correspondent." };
const col1 = { id: "Mint|2026-10-22|2", words: 80, headline: "OUR VIEW", body: "albeit with a trace of scepticism, that the global economy is showing remarkable resilience." };
const col3 = { id: "Mint|2026-10-22|4", words: 60, headline: "40-month high, according to JP Morgan's index.", body: "40-month high, according to JP Morgan's aggregated purchasing managers' index. So far, so rosy." };
const other = { id: "Mint|2026-10-22|3", words: 300, headline: "Universal basic income: put it under a zoom lens", body: "Universal basic income: put it under a zoom lens. The debate has returned." };
const blocks = [title, col1, other, col3];

test("layout: the grouping is checked against the text (block numbers, printed headline, writer with spaces ignored)", () => {
  assert.equal(textHasLoose("RAHULJACOB is a former", "Rahul Jacob"), true);
  assert.equal(textHasLoose("nobody of that name", "Rahul Jacob"), false);
  assert.equal(startsMidSentence("albeit with a trace"), true); assert.equal(startsMidSentence("  The article"), false);
  const g = normalizeGroups({ groups: [
    { blocks: [1, 2, 4], headline: "Why the global economy is facing an unusual paradox", writer: "RAHUL JACOB" },
    { blocks: [3, 99, 3], headline: "x", writer: "" },            // only one real block: not a group
    { blocks: [2, 3], headline: "reuse", writer: "" },           // block 2 is already in a group
  ] }, blocks);
  assert.deepEqual(g, [{ ids: [title.id, col1.id, col3.id], headline: "Why the global economy is facing an unusual paradox", writer: "Rahul Jacob" }]);
  const bad = normalizeGroups({ groups: [{ blocks: [1, 2], headline: "A headline that is not in the text", writer: "Invented Person" }] }, blocks);
  assert.deepEqual(bad, [{ ids: [title.id, col1.id], headline: "", writer: "" }], "a headline or writer the text does not contain is dropped");
  const label = normalizeGroups({ groups: [{ blocks: [1, 2], headline: "OUR VIEW", writer: "Staff Reporter" }] }, blocks);
  assert.deepEqual(label, [{ ids: [title.id, col1.id], headline: "", writer: "" }], "a section label is not a headline and a desk credit is not a writer");
  assert.equal(normalizeGroups({ groups: [{ blocks: [1, 2, 3, 4, 1, 2, 3, 4, 1], headline: "", writer: "" }] }, blocks).length, 1);
  assert.deepEqual(normalizeGroups({ groups: [{ blocks: Array.from({ length: 9 }, (_, i) => i + 1) }] }, Array.from({ length: 9 }, (_, i) => ({ id: "i" + i, words: 1, body: "x" }))), [], "more than eight blocks is not a plausible article");
});

function seeded() {
  const s = new Store(":memory:");
  const rows = [title, col1, other, col3].map((b) => ({ id: b.id, source: "Livemint", date: "2026-10-22", page: 20, headline: b.headline, body: b.body, hash: b.id, words: b.words, candidate: b.words >= 60, signals: [] }));
  s.putOcrArticles(rows);
  return s;
}

test("layout: pages with a continuation block are found once, and only that page's blocks are read in order", () => {
  const s = seeded();
  const pages = s.ocrPagesToAssemble();
  assert.deepEqual(pages.map((p) => [p.source, p.date, p.page]), [["Livemint", "2026-10-22", 20]]);
  assert.deepEqual(s.ocrPageBlocks("Livemint", "2026-10-22", 20).map((b) => b.id), [title.id, col1.id, other.id, col3.id], "extraction order, by the article number");
  s.close();
});

test("layout: a group becomes one article that keeps the printed title and writer; its parts stop counting on their own", async () => {
  const s = seeded();
  s.putOcrKinds([{ id: col1.id, kind: "opinion", author: "" }, { id: other.id, kind: "analysis", author: "" }, { id: col3.id, kind: "opinion", author: "Annie Lowrey" }], "m");
  s.putOcrMatches("bcg", [{ articleId: col3.id, oppKey: "bcg|Risk|t:1", fit: 0.9, angle: "x" }]);
  const reader = { groupBlocks: async (bl) => normalizeGroups({ groups: [{ blocks: [1, 2, 4], headline: "Why the global economy is facing an unusual paradox", writer: "Rahul Jacob" }] }, bl) };
  const r = await assemble({ store: s, reader });
  assert.deepEqual([r.pages, r.groups, r.parts, r.failed], [1, 1, 3, 0]);
  const gid = "Livemint|2026-10-22|g1";
  const whole = s.ocrArticle(gid);
  assert.equal(whole.headline, "Why the global economy is facing an unusual paradox"); assert.equal(whole.author, "Rahul Jacob"); assert.equal(whole.titleSource, "printed");
  assert.equal(whole.original, title.headline, "the OCR's own headline is kept alongside");
  assert.ok(whole.body.indexOf("RAHULJACOB") < whole.body.indexOf("albeit") && whole.body.indexOf("albeit") < whole.body.indexOf("40-month"), "title block first, then the columns in order");
  assert.equal(whole.words, 17 + 80 + 60);
  for (const id of [title.id, col1.id, col3.id]) assert.equal(s.ocrArticle(id).kind, "part", id);
  assert.equal(s.ocrArticle(other.id).kind, "analysis", "a block outside the group is untouched");
  assert.deepEqual(s.ocrUnclassified().map((a) => a.id), [gid], "the whole article is the one to judge now");
  assert.equal(s.ocrMatchesByOpp("bcg", "2026-10-01").size, 0, "the parts' old angle matches are dropped");
  // judging the whole keeps the writer read from the title block, and the parts no longer appear as authored pieces
  s.putOcrKinds([{ id: gid, kind: "opinion", author: "" }], "m");
  assert.equal(s.ocrArticle(gid).author, "Rahul Jacob", "an empty writer from the judgement does not wipe the one read from the page");
  assert.deepEqual(s.ocrAuthored().map((a) => a.id).sort(), [gid, other.id].sort());
  assert.deepEqual(s.ocrPagesToAssemble(), [], "the page is not looked at again");
  s.close();
});

test("layout: a page the model finds nothing on is still recorded as looked at, and a failing page is retried", async () => {
  const s = seeded();
  let calls = 0;
  const reader = { groupBlocks: async () => { calls++; if (calls === 1) throw new Error("boom"); return []; } };
  const first = await assemble({ store: s, reader });
  assert.equal(first.failed, 1); assert.equal(s.ocrPagesToAssemble().length, 1, "a failed page stays on the list");
  const second = await assemble({ store: s, reader });
  assert.deepEqual([second.groups, second.failed], [0, 0]); assert.equal(s.ocrPagesToAssemble().length, 0);
  s.close();
});

test("layout: an authored piece whose headline looks wrong brings its page into the list even with no mid-sentence block", () => {
  const s = new Store(":memory:");
  s.putOcrArticles([{ id: "Hindu|2026-10-22|1", source: "The Hindu", date: "2026-10-22", page: 8, headline: "OPINION 7", body: "A full start of an article. ".repeat(40), hash: "a", words: 200, candidate: true, signals: [] }]);
  assert.equal(s.ocrPagesToAssemble(1e9, isWeakHeadline).length, 0, "nothing is judged yet, so no authored piece to flag");
  s.putOcrKinds([{ id: "Hindu|2026-10-22|1", kind: "opinion", author: "" }], "m");
  assert.equal(s.ocrPagesToAssemble(1e9, isWeakHeadline).length, 1);
  s.close();
});

test("reader: layout grouping goes to Groq only when routed there (it is routed to Claude by default config)", async () => {
  const mk = (routing) => { const r = new Reader({ impact_areas: ["economy"], fronts: {}, practice_areas: [] }, { list: () => [] }, null, { routing }); r.chain = ["anthropic"]; r.provider = "anthropic"; r.apiKey = "k"; r.groqKey = "g"; r.groqOk = true; return r; };
  assert.equal(mk({ ocrAssemble: "claude" }).routeFor("ocrAssemble"), null);
  assert.equal(mk({ ocrAssemble: "groq" }).routeFor("ocrAssemble"), "groq");
  const calls = [], real = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => { calls.push(String(url)); return { ok: true, status: 200, json: async () => ({ content: [{ type: "tool_use", input: { groups: [{ blocks: [1, 2], headline: "", writer: "" }] } }], usage: {} }), text: async () => "" }; };
    const out = await mk({ ocrAssemble: "claude" }).groupBlocks([{ id: "a", words: 5, body: "one" }, { id: "b", words: 5, body: "two" }]);
    assert.deepEqual(out, [{ ids: ["a", "b"], headline: "", writer: "" }]); assert.match(calls[0], /api\.anthropic\.com/);
  } finally { globalThis.fetch = real; }
});
