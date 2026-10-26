// Company profiles (a brand + its sectors), upload parsing, and bracket→sector matching.
import { readFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { writeFileAtomic } from "./atomic.mjs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { norm } from "./brackets.mjs";

export const slugify = (s) => norm(s).replace(/ /g, "-").slice(0, 60);
// Bump when the matching prompt/validation changes in a way that makes stored judgements wrong: stale matches are dropped on read.
export const MATCH_VERSION = 3;
const REMATCH_GROWTH = 1.5, REMATCH_MIN_NEW = 3, REMATCH_AGE_MS = 6 * 3600e3;
const MAX_SECTORS = 60;

function csvRow(line) {
  const out = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function dedupe(items) {
  const seen = new Set(), sectors = [];
  for (const it of items) {
    const name = String(it.name ?? "").replace(/^[\s\-*•\d.)]+/, "").trim().slice(0, 80);
    const key = norm(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    sectors.push({ name, description: String(it.description ?? "").trim().slice(0, 200) });
    if (sectors.length >= MAX_SECTORS) break;
  }
  return sectors;
}

// Accepts JSON ({name, sectors:[…]} or […]), CSV with a "sector" header (+ optional "description"/"company"),
// or plain text: one sector per line, or a single comma/semicolon separated line. A first line "Company: X" names the brand.
export function parseSectors(text, hintName = "") {
  const t = String(text ?? "").replace(/^﻿/, "").trim();
  if (!t) return { name: hintName, sectors: [] };
  if (t[0] === "{" || t[0] === "[") {
    try {
      const j = JSON.parse(t);
      const arr = Array.isArray(j) ? j : j.sectors;
      const items = (Array.isArray(arr) ? arr : []).map((x) => (typeof x === "string" ? { name: x } : { name: x?.name ?? x?.sector, description: x?.description }));
      return { name: (!Array.isArray(j) && (j.name || j.company || j.brand)) || hintName, sectors: dedupe(items) };
    } catch { /* fall through to plain text */ }
  }
  let lines = t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let name = hintName;
  const m = lines[0].match(/^(?:company|brand|client|name)\s*[:=]\s*(.+)$/i);
  if (m) { name = m[1].trim(); lines = lines.slice(1); }
  if (!lines.length) return { name, sectors: [] };

  const header = csvRow(lines[0]).map((h) => h.toLowerCase());
  const sIdx = header.findIndex((h) => /^(sector|sectors|industry|industries|segment|practice area)$/.test(h));
  if (sIdx >= 0) {
    const dIdx = header.findIndex((h) => /^(description|desc|scope|sub-?sectors?|notes?)$/.test(h));
    const cIdx = header.findIndex((h) => /^(company|brand|client)$/.test(h));
    const rows = lines.slice(1).map(csvRow);
    if (!name && cIdx >= 0) name = rows.find((r) => r[cIdx])?.[cIdx] || "";
    return { name, sectors: dedupe(rows.map((r) => ({ name: r[sIdx], description: dIdx >= 0 ? r[dIdx] : "" }))) };
  }
  if (lines.length === 1) return { name, sectors: dedupe(lines[0].split(/[;,|\t]/).map((s) => ({ name: s }))) };
  return {
    name,
    sectors: dedupe(lines.map((l) => {
      const sep = l.match(/^(.+?)\s(?:-|–|—)\s(.+)$/) || l.match(/^([^:]+):\s+(.+)$/);
      return sep ? { name: sep[1], description: sep[2] } : { name: l };
    })),
  };
}

export const sectorsHash = (sectors) => createHash("sha1").update(JSON.stringify(sectors.map((s) => [s.name, s.description]))).digest("hex").slice(0, 12);

export class CompanyStore {
  constructor(dir) { this.dir = dir; mkdirSync(dir, { recursive: true }); }
  #file(id) { return join(this.dir, `${id}.json`); }

  list() {
    return readdirSync(this.dir).filter((f) => f.endsWith(".json")).map((f) => {
      try { return this.#current(JSON.parse(readFileSync(join(this.dir, f), "utf8"))); } catch { return null; }
    }).filter(Boolean).sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id) {
    const f = this.#file(id);
    if (!/^[a-z0-9-]+$/.test(id) || !existsSync(f)) return null;
    try { return this.#current(JSON.parse(readFileSync(f, "utf8"))); } catch { return null; }
  }

  #current(c) {
    if (c.matchVersion !== MATCH_VERSION) { c.matches = {}; c.matchVersion = MATCH_VERSION; }
    return c;
  }

  // Uploading again under the same name replaces the sectors; matches are kept only if the sectors are unchanged.
  put({ name, sectors, builtin = false }) {
    const id = slugify(name);
    if (!id) throw new Error("Company name is required");
    if (!sectors.length) throw new Error("No sectors found in the upload");
    const prev = this.get(id);
    const hash = sectorsHash(sectors);
    const company = {
      id, name: name.trim().slice(0, 80), sectors, sectorsHash: hash, builtin, matchVersion: MATCH_VERSION,
      matches: prev && prev.sectorsHash === hash ? prev.matches : {},
      createdAt: prev?.createdAt ?? Date.now(), updatedAt: Date.now(),
    };
    this.save(company);
    return company;
  }

  save(company) {
    writeFileAtomic(this.#file(company.id), JSON.stringify(company));
  }

  remove(id) { const f = this.#file(id); if (existsSync(f)) unlinkSync(f); }
}

// A bracket needs (re-)judging when it has never been matched, or when its stories have grown enough (or
// aged enough) that the angles written from the earlier stories are probably stale.
export function needsMatch(prev, ev) {
  if (ev && ev.storyCount === 0) return false;
  if (!prev) return true;
  if (!ev || prev.basedOn == null) return false;
  const grew = ev.storyCount >= prev.basedOn * REMATCH_GROWTH + REMATCH_MIN_NEW;
  const aged = Date.now() - prev.matchedAt > REMATCH_AGE_MS && ev.storyCount > prev.basedOn;
  return grew || aged;
}

// Judge brackets for every company. `evidence` is Map(bracketId -> {storyCount, stories}) of what is in the news
// now; brackets with no stories are skipped. Safe to call repeatedly (e.g. on a timer).
export async function matchPending(store, registry, reader, { evidence = null, batch = 4, concurrency = 3, log = () => {} } = {}) {
  let matched = 0;
  for (const c of store.list()) {
    const company = store.get(c.id);
    if (!company) continue;
    const pending = registry.list().filter((b) => needsMatch(company.matches[b.id], evidence?.get(b.id)));
    const chunks = [];
    for (let i = 0; i < pending.length; i += batch) chunks.push(pending.slice(i, i + batch));
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, async () => {
      while (next < chunks.length) {
        const chunk = chunks[next++];
        try {
          const res = await reader.match(company, chunk, evidence);
          const fresh = store.get(company.id);
          if (!fresh || fresh.sectorsHash !== company.sectorsHash) return; // company was replaced mid-flight
          for (const [id, m] of res) { fresh.matches[id] = { ...m, basedOn: evidence?.get(id)?.storyCount ?? 0, matchedAt: Date.now() }; matched++; }
          store.save(fresh);
          company.matches = fresh.matches;
        } catch (e) { log(`match failed for ${company.name} (${chunk.length} brackets): ${e.message}`); }
      }
    }));
  }
  return matched;
}
