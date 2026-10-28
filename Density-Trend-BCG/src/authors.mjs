// Author profiles (HiveMind.docx §7). A profile holds only what the author or editor supplies:
// expertise, sectors, audience, geography, preferred publications, turnaround time and the evidence they can contribute.
// Nothing is inferred or invented, and fit is computed from these fields alone (see authorFit in opportunity.mjs).
import { norm } from "./brackets.mjs";

const list = (v, max = 20, len = 80) =>
  (Array.isArray(v) ? v : String(v ?? "").split(/[\n;,|]/)).map((x) => String(x).trim().slice(0, len)).filter(Boolean).slice(0, max);

export function normalizeAuthor(body, prev = null) {
  const name = String(body?.name ?? "").trim().slice(0, 80);
  if (!name) throw new Error("Author name is required");
  const turnaround = Number(body?.turnaroundHours);
  return {
    id: prev?.id ?? (norm(name).replace(/ /g, "-").slice(0, 50) || `author-${Date.now()}`),
    name, active: body?.active !== false,
    expertise: list(body?.expertise), sectors: list(body?.sectors), geography: list(body?.geography), publications: list(body?.publications),
    audience: String(body?.audience ?? "").trim().slice(0, 200),
    turnaroundHours: Number.isFinite(turnaround) && turnaround > 0 ? Math.min(turnaround, 24 * 60) : null,
    evidence: list(body?.evidence, 12, 200),
    notes: String(body?.notes ?? "").trim().slice(0, 400),
    createdAt: prev?.createdAt,
  };
}

// CSV (header row: name, expertise, sectors, audience, geography, publications, turnaround_hours, evidence) or JSON array.
// List cells use ";" or "|" as separators.
export function parseAuthors(text) {
  const t = String(text ?? "").replace(/^﻿/, "").trim();
  if (!t) return [];
  if (t[0] === "[" || t[0] === "{") {
    const j = JSON.parse(t);
    return (Array.isArray(j) ? j : j.authors ?? []).map((a) => normalizeAuthor(a));
  }
  const rows = t.split(/\r?\n/).filter((l) => l.trim());
  const cells = (line) => { const out = []; let cur = "", q = false; for (let i = 0; i < line.length; i++) { const ch = line[i]; if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; } else if (ch === '"') q = true; else if (ch === ",") { out.push(cur); cur = ""; } else cur += ch; } out.push(cur); return out.map((s) => s.trim()); };
  const head = cells(rows[0]).map((h) => norm(h).replace(/ /g, ""));
  const col = (r, ...names) => { const i = head.findIndex((h) => names.includes(h)); return i >= 0 ? r[i] : ""; };
  return rows.slice(1).map((line) => {
    const r = cells(line);
    return normalizeAuthor({
      name: col(r, "name", "author"), expertise: col(r, "expertise", "topics"), sectors: col(r, "sectors", "sector"), audience: col(r, "audience"),
      geography: col(r, "geography", "region"), publications: col(r, "publications", "preferredpublications"),
      turnaroundHours: col(r, "turnaroundhours", "turnaround"), evidence: col(r, "evidence", "canprovide"),
    });
  });
}
