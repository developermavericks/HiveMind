import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseGoogleNews, extractArticleText, dayQuery } from "../src/gnews.mjs";
import { clusterArticles } from "../src/cluster.mjs";
import { BracketRegistry, norm } from "../src/brackets.mjs";
import { normalizeReading, normalizeMatches, normalizeMerges, extractJson } from "../src/llm.mjs";
import { parseSectors, CompanyStore, needsMatch } from "../src/companies.mjs";
import { Store, titleKey, dayStart, DAY_MS } from "../src/db.mjs";
import { DatabaseSync } from "node:sqlite";
import { buildBracketDensity, companyView, gaussianSmooth } from "../src/density.mjs";

const bcg = JSON.parse(readFileSync(new URL("../config/bcg.json", import.meta.url), "utf8"));

// ---------- ingestion ----------
const XML = `<rss><channel>
<item><title>Cyclone Arnab to hit Odisha coast tonight - The Hindu</title><link>https://news.google.com/rss/articles/CBMiX</link>
<pubDate>Mon, 26 Oct 2026 08:00:00 GMT</pubDate><description>&lt;a&gt;Cyclone Arnab to hit Odisha coast tonight&lt;/a&gt;</description><source url="https://thehindu.com">The Hindu</source></item>
<item><title>preprod.financialexpress.com</title><link>https://x</link><pubDate>Mon, 26 Oct 2026 08:00:00 GMT</pubDate></item>
<item><title>No date here - The Hindu</title><link>https://x</link></item></channel></rss>`;

test("parses Google News items, strips outlet suffix, drops bare-domain and undated items", () => {
  const items = parseGoogleNews(XML, "The Hindu");
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "Cyclone Arnab to hit Odisha coast tonight");
});

test("clusters the same story across outlets", () => {
  const mk = (title, outlet, t) => ({ title, outlet, publication: outlet, url: "u" + t, publishedAt: t, snippet: "" });
  const cs = clusterArticles([
    mk("Cyclone Arnab to hit Odisha coast tonight", "The Hindu", 1),
    mk("Cyclone Arnab set to hit Odisha coast tonight, IMD warns", "NDTV", 2),
    mk("RBI keeps repo rate unchanged", "Mint", 3),
  ]);
  assert.equal(cs.length, 2);
  assert.equal(cs.find((c) => c.title.includes("Cyclone")).outlets.length, 2);
});

test("extracts paragraph text and drops scripts", () => {
  const t = extractArticleText(`<script>var a=1</script><p>${"Real article sentence. ".repeat(5)}</p><p>short</p>`);
  assert.match(t, /Real article/);
  assert.doesNotMatch(t, /var a/);
});

test("extractJson tolerates fences and think blocks", () => {
  assert.deepEqual(extractJson('<think>hm</think>```json\n{"a":1}\n```'), { a: 1 });
  assert.equal(extractJson("no json"), null);
});

// ---------- brackets never repeat ----------
test("registry reuses a bracket for the same name, and merges near-duplicate keyword sets", () => {
  const r = new BracketRegistry(null);
  const a = r.resolve({ name: "Retail fuel price pass-through", keywords: ["petrol", "diesel", "fuel price", "excise"] });
  assert.equal(r.resolve({ name: "retail FUEL price pass through!", keywords: [] }), a);
  assert.equal(r.resolve({ name: "Pump price changes for consumers", keywords: ["petrol", "diesel", "fuel price", "omc margins"] }), a);
  assert.equal(r.size, 1);
  assert.ok(r.get(a).keywords.includes("omc margins")); // merged keywords enrich the existing bracket
  const b = r.resolve({ name: "Cyclone and storm disruption", keywords: ["cyclone", "landfall", "evacuation"] });
  assert.notEqual(a, b);
  assert.equal(r.size, 2);
});

test("registry shows only relevant candidates once it is large, and all when small", () => {
  const r = new BracketRegistry(null);
  for (let i = 0; i < 40; i++) r.resolve({ name: `Alpha${i} Beta${i} Gamma${i}`, keywords: [`topic${i}`, `thing${i}`] });
  assert.equal(r.size, 40);
  const c = r.candidates("A story about topic7 and thing7", 10);
  assert.equal(r.get(c[0].id).keywords[0], "topic7");
  assert.ok(c.length <= 22);
  const small = new BracketRegistry(null);
  small.resolve({ name: "Only one", keywords: ["x1", "x2"] });
  assert.equal(small.candidates("anything").length, 1);
});

test("normalizeReading reuses ids, creates brackets via registry, clamps and drops junk", () => {
  const r = new BracketRegistry(null);
  const existing = r.resolve({ name: "Cyclone and storm disruption", keywords: ["cyclone", "landfall"] });
  const n = normalizeReading({
    event_type: "cyclone", summary: "s", geography: ["Odisha", 5],
    impacts: [
      { group: "fishers", area: "people", direction: "negative", severity: 4, horizon: "immediate", bracket_id: existing },
      { group: "ports", area: "infrastructure", direction: "negative", severity: 0.6, bracket_id: "made-up-id", new_bracket: { name: "Port closures and cargo delays", keywords: ["port", "cargo", "closure"] } },
      { group: "x", area: "bogus", severity: 1 },
      { group: "no bracket", area: "economy", severity: 0.2 },
    ],
  }, bcg, r);
  assert.deepEqual(n.geography, ["Odisha"]);
  assert.equal(n.impacts.length, 3);
  assert.equal(n.impacts[0].severity, 1);
  assert.equal(n.impacts[0].bracket, existing);
  assert.equal(r.get(n.impacts[1].bracket).name, "Port closures and cargo delays");
  assert.equal(n.impacts[2].bracket, null);
  assert.equal(r.get(existing).count, 1);
});

test("merging brackets keeps old ids working as aliases and aggregates density under the survivor", () => {
  const r = new BracketRegistry(null);
  const a = r.resolve({ name: "Ethanol blending and biofuel policy", keywords: ["ethanol", "biofuel"] });
  const b = r.resolve({ name: "Flex-fuel vehicle adoption", keywords: ["flex-fuel", "e100"] });
  const c = r.resolve({ name: "Cyclone and storm disruption", keywords: ["cyclone", "landfall"] });
  assert.equal(r.merge(a, [b, "nope", a], "Ethanol and flex-fuel transition"), 1);
  assert.equal(r.size, 2);
  assert.equal(r.canonical(b), a);
  assert.equal(r.get(b).name, "Ethanol and flex-fuel transition");
  assert.ok(r.get(a).keywords.includes("e100"));
  // chains: merging the survivor later repoints earlier aliases
  r.merge(c, [a]);
  assert.equal(r.canonical(b), c);
  assert.equal(r.size, 1);
  // a story filed under two now-merged brackets counts once
  const r2 = new BracketRegistry(null);
  const x = r2.resolve({ name: "Ethanol blending", keywords: ["ethanol"] }), y = r2.resolve({ name: "Flex fuel cars", keywords: ["flex"] });
  r2.merge(x, [y]);
  const d = buildBracketDensity([story("s", 1, "full-text", [imp(x, 0.4), imp(y, 0.7)])], r2, { now: NOW });
  assert.equal(d.brackets.length, 1);
  assert.ok(Math.abs(d.brackets[0].weight - 0.7) < 1e-9);
});

test("normalizeMerges accepts only known ids, each at most once", () => {
  const bs = ["a", "b", "c", "d"].map((id) => ({ id }));
  const out = normalizeMerges({ groups: [
    { keep_id: "a", merge_ids: ["b", "zzz", "a"], name: "New name" },
    { keep_id: "b", merge_ids: ["c"] },       // b already merged away
    { keep_id: "c", merge_ids: ["d", "d"] },
    { keep_id: "ghost", merge_ids: ["c"] },
  ] }, bs);
  assert.deepEqual(out, [{ keep: "a", drop: ["b"], name: "New name" }, { keep: "c", drop: ["d"], name: "" }]);
});

// ---------- company upload parsing ----------
test("parseSectors: line list with Company header and descriptions", () => {
  const p = parseSectors("Company: Acme Bank\n- Retail banking\n- General insurance - motor and health\n3. Travel, Cities and Infrastructure\nretail banking");
  assert.equal(p.name, "Acme Bank");
  assert.deepEqual(p.sectors.map((s) => s.name), ["Retail banking", "General insurance", "Travel, Cities and Infrastructure"]);
  assert.equal(p.sectors[1].description, "motor and health");
});

test("parseSectors: single comma line, CSV with header, JSON", () => {
  assert.deepEqual(parseSectors("Auto, Chemicals; Metals").sectors.map((s) => s.name), ["Auto", "Chemicals", "Metals"]);
  const csv = parseSectors('company,sector,description\nAcme,Energy,"Oil, gas and power"\nAcme,Healthcare,Pharma');
  assert.equal(csv.name, "Acme");
  assert.deepEqual(csv.sectors, [{ name: "Energy", description: "Oil, gas and power" }, { name: "Healthcare", description: "Pharma" }]);
  const j = parseSectors(JSON.stringify({ name: "Zed", sectors: ["A", { name: "B", description: "bb" }] }));
  assert.equal(j.name, "Zed");
  assert.deepEqual(j.sectors.map((s) => s.name), ["A", "B"]);
  assert.deepEqual(parseSectors("").sectors, []);
});

test("normalizeMatches accepts sector names echoed with a description, but not other sectors", () => {
  const company = { sectors: [{ name: "Climate & Sustainability" }, { name: "Travel, Cities and Infrastructure" }, { name: "Travel" }] };
  const out = normalizeMatches({ matches: [{ bracket_id: "cyc", write_about: "w", sectors: [
    { sector: "Climate & Sustainability (Extreme weather, ESG)", relevance: 0.8, channel: "direct", front: "climate_physical", why: "" },
    { sector: "Travel, Cities and Infrastructure (Aviation, Rail)", relevance: 0.6, channel: "direct", front: "infrastructure", why: "" },
    { sector: "Climate Finance", relevance: 0.9, channel: "direct", front: "cost", why: "not the company's sector" },
  ] }] }, bcg, company, [{ id: "cyc" }]);
  assert.deepEqual(out.get("cyc").sectors.map((s) => s.sector), ["Climate & Sustainability", "Travel, Cities and Infrastructure"]); // longest name wins over "Travel"
});

test("a bracket is re-judged only when its stories grew a lot or aged, and skipped when it has none", () => {
  const now = Date.now();
  assert.equal(needsMatch(undefined, { storyCount: 5 }), true);   // never judged
  assert.equal(needsMatch(undefined, { storyCount: 0 }), false);  // nothing in the news
  assert.equal(needsMatch({ basedOn: 10, matchedAt: now }, { storyCount: 12 }), false);
  assert.equal(needsMatch({ basedOn: 10, matchedAt: now }, { storyCount: 18 }), true); // ≥ 1.5× + 3
  assert.equal(needsMatch({ basedOn: 10, matchedAt: now - 7 * 3600e3 }, { storyCount: 11 }), true); // aged and grown
  assert.equal(needsMatch({ basedOn: 10, matchedAt: now - 7 * 3600e3 }, { storyCount: 10 }), false); // aged but unchanged
});

test("stored matches from an older matching version are discarded", () => {
  const dir = mkdtempSync(join(tmpdir(), "co2-"));
  const store = new CompanyStore(dir);
  const c = store.put({ name: "Old Co", sectors: [{ name: "Energy", description: "" }] });
  c.matches = { x: { sectors: [], write_about: "" } }; c.matchVersion = 1; store.save(c);
  assert.deepEqual(store.get("old-co").matches, {});
  assert.deepEqual(store.list().find((x) => x.id === "old-co").matches, {});
});

test("normalizeMatches only accepts the company's own sectors and known brackets", () => {
  const company = { sectors: [{ name: "General insurance" }, { name: "Energy" }] };
  const batch = [{ id: "cyc" }, { id: "fuel" }];
  const out = normalizeMatches({
    matches: [
      { bracket_id: "cyc", sectors: [
        { sector: "general INSURANCE", relevance: 0.8, channel: "indirect", front: "climate_physical", why: "claims", write_about: "How insurers price cyclone risk" },
        { sector: "Aviation", relevance: 0.9, channel: "direct", front: "demand", why: "not ours" },
        { sector: "Energy", relevance: 0.1, channel: "direct", front: "cost", why: "weak" }] },
      { bracket_id: "nope", sectors: [] },
      { bracket_id: "fuel", sectors: [] },
    ],
  }, bcg, company, batch);
  assert.equal(out.size, 2);
  assert.deepEqual(out.get("cyc").sectors.map((s) => s.sector), ["General insurance"]);
  assert.equal(out.get("cyc").sectors[0].write_about, "How insurers price cyclone risk"); // angle belongs to the sector pairing
  assert.deepEqual(out.get("fuel").sectors, []);
});

test("seeded taxonomy: always present, reused by name, never merged away, new broad areas can be added", () => {
  const seed = JSON.parse(readFileSync(new URL("../config/brackets.seed.json", import.meta.url), "utf8"));
  const r = new BracketRegistry(null, seed);
  assert.equal(r.size, seed.length);
  for (const n of ["People", "Education", "Economy", "AI & Tech", "Startups", "Climate"]) assert.ok(r.get(norm(n).replace(/ /g, "-")), `${n} missing`);
  const people = r.get("people").id, economy = r.get("economy").id;
  assert.equal(r.resolve({ name: "people", keywords: [] }), people); // same name → same bracket, no duplicate
  assert.equal(r.merge(economy, [people]), 0); // seeded brackets can't be dropped
  assert.equal(r.size, seed.length);
  const space = r.resolve({ name: "Space", keywords: ["isro", "satellite", "launch"] });
  assert.ok(space && r.size === seed.length + 1);
  assert.equal(r.merge(r.get("security").id, [space]), 1); // extras can be folded into a seed bracket
  assert.equal(r.canonical(space), "security");
  // a persisted registry doesn't duplicate seeds when reloaded with the same seed
  assert.equal(new BracketRegistry(null, seed).size, seed.length);
});

// ---------- density ----------
test("gaussian smoothing spreads a spike and roughly preserves mass", () => {
  const s = gaussianSmooth([0, 0, 0, 10, 0, 0, 0], 1);
  assert.ok(s[3] < 10 && s[2] > 0);
  assert.ok(Math.abs(s.reduce((a, b) => a + b) - 10) < 0.2);
});

const NOW = Date.UTC(2026, 9, 26, 12);
const story = (id, outlets, basis, impacts) => ({
  id, title: id, url: "u", publishedAt: NOW - 3600e3, outlets: Array(outlets).fill("o"), basis,
  analysis: { summary: id, geography: ["Odisha"], impacts },
});
const imp = (bracket, severity, direction = "negative", group = "fishers") => ({ group, area: "people", direction, severity, horizon: "near", bracket });

function fixture() {
  const reg = new BracketRegistry(null);
  const cyc = reg.resolve({ name: "Cyclone and storm disruption", keywords: ["cyclone", "landfall"] });
  const fuel = reg.resolve({ name: "Retail fuel price pass-through", keywords: ["petrol", "diesel"] });
  const stories = [
    story("a", 4, "full-text", [imp(cyc, 0.8), imp(cyc, 0.5), imp(fuel, 0.2, "mixed", "motorists")]),
    story("b", 1, "headline", [imp(cyc, 0.8)]),
  ];
  return { reg, cyc, fuel, density: buildBracketDensity(stories, reg, { now: NOW }) };
}

test("bracket density: max severity per story, coverage and headline discount", () => {
  const { density, cyc, fuel } = fixture();
  const c = density.brackets.find((b) => b.id === cyc);
  assert.ok(Math.abs(c.weight - (0.8 * 3 * 1 + 0.8 * 1 * 0.7)) < 1e-9); // 2 impacts in one story count once
  assert.equal(c.storyCount, 2);
  assert.equal(density.brackets[0].id, cyc);
  assert.equal(density.brackets.find((b) => b.id === fuel).mixed, 1);
  assert.equal(density.geography[0][0], "Odisha");
});

test("company view: relevance scales sectors, topics ranked, unmatched brackets ignored", () => {
  const { density, cyc, fuel } = fixture();
  const company = {
    id: "acme", name: "Acme", sectors: [{ name: "General insurance" }, { name: "Energy" }, { name: "Healthcare" }],
    matches: {
      [cyc]: { sectors: [
        { sector: "General insurance", relevance: 0.9, channel: "indirect", front: "climate_physical", why: "claims", write_about: "How insurers price cyclone risk" },
        { sector: "Energy", relevance: 0.5, channel: "indirect", front: "infrastructure", why: "outages", write_about: "Grid resilience after storms" },
        { sector: "Healthcare", relevance: 0.1, channel: "indirect", front: "demand", why: "below threshold", write_about: "x" }] },
      [fuel]: { sectors: [] },
    },
  };
  const v = companyView(density, company, bcg.fronts);
  const cycW = density.brackets.find((b) => b.id === cyc).weight;
  const ins = v.sectorsView.find((s) => s.name === "General insurance");
  assert.ok(Math.abs(ins.indirect - cycW * 0.9) < 1e-9);
  assert.equal(ins.direct, 0);
  assert.equal(v.sectorsView.find((s) => s.name === "Healthcare").total, 0); // 0.1 < 0.3 threshold
  // one recommendation per (sector, bracket) pair, each with its own angle, ranked by weight × relevance
  assert.equal(v.topics.length, 2);
  assert.deepEqual(v.topics.map((t) => t.sector), ["General insurance", "Energy"]);
  assert.equal(v.topics[0].writeAbout, "How insurers price cyclone risk");
  assert.equal(v.topics[1].writeAbout, "Grid resilience after storms");
  assert.ok(Math.abs(v.topics[0].score - cycW * 0.9) < 1e-9);
  assert.deepEqual(v.matching, { done: 2, total: 2 });
  const unmatched = companyView(density, { ...company, matches: {} }, bcg.fronts);
  assert.deepEqual(unmatched.matching, { done: 0, total: 2 });
});

test("company store: replacing sectors resets matches, same sectors keeps them", () => {
  const store = new CompanyStore(mkdtempSync(join(tmpdir(), "co-")));
  const a = store.put({ name: "Acme Co", sectors: [{ name: "Energy", description: "" }] });
  a.matches.x = { sectors: [], write_about: "" }; store.save(a);
  assert.ok("x" in store.put({ name: "Acme Co", sectors: [{ name: "Energy", description: "" }] }).matches);
  assert.deepEqual(store.put({ name: "Acme Co", sectors: [{ name: "Healthcare", description: "" }] }).matches, {});
  assert.throws(() => store.put({ name: "", sectors: [{ name: "x" }] }));
  assert.throws(() => store.put({ name: "Empty", sectors: [] }));
});

// ---------- database ----------
const cl = (title, urls, t, outlets = ["The Hindu"]) => ({
  title, url: urls[0], snippet: "", publishedAt: t,
  articles: urls.map((u, i) => ({ title, outlet: outlets[i % outlets.length], publication: outlets[i % outlets.length], url: u, publishedAt: t })),
});
const reading = { analysis: { summary: "s", geography: [], impacts: [] }, basis: "full-text" };

test("database: readings survive closing and reopening the file", () => {
  const path = join(mkdtempSync(join(tmpdir(), "db-")), "h.db");
  const a = new Store(path);
  a.putReading("k1", { ...reading, readAt: 5 });
  assert.equal(a.hasReading("k1"), true);
  a.close();
  const b = new Store(path);
  assert.equal(b.hasReading("k1"), true);
  assert.equal(b.hasReading("nope"), false);
  assert.equal(b.readingCount(), 1);
  b.close();
});

test("database: stories keep their day, join readings, and a re-seen link keeps its story across runs", () => {
  const s = new Store(":memory:");
  const d1 = new Date(2026, 9, 25, 10).getTime(), d2 = new Date(2026, 9, 26, 9).getTime();
  const [k1, k2] = s.upsertClusters([cl("Cyclone Arnab hits Odisha", ["u1", "u2"], d1, ["The Hindu", "NDTV"]), cl("RBI holds repo rate", ["u3"], d2)]);
  s.putReading(k1, reading);
  // next day's poll clusters the same event under a different headline but with an old link plus a new one
  const [k1b, k3] = s.upsertClusters([cl("Odisha braces for cyclone landfall", ["u2", "u9"], d2, ["NDTV", "Mint"]), cl("Brand new story", ["u10"], d2)]);
  assert.equal(k1b, k1);
  assert.notEqual(k3, k1);
  assert.deepEqual(s.days().map((d) => [d.day, d.stories, d.analysed]), [["2026-10-26", 2, 0], ["2026-10-25", 1, 1]]);
  const day1 = s.loadStories({ from: dayStart("2026-10-25"), to: dayStart("2026-10-25") + DAY_MS });
  assert.equal(day1.length, 1); // the story stays on the day it first appeared
  assert.equal(day1[0].id, k1);
  assert.equal(day1[0].articles.length, 3); // u1, u2 + the new link u9
  assert.deepEqual(day1[0].outlets.sort(), ["Mint", "NDTV", "The Hindu"]);
  assert.equal(day1[0].analysis.summary, "s");
  const day2 = s.loadStories({ from: dayStart("2026-10-26"), to: dayStart("2026-10-26") + DAY_MS });
  assert.deepEqual(day2.map((x) => x.title).sort(), ["Brand new story", "RBI holds repo rate"]);
  assert.equal(day2.find((x) => x.title === "Brand new story").analysis, null); // not read yet
  assert.equal(k2 !== undefined, true);
  s.close();
});

test("database: a story merged into another is pruned, runs track progress, legacy files import once", () => {
  const s = new Store(":memory:");
  const t = new Date(2026, 9, 26, 8).getTime();
  const [a, b] = s.upsertClusters([cl("First event", ["x1"], t), cl("Second event", ["y1"], t)]);
  const [merged] = s.upsertClusters([cl("Both events", ["x1", "y1"], t)]);
  assert.equal(merged, a); // earliest-seen story wins
  s.pruneOrphans();
  assert.equal(s.loadStories({ from: 0, to: Date.now() + DAY_MS }).length, 1);
  assert.equal(s.loadStories({ from: 0, to: Date.now() + DAY_MS })[0].id, a);
  assert.notEqual(a, b);

  const id = s.startRun({ model: "m", headlines: 10, publications: 2, perPublication: [{ name: "P", available: 5, polled: 5 }], total: 4 });
  s.progressRun(id, 2);
  assert.deepEqual([s.latestRun().done, s.latestRun().total, s.latestRun().finishedAt], [2, 4, null]);
  s.finishRun(id, 4);
  assert.equal(s.latestRun().done, 4);
  assert.ok(s.latestRun().finishedAt);
  assert.deepEqual(s.latestRun().perPublication, [{ name: "P", available: 5, polled: 5 }]);

  const dir = mkdtempSync(join(tmpdir(), "legacy-"));
  writeFileSync(join(dir, "readings-v3.json"), JSON.stringify({ [titleKey("Old story")]: { ...reading, readAt: 1 } }));
  writeFileSync(join(dir, "stories-v3.json"), JSON.stringify({ meta: { generatedAt: t, model: "m", articles: 1, publications: 1, perPublication: [{ name: "P", available: 1, polled: 1 }] },
    stories: [{ title: "Old story", url: "o1", snippet: "", publishedAt: t, articles: [{ title: "Old story", outlet: "P", publication: "P", url: "o1" }] }] }));
  const fresh = new Store(":memory:");
  assert.deepEqual(fresh.importLegacy(dir), { readings: 1, stories: 1 });
  assert.equal(fresh.importLegacy(dir), null); // only once
  const [story] = fresh.loadStories({ from: 0, to: Date.now() + DAY_MS });
  assert.equal(story.analysis.summary, "s"); // the legacy reading is attached to the legacy story
  assert.equal(story.id, titleKey("Old story"));
  s.close(); fresh.close();
});

test("past-day runs: Google's whole-day query, and backfills don't hijack the 'latest' run", () => {
  assert.equal(dayQuery("2026-10-24"), "after:2026-10-24 before:2026-10-25");
  assert.equal(dayQuery("2026-12-31"), "after:2026-12-31 before:2027-01-01");
  assert.equal(dayQuery("2026-02-28"), "after:2026-02-28 before:2026-03-01");
  const s = new Store(":memory:");
  const base = { model: "m", headlines: 1, publications: 1, perPublication: [], total: 1 };
  const latest = s.startRun({ ...base, startedAt: 1000 });
  const backfill = s.startRun({ ...base, startedAt: 2000, targetDate: "2026-10-20" });
  assert.equal(s.latestRun().id, backfill);
  assert.equal(s.latestRun().targetDate, "2026-10-20");
  assert.equal(s.latestRun("rolling").id, latest); // the rolling view still keys off the latest-window run
  assert.equal(s.latestRun("rolling").targetDate, null);
  s.close();
});

test("a database from before backfill support gains the target_date column", () => {
  const path = join(mkdtempSync(join(tmpdir(), "mig-")), "old.db");
  const raw = new DatabaseSync(path);
  raw.exec("CREATE TABLE runs (id INTEGER PRIMARY KEY AUTOINCREMENT, started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, finished_at INTEGER, model TEXT, headlines INTEGER, publications INTEGER, per_publication TEXT, total INTEGER, done INTEGER NOT NULL DEFAULT 0)");
  raw.exec("INSERT INTO runs (started_at, updated_at, model, headlines, publications, per_publication, total) VALUES (1, 1, 'm', 1, 1, '[]', 1)");
  raw.close();
  const s = new Store(path);
  assert.equal(s.latestRun().targetDate, null);
  s.startRun({ model: "m", headlines: 1, publications: 1, perPublication: [], total: 1, targetDate: "2026-10-01" });
  assert.equal(s.latestRun().targetDate, "2026-10-01");
  s.close();
});

// ---------- server ----------
test("server: upload a company, list it in state, reject bad uploads", async () => {
  process.env.HIVEMIND_LLM = "off"; // matching disabled; this test covers HTTP + storage only
  const root = mkdtempSync(join(tmpdir(), "srv-"));
  mkdirSync(join(root, "src"));
  copyFileSync(new URL("../src/dashboard.html", import.meta.url), join(root, "src", "dashboard.html"));
  const { serve } = await import("../src/server.mjs");
  const server = await serve({ root, bcg, port: 0, autoSync: false, auth: false, log: () => {} });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, type = "application/json") => fetch(`${base}/api/company`, { method: "POST", headers: { "content-type": type }, body: typeof body === "string" ? body : JSON.stringify(body) });
  try {
    const ok = await post({ name: "Acme Bank", text: "Retail banking\nGeneral insurance" });
    assert.equal(ok.status, 200);
    assert.deepEqual((await ok.json()).sectors.map((s) => s.name), ["Retail banking", "General insurance"]);
    assert.equal((await post({ text: "Energy" })).status, 400); // no name anywhere
    assert.equal((await post({ name: "Z", text: "" })).status, 400); // no sectors
    assert.equal((await post("{}", "text/plain")).status, 415); // not JSON
    assert.equal((await post({ text: "Company: Named By File\nEnergy" })).status, 200); // name taken from the file
    const state = await (await fetch(`${base}/api/state?company=acme-bank`)).json();
    assert.equal(state.empty, true);
    assert.deepEqual(state.companies.map((c) => c.id).sort(), ["acme-bank", "bcg", "named-by-file"]);
    assert.equal(state.llm.ok, false);
    assert.equal((await fetch(`${base}/`)).status, 200);
    const del = await fetch(`${base}/api/company?id=bcg`, { method: "DELETE" });
    assert.equal(del.status, 400);
  } finally { server.close(); server.closeAllConnections?.(); }
});

test("server: the Run button validates the day, starts one run at a time, and reports the outcome", async () => {
  const prev = { llm: process.env.HIVEMIND_LLM, key: process.env.ANTHROPIC_API_KEY };
  process.env.HIVEMIND_LLM = "anthropic"; process.env.ANTHROPIC_API_KEY = "test-key-not-real"; // detect() only checks it is set
  const root = mkdtempSync(join(tmpdir(), "run-"));
  mkdirSync(join(root, "src"));
  copyFileSync(new URL("../src/dashboard.html", import.meta.url), join(root, "src", "dashboard.html"));
  const { serve } = await import("../src/server.mjs");
  const { EventEmitter } = await import("node:events");
  const calls = [];
  let child;
  const fakeSpawn = (cmd, args) => {
    calls.push(args);
    child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill() {} });
    return child;
  };
  const server = await serve({ root, bcg, port: 0, autoSync: false, auth: false, log: () => {}, spawn: fakeSpawn });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, type = "application/json") => fetch(`${base}/api/run`, { method: "POST", headers: { "content-type": type }, body: typeof body === "string" ? body : JSON.stringify(body) });
  const state = async () => (await (await fetch(`${base}/api/state`)).json()).runner;
  try {
    assert.equal((await post("{}", "text/plain")).status, 415);
    assert.equal((await post({ date: "not-a-date" })).status, 400);
    assert.equal((await post({ date: "2999-01-01" })).status, 400); // future
    assert.equal(calls.length, 0);

    assert.equal((await post({ date: "2026-10-24" })).status, 200);
    assert.deepEqual(calls[0].slice(-3), ["run", "--date", "2026-10-24"]);
    assert.equal((await state()).running, true);
    assert.equal((await state()).date, "2026-10-24");
    assert.equal((await post({ date: "2026-10-23" })).status, 409); // one at a time
    assert.equal(calls.length, 1);

    child.stderr.emit("data", "(node:1) ExperimentalWarning: SQLite\nError: No articles retrieved from any publication.\n");
    child.emit("close", 1);
    const failed = await state();
    assert.deepEqual([failed.running, failed.lastExit, failed.lastMessage], [false, 1, "Error: No articles retrieved from any publication."]);

    assert.equal((await post({ date: null })).status, 200); // latest 24h: no --date
    assert.ok(!calls[1].includes("--date"));
    child.stdout.emit("data", "Read 12 new stories (0 failed, 3 already in the database) · 22 brackets\nDatabase: x — 2 day(s) of history\n");
    child.emit("close", 0);
    assert.match((await state()).lastMessage, /Read 12 new stories/);
  } finally {
    server.close(); server.closeAllConnections?.();
    for (const [k, v] of [["HIVEMIND_LLM", prev.llm], ["ANTHROPIC_API_KEY", prev.key]]) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
});
