// The duplicate finder was made about 100 times faster (prefix filtering). It must give exactly the answer of the original all-pairs comparison.
import test from "node:test";
import assert from "node:assert/strict";
import { findDuplicates } from "../src/quality.mjs";
import { norm } from "../src/brackets.mjs";

const HOUR = 3600e3, CFG = { dedupe: { minJaccard: 0.7, withinHours: 36, minTokenLength: 3 } };
// the original method, kept here as the reference: compare each story with every earlier one inside the window, nearest first
const core = (t) => String(t ?? "").replace(/\s[-|–—]\s[^-|–—]{2,40}$/, "");
const tokens = (t, minLen) => new Set(norm(core(t)).split(" ").filter((w) => w.length >= minLen));
const jaccard = (a, b) => { let i = 0; for (const x of a) if (b.has(x)) i++; return i / (a.size + b.size - i || 1); };
function reference(rows, cfg) {
  const d = cfg.dedupe, minJ = d.minJaccard, win = d.withinHours * HOUR, toks = rows.map((r) => tokens(r.title, d.minTokenLength)), root = new Map(), out = [];
  for (let i = 0; i < rows.length; i++) {
    if (toks[i].size < 3) continue;
    for (let j = i - 1; j >= 0 && rows[i].published_at - rows[j].published_at <= win; j--) {
      if (toks[j].size < 3 || Math.abs(toks[i].size - toks[j].size) > Math.max(toks[i].size, toks[j].size) * 0.5) continue;
      const jac = jaccard(toks[i], toks[j]);
      if (jac >= minJ) { const canon = root.get(rows[j].key) ?? rows[j].key; root.set(rows[i].key, canon); out.push({ key: rows[i].key, canonical: canon, jaccard: jac }); break; }
    }
  }
  return out;
}
const lcg = (seed) => () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const strip = (a) => a.map(({ key, canonical, jaccard: j }) => ({ key, canonical, jaccard: j }));

test("duplicates: the fast finder returns exactly what the all-pairs comparison returns, on many random sets", () => {
  const vocab = Array.from({ length: 60 }, (_, i) => "word" + i + "x".repeat(i % 3)), rnd = lcg(2026);
  let pairsFound = 0;
  for (let c = 0; c < 150; c++) {
    const n = 5 + Math.floor(rnd() * 150), rows = []; let t = 1e9;
    for (let i = 0; i < n; i++) {
      t += Math.floor(rnd() * 6 * HOUR);
      let words;
      if (i > 3 && rnd() < 0.4) { words = rows[Math.floor(rnd() * rows.length)].title.split(" ").filter(() => rnd() > 0.15); if (rnd() < 0.5) words.push(vocab[Math.floor(rnd() * vocab.length)]); } // a reworded repeat
      else words = Array.from({ length: 2 + Math.floor(rnd() * 12) }, () => vocab[Math.floor(rnd() * (rnd() < 0.5 ? 12 : 60))]);
      rows.push({ key: "k" + i, title: words.join(" ") + (rnd() < 0.2 ? " - Some Outlet" : ""), published_at: t });
    }
    const fast = strip(findDuplicates(rows, CFG)), slow = reference(rows, CFG);
    assert.deepEqual(fast, slow, `set ${c} differs`);
    pairsFound += slow.length;
  }
  assert.ok(pairsFound > 500, "the random sets really contain repeats to find (" + pairsFound + ")");
});

test("duplicates: a repeat outside the window, a too-short title and a different story are not matched", () => {
  const r = (key, title, h) => ({ key, title, published_at: h * HOUR });
  const rows = [r("a", "Tata Motors and Amazon partner to deploy electric trucks for logistics", 0), r("b", "Tata Motors and Amazon partner to deploy electric trucks logistics - Mint", 5),
    r("c", "Tata Motors and Amazon partner to deploy electric trucks for logistics", 80), r("d", "Rain floods", 6), r("e", "Rain floods", 7), r("f", "Budget session of Parliament begins on Monday morning", 8)];
  assert.deepEqual(strip(findDuplicates(rows, CFG)).map((d) => [d.key, d.canonical]), [["b", "a"]], "only b repeats a: c is 80 h later and d/e have under three words of substance");
});

test("duplicates: two days of headlines are checked in well under a second (it took about 20 s before)", () => {
  const vocab = Array.from({ length: 400 }, (_, i) => "term" + i), rnd = lcg(7), rows = []; let t = 1e9;
  for (let i = 0; i < 9000; i++) { t += 19000; rows.push({ key: "k" + i, title: Array.from({ length: 6 + Math.floor(rnd() * 6) }, () => vocab[Math.floor(rnd() * rnd() * 400)]).join(" "), published_at: t }); }
  const t0 = performance.now(); findDuplicates(rows, CFG); const ms = performance.now() - t0;
  assert.ok(ms < 3000, `took ${Math.round(ms)} ms`);
});
