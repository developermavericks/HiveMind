// Durable local store (SQLite, built into Node — no dependency): data/hivemind.db
//
//   readings  one LLM reading per story (the cache — a story is never read twice)
//   stories   every story ever seen, tagged with the local calendar day it was first published
//   articles  every headline, pointing at its story; a re-seen link keeps its story, so overlapping runs don't double count
//   runs      one row per pipeline run: when, how many headlines, per-publication counts, live progress
//
// Two processes use it at once (`run` writes, `serve` reads); WAL mode lets them.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

export const titleKey = (title) => createHash("sha1").update(title.toLowerCase().replace(/\W+/g, " ").trim()).digest("hex").slice(0, 16);
const pad = (n) => String(n).padStart(2, "0");
// Days are the server's local calendar days (IST on an Indian machine).
export const dayOf = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
export const dayStart = (day) => { const [y, m, d] = day.split("-").map(Number); return new Date(y, m - 1, d).getTime(); };
export const DAY_MS = 24 * 3600e3;

export class Store {
  constructor(path) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.path = path;
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS readings (key TEXT PRIMARY KEY, basis TEXT NOT NULL, analysis TEXT NOT NULL, read_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS stories (
        key TEXT PRIMARY KEY, title TEXT NOT NULL, url TEXT NOT NULL, snippet TEXT NOT NULL DEFAULT '',
        published_at INTEGER NOT NULL, day TEXT NOT NULL, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS stories_day ON stories(day);
      CREATE INDEX IF NOT EXISTS stories_published ON stories(published_at);
      CREATE TABLE IF NOT EXISTS articles (
        url TEXT PRIMARY KEY, story_key TEXT NOT NULL, title TEXT NOT NULL, outlet TEXT NOT NULL,
        publication TEXT NOT NULL, published_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS articles_story ON articles(story_key);
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, finished_at INTEGER,
        model TEXT, headlines INTEGER, publications INTEGER, per_publication TEXT, total INTEGER, done INTEGER NOT NULL DEFAULT 0,
        target_date TEXT);
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
    `);
    // databases created before backfill support lack this column
    if (!this.db.prepare("PRAGMA table_info(runs)").all().some((c) => c.name === "target_date")) this.db.exec("ALTER TABLE runs ADD COLUMN target_date TEXT");
  }

  close() { this.db.close(); }

  #tx(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try { const r = fn(); this.db.exec("COMMIT"); return r; }
    catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }

  // ---- readings (the cache) ----
  hasReading(key) { return !!this.db.prepare("SELECT 1 FROM readings WHERE key = ?").get(key); }
  readingCount() { return this.db.prepare("SELECT COUNT(*) AS n FROM readings").get().n; }
  putReading(key, { analysis, basis, readAt = Date.now() }) {
    this.db.prepare("INSERT OR REPLACE INTO readings (key, basis, analysis, read_at) VALUES (?, ?, ?, ?)").run(key, basis, JSON.stringify(analysis), readAt);
  }

  // ---- stories ----
  // Give each cluster a stable key. If any of its links was already stored, it IS that story (so a re-poll the next
  // day doesn't create a second copy); otherwise it is new. Returns the keys in cluster order.
  upsertClusters(clusters, now = Date.now()) {
    return this.#tx(() => clusters.map((c) => {
      const urls = c.articles.map((a) => a.url);
      const hit = this.db.prepare(
        `SELECT s.key FROM articles a JOIN stories s ON s.key = a.story_key WHERE a.url IN (${urls.map(() => "?").join(",")}) ORDER BY s.first_seen ASC LIMIT 1`,
      ).get(...urls);
      const key = hit?.key ?? titleKey(c.title);
      this.db.prepare(
        `INSERT INTO stories (key, title, url, snippet, published_at, day, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET last_seen = excluded.last_seen`,
      ).run(key, c.title, c.url, c.snippet || "", c.publishedAt, dayOf(c.publishedAt), now, now);
      const art = this.db.prepare(
        `INSERT INTO articles (url, story_key, title, outlet, publication, published_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(url) DO UPDATE SET story_key = excluded.story_key`,
      );
      for (const a of c.articles) art.run(a.url, key, a.title, a.outlet || "", a.publication || a.outlet || "", a.publishedAt ?? c.publishedAt);
      return key;
    }));
  }

  // A story that a later run merged into another is left with no headlines; drop it.
  pruneOrphans() {
    this.db.exec("DELETE FROM stories WHERE key NOT IN (SELECT DISTINCT story_key FROM articles)");
  }

  // Stories first published in [from, to), shaped like the pipeline's in-memory stories. analysis is null until read.
  loadStories({ from, to }) {
    const rows = this.db.prepare(
      `SELECT s.key, s.title, s.url, s.snippet, s.published_at, r.basis, r.analysis
       FROM stories s LEFT JOIN readings r ON r.key = s.key
       WHERE s.published_at >= ? AND s.published_at < ? ORDER BY s.published_at`,
    ).all(from, to);
    const arts = this.db.prepare(
      `SELECT story_key, title, outlet, publication, url FROM articles
       WHERE story_key IN (SELECT key FROM stories WHERE published_at >= ? AND published_at < ?)`,
    ).all(from, to);
    const by = new Map();
    for (const a of arts) (by.get(a.story_key) ?? by.set(a.story_key, []).get(a.story_key)).push({ title: a.title, outlet: a.outlet, publication: a.publication, url: a.url });
    return rows.map((r) => {
      const articles = by.get(r.key) ?? [];
      return {
        id: r.key, title: r.title, url: r.url, snippet: r.snippet, publishedAt: r.published_at,
        outlets: [...new Set(articles.map((a) => a.outlet))], articles,
        analysis: r.analysis ? JSON.parse(r.analysis) : null, basis: r.basis ?? "headline",
      };
    });
  }

  // Days that have data, newest first.
  days() {
    return this.db.prepare(
      `SELECT s.day AS day, COUNT(*) AS stories, COUNT(r.key) AS analysed
       FROM stories s LEFT JOIN readings r ON r.key = s.key GROUP BY s.day ORDER BY s.day DESC`,
    ).all().map((d) => ({ day: d.day, stories: d.stories, analysed: d.analysed }));
  }

  // ---- runs ----
  // targetDate is set for a backfill of one past day; the "latest" runs leave it null.
  startRun({ startedAt = Date.now(), model, headlines, publications, perPublication, total, targetDate = null }) {
    return Number(this.db.prepare(
      "INSERT INTO runs (started_at, updated_at, model, headlines, publications, per_publication, total, done, target_date) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)",
    ).run(startedAt, startedAt, model, headlines, publications, JSON.stringify(perPublication), total, targetDate).lastInsertRowid);
  }
  progressRun(id, done) { this.db.prepare("UPDATE runs SET done = ?, updated_at = ? WHERE id = ?").run(done, Date.now(), id); }
  finishRun(id, done) { const t = Date.now(); this.db.prepare("UPDATE runs SET done = ?, updated_at = ?, finished_at = ? WHERE id = ?").run(done, t, t, id); }
  // kind "any": the most recent run. kind "rolling": the most recent run for the latest window (not a past-day backfill),
  // which is what the rolling view's "now" and per-publication counts are based on.
  latestRun(kind = "any") {
    const r = this.db.prepare(`SELECT * FROM runs ${kind === "rolling" ? "WHERE target_date IS NULL" : ""} ORDER BY id DESC LIMIT 1`).get();
    return r && {
      id: r.id, targetDate: r.target_date, startedAt: r.started_at, updatedAt: r.updated_at, finishedAt: r.finished_at, model: r.model,
      headlines: r.headlines, publications: r.publications, perPublication: JSON.parse(r.per_publication || "[]"), total: r.total, done: r.done,
    };
  }

  // ---- one-time import of the earlier JSON files ----
  importLegacy(dataDir) {
    if (this.db.prepare("SELECT v FROM meta WHERE k = 'legacy_imported'").get()) return null;
    const out = { readings: 0, stories: 0 };
    const readJson = (f) => { const p = join(dataDir, f); return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null; };
    const readings = readJson("readings-v3.json"), stories = readJson("stories-v3.json");
    this.#tx(() => {
      const rd = this.db.prepare("INSERT OR IGNORE INTO readings (key, basis, analysis, read_at) VALUES (?, ?, ?, ?)");
      for (const [k, v] of Object.entries(readings ?? {})) { rd.run(k, v.basis || "headline", JSON.stringify(v.analysis), v.readAt || Date.now()); out.readings++; }
    });
    if (stories?.stories?.length) {
      const seen = stories.meta?.generatedAt ?? Date.now();
      this.upsertClusters(stories.stories.map((s) => ({
        title: s.title, url: s.url, snippet: s.snippet, publishedAt: s.publishedAt,
        articles: (s.articles || []).map((a) => ({ ...a, publishedAt: s.publishedAt })),
      })), seen);
      out.stories = stories.stories.length;
      if (stories.meta?.perPublication) {
        const id = this.startRun({ startedAt: seen, model: stories.meta.model, headlines: stories.meta.articles, publications: stories.meta.publications, perPublication: stories.meta.perPublication, total: stories.stories.length });
        this.finishRun(id, stories.stories.length);
      }
    }
    this.db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('legacy_imported', ?)").run(String(Date.now()));
    return out;
  }
}
