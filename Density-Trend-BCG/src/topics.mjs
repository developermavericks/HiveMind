// Registry of finer "topics" (HiveMind.docx §4): consistent labels with aliases, so different wording is grouped
// without merging unrelated stories. Brackets are the broad topic groups ("Climate", "Finance"); topics are the
// specific consequences readers ask about next ("port disruption", "crop damage", "insurance claims").
// Persisted in the `topics` table; the LLM sees the closest existing topics and must reuse one when it fits.
import { norm } from "./brackets.mjs";

const STOP = new Set("and the of for in on to with a an or by at from as is are over amid into".split(" "));
const tokens = (s) => new Set(norm(s).split(" ").filter((w) => w.length > 2 && !STOP.has(w)).map((w) => w.replace(/(ies|s)$/, (m) => (m === "ies" ? "y" : ""))));
const jaccard = (a, b) => { let i = 0; for (const t of a) if (b.has(t)) i++; return i / (a.size + b.size - i || 1); };
const slug = (s) => norm(s).replace(/ /g, "-").slice(0, 50) || "topic";
export const TOPIC_MERGE = 0.6;
// Vague filler labels ("personal stories") name no recurring subject, so they never rank. They stay in the database.
export const isWeakLabel = (name, cfg) => {
  const n = norm(name ?? "");
  if (!n || (cfg?.topics?.weakLabels ?? []).some((w) => norm(w) === n) || n.split(" ").length > 4) return true;
  // "cricket news", "market updates": a category of coverage, not a subject someone can write about
  const words = n.split(" ");
  return words.length <= (cfg?.topics?.weakMaxWords ?? 2) && (cfg?.topics?.weakSuffixes ?? []).includes(words[words.length - 1]);
};

export class TopicRegistry {
  constructor(store) {
    this.store = store;
    this.items = new Map(store ? store.loadTopics().map((t) => [t.id, t]) : []);
    this.dirty = new Set();
  }
  get size() { return this.items.size; }
  get(id) { return this.items.get(id); }
  asMap() { return this.items; }

  // Existing topics worth showing the model for this story: token overlap first, topped up with the most used.
  candidates(text, n = 60) {
    const tk = tokens(text), all = [...this.items.values()];
    if (all.length <= n) return all;
    const scored = all.map((t) => ({ t, s: jaccard(tokens(t.name), tk) + 0.05 * Math.log1p(t.count) })).sort((a, b) => b.s - a.s);
    return scored.slice(0, n).map((x) => x.t);
  }

  // Name → id of an existing topic (exact, alias, or ≥60% token overlap) or a new one.
  resolve(name, bracket = null) {
    const clean = String(name ?? "").replace(/[^\p{L}\p{N}\s&/-]/gu, " ").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 40);
    const tk = tokens(clean);
    if (!clean || !tk.size || clean.split(" ").length > 6) return null;
    const key = norm(clean);
    let best = null, bestScore = 0;
    for (const t of this.items.values()) {
      if (norm(t.name) === key || t.aliases.some((a) => norm(a) === key)) { best = t; bestScore = 9; break; }
      const s = Math.max(jaccard(tokens(t.name), tk), ...t.aliases.map((a) => jaccard(tokens(a), tk)));
      if (s > bestScore) { bestScore = s; best = t; }
    }
    if (best && bestScore >= TOPIC_MERGE) {
      if (norm(best.name) !== key && !best.aliases.some((a) => norm(a) === key) && best.aliases.length < 12) { best.aliases.push(clean); this.dirty.add(best.id); }
      return best.id;
    }
    let id = slug(clean);
    for (let i = 2; this.items.has(id); i++) id = `${slug(clean)}-${i}`;
    this.items.set(id, { id, name: clean, bracket, aliases: [], count: 0, createdAt: Date.now() });
    this.dirty.add(id);
    return id;
  }

  touch(id) { const t = this.items.get(id); if (t) { t.count++; this.dirty.add(id); } }

  save() {
    if (!this.store) return;
    for (const id of this.dirty) this.store.saveTopic(this.items.get(id));
    this.dirty.clear();
  }
}
