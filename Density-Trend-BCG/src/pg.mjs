// PostgreSQL enterprise adapter for HiveMind.
// Used when DATABASE_URL (or PGHOST/PGDATABASE) is set, e.g. in Docker or cloud deployments.
// Provides connection pooling, multi-user concurrency, and high availability.
import pg from "pg";
const { Pool } = pg;

let pool = null;

export function getPgPool() {
  const connStr = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!connStr && !process.env.PGHOST) return null;
  if (pool) return pool;

  pool = new Pool({
    connectionString: connStr,
    host: process.env.PGHOST,
    port: process.env.PGPORT ? +process.env.PGPORT : 5432,
    database: process.env.PGDATABASE,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    max: Math.min(50, Math.max(10, +process.env.PGMAX_POOL || 20)),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  pool.on("error", (err) => {
    console.error("[PostgreSQL Pool Error]", err.message);
  });

  return pool;
}

export async function initPgSchema(pool) {
  if (!pool) return;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id VARCHAR(64) PRIMARY KEY,
        email VARCHAR(255) NOT NULL UNIQUE,
        name VARCHAR(255) NOT NULL,
        pw_hash TEXT NOT NULL,
        role VARCHAR(32) NOT NULL DEFAULT 'member',
        status VARCHAR(32) NOT NULL DEFAULT 'pending',
        created_at BIGINT NOT NULL,
        last_login_at BIGINT,
        failed_count INT NOT NULL DEFAULT 0,
        locked_until BIGINT,
        company_id VARCHAR(64) NOT NULL DEFAULT 'bcg'
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id_hash VARCHAR(128) PRIMARY KEY,
        user_id VARCHAR(64) NOT NULL,
        created_at BIGINT NOT NULL,
        last_seen BIGINT NOT NULL,
        expires_at BIGINT NOT NULL,
        ip VARCHAR(64),
        ua TEXT,
        lat DOUBLE PRECISION,
        lon DOUBLE PRECISION,
        geo_accuracy REAL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

      CREATE TABLE IF NOT EXISTS auth_log (
        id BIGSERIAL PRIMARY KEY,
        ts BIGINT NOT NULL,
        event VARCHAR(64) NOT NULL,
        email VARCHAR(255),
        ip VARCHAR(64),
        detail TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_auth_log_ts ON auth_log(ts);

      CREATE TABLE IF NOT EXISTS activity_log (
        id BIGSERIAL PRIMARY KEY,
        ts BIGINT NOT NULL,
        user_id VARCHAR(64),
        email VARCHAR(255),
        name VARCHAR(255),
        company_id VARCHAR(64) NOT NULL DEFAULT 'bcg',
        action TEXT NOT NULL,
        path TEXT NOT NULL,
        method VARCHAR(16) NOT NULL,
        status_code INT NOT NULL,
        error TEXT,
        ip VARCHAR(64),
        location TEXT,
        network TEXT,
        ua TEXT,
        duration_ms INT,
        lat DOUBLE PRECISION,
        lon DOUBLE PRECISION,
        geo_accuracy REAL
      );
      CREATE INDEX IF NOT EXISTS idx_activity_log_ts ON activity_log(ts);
      CREATE INDEX IF NOT EXISTS idx_activity_log_user ON activity_log(user_id);

      CREATE TABLE IF NOT EXISTS password_resets (
        id VARCHAR(64) PRIMARY KEY,
        user_id VARCHAR(64) NOT NULL,
        email VARCHAR(255) NOT NULL,
        token_hash VARCHAR(128) NOT NULL,
        expires_at BIGINT NOT NULL,
        used INT NOT NULL DEFAULT 0,
        created_at BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pw_resets_token ON password_resets(token_hash);

      CREATE TABLE IF NOT EXISTS tickets (
        id VARCHAR(64) PRIMARY KEY,
        created_at BIGINT NOT NULL,
        user_id VARCHAR(64) NOT NULL,
        email VARCHAR(255) NOT NULL,
        name VARCHAR(255) NOT NULL,
        company_id VARCHAR(64) NOT NULL DEFAULT 'bcg',
        kind VARCHAR(32) NOT NULL DEFAULT 'bug',
        subject TEXT NOT NULL,
        description TEXT NOT NULL,
        page_url TEXT,
        status VARCHAR(32) NOT NULL DEFAULT 'open',
        admin_notes TEXT DEFAULT '',
        resolved_at BIGINT
      );
      CREATE INDEX IF NOT EXISTS idx_tickets_user ON tickets(user_id);
      CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);

      CREATE TABLE IF NOT EXISTS readings (
        key VARCHAR(64) PRIMARY KEY,
        basis VARCHAR(32) NOT NULL,
        analysis JSONB NOT NULL,
        read_at BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS stories (
        key VARCHAR(64) PRIMARY KEY,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        snippet TEXT NOT NULL DEFAULT '',
        published_at BIGINT NOT NULL,
        day VARCHAR(16) NOT NULL,
        first_seen BIGINT NOT NULL,
        last_seen BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_stories_day ON stories(day);
      CREATE INDEX IF NOT EXISTS idx_stories_published ON stories(published_at);

      CREATE TABLE IF NOT EXISTS articles (
        url TEXT PRIMARY KEY,
        story_key VARCHAR(64) NOT NULL,
        title TEXT NOT NULL,
        outlet VARCHAR(128) NOT NULL,
        publication VARCHAR(128) NOT NULL,
        published_at BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_articles_story ON articles(story_key);

      CREATE TABLE IF NOT EXISTS runs (
        id BIGSERIAL PRIMARY KEY,
        started_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        finished_at BIGINT,
        model VARCHAR(128),
        headlines INT,
        publications INT,
        per_publication TEXT,
        total INT,
        done INT NOT NULL DEFAULT 0,
        target_date VARCHAR(16)
      );

      CREATE TABLE IF NOT EXISTS forecast_log (
        id BIGSERIAL PRIMARY KEY,
        topic VARCHAR(128) NOT NULL,
        made_at BIGINT NOT NULL,
        target_at BIGINT NOT NULL,
        horizon INT NOT NULL,
        predicted REAL NOT NULL,
        lo REAL,
        hi REAL,
        naive REAL,
        actual REAL,
        evaluated_at BIGINT
      );
      CREATE INDEX IF NOT EXISTS idx_forecast_target ON forecast_log(target_at);
    `);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// Convert SQLite '?' placeholder query to PostgreSQL '$1, $2, ...' parameter syntax
export function toPgSql(sql) {
  let idx = 0;
  return sql.replace(/\?/g, () => `$${++idx}`);
}

