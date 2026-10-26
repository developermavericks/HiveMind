// Assembles everything the dashboard shows from the files the pipeline writes.
import { readFileSync, statSync, existsSync } from "node:fs";
import { BracketRegistry } from "./brackets.mjs";
import { buildBracketDensity, companyView } from "./density.mjs";

// Re-read a JSON/registry file only when it changes on disk (the pipeline rewrites it every few seconds while running).
export class FileCache {
  constructor(path, load) { this.path = path; this.load = load; this.mtime = 0; this.value = null; }
  get() {
    if (!existsSync(this.path)) return null;
    const m = statSync(this.path).mtimeMs;
    if (m !== this.mtime) {
      try { this.value = this.load(this.path); this.mtime = m; } catch { /* file mid-write: keep the previous value */ }
    }
    return this.value;
  }
}

export const storiesCache = (path) => new FileCache(path, (p) => JSON.parse(readFileSync(p, "utf8")));
export const registryCache = (path, seed = []) => new FileCache(path, (p) => new BracketRegistry(p, seed));

export function buildState({ data, registry, companies, companyId, bcg, hours = 48, llm }) {
  const base = { companies: companies.map((c) => ({ id: c.id, name: c.name, builtin: !!c.builtin, sectors: c.sectors.length })), llm, fronts: bcg.fronts };
  if (!data || !registry) return { ...base, empty: true };

  const analysed = data.stories.filter((s) => s.analysis);
  const density = buildBracketDensity(analysed, registry, { now: data.meta.generatedAt, hours });

  const readBy = {};
  for (const s of analysed) for (const a of s.articles) readBy[a.publication] = (readBy[a.publication] || 0) + 1;
  const meta = {
    ...data.meta, stories: analysed.length, fullText: analysed.filter((s) => s.basis === "full-text").length,
    brackets: density.brackets.length, perPublication: (data.meta.perPublication || []).map((p) => ({ ...p, read: readBy[p.name] || 0 })),
  };

  const company = companies.find((c) => c.id === companyId) ?? null;
  return {
    ...base, meta, hours, bins: density.bins,
    brackets: density.brackets.slice(0, 150),
    impactAreas: density.impactAreas, geography: density.geography, groups: density.groups,
    company: company ? companyView(density, company, bcg.fronts) : null,
  };
}
