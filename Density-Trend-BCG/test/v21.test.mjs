// Online opinion / analysis pieces: counted per angle next to the print pieces, market notes left out, opinion-page polling, and the reading of
// the text (confirm, writer, exact angle). Nothing here touches the network or a model: every fetch and reader is a fake.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Store, dayOf } from "../src/db.mjs";
import { BracketRegistry } from "../src/brackets.mjs";
import { buildOpportunities, onlineOnAngle } from "../src/opportunity.mjs";
import { onlineKind, pollSections, candidates, confirm, matchOnline, capLeft } from "../src/online.mjs";
import { Analytics } from "../src/analytics.mjs";

const J = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const cfg = J("../config/hivemind.json"), pubs = J("../config/publications.json"), seed = J("../config/brackets.seed.json");
const registry = new BracketRegistry(null, seed), HOUR = 3600e3, NOW = Date.UTC(2026, 9, 28, 12);
const item = (id, o = {}) => ({ id, title: "Why the policy fails", url: "https://x/" + id, at: NOW - 5 * HOUR, outlets: ["The Hindu"], contentType: "opinion", ...o });
const OPP = "acme|Energy|t:ev-charging";

test("kind: the model's label counts, market notes do not, a headline cue does, a read text outranks the label", () => {
  assert.deepEqual(onlineKind(item("a")), { kind: "opinion", by: "label" });
  assert.deepEqual(onlineKind(item("a", { contentType: "analysis", title: "Reliance: target price Rs 1,700, analysts say buy" })), null, "a stock note is not an authored piece");
  assert.deepEqual(onlineKind(item("a", { contentType: "analysis", title: "Why rate cuts matter" })), { kind: "analysis", by: "label" });
  assert.deepEqual(onlineKind(item("a", { contentType: "reported", title: "Opinion: the budget gap" })), { kind: "opinion", by: "cue" });
  assert.deepEqual(onlineKind(item("a", { contentType: "reported", title: "Explained: why the rupee fell" })), { kind: "analysis", by: "cue" });
  assert.equal(onlineKind(item("a", { contentType: "reported", title: "Police arrest two men" })), null);
  assert.equal(onlineKind(item("a"), { kind: "news" }), null, "the text was read and it is reported news");
  assert.deepEqual(onlineKind(item("a", { contentType: "reported" }), { kind: "analysis", source: "text" }), { kind: "analysis", by: "text" });
  assert.deepEqual(onlineKind(item("a", { contentType: "reported", title: "Plain headline" }), { source: "section" }), { kind: "opinion", by: "section" });
});

test("angle: a piece matched to other angles does not count here; an unmatched one counts for the topic; old ones and demoted ones do not", () => {
  const list = [item("matched-here"), item("matched-elsewhere"), item("unmatched"), item("old", { at: NOW - 9 * 864e5 }), item("demoted"), item("news", { contentType: "reported", title: "Plain" })];
  const onl = { windowDays: 7, pieces: new Map([["demoted", { kind: "news" }], ["unmatched", { kind: "opinion", author: "A. Rao", source: "text" }]]), matches: new Map([["matched-here", [{ oppKey: OPP }]], ["matched-elsewhere", [{ oppKey: "acme|Retail|t:other" }]], ["demoted", [{ oppKey: OPP }]]]) };
  const got = onlineOnAngle(list, OPP, onl, NOW);
  assert.deepEqual(got.map((x) => x.id).sort(), ["matched-here", "unmatched"]);
  assert.equal(got.find((x) => x.id === "matched-here").exact, true);
  assert.equal(got.find((x) => x.id === "unmatched").author, "A. Rao");
  // a broad area (b:) is not credited with every piece in it: only pieces matched to that exact angle count
  const broadKey = "acme|Public Sector|b:governance";
  onl.matches.set("matched-here", [{ oppKey: broadKey }]);
  assert.deepEqual(onlineOnAngle(list, broadKey, onl, NOW).map((x) => x.id), ["matched-here"]);
});

function topicLabel() {
  return { key: "t:ev-charging", level: "topic", id: "ev-charging", parent: null, count: 8, countPrev: 2, total: 400, share: 0.02, baseShare: 0.004, ratio: 5, ratioPrev: 3, accel: 1.2, originsRecent: 6, areaCount: 3, areas: [], fullTextCount: 0, verifiedCount: 2, baselineHours: 100, windowHours: 24, storiesAll: 20,
    sharePercentile: 0.3, stage: "rising", stageRule: "r", evidence: { level: "medium", reasons: [] }, spark: [], weight: 1 };
}
const build = (online, printed = 1) => {
  const company = { id: "acme", name: "Acme", sectors: [{ name: "Energy" }], matches: {} };
  const base = { id: "t1", title: "Charging network expands", url: "u", at: NOW - HOUR, verified: true, originCount: 4, outletCount: 4, primary: false, maxSev: 0.7, horizon: "immediate", summary: "", fullText: false, contentType: "reported" };
  const byOpp = new Map([[OPP, Array.from({ length: printed }, (_, i) => ({ id: "p" + i, source: "Mint", headline: "h", author: "W", kind: "opinion", fit: 0.8 }))]]);
  const topicMatches = new Map([["ev-charging", { judgedAt: 1, storyCount: 8, sectors: [{ sector: "Energy", relevance: 0.8, channel: "direct", front: "supply", why: "w", write_about: "Who pays for charging?" }] }]]);
  return buildOpportunities({ company, matches: {}, analysisResult: { labels: new Map([["t:ev-charging", topicLabel()]]) }, byLabel: new Map([["t:ev-charging", [base, item("o1"), item("o2")]]]), ctx: { cfg, registry, topics: new Map([["ev-charging", { name: "ev charging" }]]) }, asOf: NOW, topicMatches, ocr: { byOpp, cap: 5, mode: "whitespace", windowDays: 7 }, online }).items[0];
};
test("headroom: print and online pieces are added; the split is reported; whitespace score falls as pieces rise; the config switch turns online counting off", () => {
  const onl = { windowDays: 7, pieces: new Map(), matches: new Map() };
  const printOnly = build(null), both = build(onl), off = build({ ...onl, count: false });
  assert.deepEqual([printOnly.authored.count, printOnly.authored.online], [1, 0]);
  assert.deepEqual([both.authored.count, both.authored.print, both.authored.online], [3, 1, 2]);
  assert.ok(both.components.headroom.score < printOnly.components.headroom.score, "more pieces, less open ground");
  assert.match(both.components.headroom.note, /1 print, 2 online/);
  assert.equal(off.authored.count, 1, "online pieces listed but not counted when switched off");
  assert.equal(off.authored.online, 2);
  assert.equal(both.authored.onlineArticles.length, 2);
});

test("db: pieces, matches, section links and the daily count", () => {
  const s = new Store(":memory:");
  const ins = s.db.prepare("INSERT INTO stories (key, title, url, snippet, published_at, day, first_seen, last_seen) VALUES (?, ?, ?, '', ?, ?, ?, ?)");
  for (const k of ["s1", "s2", "s3"]) ins.run(k, "Title " + k, "g/" + k, NOW, dayOf(NOW), NOW, NOW);
  s.db.prepare("INSERT INTO articles (url, story_key, title, outlet, publication, published_at) VALUES ('https://g/1', 's1', 't', 'o', 'The Hindu', ?)").run(NOW);
  assert.equal(s.putSectionPieces([{ url: "https://g/1", title: "Other title", publishedAt: NOW, publication: "The Hindu", section: "/opinion" }, { url: "https://g/9", title: "Title s2", publishedAt: NOW }, { url: "https://g/8", title: "Never collected", publishedAt: NOW }]), 3);
  assert.equal(s.putSectionPieces([{ url: "https://g/1", title: "again", publishedAt: NOW }]), 0, "a repeat is not stored twice");
  s.linkSectionPieces();
  assert.deepEqual([...s.onlineSectionKeys()].sort(), ["s1", "s2"], "linked by link, else by headline; the uncollected one is not linked");
  s.putOnlinePieces([{ key: "s1", kind: "opinion", author: "A. Rao", source: "text", basis: "full-text", excerpt: "text" }, { key: "s2", kind: "news", basis: "full-text" }, { key: "s3", kind: "analysis", source: "label", basis: "headline" }], NOW);
  assert.equal(s.onlineReadOn(dayOf(NOW)), 2, "only pieces whose text was read count towards the cap");
  assert.deepEqual([...s.onlineChecked()].sort(), ["s1", "s2", "s3"]);
  assert.deepEqual(s.onlineUnmatched("acme").map((r) => r.key).sort(), ["s1", "s3"], "reported news is never matched");
  s.putOnlineMatches("acme", [{ storyKey: "s1", oppKey: OPP, fit: 0.9, angle: "a" }, { storyKey: "s3", oppKey: "-", fit: 0 }]);
  assert.deepEqual(s.onlineUnmatched("acme"), [], "both are now judged, one with no angle");
  assert.deepEqual(s.onlineMatches("acme").get("s1"), [{ oppKey: OPP, fit: 0.9 }]);
  assert.equal(s.onlineStats("0000").named, 1);
  assert.equal(capLeft(s, 150, NOW), 148);
  assert.equal(capLeft(s, 1, NOW), 0);
  s.close();
});

test("sections: only papers with an opinion path are asked; one that fails is skipped; the query is the paper's domain plus the path", async () => {
  const asked = [];
  const fetchPub = async (p) => { asked.push(p.domain); if (p.domain.startsWith("livemint")) throw new Error("HTTP 503"); return [{ title: "t", url: "u" + p.domain, publishedAt: NOW, publication: p.name, outlet: p.name }]; };
  const out = await pollSections(pubs, { fetchPub });
  const withPath = pubs.filter((p) => p.opinionPath);
  assert.equal(withPath.length, 11);
  assert.equal(asked.length, withPath.length);
  assert.ok(asked.includes("thehindu.com/opinion") && asked.includes("indianexpress.com/article/opinion"));
  assert.equal(out.length, withPath.length - 1);
  assert.ok(out.every((x) => x.section.startsWith("/")));
});

test("candidates: the daily cap and already-read pieces are respected, newest first", () => {
  const s = new Store(":memory:");
  const items = [item("n1", { at: NOW - 1 * HOUR }), item("n2", { at: NOW - 2 * HOUR }), item("n3", { at: NOW - 3 * HOUR }), item("done", { at: NOW - HOUR }), item("rep", { contentType: "reported", title: "Plain" })];
  s.putOnlinePieces([{ key: "done", kind: "opinion" }], NOW);
  const picks = candidates({ items, store: s, windowDays: 7, asOf: NOW, cap: 2 });
  assert.deepEqual(picks.map((p) => p.item.id), ["n1", "n2"]);
  assert.deepEqual(candidates({ items, store: s, windowDays: 7, asOf: NOW, cap: 0 }), []);
  s.close();
});

test("confirm: text read, label confirmed or demoted, writer kept; a missing text keeps the label; the reader only gets the text it needs", async () => {
  const s = new Store(":memory:");
  const picks = ["ok", "news", "notext"].map((id) => ({ item: item(id), label: { kind: "opinion", by: "label" } }));
  const seen = [];
  const reader = { classifyArticles: async (b) => { seen.push(...b); return b.map((x) => (x.id === "news" ? { id: x.id, kind: "news", author: "", why: "" } : { id: x.id, kind: "analysis", author: "S. Menon", why: "w" })); } };
  const fetchBody = async (a) => (a.url.endsWith("notext") ? { text: "", basis: "headline" } : { text: "word ".repeat(500), basis: "full-text" });
  const r = await confirm({ store: s, reader, picks, fetchBody });
  assert.deepEqual([r.looked, r.fetched, r.noText, r.confirmed, r.demoted, r.named], [3, 2, 1, 1, 1, 1]);
  assert.deepEqual(seen.map((x) => x.id).sort(), ["news", "ok"], "no model call for a piece without text");
  assert.ok(seen.every((x) => x.excerpt.length < 1000), "only the start and end of the text go to the model");
  const p = s.onlinePieces();
  assert.deepEqual([p.get("ok").kind, p.get("ok").author, p.get("news").kind, p.get("notext").kind, p.get("notext").basis], ["analysis", "S. Menon", "news", "opinion", "headline"]);
  // a failing reader loses nothing and writes nothing for that batch
  const s2 = new Store(":memory:");
  const bad = await confirm({ store: s2, reader: { classifyArticles: async () => { throw new Error("Groq 400"); } }, picks: [picks[0]], fetchBody, log: () => {} });
  assert.equal(bad.failed, 1); assert.equal(s2.onlineChecked().size, 0, "a failed batch is retried next time");
  s.close(); s2.close();
});

test("matchOnline: only confirmed pieces with a shortlisted angle reach the model; no-candidate pieces are recorded as none", async () => {
  const s = new Store(":memory:");
  const ins = s.db.prepare("INSERT INTO stories (key, title, url, snippet, published_at, day, first_seen, last_seen) VALUES (?, ?, ?, '', ?, ?, ?, ?)");
  ins.run("a", "Who pays for EV charging", "u", NOW, dayOf(NOW), NOW, NOW); ins.run("b", "Cricket selection row", "u", NOW, dayOf(NOW), NOW, NOW);
  s.putOnlinePieces([{ key: "a", kind: "opinion", excerpt: "electric vehicle charging network costs and subsidies", basis: "full-text" }, { key: "b", kind: "opinion", excerpt: "selectors and the team", basis: "full-text" }], NOW);
  const opps = [{ key: OPP, label: { name: "EV charging" }, sector: "Energy", angle: "Who pays for the charging network?" }];
  const asked = [];
  const reader = { matchAngles: async (batch) => { asked.push(...batch.map((x) => x.id)); return batch.map((x) => ({ id: x.id, oppKey: OPP, fit: 0.8 })); } };
  const r = await matchOnline({ store: s, reader, analytics: { opportunities: () => ({ items: opps }), cache: new Map() } });
  assert.deepEqual(asked, ["a"]);
  assert.deepEqual([r.pieces, r.shortlisted, r.matched], [2, 1, 1]);
  assert.deepEqual(s.onlineMatches("acme").get("b"), undefined);
  assert.deepEqual(s.onlineMatches("bcg").get("b"), [{ oppKey: "-", fit: 0 }], "remembered as judged, with no angle");
  assert.deepEqual(s.onlineMatches("bcg").get("a").map((x) => x.oppKey), [OPP]);
  s.close();
});

test("leadership: trending angles split into written and open, with writers and the print/online counts", () => {
  const o = (key, topic, over = {}) => ({ key, label: { name: topic, parentName: "Area" }, sector: "Energy", angle: "an angle", score: 70, stage: "rising", action: "monitor", metrics: { ratio: 3, accel: 0.1, originsRecent: 5 }, spark: [], trigger: null, stories: [], authored: { print: 0, online: 0, count: 0, articles: [], onlineArticles: [], mode: "whitespace" }, ...over });
  const written = o("k1", "EV charging", { score: 80, authored: { print: 1, online: 2, count: 3, mode: "whitespace", articles: [{ id: "p1", source: "Mint", headline: "h", author: "W. One", date: "2026-10-27" }], onlineArticles: [{ title: "t", url: "u", outlet: "The Hindu", author: "W. One", kind: "opinion", exact: true, at: NOW }, { title: "t2", url: "u2", outlet: "ET", author: "", kind: "analysis", at: NOW }] } });
  const open = o("k2", "Dam safety", { score: 60 }), skipped = o("k3", "Old news", { action: "skip" }), steady = o("k4", "Steady", { stage: "steady" }), nextUp = o("k5", "Satellite navigation", { stage: "emerging", score: 50, metrics: { ratio: 1.9, accel: 1.88, originsRecent: 3 } });
  const ctxObj = { asOf: NOW }; // the real context is one cached object, so the cache can tell it has not changed
  const fake = { context: () => ctxObj, opportunities: () => ({ items: [written, open, skipped, steady, nextUp] }), store: { lastWebCheck: (t) => (t === "ev charging" ? { at: NOW, total: 12, outlets: 7, outsideOurSources: ["x"], top: [{ title: "T", link: "l", source: "S" }] } : null), onlineStats: () => ({ checked: 9, read: 4, authored: 3, named: 1, sections: 20 }), onlineReadOn: () => 4 }, cfg: { ocr: { windowDays: 7 }, online: { analyze: false, dailyCap: 150 } }, pubs };
  const L = Analytics.prototype._leadership.call(fake, "bcg", null, null);
  assert.deepEqual(L.counts, { trending: 3, written: 1, open: 2, print: 1, online: 2 });
  assert.deepEqual(L.written.map((r) => r.topic), ["EV charging"]);
  assert.deepEqual(L.open.map((r) => r.topic), ["Dam safety", "Satellite navigation"]);
  assert.deepEqual(L.next.map((r) => r.topic), ["Satellite navigation"], "emerging or accelerating");
  assert.ok("sources" in L.written[0] && !("pieces" in L.written[0]) && !("writers" in L), "only what the page shows");
  // repeat calls are served from the cache for a minute, and a cleared cache recomputes
  const cached = { ...fake, cache: new Map(), _leadership: (...a) => { cached.calls = (cached.calls ?? 0) + 1; return Analytics.prototype._leadership.apply(fake, a); } };
  Analytics.prototype.leadership.call(cached, {}); Analytics.prototype.leadership.call(cached, {}); assert.equal(cached.calls, 1);
  cached.cache.clear(); Analytics.prototype.leadership.call(cached, {}); assert.equal(cached.calls, 2);
  assert.equal(L.hot.length, 1); assert.equal(L.hot[0].web.outside, 1);
  assert.deepEqual([L.online.analyze, L.online.sectionsOn, L.online.readToday], [false, 11, 4]);
});

test("config: the paid reading of online pieces is off by default, capped, and opinion pages are polled for free", () => {
  assert.equal(cfg.online.analyze, false);
  assert.equal(cfg.online.sectionRead, false);
  assert.ok(cfg.online.dailyCap > 0 && cfg.online.dailyCap <= 200);
  assert.equal(cfg.online.sections, true);
  assert.equal(cfg.online.countInHeadroom, true);
});

test("pieces: the list behind a chip is the same set the count came from, split into print and online", () => {
  const key = "acme|Energy|t:ev-charging";
  const printed = [{ id: "p1", source: "Mint", headline: "h", author: "W", kind: "opinion", fit: 0.8 }];
  const fake = { context: () => ({ asOf: NOW, byLabel: new Map([["t:ev-charging", [item("o1"), item("o2"), item("rep", { contentType: "reported", title: "Plain" })]]]) }), company: () => ({ id: "acme" }),
    ocrHeadroom: () => ({ byOpp: new Map([[key, printed]]) }), onlineContext: () => ({ windowDays: 7, pieces: new Map(), matches: new Map() }), labelName: () => "EV charging", cfg: { ocr: { windowDays: 7 } } };
  const d = Analytics.prototype.pieces.call(fake, { key });
  assert.deepEqual([d.print.length, d.online.length, d.topic, d.sector], [1, 2, "EV charging", "Energy"]);
  assert.deepEqual(Analytics.prototype.pieces.call(fake, {}), { print: [], online: [] });
});
