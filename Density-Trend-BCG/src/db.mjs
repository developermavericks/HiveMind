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
      -- Added for the topic-forecasting workflow. All optional: stories without these rows keep working.
      CREATE TABLE IF NOT EXISTS enrichments (
        key TEXT PRIMARY KEY, wire TEXT, content_type TEXT, entities TEXT, topics TEXT, pathways TEXT, source TEXT, enriched_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS topics (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, bracket TEXT, aliases TEXT NOT NULL DEFAULT '[]', count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS authors (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, profile TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS briefs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL, company TEXT, opp_key TEXT NOT NULL, sector TEXT, topic TEXT,
        author_id TEXT, brief TEXT NOT NULL, model TEXT, status TEXT NOT NULL DEFAULT 'pending', note TEXT, decided_at INTEGER);
      CREATE INDEX IF NOT EXISTS briefs_opp ON briefs(opp_key);
      CREATE TABLE IF NOT EXISTS recommendation_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, as_of INTEGER NOT NULL, company TEXT NOT NULL, opp_key TEXT NOT NULL,
        sector TEXT, label TEXT, level TEXT, score REAL, action TEXT, stage TEXT, kind TEXT, components TEXT, evidence TEXT, reason TEXT);
      CREATE INDEX IF NOT EXISTS reclog_key ON recommendation_log(company, opp_key, ts);
      CREATE TABLE IF NOT EXISTS journalists (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, publication TEXT, beat TEXT, designation TEXT, city TEXT, state TEXT, country TEXT,
        email TEXT, phone TEXT, linkedin TEXT, twitter TEXT, profile_url TEXT, articles TEXT NOT NULL DEFAULT '[]', synced_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS journalists_pub ON journalists(publication);
      CREATE TABLE IF NOT EXISTS signals (
        topic TEXT NOT NULL, source TEXT NOT NULL, t INTEGER NOT NULL, value REAL NOT NULL, PRIMARY KEY (topic, source, t));
    `);
    // ---- v2: sentiment, merged topics, job log, usage, outcomes, reading history. Additive only: nothing existing is altered or dropped.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS job_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, trigger TEXT NOT NULL, status TEXT NOT NULL, started_at INTEGER NOT NULL,
        finished_at INTEGER, summary TEXT NOT NULL DEFAULT '', stats TEXT NOT NULL DEFAULT '{}', error TEXT);
      CREATE TABLE IF NOT EXISTS usage_daily (
        day TEXT NOT NULL, service TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0,
        tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, service));
      CREATE TABLE IF NOT EXISTS reading_versions (key TEXT NOT NULL, at INTEGER NOT NULL, basis TEXT NOT NULL, analysis TEXT NOT NULL, PRIMARY KEY (key, at));
      CREATE TABLE IF NOT EXISTS rec_outcomes (
        rec_id INTEGER PRIMARY KEY, evaluated_at INTEGER NOT NULL, hit INTEGER NOT NULL, peak_ratio REAL, peak_origins INTEGER, base_share REAL, peak_share REAL);
      CREATE TABLE IF NOT EXISTS fulltext_tries (key TEXT PRIMARY KEY, tries INTEGER NOT NULL DEFAULT 0, last_at INTEGER NOT NULL, result TEXT);
      CREATE TABLE IF NOT EXISTS web_checks (topic TEXT NOT NULL, source TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (topic, source, at));
    `);
    const cols = (t) => this.db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    const addCol = (t, c, def) => { if (!cols(t).includes(c)) this.db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`); };
    addCol("enrichments", "sentiment", "TEXT"); addCol("enrichments", "stance", "TEXT"); addCol("enrichments", "sentiment_at", "INTEGER");
    addCol("topics", "merged_into", "TEXT"); addCol("topics", "merged_at", "INTEGER");
    addCol("recommendation_log", "voided", "INTEGER NOT NULL DEFAULT 0");
    addCol("usage_daily", "cache_read", "INTEGER NOT NULL DEFAULT 0"); addCol("usage_daily", "batch_tokens", "INTEGER NOT NULL DEFAULT 0");
    // ---- v3: judged topic-sector links, duplicate/junk stories, human audit, second opinions, forecast log, entity aliases. Additive only.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS topic_matches (
        company TEXT NOT NULL, topic TEXT NOT NULL, sector TEXT NOT NULL, relevance REAL NOT NULL, channel TEXT, front TEXT, why TEXT, angle TEXT,
        judged_at INTEGER NOT NULL, story_count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (company, topic, sector));
      CREATE TABLE IF NOT EXISTS story_dupes (key TEXT PRIMARY KEY, canonical TEXT, reason TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS audits (key TEXT PRIMARY KEY, verdict TEXT NOT NULL, note TEXT, reviewer TEXT, reason TEXT, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS reading_reviews (key TEXT NOT NULL, model TEXT NOT NULL, agrees INTEGER NOT NULL, note TEXT, at INTEGER NOT NULL, PRIMARY KEY (key, model));
      CREATE TABLE IF NOT EXISTS forecast_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, topic TEXT NOT NULL, made_at INTEGER NOT NULL, target_at INTEGER NOT NULL, horizon INTEGER NOT NULL,
        predicted REAL NOT NULL, lo REAL, hi REAL, naive REAL, actual REAL, evaluated_at INTEGER);
      CREATE INDEX IF NOT EXISTS forecast_target ON forecast_log(target_at);
      CREATE TABLE IF NOT EXISTS topic_checks (story_key TEXT NOT NULL, topic_id TEXT NOT NULL, fits INTEGER NOT NULL, why TEXT, at INTEGER NOT NULL, PRIMARY KEY (story_key, topic_id));
      CREATE INDEX IF NOT EXISTS topic_checks_at ON topic_checks(at);
      CREATE TABLE IF NOT EXISTS entity_aliases (alias TEXT PRIMARY KEY, canonical TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS topic_matches_topic ON topic_matches(topic);
      CREATE TABLE IF NOT EXISTS ocr_articles (
        id TEXT PRIMARY KEY, source TEXT NOT NULL, edition_date TEXT NOT NULL, page INTEGER, headline TEXT NOT NULL, body TEXT NOT NULL, hash TEXT,
        words INTEGER NOT NULL DEFAULT 0, candidate INTEGER NOT NULL DEFAULT 0, signals TEXT,
        kind TEXT, author TEXT, why TEXT, classified_at INTEGER, model TEXT, fetched_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS ocr_articles_date ON ocr_articles(edition_date);
      CREATE INDEX IF NOT EXISTS ocr_articles_kind ON ocr_articles(kind, edition_date);
      CREATE TABLE IF NOT EXISTS ocr_pages (key TEXT PRIMARY KEY, at INTEGER NOT NULL, groups INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS ocr_angle_matches (
        article_id TEXT NOT NULL, opp_key TEXT NOT NULL, company TEXT NOT NULL, fit REAL NOT NULL, angle TEXT, matched_at INTEGER NOT NULL, PRIMARY KEY (article_id, opp_key));
      CREATE INDEX IF NOT EXISTS ocr_matches_opp ON ocr_angle_matches(company, opp_key);
      -- online opinion / analysis pieces (src/online.mjs): what reading the text found, the opinion-section pages seen, and the exact angle each piece takes up
      CREATE TABLE IF NOT EXISTS online_pieces (story_key TEXT PRIMARY KEY, kind TEXT NOT NULL, author TEXT NOT NULL DEFAULT '', source TEXT, basis TEXT, excerpt TEXT, day TEXT NOT NULL, checked_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS online_pieces_day ON online_pieces(day);
      CREATE TABLE IF NOT EXISTS section_pieces (url TEXT PRIMARY KEY, title TEXT NOT NULL, publication TEXT, outlet TEXT, section TEXT, published_at INTEGER NOT NULL, seen_at INTEGER NOT NULL, story_key TEXT);
      CREATE INDEX IF NOT EXISTS stories_title ON stories(title);
      CREATE TABLE IF NOT EXISTS online_matches (story_key TEXT NOT NULL, opp_key TEXT NOT NULL, company TEXT NOT NULL, fit REAL NOT NULL, angle TEXT, matched_at INTEGER NOT NULL, PRIMARY KEY (story_key, opp_key));
      CREATE INDEX IF NOT EXISTS online_matches_opp ON online_matches(company, opp_key);
    `);
    // Indexes for every lookup the dashboard, the jobs and the analytics make (IF NOT EXISTS: safe on every start).
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS stories_first_seen ON stories(first_seen);
      CREATE INDEX IF NOT EXISTS stories_last_seen ON stories(last_seen);
      CREATE INDEX IF NOT EXISTS articles_pub ON articles(publication, published_at);
      CREATE INDEX IF NOT EXISTS articles_published ON articles(published_at);
      CREATE INDEX IF NOT EXISTS readings_read_at ON readings(read_at);
      CREATE INDEX IF NOT EXISTS readings_basis ON readings(basis);
      CREATE INDEX IF NOT EXISTS enrich_at ON enrichments(enriched_at);
      CREATE INDEX IF NOT EXISTS enrich_sentiment ON enrichments(sentiment);
      CREATE INDEX IF NOT EXISTS topics_name ON topics(name);
      CREATE INDEX IF NOT EXISTS topics_merged ON topics(merged_into);
      CREATE INDEX IF NOT EXISTS reclog_ts ON recommendation_log(ts);
      CREATE INDEX IF NOT EXISTS reclog_action ON recommendation_log(action, ts);
      CREATE INDEX IF NOT EXISTS briefs_status ON briefs(status);
      CREATE INDEX IF NOT EXISTS runs_started ON runs(started_at);
      CREATE INDEX IF NOT EXISTS signals_source ON signals(source, t);
      CREATE INDEX IF NOT EXISTS journalists_name ON journalists(name);
      CREATE INDEX IF NOT EXISTS journalists_beat ON journalists(beat);
      CREATE INDEX IF NOT EXISTS joblog_started ON job_log(started_at);
      CREATE INDEX IF NOT EXISTS joblog_kind ON job_log(kind, started_at);
      CREATE INDEX IF NOT EXISTS webchecks_at ON web_checks(at);
    `);
    // When each headline was first seen (databases created earlier only recorded it per story).
    if (!this.db.prepare("PRAGMA table_info(articles)").all().some((c) => c.name === "first_seen")) this.db.exec("ALTER TABLE articles ADD COLUMN first_seen INTEGER");
    // databases created before backfill support lack this column
    if (!this.db.prepare("PRAGMA table_info(runs)").all().some((c) => c.name === "target_date")) this.db.exec("ALTER TABLE runs ADD COLUMN target_date TEXT");
    this.db.exec("CREATE INDEX IF NOT EXISTS runs_target ON runs(target_date)");
    if (!this.db.prepare("PRAGMA table_info(ocr_articles)").all().some((c) => c.name === "author_checked")) this.db.exec("ALTER TABLE ocr_articles ADD COLUMN author_checked INTEGER");
    // an article the OCR cut into columns is put back together: its parts point at the whole (merged_into) and are marked kind = 'part'
    if (!this.db.prepare("PRAGMA table_info(ocr_articles)").all().some((c) => c.name === "merged_into")) this.db.exec("ALTER TABLE ocr_articles ADD COLUMN merged_into TEXT");
    // the repaired headline (the original OCR headline stays in "headline") and how it was found: printed | generated | kept
    if (!this.db.prepare("PRAGMA table_info(ocr_articles)").all().some((c) => c.name === "title")) this.db.exec("ALTER TABLE ocr_articles ADD COLUMN title TEXT; ALTER TABLE ocr_articles ADD COLUMN title_source TEXT");
    // the collected story an opinion-page entry turned out to be (set once the stories are stored)
    if (!this.db.prepare("PRAGMA table_info(section_pieces)").all().some((c) => c.name === "story_key")) this.db.exec("ALTER TABLE section_pieces ADD COLUMN story_key TEXT");
  }

  // Refresh the query planner's statistics before closing, so indexes keep being chosen well as the data grows.
  close() { try { this.db.exec("PRAGMA optimize"); } catch { /* read-only or busy: not essential */ } this.db.close(); }
  // Consistent copy of the whole database (safe while other processes use it).
  backup(dest) { this.db.exec(`VACUUM INTO '${String(dest).replace(/'/g, "''")}'`); }

  #tx(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try { const r = fn(); this.db.exec("COMMIT"); return r; }
    catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }

  // ---- readings (the cache) ----
  hasReading(key) { return !!this.db.prepare("SELECT 1 FROM readings WHERE key = ?").get(key); }
  // Finished dashboard answers, saved with the data signature they were computed for. A restart or a second copy of the app reads them back
  // instead of recomputing; they are used only while the signature still matches, and are derived data (safe to drop at any time).
  #views() { if (!this._viewsReady) { this.db.exec("CREATE TABLE IF NOT EXISTS response_cache (k TEXT PRIMARY KEY, sig TEXT NOT NULL, body TEXT NOT NULL, at INTEGER NOT NULL)"); this._viewsReady = true; } }
  getView(k, sig) { this.#views(); const r = this.db.prepare("SELECT body FROM response_cache WHERE k = ? AND sig = ?").get(k, sig); return r ? r.body : null; }
  putView(k, sig, body) { this.#views(); this.db.prepare("INSERT INTO response_cache (k, sig, body, at) VALUES (?, ?, ?, ?) ON CONFLICT(k) DO UPDATE SET sig = excluded.sig, body = excluded.body, at = excluded.at").run(k, sig, body, Date.now()); }
  pruneViews(maxAgeMs = 3 * 864e5) { this.#views(); return this.db.prepare("DELETE FROM response_cache WHERE at < ?").run(Date.now() - maxAgeMs).changes; }
  // Changes whenever a background job finishes: part of the dashboard cache's signature, so a longer cache lifetime never serves stale data.
  jobRev() { const r = this.db.prepare("SELECT COUNT(*) AS n, COALESCE(MAX(finished_at), 0) AS m FROM job_log WHERE status <> 'running'").get(); return r.n + ":" + r.m; }
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
        `INSERT INTO articles (url, story_key, title, outlet, publication, published_at, first_seen) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(url) DO UPDATE SET story_key = excluded.story_key`,
      );
      for (const a of c.articles) art.run(a.url, key, a.title, a.outlet || "", a.publication || a.outlet || "", a.publishedAt ?? c.publishedAt, now);
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
      `SELECT s.key, s.title, s.url, s.snippet, s.published_at, s.first_seen, r.basis, r.analysis, r.read_at, e.enriched_at,
              e.wire, e.content_type, e.entities, e.topics, e.pathways, e.sentiment, e.stance
       FROM stories s LEFT JOIN readings r ON r.key = s.key LEFT JOIN enrichments e ON e.key = s.key
       WHERE s.published_at >= ? AND s.published_at < ? ORDER BY s.published_at`,
    ).all(from, to);
    const arts = this.db.prepare(
      `SELECT story_key, title, outlet, publication, url FROM articles
       WHERE story_key IN (SELECT key FROM stories WHERE published_at >= ? AND published_at < ?)`,
    ).all(from, to);
    const merged = this.#mergeMap();
    const by = new Map();
    for (const a of arts) (by.get(a.story_key) ?? by.set(a.story_key, []).get(a.story_key)).push({ title: a.title, outlet: a.outlet, publication: a.publication, url: a.url });
    const drops = this.topicDrops();
    const dupes = this.dupeMap();
    if (dupes.size) {
      const present = new Set(rows.map((r) => r.key));
      for (const [k, canon] of dupes) {
        if (!by.has(k)) continue;
        if (canon && present.has(canon)) { const into = by.get(canon) ?? by.set(canon, []).get(canon), seen = new Set(into.map((a) => a.url)); for (const a of by.get(k)) if (!seen.has(a.url)) into.push(a); }
        by.delete(k);
      }
    }
    return rows.filter((r) => !dupes.has(r.key)).map((r) => {
      const articles = by.get(r.key) ?? [];
      return {
        id: r.key, title: r.title, url: r.url, snippet: r.snippet, publishedAt: r.published_at, firstSeen: r.first_seen, readAt: r.read_at ?? null, enrichedAt: r.enriched_at ?? null,
        outlets: [...new Set(articles.map((a) => a.outlet))], articles,
        analysis: r.analysis ? JSON.parse(r.analysis) : null, basis: r.basis ?? "headline",
        meta: r.content_type || r.topics || r.wire || r.sentiment ? {
          wire: r.wire || null, contentType: r.content_type || null,
          entities: JSON.parse(r.entities || "[]"), topics: [...new Set(JSON.parse(r.topics || "[]").map((t) => merged.get(t) ?? t))].filter((t) => !drops.has(r.key + "|" + t)), pathways: JSON.parse(r.pathways || "[]"),
          sentiment: r.sentiment || null, stance: r.stance || null,
        } : null,
      };
    });
  }

  // First and last publication time ever stored, and how many distinct local days have data.
  span() {
    const r = this.db.prepare("SELECT MIN(published_at) AS a, MAX(published_at) AS b, MAX(last_seen) AS c, COUNT(DISTINCT day) AS days FROM stories").get();
    // lastSeen: when the newest collection touched the database (the live view's "now"), never later than the clock.
    return { first: r.a, last: r.b, days: r.days, lastSeen: r.c ? Math.min(r.c, Date.now()) : r.b };
  }

  // ---- enrichments: extra labels per story (topics, content type, entities, causal pathways, wire credit) ----
  hasEnrichment(key) { return !!this.db.prepare("SELECT 1 FROM enrichments WHERE key = ?").get(key); }
  enrichmentCount() { return this.db.prepare("SELECT COUNT(*) AS n FROM enrichments WHERE topics IS NOT NULL").get().n; }
  putEnrichment(key, { wire = null, contentType = null, entities = null, topics = null, pathways = null, sentiment = null, stance = null, source = "read" }) {
    const prev = this.db.prepare("SELECT * FROM enrichments WHERE key = ?").get(key);
    const j = (v, old) => (v == null ? old ?? null : JSON.stringify(v));
    this.db.prepare("INSERT OR REPLACE INTO enrichments (key, wire, content_type, entities, topics, pathways, source, enriched_at, sentiment, stance, sentiment_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(key, wire ?? prev?.wire ?? null, contentType ?? prev?.content_type ?? null, j(entities, prev?.entities), j(topics, prev?.topics), j(pathways, prev?.pathways), source, Date.now(),
        sentiment ?? prev?.sentiment ?? null, stance ?? prev?.stance ?? null, sentiment ? Date.now() : prev?.sentiment_at ?? null);
  }
  unenrichedCount() {
    return this.db.prepare("SELECT COUNT(*) AS n FROM stories s JOIN readings r ON r.key = s.key LEFT JOIN enrichments e ON e.key = s.key WHERE e.topics IS NULL").get().n;
  }
  // Read stories that have no topic labels yet, in RANDOM order. A topic can only be given to stories labelled after it was
  // coined, so a random order makes that eligible set an unbiased sample of every time period; newest-first would leave
  // late-coined topics with only old stories and no recent history.
  // (The `enrich` command uses this.)
  unenriched(limit = 1e9) {
    return this.db.prepare(
      `SELECT s.key, s.title, s.published_at, r.analysis FROM stories s JOIN readings r ON r.key = s.key
       LEFT JOIN enrichments e ON e.key = s.key WHERE e.topics IS NULL ORDER BY RANDOM() LIMIT ?`,
    ).all(limit).map((r) => ({ key: r.key, title: r.title, publishedAt: r.published_at, analysis: JSON.parse(r.analysis) }));
  }

  // ---- sentiment and stance (one batch call labels many stories; never touches the impact reading) ----
  putSentiment(key, { sentiment, stance }) {
    const now = Date.now();
    if (this.hasEnrichment(key)) this.db.prepare("UPDATE enrichments SET sentiment = ?, stance = ?, sentiment_at = ? WHERE key = ?").run(sentiment, stance, now, key);
    else this.db.prepare("INSERT INTO enrichments (key, source, enriched_at, sentiment, stance, sentiment_at) VALUES (?, 'sentiment', ?, ?, ?, ?)").run(key, now, sentiment, stance, now);
  }
  putSentiments(list) { this.#tx(() => { for (const x of list) this.putSentiment(x.key, x); }); }
  sentimentCount() { return this.db.prepare("SELECT COUNT(*) AS n FROM enrichments WHERE sentiment IS NOT NULL").get().n; }
  unsentimentedCount() { return this.db.prepare("SELECT COUNT(*) AS n FROM readings r LEFT JOIN enrichments e ON e.key = r.key WHERE e.sentiment IS NULL").get().n; }
  // Newest first: recent stories matter most for trends, so a partly finished backfill is already useful.
  unsentimented(limit = 1e9) {
    return this.db.prepare(`SELECT s.key, s.title, s.published_at, r.analysis FROM readings r JOIN stories s ON s.key = r.key LEFT JOIN enrichments e ON e.key = r.key
      WHERE e.sentiment IS NULL ORDER BY s.published_at DESC LIMIT ?`).all(limit).map((r) => ({ key: r.key, title: r.title, publishedAt: r.published_at, analysis: JSON.parse(r.analysis) }));
  }

  // ---- topic merges: reversible (the merged topic row stays, pointing at the one that absorbed it) ----
  #mergeMap() {
    if (this._mm && Date.now() - this._mm.at < 3000) return this._mm.map;
    const map = new Map(this.db.prepare("SELECT id, merged_into FROM topics WHERE merged_into IS NOT NULL").all().map((r) => [r.id, r.merged_into]));
    // follow chains (a to b to c) to the final topic
    for (const [k, v] of map) { let t = v, n = 0; while (map.has(t) && n++ < 10) t = map.get(t); map.set(k, t); }
    this._mm = { at: Date.now(), map };
    return map;
  }
  mergeTopics(keepId, dropId, { name = null } = {}) {
    if (keepId === dropId) return 0;
    const keep = this.db.prepare("SELECT * FROM topics WHERE id = ?").get(keepId), drop = this.db.prepare("SELECT * FROM topics WHERE id = ?").get(dropId);
    if (!keep || !drop || keep.merged_into || drop.merged_into) return 0;
    const aliases = [...new Set([...JSON.parse(keep.aliases), keep.name, drop.name, ...JSON.parse(drop.aliases)].filter((a) => a && a !== (name ?? keep.name)))].slice(0, 40);
    this.#tx(() => {
      this.db.prepare("UPDATE topics SET aliases = ?, count = count + ?, name = ?, created_at = MIN(created_at, ?) WHERE id = ?").run(JSON.stringify(aliases), drop.count, name ?? keep.name, drop.created_at, keepId);
      this.db.prepare("UPDATE topics SET merged_into = ?, merged_at = ? WHERE id = ?").run(keepId, Date.now(), dropId);
      this.db.prepare("UPDATE topics SET merged_into = ? WHERE merged_into = ?").run(keepId, dropId);
    });
    this._mm = null;
    return 1;
  }
  unmergeTopic(id) { this.db.prepare("UPDATE topics SET merged_into = NULL, merged_at = NULL WHERE id = ?").run(id); this._mm = null; }
  mergedTopicCount() { return this.db.prepare("SELECT COUNT(*) AS n FROM topics WHERE merged_into IS NOT NULL").get().n; }

  // ---- small key/value settings (integration toggles and usage, LLM preferences, per-machine settings) ----
  getMeta(k, fallback = null) { const r = this.db.prepare("SELECT v FROM meta WHERE k = ?").get(k); return r ? r.v : fallback; }
  setMeta(k, v) { this.db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)").run(k, String(v)); }
  getJson(k, fallback = {}) { try { return JSON.parse(this.getMeta(k) ?? "null") ?? fallback; } catch { return fallback; } }
  setJson(k, v) { this.setMeta(k, JSON.stringify(v)); }

  // ---- journalist directory (synced from the external endpoint; contact details stay in this local file) ----
  upsertJournalists(list) {
    const now = Date.now();
    this.#tx(() => {
      const st = this.db.prepare(`INSERT OR REPLACE INTO journalists (id, name, publication, beat, designation, city, state, country, email, phone, linkedin, twitter, profile_url, articles, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const j of list) st.run(j.id, j.name, j.publication, j.beat, j.designation, j.city, j.state, j.country, j.email, j.phone, j.linkedin, j.twitter, j.profileUrl, JSON.stringify(j.articles), now);
    });
    return list.length;
  }
  journalistCount() { return this.db.prepare("SELECT COUNT(*) AS n FROM journalists").get().n; }
  #jrow(r) { return { id: r.id, name: r.name, publication: r.publication, beat: r.beat, designation: r.designation, city: r.city, state: r.state, country: r.country, email: r.email, phone: r.phone, linkedin: r.linkedin, twitter: r.twitter, profileUrl: r.profile_url, articles: JSON.parse(r.articles) }; }
  allJournalists() { return this.db.prepare("SELECT * FROM journalists").all().map((r) => this.#jrow(r)); }
  getJournalist(id) { const r = this.db.prepare("SELECT * FROM journalists WHERE id = ?").get(id); return r ? this.#jrow(r) : null; }
  searchJournalists({ q = "", beat = "", publication = "", limit = 50, offset = 0 } = {}) {
    const where = [], args = [];
    if (q) { where.push("(name LIKE ? OR publication LIKE ? OR beat LIKE ? OR city LIKE ? OR articles LIKE ?)"); args.push(...Array(5).fill(`%${q}%`)); }
    if (beat) { where.push("beat LIKE ?"); args.push(`%${beat}%`); }
    if (publication) { where.push("publication LIKE ?"); args.push(`%${publication}%`); }
    const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM journalists ${w}`).get(...args).n;
    const rows = this.db.prepare(`SELECT * FROM journalists ${w} ORDER BY name LIMIT ? OFFSET ?`).all(...args, limit, offset).map((r) => this.#jrow(r));
    return { total, rows };
  }
  journalistFacets() {
    const pubs = this.db.prepare("SELECT publication AS v, COUNT(*) AS n FROM journalists WHERE publication != '' GROUP BY publication ORDER BY n DESC LIMIT 40").all();
    const beats = {};
    for (const { beat } of this.db.prepare("SELECT beat FROM journalists WHERE beat != ''").all()) for (const b of beat.split(",")) { const t = b.trim(); if (t) beats[t] = (beats[t] || 0) + 1; }
    const c = this.db.prepare("SELECT SUM(email != '') AS email, SUM(phone != '') AS phone, SUM(linkedin != '') AS linkedin, SUM(beat != '') AS beat, SUM(articles != '[]') AS articles FROM journalists").get();
    return { publications: pubs, beats: Object.entries(beats).sort((a, b) => b[1] - a[1]).slice(0, 40).map(([v, n]) => ({ v, n })), coverage: { email: c.email || 0, phone: c.phone || 0, linkedin: c.linkedin || 0, beat: c.beat || 0, articles: c.articles || 0 } };
  }

  // ---- topic registry rows (merged topics are hidden; their names live on as aliases of the topic that absorbed them) ----
  loadTopics() { return this.db.prepare("SELECT * FROM topics WHERE merged_into IS NULL").all().map((t) => ({ id: t.id, name: t.name, bracket: t.bracket, aliases: JSON.parse(t.aliases), count: t.count, createdAt: t.created_at })); }
  saveTopic(t) {
    // Never un-merge or lose merge state: update the editable fields only.
    this.db.prepare("INSERT INTO topics (id, name, bracket, aliases, count, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, bracket = excluded.bracket, aliases = excluded.aliases, count = excluded.count")
      .run(t.id, t.name, t.bracket ?? null, JSON.stringify(t.aliases ?? []), t.count ?? 0, t.createdAt ?? Date.now());
  }

  // ---- authors ----
  listAuthors() { return this.db.prepare("SELECT * FROM authors ORDER BY name").all().map((a) => ({ id: a.id, name: a.name, active: !!a.active, ...JSON.parse(a.profile), createdAt: a.created_at, updatedAt: a.updated_at })); }
  putAuthor(a) {
    const { id, name, active = true, createdAt, ...profile } = a;
    const now = Date.now();
    this.db.prepare("INSERT INTO authors (id, name, profile, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, profile = excluded.profile, active = excluded.active, updated_at = excluded.updated_at")
      .run(id, name, JSON.stringify(profile), active ? 1 : 0, createdAt ?? now, now);
  }
  removeAuthor(id) { return Number(this.db.prepare("DELETE FROM authors WHERE id = ?").run(id).changes); }

  // ---- briefs and editor decisions ----
  addBrief({ company, oppKey, sector, topic, authorId = null, brief, model }) {
    return Number(this.db.prepare("INSERT INTO briefs (created_at, company, opp_key, sector, topic, author_id, brief, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(Date.now(), company, oppKey, sector, topic, authorId, JSON.stringify(brief), model).lastInsertRowid);
  }
  listBriefs({ oppKey = null, limit = 100 } = {}) {
    const rows = oppKey
      ? this.db.prepare("SELECT * FROM briefs WHERE opp_key = ? ORDER BY id DESC LIMIT ?").all(oppKey, limit)
      : this.db.prepare("SELECT * FROM briefs ORDER BY id DESC LIMIT ?").all(limit);
    return rows.map((b) => ({ id: b.id, createdAt: b.created_at, company: b.company, oppKey: b.opp_key, sector: b.sector, topic: b.topic, authorId: b.author_id, brief: JSON.parse(b.brief), model: b.model, status: b.status, note: b.note, decidedAt: b.decided_at }));
  }
  decideBrief(id, status, note = "") {
    return Number(this.db.prepare("UPDATE briefs SET status = ?, note = ?, decided_at = ? WHERE id = ?").run(status, note, Date.now(), id).changes);
  }
  briefStats() {
    const r = this.db.prepare("SELECT status, COUNT(*) AS n FROM briefs GROUP BY status").all();
    return Object.fromEntries(r.map((x) => [x.status, x.n]));
  }

  // ---- recommendation history ----
  lastRecommendation(company, oppKey) {
    const r = this.db.prepare("SELECT * FROM recommendation_log WHERE company = ? AND opp_key = ? ORDER BY id DESC LIMIT 1").get(company, oppKey);
    return r && { ...r, components: JSON.parse(r.components || "{}") };
  }
  addRecommendation(r) {
    this.db.prepare("INSERT INTO recommendation_log (ts, as_of, company, opp_key, sector, label, level, score, action, stage, kind, components, evidence, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(r.ts ?? Date.now(), r.asOf, r.company, r.oppKey, r.sector, r.label, r.level, r.score, r.action, r.stage, r.kind, JSON.stringify(r.components ?? {}), JSON.stringify(r.evidence ?? []), r.reason ?? "");
  }
  recommendationHistory(company, oppKey, limit = 50) {
    return this.db.prepare("SELECT * FROM recommendation_log WHERE company = ? AND opp_key = ? ORDER BY id DESC LIMIT ?").all(company, oppKey, limit)
      .map((r) => ({ ...r, components: JSON.parse(r.components || "{}"), evidence: JSON.parse(r.evidence || "[]") }));
  }
  recommendationCount() { return this.db.prepare("SELECT COUNT(*) AS n FROM recommendation_log").get().n; }

  // ---- external signals (search interest): kept separate from news coverage, never zero-filled ----
  putSignal(topic, source, points) {
    this.#tx(() => { const st = this.db.prepare("INSERT OR REPLACE INTO signals (topic, source, t, value) VALUES (?, ?, ?, ?)"); for (const p of points) st.run(topic, source, p.t, p.value); });
  }
  getSignal(topic, source = null) {
    return (source ? this.db.prepare("SELECT t, value, source FROM signals WHERE topic = ? AND source = ? ORDER BY t").all(topic, source) : this.db.prepare("SELECT t, value, source FROM signals WHERE topic = ? ORDER BY t").all(topic));
  }
  signalTopics() { return this.db.prepare("SELECT topic, source, COUNT(*) AS n, MIN(t) AS a, MAX(t) AS b FROM signals GROUP BY topic, source").all(); }

  // Headlines and distinct stories per publication in [from, to): the source-health table.
  publicationStats(from, to) {
    return this.db.prepare("SELECT publication, COUNT(*) AS headlines, COUNT(DISTINCT story_key) AS stories, MAX(published_at) AS last FROM articles WHERE published_at >= ? AND published_at < ? GROUP BY publication").all(from, to);
  }

  // ---- run history (for the collection-health panel) ----
  runs(limit = 30) {
    return this.db.prepare("SELECT * FROM runs ORDER BY id DESC LIMIT ?").all(limit).map((r) => ({
      id: r.id, targetDate: r.target_date, startedAt: r.started_at, finishedAt: r.finished_at, model: r.model, headlines: r.headlines,
      publications: r.publications, perPublication: JSON.parse(r.per_publication || "[]"), total: r.total, done: r.done,
    }));
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
  // A run is recorded before Google News is polled (so the dashboard can show it at once); this fills in its plan once the stories are known.
  planRun(id, { headlines, total, perPublication }) { this.db.prepare("UPDATE runs SET headlines = ?, total = ?, per_publication = ?, updated_at = ? WHERE id = ?").run(headlines, total, JSON.stringify(perPublication), Date.now(), id); }
  // A run that failed before it read anything leaves no trace (a finished or started run is never deleted).
  discardRun(id) { this.db.prepare("DELETE FROM runs WHERE id = ? AND finished_at IS NULL AND done = 0").run(id); }
  runStats(id) { const r = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id); return r && { headlines: r.headlines, total: r.total, done: r.done, perPublication: JSON.parse(r.per_publication || "[]") }; }
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

  // ---- job log: every automated and manual job, what it did and how it ended (Settings -> Logs) ----
  startJob({ kind, trigger = "manual", summary = "", stats = {} }) {
    return Number(this.db.prepare("INSERT INTO job_log (kind, trigger, status, started_at, summary, stats) VALUES (?, ?, 'running', ?, ?, ?)").run(kind, trigger, Date.now(), summary, JSON.stringify(stats)).lastInsertRowid);
  }
  finishJob(id, { status = "ok", summary = "", stats = null, error = null } = {}) {
    const prev = this.db.prepare("SELECT stats FROM job_log WHERE id = ?").get(id);
    const merged = { ...JSON.parse(prev?.stats || "{}"), ...(stats ?? {}) };
    this.db.prepare("UPDATE job_log SET status = ?, finished_at = ?, summary = ?, stats = ?, error = ? WHERE id = ?").run(status, Date.now(), summary, JSON.stringify(merged), error, id);
  }
  // A server that was stopped mid-job leaves 'running' rows behind; mark them so the log is truthful.
  closeStaleJobs(aliveKinds = []) {
    const rows = this.db.prepare("SELECT id, kind FROM job_log WHERE status = 'running'").all().filter((r) => !aliveKinds.includes(r.kind));
    for (const r of rows) this.finishJob(r.id, { status: "stopped", summary: "Interrupted (the server stopped before this job finished)." });
    return rows.length;
  }
  jobLog({ limit = 100, kind = null, status = null, trigger = null } = {}) {
    const w = [], a = [];
    if (kind) { w.push("kind = ?"); a.push(kind); } if (status) { w.push("status = ?"); a.push(status); } if (trigger) { w.push("trigger = ?"); a.push(trigger); }
    return this.db.prepare(`SELECT * FROM job_log ${w.length ? "WHERE " + w.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`).all(...a, limit).map((r) => ({
      id: r.id, kind: r.kind, trigger: r.trigger, status: r.status, startedAt: r.started_at, finishedAt: r.finished_at, durationMs: r.finished_at ? r.finished_at - r.started_at : null,
      summary: r.summary, stats: JSON.parse(r.stats || "{}"), error: r.error }));
  }

  // ---- API usage (calls and tokens per day, per service). One atomic upsert, safe from several processes. ----
  addUsage(service, { calls = 1, errors = 0, tokensIn = 0, tokensOut = 0, cacheRead = 0, batchTokens = 0 } = {}) {
    this.db.prepare(`INSERT INTO usage_daily (day, service, calls, errors, tokens_in, tokens_out, cache_read, batch_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(day, service) DO UPDATE SET calls = calls + excluded.calls, errors = errors + excluded.errors, tokens_in = tokens_in + excluded.tokens_in, tokens_out = tokens_out + excluded.tokens_out,
        cache_read = cache_read + excluded.cache_read, batch_tokens = batch_tokens + excluded.batch_tokens`)
      .run(dayOf(Date.now()), service, calls, errors, tokensIn, tokensOut, cacheRead, batchTokens);
  }
  usage(service, fromDay) {
    const r = this.db.prepare("SELECT COALESCE(SUM(calls),0) AS calls, COALESCE(SUM(errors),0) AS errors, COALESCE(SUM(tokens_in),0) AS tokensIn, COALESCE(SUM(tokens_out),0) AS tokensOut, COALESCE(SUM(cache_read),0) AS cacheRead, COALESCE(SUM(batch_tokens),0) AS batchTokens FROM usage_daily WHERE service = ? AND day >= ?").get(service, fromDay);
    return { calls: r.calls, errors: r.errors, tokensIn: r.tokensIn, tokensOut: r.tokensOut, cacheRead: r.cacheRead, batchTokens: r.batchTokens };
  }

  // ---- live-recommendation outcomes ----
  pendingOutcomes(beforeTs, limit = 500) {
    return this.db.prepare("SELECT * FROM recommendation_log WHERE voided = 0 AND ts <= ? AND id NOT IN (SELECT rec_id FROM rec_outcomes) ORDER BY id LIMIT ?").all(beforeTs, limit)
      .map((r) => ({ ...r, components: JSON.parse(r.components || "{}") }));
  }
  putOutcome(recId, o) { this.db.prepare("INSERT OR REPLACE INTO rec_outcomes (rec_id, evaluated_at, hit, peak_ratio, peak_origins, base_share, peak_share) VALUES (?, ?, ?, ?, ?, ?, ?)").run(recId, Date.now(), o.hit ? 1 : 0, o.peakRatio ?? null, o.peakOrigins ?? null, o.baseShare ?? null, o.peakShare ?? null); }
  outcomes() {
    return this.db.prepare("SELECT r.*, o.hit, o.peak_ratio, o.peak_origins, o.evaluated_at FROM recommendation_log r LEFT JOIN rec_outcomes o ON o.rec_id = r.id WHERE r.voided = 0 ORDER BY r.id DESC").all()
      .map((r) => ({ id: r.id, ts: r.ts, company: r.company, oppKey: r.opp_key, sector: r.sector, label: r.label, level: r.level, score: r.score, action: r.action, stage: r.stage, components: JSON.parse(r.components || "{}"),
        hit: r.evaluated_at ? !!r.hit : null, peakRatio: r.peak_ratio, peakOrigins: r.peak_origins }));
  }

  // ---- full-text upgrades: the earlier reading is kept before a headline-only reading is replaced ----
  headlineOnly(limit = 1e9) {
    return this.db.prepare(`SELECT s.key, s.title, s.url, s.snippet, s.published_at FROM readings r JOIN stories s ON s.key = r.key WHERE r.basis != 'full-text' ORDER BY s.published_at DESC LIMIT ?`).all(limit);
  }
  // Stories still worth a second full-text attempt: tried fewer than maxTries times, and not within the last retryAfterHours.
  fulltextCandidates({ limit, maxTries = 2, retryAfterMs = 12 * 3600e3 }) {
    return this.db.prepare(`SELECT s.key, s.title, s.url, s.snippet, s.published_at FROM readings r JOIN stories s ON s.key = r.key LEFT JOIN fulltext_tries f ON f.key = r.key
      WHERE r.basis != 'full-text' AND (f.key IS NULL OR (f.tries < ? AND f.last_at < ?)) ORDER BY s.published_at DESC LIMIT ?`).all(maxTries, Date.now() - retryAfterMs, limit);
  }
  noteFulltextTry(key, result) { this.db.prepare("INSERT INTO fulltext_tries (key, tries, last_at, result) VALUES (?, 1, ?, ?) ON CONFLICT(key) DO UPDATE SET tries = tries + 1, last_at = excluded.last_at, result = excluded.result").run(key, Date.now(), result); }
  fulltextStats() { return this.db.prepare("SELECT result, COUNT(*) AS n FROM fulltext_tries GROUP BY result").all(); }
  headlineOnlyCount() { return this.db.prepare("SELECT COUNT(*) AS n FROM readings WHERE basis != 'full-text'").get().n; }
  articlesOf(key) { return this.db.prepare("SELECT title, outlet, publication, url FROM articles WHERE story_key = ?").all(key); }
  upgradeReading(key, { analysis, basis }) {
    this.#tx(() => {
      const prev = this.db.prepare("SELECT basis, analysis FROM readings WHERE key = ?").get(key);
      if (prev) this.db.prepare("INSERT OR IGNORE INTO reading_versions (key, at, basis, analysis) VALUES (?, ?, ?, ?)").run(key, Date.now(), prev.basis, prev.analysis);
      this.db.prepare("INSERT OR REPLACE INTO readings (key, basis, analysis, read_at) VALUES (?, ?, ?, COALESCE((SELECT read_at FROM readings WHERE key = ?), ?))").run(key, basis, JSON.stringify(analysis), key, Date.now());
    });
  }

  // ---- web checks (Serper / search interest results for hot topics) ----
  putWebCheck(topic, source, data) { this.db.prepare("INSERT OR REPLACE INTO web_checks (topic, source, at, data) VALUES (?, ?, ?, ?)").run(topic, source, Date.now(), JSON.stringify(data)); }
  lastWebCheck(topic, source) { const r = this.db.prepare("SELECT at, data FROM web_checks WHERE topic = ? AND source = ? ORDER BY at DESC LIMIT 1").get(topic, source); return r ? { at: r.at, ...JSON.parse(r.data) } : null; }
  webChecksSince(source, since) { return this.db.prepare("SELECT topic, at FROM web_checks WHERE source = ? AND at >= ?").all(source, since); }

  // ---- judged topic-sector links (a direct model judgement per client sector, instead of inheriting the parent bracket's) ----
  putTopicMatches(company, topic, list, storyCount = 0) {
    const now = Date.now();
    this.#tx(() => {
      this.db.prepare("DELETE FROM topic_matches WHERE company = ? AND topic = ?").run(company, topic);
      const st = this.db.prepare("INSERT INTO topic_matches (company, topic, sector, relevance, channel, front, why, angle, judged_at, story_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      for (const m of list) st.run(company, topic, m.sector, m.relevance, m.channel ?? null, m.front ?? null, m.why ?? "", m.write_about ?? "", now, storyCount);
      if (!list.length) st.run(company, topic, "", 0, null, null, "", "", now, storyCount); // a judgement of 'no relevant sector' is remembered too
    });
  }
  topicMatches(company) {
    const out = new Map();
    for (const r of this.db.prepare("SELECT * FROM topic_matches WHERE company = ?").all(company)) {
      if (!out.has(r.topic)) out.set(r.topic, { judgedAt: r.judged_at, storyCount: r.story_count, sectors: [] });
      if (r.sector) out.get(r.topic).sectors.push({ sector: r.sector, relevance: r.relevance, channel: r.channel, front: r.front, why: r.why, write_about: r.angle });
    }
    return out;
  }

  // ---- duplicate and junk stories: excluded (canonical NULL) or folded into the story they repeat; reversible, nothing is deleted ----
  dupeMap() {
    if (this._dm && Date.now() - this._dm.at < 3000) return this._dm.map;
    const map = new Map(this.db.prepare("SELECT key, canonical FROM story_dupes").all().map((r) => [r.key, r.canonical]));
    this._dm = { at: Date.now(), map };
    return map;
  }
  markDupes(list) {
    this.#tx(() => { const st = this.db.prepare("INSERT OR REPLACE INTO story_dupes (key, canonical, reason, at) VALUES (?, ?, ?, ?)"); for (const d of list) st.run(d.key, d.canonical ?? null, d.reason, Date.now()); });
    this._dm = null;
  }
  clearDupes() { this.db.exec("DELETE FROM story_dupes"); this._dm = null; }
  dupeCounts() { const r = this.db.prepare("SELECT SUM(canonical IS NULL) AS junk, SUM(canonical IS NOT NULL) AS dupes FROM story_dupes").get(); return { junk: r.junk || 0, duplicates: r.dupes || 0 }; }
  // Every story's id, title and time (cheap scan used by the duplicate check)
  storyTitles(since) { return this.db.prepare("SELECT key, title, published_at FROM stories WHERE published_at >= ? ORDER BY published_at").all(since); }

  // ---- topic fit: a headline filed under a topic is checked against it; labels that do not fit are left out of the topic (reversible) ----
  putTopicChecks(list) {
    this.#tx(() => { const st = this.db.prepare("INSERT OR REPLACE INTO topic_checks (story_key, topic_id, fits, why, at) VALUES (?, ?, ?, ?, ?)"); for (const c of list) st.run(c.key, c.topic, c.fits ? 1 : 0, c.why ?? "", Date.now()); });
    this._td = null;
  }
  topicDrops() {
    if (this._td && Date.now() - this._td.at < 3000) return this._td.set;
    const set = new Set(this.db.prepare("SELECT story_key, topic_id FROM topic_checks WHERE fits = 0").all().map((r) => r.story_key + "|" + r.topic_id.split("@")[0]));
    this._td = { at: Date.now(), set };
    return set;
  }
  checkedTopicPairs() { return new Set(this.db.prepare("SELECT story_key, topic_id FROM topic_checks").all().map((r) => r.story_key + "|" + r.topic_id)); }
  topicFitStats(since) { const r = this.db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(fits), 0) AS fits FROM topic_checks WHERE at >= ?").get(since); return { checked: r.n, fits: r.fits }; }
  topicDropCount(topicId, sinceMs) {
    return this.db.prepare("SELECT COUNT(DISTINCT c.story_key) AS n FROM topic_checks c JOIN stories s ON s.key = c.story_key WHERE (c.topic_id = ? OR c.topic_id LIKE ?) AND c.fits = 0 AND s.published_at >= ?").get(topicId, topicId + "@%", sinceMs).n;
  }
  clearTopicChecks() { this.db.exec("DELETE FROM topic_checks"); this._td = null; }

  // ---- print-edition (OCR) articles: every article kept, authored/opinion pieces marked, and the suggested angle each one takes ----
  // rows: [{ id, source, date, page, headline, body, hash, words, candidate, signals }]. A re-download keeps what was already judged.
  putOcrArticles(rows, now = Date.now()) {
    return this.#tx(() => {
      const ins = this.db.prepare("INSERT OR IGNORE INTO ocr_articles (id, source, edition_date, page, headline, body, hash, words, candidate, signals, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      let added = 0;
      for (const r of rows) added += Number(ins.run(r.id, r.source, r.date, r.page, r.headline, r.body, r.hash, r.words, r.candidate ? 1 : 0, (r.signals ?? []).join(","), now).changes);
      return added;
    });
  }
  ocrUnclassified(limit = 1e9) {
    return this.db.prepare("SELECT id, source, edition_date AS date, page, headline, body, signals FROM ocr_articles WHERE candidate = 1 AND kind IS NULL ORDER BY edition_date DESC, id LIMIT ?").all(limit);
  }
  putOcrKinds(list, model = "", now = Date.now()) {
    this.#tx(() => {
      const st = this.db.prepare("UPDATE ocr_articles SET kind = ?, author = COALESCE(NULLIF(author, ''), NULLIF(?, ''), ''), why = ?, classified_at = ?, model = ? WHERE id = ?");
      for (const c of list) st.run(c.kind, c.author ?? "", c.why ?? "", now, model, c.id);
    });
  }
  // ---- articles the OCR cut into columns ----
  // Undoes assembly: the assembled articles are deleted and their parts become ordinary blocks again, to be judged afresh.
  ocrResetAssembly() {
    return this.#tx(() => {
      const merged = Number(this.db.prepare("DELETE FROM ocr_articles WHERE id GLOB '*|g[0-9]*'").run().changes);
      this.db.prepare("DELETE FROM ocr_angle_matches WHERE article_id GLOB '*|g[0-9]*'").run();
      const parts = Number(this.db.prepare("UPDATE ocr_articles SET kind = NULL, merged_into = NULL, why = NULL, classified_at = NULL, model = NULL, author = NULL, author_checked = NULL, title = NULL, title_source = NULL WHERE kind = 'part'").run().changes);
      this.db.prepare("DELETE FROM ocr_pages").run();
      this.db.prepare("UPDATE ocr_articles SET kind = 'news', classified_at = ?, model = 'rule' WHERE candidate = 0 AND kind IS NULL").run(Date.now());
      return { merged, parts };
    });
  }
  // Pages that have a block starting mid-sentence (the continuation of a column), or an authored piece whose headline looks wrong,
  // and have not been looked at yet. isWeak(headline, author) says whether a headline looks wrong.
  ocrPagesToAssemble(limit = 1e9, isWeak = () => false) {
    const key = (r) => `${r.source}|${r.date}|${r.page}`, pages = new Map();
    const done = new Set(this.db.prepare("SELECT key FROM ocr_pages").all().map((r) => r.key));
    for (const r of this.db.prepare("SELECT DISTINCT source, edition_date AS date, page FROM ocr_articles WHERE page IS NOT NULL AND kind IS NOT 'part' AND words >= 40 AND substr(ltrim(body), 1, 1) GLOB '[a-z]' ORDER BY edition_date DESC, source, page").all()) pages.set(key(r), r);
    for (const r of this.db.prepare("SELECT source, edition_date AS date, page, headline, author FROM ocr_articles WHERE page IS NOT NULL AND kind IN ('opinion', 'analysis') AND merged_into IS NULL").all()) if (isWeak(r.headline, r.author)) pages.set(key(r), { source: r.source, date: r.date, page: r.page });
    return [...pages.entries()].filter(([k]) => !done.has(k)).map(([, v]) => v).slice(0, limit);
  }
  // The blocks of one page in the order the OCR extracted them (article ids count up through the page).
  ocrPageBlocks(source, date, page) {
    return this.db.prepare("SELECT id, words, headline, body FROM ocr_articles WHERE source = ? AND edition_date = ? AND page = ? AND kind IS NOT 'part' AND merged_into IS NULL AND id NOT GLOB '*|g[0-9]*' AND words >= 3 ORDER BY CAST(substr(id, length(source) + length(edition_date) + 3) AS INTEGER)").all(source, date, page);
  }
  // groups: [{ ids, headline, writer }] from the model. Each group becomes one article (id "...|g<first block id>"); its parts stay in the table,
  // marked kind = 'part' so they are not judged or counted on their own, and their angle matches are dropped (the whole article is matched instead).
  putOcrGroups(pg, groups, blocks, now = Date.now()) {
    this.#tx(() => {
      const ins = this.db.prepare("INSERT OR REPLACE INTO ocr_articles (id, source, edition_date, page, headline, body, hash, words, candidate, signals, author, author_checked, title, title_source, fetched_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 1, '', ?, ?, ?, ?, ?)");
      const part = this.db.prepare("UPDATE ocr_articles SET kind = 'part', merged_into = ? WHERE id = ?"), drop = this.db.prepare("DELETE FROM ocr_angle_matches WHERE article_id = ?");
      for (const g of groups) {
        const members = g.ids.map((id) => blocks.find((b) => b.id === id)).filter(Boolean);
        if (members.length < 2) continue;
        const id = `${pg.source}|${pg.date}|g${members[0].id.split("|")[2]}`;
        ins.run(id, pg.source, pg.date, pg.page, members[0].headline, members.map((b) => b.body).join("\n\n"), members.reduce((n, b) => n + b.words, 0), g.writer || "", g.writer ? 1 : null, g.headline || null, g.headline ? "printed" : null, now);
        for (const m of members) { part.run(id, m.id); drop.run(m.id); }
      }
      this.db.prepare("INSERT OR REPLACE INTO ocr_pages (key, at, groups) VALUES (?, ?, ?)").run(`${pg.source}|${pg.date}|${pg.page}`, now, groups.length);
    });
  }

  // Authored pieces whose writer has not been looked for yet. The start and end of the text are kept: that is where the name is printed.
  ocrNeedingAuthor(limit = 1e9) {
    return this.db.prepare("SELECT id, source, page, headline, substr(body, 1, 420) AS start, substr(body, -280) AS finish FROM ocr_articles WHERE kind IN ('opinion', 'analysis') AND author = '' AND author_checked IS NULL ORDER BY edition_date DESC, id LIMIT ?").all(limit);
  }
  ocrNeedingTitle(limit = 1e9) {
    return this.db.prepare("SELECT id, source, page, author, headline, substr(body, 1, 700) AS start FROM ocr_articles WHERE kind IN ('opinion', 'analysis') AND title_source IS NULL ORDER BY edition_date DESC, id LIMIT ?").all(limit);
  }
  putOcrTitles(list) {
    this.#tx(() => { const st = this.db.prepare("UPDATE ocr_articles SET title = ?, title_source = ? WHERE id = ?"); for (const t of list) st.run(t.title || null, t.source, t.id); });
  }
  putOcrAuthors(list) {
    this.#tx(() => {
      const st = this.db.prepare("UPDATE ocr_articles SET author = ?, author_checked = 1 WHERE id = ?");
      for (const a of list) st.run(a.author ?? "", a.id);
    });
  }
  // Articles that were not candidates (short briefs and listings) are recorded as news so each article ends up with a kind.
  markOcrNonCandidates(now = Date.now()) { return Number(this.db.prepare("UPDATE ocr_articles SET kind = 'news', classified_at = ?, model = 'rule' WHERE candidate = 0 AND kind IS NULL").run(now).changes); }
  ocrAuthored({ from = "0000", to = "9999", limit = 1e9 } = {}) {
    return this.db.prepare("SELECT id, source, edition_date AS date, page, COALESCE(title, headline) AS headline, headline AS original, body, kind, author, why FROM ocr_articles WHERE kind IN ('opinion', 'analysis') AND edition_date >= ? AND edition_date <= ? ORDER BY edition_date DESC, id LIMIT ?").all(from, to, limit);
  }
  ocrCounts() {
    const r = this.db.prepare("SELECT COUNT(*) AS total, SUM(kind IN ('opinion', 'analysis')) AS authored, SUM(kind = 'opinion') AS opinion, SUM(kind = 'analysis') AS analysis, SUM(kind IS NOT NULL) AS judged, SUM(candidate = 1) AS candidates, MIN(edition_date) AS first, MAX(edition_date) AS last FROM ocr_articles").get();
    return { total: r.total, authored: r.authored ?? 0, opinion: r.opinion ?? 0, analysis: r.analysis ?? 0, judged: r.judged ?? 0, candidates: r.candidates ?? 0, first: r.first, last: r.last };
  }
  ocrCountsBySource() { return this.db.prepare("SELECT source, COUNT(*) AS total, SUM(kind IN ('opinion', 'analysis')) AS authored FROM ocr_articles GROUP BY source ORDER BY source").all(); }
  // Replaces a company's matches for the given articles: an article takes up at most the angles listed now.
  putOcrMatches(company, list, now = Date.now()) {
    this.#tx(() => {
      const del = this.db.prepare("DELETE FROM ocr_angle_matches WHERE company = ? AND article_id = ?");
      const ins = this.db.prepare("INSERT OR REPLACE INTO ocr_angle_matches (article_id, opp_key, company, fit, angle, matched_at) VALUES (?, ?, ?, ?, ?, ?)");
      for (const id of new Set(list.map((m) => m.articleId))) del.run(company, id);
      for (const m of list) ins.run(m.articleId, m.oppKey, company, m.fit, m.angle ?? "", now);
    });
  }
  ocrMatchedIds(company) { return new Set(this.db.prepare("SELECT DISTINCT article_id FROM ocr_angle_matches WHERE company = ?").all(company).map((r) => r.article_id)); }
  ocrHasData(from, to = "9999") { return this.db.prepare("SELECT COUNT(*) AS n FROM ocr_articles WHERE kind IN ('opinion', 'analysis') AND edition_date >= ? AND edition_date <= ?").get(from, to).n > 0; }
  // The authored-articles page: opinion / analysis pieces (or every judged article with kind = "all"), searchable, with the angles each one takes up.
  ocrSearch({ q = "", source = "", kind = "authored", matched = "", limit = 25, offset = 0, company = "bcg" } = {}) {
    const w = [], args = [];
    if (kind === "opinion" || kind === "analysis") { w.push("a.kind = ?"); args.push(kind); } else if (kind === "news") w.push("a.kind = 'news'"); else if (kind !== "all") w.push("a.kind IN ('opinion', 'analysis')");
    if (source) { w.push("a.source = ?"); args.push(source); }
    if (q) { w.push("(a.headline LIKE ? OR a.author LIKE ? OR a.body LIKE ?)"); const l = "%" + q.replace(/[%_]/g, " ") + "%"; args.push(l, l, l); }
    if (matched === "1") w.push("EXISTS (SELECT 1 FROM ocr_angle_matches m WHERE m.article_id = a.id AND m.company = ? AND m.opp_key <> '-')"); else if (matched === "0") w.push("NOT EXISTS (SELECT 1 FROM ocr_angle_matches m WHERE m.article_id = a.id AND m.company = ? AND m.opp_key <> '-')");
    if (matched === "1" || matched === "0") args.push(company);
    const where = w.length ? "WHERE " + w.join(" AND ") : "";
    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM ocr_articles a ${where}`).get(...args).n;
    const rows = this.db.prepare(`SELECT a.id, a.source, a.edition_date AS date, a.page, COALESCE(a.title, a.headline) AS headline, a.headline AS original, a.title_source AS titleSource, a.author, a.kind, a.why, a.words, substr(a.body, 1, 900) AS excerpt FROM ocr_articles a ${where} ORDER BY a.edition_date DESC, a.source, a.page LIMIT ? OFFSET ?`).all(...args, limit, offset);
    const by = new Map();
    if (rows.length) {
      const ph = rows.map(() => "?").join(",");
      for (const m of this.db.prepare(`SELECT article_id, opp_key, fit, angle FROM ocr_angle_matches WHERE company = ? AND opp_key <> '-' AND article_id IN (${ph}) ORDER BY fit DESC`).all(company, ...rows.map((r) => r.id)))
        (by.get(m.article_id) ?? by.set(m.article_id, []).get(m.article_id)).push({ oppKey: m.opp_key, sector: m.opp_key.split("|")[1] ?? "", fit: m.fit, angle: m.angle });
    }
    return { total, rows: rows.map((r) => ({ ...r, matches: by.get(r.id) ?? [] })) };
  }
  ocrArticle(id, company = "bcg") {
    const r = this.db.prepare("SELECT id, source, edition_date AS date, page, COALESCE(title, headline) AS headline, headline AS original, title_source AS titleSource, body, kind, author, why, words FROM ocr_articles WHERE id = ?").get(id);
    if (!r) return null;
    const matches = this.db.prepare("SELECT opp_key, fit, angle FROM ocr_angle_matches WHERE company = ? AND article_id = ? AND opp_key <> '-' ORDER BY fit DESC").all(company, id).map((m) => ({ oppKey: m.opp_key, sector: m.opp_key.split("|")[1] ?? "", fit: m.fit, angle: m.angle }));
    return { ...r, matches };
  }
  ocrFacets(company = "bcg") { return { counts: { ...this.ocrCounts(), matched: this.db.prepare("SELECT COUNT(DISTINCT article_id) AS n FROM ocr_angle_matches WHERE company = ? AND opp_key <> '-'").get(company).n }, sources: this.ocrCountsBySource() }; }
  // opp_key -> [{ id, source, date, headline, author, kind, fit }] for authored articles in the window.
  ocrMatchesByOpp(company, from, to = "9999") {
    const by = new Map();
    const rows = this.db.prepare("SELECT m.opp_key, m.fit, a.id, a.source, a.edition_date AS date, a.page, COALESCE(a.title, a.headline) AS headline, a.headline AS original, a.title_source AS titleSource, a.author, a.kind FROM ocr_angle_matches m JOIN ocr_articles a ON a.id = m.article_id WHERE m.company = ? AND a.edition_date >= ? AND a.edition_date <= ? ORDER BY m.fit DESC, a.edition_date DESC").all(company, from, to);
    for (const r of rows) (by.get(r.opp_key) ?? by.set(r.opp_key, []).get(r.opp_key)).push({ id: r.id, source: r.source, date: r.date, page: r.page, headline: r.headline, original: r.original, titleSource: r.titleSource, author: r.author, kind: r.kind, fit: r.fit });
    return by;
  }

  // ---- online opinion / analysis pieces ----
  onlineChecked() { return new Set(this.db.prepare("SELECT story_key FROM online_pieces").all().map((r) => r.story_key)); }
  onlineReadOn(day) { return this.db.prepare("SELECT COUNT(*) AS n FROM online_pieces WHERE day = ? AND basis = 'full-text'").get(day).n; }
  putSectionPieces(list, now = Date.now()) {
    return this.#tx(() => {
      const st = this.db.prepare("INSERT OR IGNORE INTO section_pieces (url, title, publication, outlet, section, published_at, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
      let added = 0;
      for (const s of list) added += Number(st.run(s.url, s.title, s.publication ?? "", s.outlet ?? "", s.section ?? "", s.publishedAt, now).changes);
      return added;
    });
  }
  // Ties each opinion-page entry to the collected story it is (same link, else same headline), once, when the stories have been stored.
  linkSectionPieces() {
    return this.#tx(() => {
      const a = Number(this.db.prepare("UPDATE section_pieces SET story_key = (SELECT story_key FROM articles WHERE articles.url = section_pieces.url LIMIT 1) WHERE story_key IS NULL").run().changes);
      const b = Number(this.db.prepare("UPDATE section_pieces SET story_key = (SELECT key FROM stories WHERE stories.title = section_pieces.title LIMIT 1) WHERE story_key IS NULL").run().changes);
      return a + b;
    });
  }
  // Stories found on a newspaper's opinion section page.
  onlineSectionKeys() { return new Set(this.db.prepare("SELECT DISTINCT story_key FROM section_pieces WHERE story_key IS NOT NULL").all().map((r) => r.story_key)); }
  putOnlinePieces(rows, now = Date.now()) {
    const day = dayOf(now);
    this.#tx(() => { const st = this.db.prepare("INSERT OR REPLACE INTO online_pieces (story_key, kind, author, source, basis, excerpt, day, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"); for (const r of rows) st.run(r.key, r.kind, r.author ?? "", r.source ?? "", r.basis ?? "", r.excerpt ?? "", day, now); });
  }
  onlinePieces() { return new Map(this.db.prepare("SELECT story_key, kind, author, source, basis FROM online_pieces").all().map((r) => [r.story_key, { kind: r.kind, author: r.author, source: r.source, basis: r.basis }])); }
  // Confirmed pieces (opinion / analysis) that no angle has been looked for yet.
  onlineUnmatched(company, limit = 1e9) {
    return this.db.prepare("SELECT p.story_key AS key, s.title, p.excerpt FROM online_pieces p JOIN stories s ON s.key = p.story_key WHERE p.kind IN ('opinion', 'analysis') AND NOT EXISTS (SELECT 1 FROM online_matches m WHERE m.story_key = p.story_key AND m.company = ?) ORDER BY s.published_at DESC LIMIT ?").all(company, limit);
  }
  putOnlineMatches(company, list, now = Date.now()) {
    this.#tx(() => {
      const del = this.db.prepare("DELETE FROM online_matches WHERE company = ? AND story_key = ?");
      const ins = this.db.prepare("INSERT OR REPLACE INTO online_matches (story_key, opp_key, company, fit, angle, matched_at) VALUES (?, ?, ?, ?, ?, ?)");
      for (const id of new Set(list.map((m) => m.storyKey))) del.run(company, id);
      for (const m of list) ins.run(m.storyKey, m.oppKey, company, m.fit, m.angle ?? "", now);
    });
  }
  // story key -> opp keys it was matched to ("-" rows only mark the piece as judged, with no angle)
  onlineMatches(company) {
    const by = new Map();
    for (const r of this.db.prepare("SELECT story_key, opp_key, fit FROM online_matches WHERE company = ?").all(company)) (by.get(r.story_key) ?? by.set(r.story_key, []).get(r.story_key)).push({ oppKey: r.opp_key, fit: r.fit });
    return by;
  }
  onlineStats(sinceDay) {
    const r = this.db.prepare("SELECT COUNT(*) AS n, SUM(basis = 'full-text') AS read, SUM(kind IN ('opinion', 'analysis')) AS authored, SUM(author <> '') AS named FROM online_pieces WHERE day >= ?").get(sinceDay);
    return { checked: r.n, read: r.read ?? 0, authored: r.authored ?? 0, named: r.named ?? 0, sections: this.db.prepare("SELECT COUNT(*) AS n FROM section_pieces").get().n };
  }

  // ---- human audit of the AI reading, and a second model's opinion ----
  putAudit({ key, verdict, note = "", reviewer = "", reason = "" }) { this.db.prepare("INSERT OR REPLACE INTO audits (key, verdict, note, reviewer, reason, at) VALUES (?, ?, ?, ?, ?, ?)").run(key, verdict, String(note).slice(0, 400), reviewer, reason, Date.now()); }
  auditedKeys() { return new Set(this.db.prepare("SELECT key FROM audits").all().map((r) => r.key)); }
  auditStats() {
    const rows = this.db.prepare("SELECT verdict, COUNT(*) AS n FROM audits GROUP BY verdict").all(), o = { reviewed: 0, correct: 0, wrong: 0, unsure: 0 };
    for (const r of rows) { o[r.verdict] = r.n; o.reviewed += r.n; }
    const judged = o.correct + o.wrong;
    return { ...o, accuracy: judged ? o.correct / judged : null };
  }
  putReview(key, model, agrees, note = "") { this.db.prepare("INSERT OR REPLACE INTO reading_reviews (key, model, agrees, note, at) VALUES (?, ?, ?, ?, ?)").run(key, model, agrees ? 1 : 0, String(note).slice(0, 300), Date.now()); }
  reviews(limit = 100) { return this.db.prepare("SELECT r.key, r.model, r.agrees, r.note, r.at, s.title FROM reading_reviews r JOIN stories s ON s.key = r.key ORDER BY r.at DESC LIMIT ?").all(limit).map((r) => ({ key: r.key, model: r.model, agrees: !!r.agrees, note: r.note, at: r.at, title: r.title })); }
  reviewedKeys(model) { return new Set(this.db.prepare("SELECT key FROM reading_reviews WHERE model = ?").all(model).map((r) => r.key)); }

  // ---- forecast log: what the dashed line said, kept so it can be compared with what happened ----
  addForecasts(list) {
    this.#tx(() => { const st = this.db.prepare("INSERT INTO forecast_log (topic, made_at, target_at, horizon, predicted, lo, hi, naive) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"); for (const f of list) st.run(f.topic, f.madeAt, f.targetAt, f.horizon, f.predicted, f.lo, f.hi, f.naive); });
  }
  lastForecastAt(topic) { return this.db.prepare("SELECT MAX(made_at) AS t FROM forecast_log WHERE topic = ?").get(topic).t ?? 0; }
  dueForecasts(now) { return this.db.prepare("SELECT * FROM forecast_log WHERE actual IS NULL AND target_at <= ? LIMIT 2000").all(now); }
  putForecastActual(id, actual) { this.db.prepare("UPDATE forecast_log SET actual = ?, evaluated_at = ? WHERE id = ?").run(actual, Date.now(), id); }
  forecastRows() { return this.db.prepare("SELECT * FROM forecast_log WHERE actual IS NOT NULL").all(); }
  forecastPending() { return this.db.prepare("SELECT COUNT(*) AS n FROM forecast_log WHERE actual IS NULL").get().n; }

  // ---- entity aliases (same entity, different wording) ----
  entityAliases() { return new Map(this.db.prepare("SELECT alias, canonical FROM entity_aliases").all().map((r) => [r.alias, r.canonical])); }
  putEntityAlias(alias, canonical) { this.db.prepare("INSERT OR REPLACE INTO entity_aliases (alias, canonical, at) VALUES (?, ?, ?)").run(alias, canonical, Date.now()); }

  // ---- recommendations whose pairing no longer exists are voided so they do not count in the hit rate ----
  voidRecommendations(pred) {
    const rows = this.db.prepare("SELECT id, company, opp_key FROM recommendation_log WHERE voided = 0").all(); let n = 0;
    this.#tx(() => { for (const r of rows) if (pred(r)) { this.db.prepare("UPDATE recommendation_log SET voided = 1 WHERE id = ?").run(r.id); n++; } });
    return n;
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
