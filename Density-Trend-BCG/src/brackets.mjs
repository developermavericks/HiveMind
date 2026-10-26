// Persistent registry of "keyword brackets": reusable, company-agnostic impact themes
// (e.g. "Retail fuel price pass-through": fuel price, petrol, diesel, excise, OMC margins).
//
// A bracket is created once. Later stories are shown the existing brackets that fit them and must reuse
// one; a proposed new bracket is merged into an existing one when its name or keywords overlap enough.
import { readFileSync, existsSync } from "node:fs";
import { writeFileAtomic } from "./atomic.mjs";

export const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const slug = (s) => norm(s).replace(/ /g, "-").slice(0, 60) || "bracket";
const tokenSet = (s) => new Set(norm(s).split(" ").filter((w) => w.length > 2));
const jaccard = (a, b) => {
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter || 1);
};
export const cleanKeywords = (arr) =>
  [...new Set((Array.isArray(arr) ? arr : []).filter((k) => typeof k === "string").map((k) => k.toLowerCase().trim()).filter((k) => k.length > 1 && k.length < 40))].slice(0, 12);

export const MERGE_THRESHOLD = 0.6;

export class BracketRegistry {
  // `seed` is the fixed starter taxonomy (People, Economy, AI & Tech, …). Seeded brackets are always present
  // and are never merged away; the LLM adds a new bracket only when nothing in the taxonomy fits.
  constructor(path, seed = []) {
    this.path = path;
    this.items = new Map();
    this.aliases = {}; // merged-away bracket id -> surviving id
    if (path && existsSync(path)) {
      try {
        const j = JSON.parse(readFileSync(path, "utf8"));
        for (const b of j.brackets) this.items.set(b.id, b);
        this.aliases = j.aliases || {};
      } catch { /* start empty */ }
    }
    for (const s of seed) {
      const id = slug(s.name);
      if (this.items.has(id) || id in this.aliases) continue;
      this.items.set(id, { id, name: s.name, description: s.description || "", keywords: cleanKeywords(s.keywords), count: 0, createdAt: Date.now(), seed: true });
    }
  }

  get size() { return this.items.size; }
  list() { return [...this.items.values()]; }
  // Follows merges, so an id stored in an older reading still resolves to the surviving bracket.
  canonical(id) {
    for (let hops = 0; hops < 20 && id in this.aliases; hops++) id = this.aliases[id];
    return id;
  }
  get(id) { return this.items.get(this.canonical(id)); }

  // Fold `dropIds` into `keepId`. Readings that mention a dropped id keep working through the alias.
  merge(keepId, dropIds, name) {
    const keep = this.items.get(keepId);
    if (!keep) return 0;
    let merged = 0;
    for (const id of dropIds) {
      const drop = this.items.get(id);
      if (!drop || id === keepId || drop.seed) continue;
      keep.keywords = cleanKeywords([...keep.keywords, ...drop.keywords]);
      keep.count += drop.count;
      if (!keep.description && drop.description) keep.description = drop.description;
      this.items.delete(id);
      this.aliases[id] = keepId;
      for (const [from, to] of Object.entries(this.aliases)) if (to === id) this.aliases[from] = keepId;
      merged++;
    }
    if (merged && typeof name === "string" && name.trim()) keep.name = name.trim().slice(0, 80);
    return merged;
  }

  // Brackets worth showing the LLM for this story: keyword/name hits first, topped up with the most-used ones.
  candidates(text, n = 40) {
    const all = this.list();
    if (all.length <= n) return all.sort((a, b) => b.count - a.count);
    const lower = text.toLowerCase();
    const scored = all.map((b) => {
      let s = 0;
      for (const k of b.keywords) if (lower.includes(k)) s += 1;
      for (const t of tokenSet(b.name)) if (lower.includes(t)) s += 0.3;
      return { b, s };
    });
    const hits = scored.filter((x) => x.s > 0).sort((x, y) => y.s - x.s || y.b.count - x.b.count).slice(0, n).map((x) => x.b);
    if (hits.length >= 12) return hits;
    const fill = all.filter((b) => !hits.includes(b)).sort((a, b) => b.count - a.count).slice(0, 12 - hits.length);
    return [...hits, ...fill];
  }

  // Returns the id of an existing bracket this proposal duplicates, else creates a new one.
  resolve(p) {
    if (!p || typeof p.name !== "string" || !p.name.trim()) return null;
    const name = p.name.trim().slice(0, 80);
    const key = norm(name);
    if (!key) return null;
    const ks = cleanKeywords(p.keywords);
    let best = null, bestScore = 0;
    for (const b of this.items.values()) {
      if (norm(b.name) === key) { best = b; bestScore = 9; break; }
      const have = new Set(b.keywords);
      const inter = ks.filter((k) => have.has(k)).length;
      const kwOverlap = inter >= 2 ? inter / Math.min(have.size, ks.length) : 0;
      const s = Math.max(kwOverlap, jaccard(tokenSet(b.name), tokenSet(name)));
      if (s > bestScore) { bestScore = s; best = b; }
    }
    if (best && bestScore >= MERGE_THRESHOLD) {
      best.keywords = cleanKeywords([...best.keywords, ...ks]);
      return best.id;
    }
    let id = slug(name);
    for (let i = 2; this.items.has(id) || id in this.aliases; i++) id = `${slug(name)}-${i}`;
    this.items.set(id, { id, name, description: typeof p.description === "string" ? p.description.trim().slice(0, 240) : "", keywords: ks, count: 0, createdAt: Date.now() });
    return id;
  }

  touch(id) { const b = this.get(id); if (b) b.count++; }

  save() {
    if (this.path) writeFileAtomic(this.path, JSON.stringify({ brackets: this.list(), aliases: this.aliases }));
  }
}
