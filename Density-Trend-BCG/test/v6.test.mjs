// Print-edition (OCR) articles: authored/opinion detection, angle matching, and the headroom built from the authored count.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { looksAuthored, isCandidate, excerpt, articleRows, dateRange } from "../src/ocr.mjs";
import { normalizeArticleKinds, normalizeAngleMatches, normalizeAuthors, cleanAuthor, Reader } from "../src/llm.mjs";
import { shortlist } from "../src/ocrjobs.mjs";
import { labelComponents } from "../src/opportunity.mjs";
import { Store } from "../src/db.mjs";
import { BracketRegistry } from "../src/brackets.mjs";

const J = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const cfg = J("../config/hivemind.json"), bcg = J("../config/bcg.json"), seed = J("../config/brackets.seed.json");
// the pure formula, with the damping switched off (the shipped config damps the zero-authored case: see the last headroom test)
const plain = { ...cfg, ocr: { ...cfg.ocr, whitespaceMax: 100, unvalidatedFactor: 1 } };
const words = (n) => Array.from({ length: n }, (_, i) => "word" + i).join(" ");

test("ocr: rules pick candidates, but a reporter credit alone never decides the kind", () => {
  assert.ok(looksAuthored({ headline: "Why India must rethink coal", body: "By Jane Doe\nThe argument…" }).includes("byline"));
  assert.ok(looksAuthored({ headline: "x", body: words(80) + " the end. — Vasantha Kumar" }).includes("signature"));
  assert.ok(looksAuthored({ headline: "OPINION: a view", body: "text" }).includes("label in headline"));
  assert.deepEqual(looksAuthored({ headline: "Sensex falls", body: "Mumbai: Shares fell on Tuesday." }), []);
  assert.equal(isCandidate({ headline: "h", body: words(40) }), false, "briefs are skipped");
  assert.equal(isCandidate({ headline: "h", body: words(220) }), true, "long pieces are judged even with no byline");
  assert.equal(isCandidate({ headline: "h", body: words(70) + ". — Jane Roe" }), true, "a short signed piece is judged");
  assert.ok(excerpt({ body: words(1000) }).includes("[…]") && excerpt({ body: "short text" }) === "short text");
});

test("ocr: the export is flattened to stable rows and the date range is inclusive", () => {
  const rows = articleRows({ articles: [{ id: "7", headline: " H ", body_text: "B", page_number: 3, content_hash: "h" }, { id: "8", headline: "", body_text: "" }] }, "Livemint", "2026-10-20");
  assert.deepEqual(rows, [{ id: "Livemint|2026-10-20|7", source: "Livemint", date: "2026-10-20", page: 3, headline: "H", body: "B", hash: "h" }]);
  assert.deepEqual(dateRange("2026-10-30", "2026-11-02"), ["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
});

test("llm: article kinds and angle matches are validated against what was asked", () => {
  const batch = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const kinds = normalizeArticleKinds({ items: [{ n: 1, kind: "opinion", author: "Jane Doe", why: "argues" }, { n: 2, kind: "news", author: "Reporter", why: "x" }, { n: 3, kind: "bogus" }, { n: 9, kind: "opinion" }, { n: 1, kind: "news" }] }, batch);
  assert.deepEqual(kinds, [{ id: "a", kind: "opinion", author: "Jane Doe", why: "argues" }, { id: "b", kind: "news", author: "", why: "" }]);
  const ab = [{ id: "a", candidates: [{ id: "c1", oppKey: "bcg|Energy|t:1" }, { id: "c2", oppKey: "bcg|Energy|t:2" }] }, { id: "b", candidates: [{ id: "c1", oppKey: "bcg|X|t:3" }] }, { id: "c", candidates: [{ id: "c1", oppKey: "k" }] }];
  const m = normalizeAngleMatches({ items: [{ n: 1, angle: "c2", fit: 0.8 }, { n: 2, angle: "none", fit: 0.9 }, { n: 3, angle: "c1", fit: 0.2 }] }, ab);
  assert.deepEqual(m, [{ id: "a", oppKey: "bcg|Energy|t:2", fit: 0.8 }]);
});

test("ocr: an article is shortlisted only against angles that share its topic words", () => {
  const opp = (key, name, angle) => ({ key, label: { name }, sector: "Energy", angle });
  const opps = [opp("k1", "coal power", "Should India phase out coal power plants"), opp("k2", "repo rate", "What a rate cut means for borrowers"), opp("k3", "monsoon", "Rain and food prices")];
  const a = { headline: "India cannot phase out coal power yet", body: "An argument about coal power and the grid in India. " + words(100) };
  assert.deepEqual(shortlist(a, opps).map((o) => o.key), ["k1"]);
  assert.deepEqual(shortlist({ headline: "Cricket final", body: "bat and ball" }, opps), []);
});

test("headroom: authored articles on the angle use up the room; with no print data the old share rule applies", () => {
  const m = { ratio: 2, accel: 0, originsRecent: 4, sharePercentile: 0.2, stage: "crowded" };
  const sector = { score: 50, raw: 0.5, note: "" }, at = (authored) => labelComponents(m, { trigger: null, sector, authored }, plain);
  assert.equal(at({ count: 0, cap: 5 }).headroom, 100, "nobody has written it: full headroom, even for a crowded topic");
  assert.equal(at({ count: 2, cap: 5 }).headroom, 60);
  assert.equal(at({ count: 9, cap: 5 }).headroom, 0);
  assert.equal(at(null).headroom, 30, "no print data: share percentile 0.2 gives 80, capped at 30 for a crowded topic");
  assert.ok(at({ count: 0, cap: 5 }).score > at({ count: 4, cap: 5 }).score, "more headroom, more points");
  assert.match(at({ count: 1, cap: 5 }).comp.headroom.note, /1 authored article on this angle/);
});

test("headroom: the validated view is the mirror image, and it scores the same count the other way round", () => {
  const m = { ratio: 2, accel: 0, originsRecent: 4, sharePercentile: 0.2, stage: "rising" };
  const sector = { score: 50, raw: 0.5, note: "" }, at = (count, mode) => labelComponents(m, { trigger: null, sector, authored: { count, cap: 5, mode } }, plain);
  for (const n of [0, 1, 3, 5, 8]) assert.equal(at(n, "validated").headroom + at(n, "whitespace").headroom, 100, `count ${n}`);
  assert.equal(at(0, "validated").headroom, 0, "no writer has made the case yet");
  assert.equal(at(5, "validated").headroom, 100);
  assert.ok(at(4, "validated").score > at(1, "validated").score, "validated: more written, more points");
  assert.ok(at(1, "whitespace").score > at(4, "whitespace").score, "whitespace: less written, more points");
  assert.match(at(3, "validated").comp.headroom.note, /3 authored articles already on this angle: validated/);
  assert.match(at(0, "whitespace").comp.headroom.note, /open ground/);
});

test("store: print articles are kept, judged once, and counted per suggested angle inside the window", () => {
  const s = new Store(":memory:");
  const row = (id, date, extra = {}) => ({ id, source: "The Hindu", date, page: 8, headline: "H " + id, body: "B", hash: id, words: 300, candidate: true, signals: [], ...extra });
  assert.equal(s.putOcrArticles([row("a", "2026-10-26"), row("b", "2026-10-27"), row("c", "2026-10-27"), row("d", "2026-10-27", { candidate: false, words: 10 })]), 4);
  assert.equal(s.putOcrArticles([row("a", "2026-10-26")]), 0, "a re-download does not duplicate");
  s.markOcrNonCandidates();
  assert.deepEqual(s.ocrUnclassified().map((r) => r.id).sort(), ["a", "b", "c"]);
  s.putOcrKinds([{ id: "a", kind: "opinion", author: "X" }, { id: "b", kind: "analysis", author: "Y" }, { id: "c", kind: "news" }], "m");
  assert.equal(s.ocrUnclassified().length, 0);
  assert.deepEqual(s.ocrAuthored().map((r) => r.id).sort(), ["a", "b"]);
  const c = s.ocrCounts(); assert.equal(c.authored, 2); assert.equal(c.opinion, 1); assert.equal(c.analysis, 1); assert.equal(c.total, 4);
  s.putOcrMatches("bcg", [{ articleId: "a", oppKey: "bcg|Energy|t:1", fit: 0.9, angle: "ang" }, { articleId: "b", oppKey: "bcg|Energy|t:1", fit: 0.6 }, { articleId: "x", oppKey: "-", fit: 0 }]);
  assert.equal(s.ocrMatchesByOpp("bcg", "2026-10-20").get("bcg|Energy|t:1").length, 2);
  assert.equal(s.ocrMatchesByOpp("bcg", "2026-10-27").get("bcg|Energy|t:1").length, 1, "only articles inside the window count");
  assert.ok(s.ocrMatchedIds("bcg").has("x"), "'matched to nothing' is remembered");
  s.putOcrMatches("bcg", [{ articleId: "a", oppKey: "bcg|Energy|t:2", fit: 0.7 }]);
  assert.equal(s.ocrMatchesByOpp("bcg", "2026-10-20").get("bcg|Energy|t:1").length, 1, "re-matching replaces an article's earlier matches");
  assert.ok(s.ocrHasData("2026-10-20") && !s.ocrHasData("2026-11-20"));
  s.close();
});

test("reader: classifying and matching go to Groq first (routing) and record its tokens", async () => {
  const usage = [], r = new Reader(bcg, new BracketRegistry(null, seed), null, { routing: { ocrClassify: "groq", ocrMatch: "groq" }, onUsage: (n, u) => usage.push([n, u]) });
  r.chain = ["anthropic"]; r.provider = "anthropic"; r.apiKey = "k"; r.groqKey = "g"; r.groqOk = true;
  const calls = [], real = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => { calls.push(String(url)); return { ok: true, status: 200, json: async () => ({ choices: [{ message: { tool_calls: [{ function: { arguments: JSON.stringify({ items: [{ n: 1, kind: "opinion", author: "Jane Doe", why: "w" }] }) } }] } }], usage: { prompt_tokens: 100, completion_tokens: 20 } }), text: async () => "" }; };
    const out = await r.classifyArticles([{ id: "x", source: "The Hindu", page: 8, headline: "h", signals: [], excerpt: "e" }]);
    assert.deepEqual(out, [{ id: "x", kind: "opinion", author: "Jane Doe", why: "w" }]);
    assert.match(calls[0], /api\.groq\.com/); assert.equal(usage[0][0], "groq");
  } finally { globalThis.fetch = real; }
});

test("headroom: zero authored pieces no longer fires the score up (open ground is capped, and the validated view scales it down)", () => {
  const m = { ratio: 2, accel: 0, originsRecent: 4, sharePercentile: 0.2, stage: "rising" };
  const sector = { score: 50, raw: 0.5, note: "" }, at = (count, mode) => labelComponents(m, { trigger: null, sector, authored: { count, cap: 5, mode } }, cfg);
  assert.equal(cfg.ocr.whitespaceMax, 60); assert.equal(cfg.ocr.unvalidatedFactor, 0.75);
  assert.equal(at(0, "whitespace").headroom, 60, "nobody has written it: capped at whitespaceMax, not 100");
  assert.equal(at(5, "whitespace").headroom, 0); assert.equal(at(2, "whitespace").headroom, 36);
  assert.ok(at(0, "whitespace").score > at(3, "whitespace").score, "still: fewer pieces, more points");
  const zero = at(0, "validated"), one = at(1, "validated");
  assert.ok(Math.abs(zero.score - 0.75 * labelComponents(m, { trigger: null, sector, authored: { count: 0, cap: 5, mode: "validated" } }, plain).score) < 1e-9, "no piece validates it: the whole score is scaled by 0.75");
  assert.ok(one.score > zero.score, "validated: an angle with one piece beats an otherwise identical angle with none");
  assert.match(zero.comp.headroom.note, /scaled ×0.75/);
  const pts = Object.values(zero.comp).reduce((a, c) => a + c.points, 0); assert.ok(Math.abs(pts - zero.score) < 1e-9, "the factor points still add up to the score");
});

test("authors: writer names are cleaned, joint bylines kept, and desk credits and job titles rejected", () => {
  assert.equal(cleanAuthor("Seema Sirohi"), "Seema Sirohi");
  assert.equal(cleanAuthor("TARANJIT SINGH SANDHU"), "Taranjit Singh Sandhu");
  assert.equal(cleanAuthor("rama bijapurkar"), "Rama Bijapurkar");
  assert.equal(cleanAuthor("By Jane Doe"), "Jane Doe");
  assert.equal(cleanAuthor("soumya kanti ghosh & shashidharan sharma"), "Soumya Kanti Ghosh, Shashidharan Sharma");
  assert.equal(cleanAuthor("abhishek anand, praveen ravi, navneeraj sharma & arvind subramanian"), "Abhishek Anand, Praveen Ravi, Navneeraj Sharma, Arvind Subramanian");
  for (const bad of ["", "Staff Reporter", "Times News Network", "PTI", "Invitation", "independent journalist", "The Hindu Bureau", "A, B, C, D, E", "Name 42"]) assert.equal(cleanAuthor(bad), "", JSON.stringify(bad));
  const batch = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.deepEqual(normalizeAuthors({ items: [{ n: 1, author: "Kamlesh Tripathi" }, { n: 2, author: "Staff Reporter" }, { n: 9, author: "X Y" }, { n: 1, author: "Other Name" }] }, batch), [{ id: "a", author: "Kamlesh Tripathi" }, { id: "b", author: "" }]);
});

test("store: authored pieces without a writer are looked at once, and the result is kept", () => {
  const s = new Store(":memory:");
  const row = (id) => ({ id, source: "The Hindu", date: "2026-10-27", page: 6, headline: "H " + id, body: "Seema Sirohi\n" + "word ".repeat(100), hash: id, words: 100, candidate: true, signals: [] });
  s.putOcrArticles([row("a"), row("b"), row("c")]);
  s.putOcrKinds([{ id: "a", kind: "opinion", author: "" }, { id: "b", kind: "analysis", author: "Known Writer" }, { id: "c", kind: "news" }], "m");
  assert.deepEqual(s.ocrNeedingAuthor().map((r) => r.id), ["a"], "only authored pieces with no writer; news and named pieces are skipped");
  assert.match(s.ocrNeedingAuthor()[0].start, /^Seema Sirohi/);
  s.putOcrAuthors([{ id: "a", author: "Seema Sirohi" }]);
  assert.equal(s.ocrNeedingAuthor().length, 0);
  assert.equal(s.ocrAuthored().find((r) => r.id === "a").author, "Seema Sirohi");
  s.putOcrAuthors([{ id: "b", author: "" }]);
  assert.equal(s.ocrAuthored().find((r) => r.id === "b").author, "", "an empty answer is stored too, so the piece is not asked about again");
  s.close();
});
