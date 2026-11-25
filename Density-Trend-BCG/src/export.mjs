// Data export API for other systems: every stored dataset, read-only, behind one secret key.
//
//   GET /api/export                          list of datasets with row counts and latest change time
//   GET /api/export/<dataset>?since=&limit=&cursor=&company=
//                                            rows of one dataset, oldest change first, in pages
//   GET /api/export/views/<view>?date=&company=...
//                                            a dashboard view as the app computes it (overview, opportunities, labels, ...)
//
// The key comes from HIVEMIND_EXPORT_KEY in .env and is sent as the X-API-Key header (or Authorization: Bearer <key>).
// With no key configured the API is switched off. The key is never accepted in the URL, so it never lands in logs.
//
// Incremental sync: a first call without `since` returns everything (page by page). Each page carries `next_since`; after
// the last page (has_more = false) the caller stores it and passes it as `since` next time to get only rows added or changed
// after that. Rows are identified by their `key` fields: an updated row comes again, so the caller should insert-or-update.
//
// Private data is never exported: users, sessions, sign-in and activity logs, password resets, tickets, journalist contact
// details, usage/cost records, job logs, settings and keys.
import { createHash, timingSafeEqual } from "node:crypto";

// dataset -> table, the columns that identify a row, and when a row last changed (epoch ms; an SQL expression)
export const DATASETS = {
  stories:            { table: "stories",            key: ["key"],                       changed: "last_seen",                                          about: "Every news story seen: title, link, snippet, publish time, day" },
  articles:           { table: "articles",           key: ["url"],                       changed: "COALESCE(first_seen, published_at)",                 about: "Every headline (one per outlet), pointing at its story" },
  readings:           { table: "readings",           key: ["key"],                       changed: "read_at",                                            about: "AI reading of each story: what happened, impacts, keyword brackets" },
  reading_versions:   { table: "reading_versions",   key: ["key", "at"],                 changed: "at",                                                 about: "Earlier versions of readings" },
  reading_reviews:    { table: "reading_reviews",    key: ["key", "model"],              changed: "at",                                                 about: "Second-opinion reviews of readings by another model" },
  enrichments:        { table: "enrichments",        key: ["key"],                       changed: "MAX(enriched_at, COALESCE(sentiment_at, 0))",        about: "Per story: entities, topics, pathways, sentiment, stance, wire, content type" },
  topics:             { table: "topics",             key: ["id"],                        changed: "MAX(created_at, COALESCE(merged_at, 0))",            about: "Topics, their bracket, aliases and merges" },
  topic_checks:       { table: "topic_checks",       key: ["story_key", "topic_id"],     changed: "at",                                                 about: "Whether a story fits a topic, and why" },
  topic_matches:      { table: "topic_matches",      key: ["company", "topic", "sector"], changed: "judged_at",                                         about: "How relevant each topic is to each company sector" },
  signals:            { table: "signals",            key: ["topic", "source", "t"],      changed: "t",                                                  about: "Search-interest and other time series per topic" },
  web_checks:         { table: "web_checks",         key: ["topic", "source", "at"],     changed: "at",                                                 about: "Web checks made per topic" },
  recommendation_log: { table: "recommendation_log", key: ["id"],                        changed: "ts",                                                 about: "Every recommendation (opportunity, score, stage, action) as it was made" },
  rec_outcomes:       { table: "rec_outcomes",       key: ["rec_id"],                    changed: "evaluated_at",                                       about: "How each recommendation turned out" },
  forecast_log:       { table: "forecast_log",       key: ["id"],                        changed: "COALESCE(evaluated_at, made_at)",                    about: "Topic forecasts and their actual values" },
  briefs:             { table: "briefs",             key: ["id"],                        changed: "COALESCE(decided_at, created_at)",                   about: "Writing briefs and their decisions" },
  authors:            { table: "authors",            key: ["id"],                        changed: "updated_at",                                         about: "Author profiles used for briefs" },
  story_dupes:        { table: "story_dupes",        key: ["key"],                       changed: "at",                                                 about: "Stories marked duplicate or junk, with their canonical story" },
  audits:             { table: "audits",             key: ["key"],                       changed: "at",            omit: ["reviewer"],                  about: "Quality audit verdicts" },
  entity_aliases:     { table: "entity_aliases",     key: ["alias"],                     changed: "at",                                                 about: "Entity name aliases" },
  ocr_articles:       { table: "ocr_articles",       key: ["id"],                        changed: "MAX(fetched_at, COALESCE(classified_at, 0))",        about: "Newspaper print articles (OCR): headline, text, kind, author" },
  ocr_angle_matches:  { table: "ocr_angle_matches",  key: ["article_id", "opp_key"],     changed: "matched_at",                                         about: "Print articles matched to opportunities" },
  online_pieces:      { table: "online_pieces",      key: ["story_key"],                 changed: "checked_at",                                         about: "Online opinion / analysis pieces" },
  section_pieces:     { table: "section_pieces",     key: ["url"],                       changed: "seen_at",                                            about: "Entries seen on opinion-section pages" },
  online_matches:     { table: "online_matches",     key: ["story_key", "opp_key"],      changed: "matched_at",                                         about: "Online pieces matched to opportunities" },
  runs:               { table: "runs",               key: ["id"],                        changed: "COALESCE(finished_at, updated_at, started_at)",      about: "Collection runs: when, headlines, publications" },
};

export const exportKeyConfigured = () => String(process.env.HIVEMIND_EXPORT_KEY || "").trim().length >= 32;

// null when the request may proceed, else { code, error }
export function checkExportKey(req) {
  const want = String(process.env.HIVEMIND_EXPORT_KEY || "").trim();
  if (want.length < 32) return { code: 404, error: "Data export is not enabled on this server" };
  const auth = String(req.headers.authorization || "");
  const got = String(req.headers["x-api-key"] || (auth.toLowerCase().startsWith("bearer ") ? auth.slice(7) : "")).trim();
  const h = (s) => createHash("sha256").update(s).digest();
  if (!got || !timingSafeEqual(h(got), h(want))) return { code: 401, error: "Missing or wrong API key (send it as the X-API-Key header)" };
  return null;
}

const tableExists = (db, t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
const columns = (db, t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);

// Text that holds JSON (readings, entities, aliases, ...) is returned as JSON, not as a string.
function decode(v) {
  if (typeof v !== "string" || v.length < 2) return v;
  const a = v[0], z = v[v.length - 1];
  if ((a === "{" && z === "}") || (a === "[" && z === "]")) { try { return JSON.parse(v); } catch { return v; } }
  return v;
}

function parseSince(raw) {
  if (raw == null || raw === "") return 0;
  if (/^\d+$/.test(raw)) return +raw;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}
const encodeCursor = (t, r) => Buffer.from(JSON.stringify([t, r])).toString("base64url");
function decodeCursor(s) {
  try { const [t, r] = JSON.parse(Buffer.from(String(s), "base64url").toString()); return Number.isFinite(t) && Number.isInteger(r) ? { t, r } : null; } catch { return null; }
}

export function exportIndex(db) {
  const datasets = [];
  for (const [name, d] of Object.entries(DATASETS)) {
    if (!tableExists(db, d.table)) continue;
    const r = db.prepare(`SELECT COUNT(*) AS n, MAX(${d.changed}) AS last FROM ${d.table}`).get();
    datasets.push({ name, about: d.about, key: d.key, rows: r.n, last_changed_at: r.last ?? null, last_changed: r.last ? new Date(r.last).toISOString() : null, path: `/api/export/${name}` });
  }
  return {
    server_time: Date.now(),
    datasets,
    reference: {
      "/api/export/brackets": "Keyword brackets (BCG impact categories) with descriptions, keywords and story counts",
      "/api/export/companies": "Companies and their sectors (BCG practice areas), with topic matches",
      "/api/export/xtrends": "Latest Twitter/X trends (India and worldwide) as last collected",
    },
    views: ["overview", "opportunities", "leadership", "labels", "sentiment", "entities", "sources", "origins", "series", "topic", "opportunity", "backtest"].map((v) => `/api/export/views/${v}`),
    usage: {
      auth: "Send the key in the X-API-Key header (or Authorization: Bearer <key>).",
      first_sync: "GET /api/export/<dataset> with no since. Follow next_cursor while has_more is true.",
      later_syncs: "Pass since=<next_since from your previous sync> to get only rows added or changed after it. Insert-or-update rows by their key fields.",
      params: { since: "epoch milliseconds or ISO date-time; rows changed at or after it", limit: "rows per page, 1-2000, default 500", cursor: "next_cursor from the previous page", company: "only rows for one company, on datasets that have a company column" },
    },
  };
}

// One page of a dataset. Returns { code, body }.
export function exportPage(db, name, params) {
  const d = DATASETS[name];
  if (!d || !tableExists(db, d.table)) return { code: 404, body: { error: `Unknown dataset '${name}'. GET /api/export lists them.` } };
  const since = parseSince(params.get("since"));
  if (since == null) return { code: 400, body: { error: "since must be epoch milliseconds or an ISO date-time" } };
  const limit = Math.min(2000, Math.max(1, Math.floor(+params.get("limit") || 500)));
  let from = { t: since, r: -1 };
  if (params.get("cursor")) { from = decodeCursor(params.get("cursor")); if (!from) return { code: 400, body: { error: "Bad cursor" } }; }

  const cols = columns(db, d.table).filter((c) => !(d.omit || []).includes(c));
  const where = [`((${d.changed}) > ? OR ((${d.changed}) = ? AND rowid > ?))`], args = [from.t, from.t, from.r];
  const company = params.get("company");
  if (company && cols.includes("company")) { where.push("company = ?"); args.push(company); }
  const sql = `SELECT rowid AS _rid, (${d.changed}) AS _changed, ${cols.map((c) => `"${c}"`).join(", ")} FROM ${d.table} WHERE ${where.join(" AND ")} ORDER BY _changed, rowid LIMIT ?`;
  const raw = db.prepare(sql).all(...args, limit + 1);
  const more = raw.length > limit, page = more ? raw.slice(0, limit) : raw;
  const rows = page.map((r) => {
    const o = {};
    for (const c of cols) o[c] = decode(r[c]);
    o._changed_at = r._changed;
    return o;
  });
  const last = page[page.length - 1];
  return {
    code: 200,
    body: {
      dataset: name, key: d.key, since, count: rows.length, has_more: more,
      next_cursor: more ? encodeCursor(last._changed, last._rid) : null,
      next_since: last ? last._changed : since,
      rows,
    },
  };
}
