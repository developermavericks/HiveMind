// Migrates all existing SQLite data to PostgreSQL
// Usage: node src/migrate_to_pg.mjs
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { getPgPool, initPgSchema } from "./pg.mjs";

async function main() {
  const pool = getPgPool();
  if (!pool) {
    console.error("No PostgreSQL connection configured. Set DATABASE_URL=postgres://user:pass@host:5432/db");
    process.exit(1);
  }

  console.log("Connecting to PostgreSQL and creating schema...");
  await initPgSchema(pool);
  console.log("PostgreSQL schema ready.");

  const sqlitePath = join(process.cwd(), "data", "hivemind.db");
  const sdb = new DatabaseSync(sqlitePath);

  const client = await pool.connect();
  try {
    // 1. Migrate users
    const users = sdb.prepare("SELECT * FROM users").all();
    console.log(`Migrating ${users.length} users...`);
    for (const u of users) {
      await client.query(`
        INSERT INTO users (id, email, name, pw_hash, role, status, created_at, last_login_at, failed_count, locked_until, company_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name, pw_hash = EXCLUDED.pw_hash, role = EXCLUDED.role,
          status = EXCLUDED.status, company_id = EXCLUDED.company_id
      `, [u.id, u.email, u.name, u.pw_hash, u.role, u.status, u.created_at, u.last_login_at, u.failed_count, u.locked_until, u.company_id || "bcg"]);
    }

    // 2. Migrate stories in batches
    const storiesCount = sdb.prepare("SELECT COUNT(*) as c FROM stories").get().c;
    console.log(`Migrating ${storiesCount} stories...`);
    const BATCH = 500;
    for (let offset = 0; offset < storiesCount; offset += BATCH) {
      const batch = sdb.prepare("SELECT * FROM stories LIMIT ? OFFSET ?").all(BATCH, offset);
      for (const s of batch) {
        await client.query(`
          INSERT INTO stories (key, title, url, snippet, published_at, day, first_seen, last_seen)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT (key) DO NOTHING
        `, [s.key, s.title, s.url, s.snippet || "", s.published_at, s.day, s.first_seen, s.last_seen]);
      }
      process.stdout.write(`\rStories migrated: ${Math.min(storiesCount, offset + BATCH)} / ${storiesCount}`);
    }
    console.log("\nStories migrated successfully.");

    // 3. Migrate readings in batches
    const readingsCount = sdb.prepare("SELECT COUNT(*) as c FROM readings").get().c;
    console.log(`Migrating ${readingsCount} readings...`);
    for (let offset = 0; offset < readingsCount; offset += BATCH) {
      const batch = sdb.prepare("SELECT * FROM readings LIMIT ? OFFSET ?").all(BATCH, offset);
      for (const r of batch) {
        await client.query(`
          INSERT INTO readings (key, basis, analysis, read_at)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (key) DO NOTHING
        `, [r.key, r.basis, r.analysis, r.read_at]);
      }
      process.stdout.write(`\rReadings migrated: ${Math.min(readingsCount, offset + BATCH)} / ${readingsCount}`);
    }
    console.log("\nReadings migrated successfully.");

    // 4. Migrate forecast_log
    const forecasts = sdb.prepare("SELECT * FROM forecast_log").all();
    console.log(`Migrating ${forecasts.length} forecasts...`);
    for (const f of forecasts) {
      await client.query(`
        INSERT INTO forecast_log (topic, made_at, target_at, horizon, predicted, lo, hi, naive, actual, evaluated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      `, [f.topic, f.made_at, f.target_at, f.horizon, f.predicted, f.lo, f.hi, f.naive, f.actual, f.evaluated_at]);
    }

    console.log("\n--- MIGRATION TO POSTGRESQL COMPLETE! ---");
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1]?.endsWith("migrate_to_pg.mjs")) {
  main().catch(console.error);
}

