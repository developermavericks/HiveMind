# PostgreSQL instead of SQLite

## Short answer

**Postgres will not make the dashboard load faster, and on one machine it is a little slower. The reason to move is the cloud (several instances, managed backups, no local disk), not speed.** The slow loading had a different cause, which is fixed (next section).

## What was slow, and what fixed it

Measured on the real database (11,923 stories, 93 MB):

| Step | Before | After |
|---|---|---|
| First load of the Opportunities page | **22.9 s** | **0.7 s** |
| of which the data-quality check | 21.8 s | 0.2 s |
| All SQL for the dashboard (heaviest read) | 0.6 s | unchanged |

The 22 seconds were not database time. The data-quality check looked for repeated headlines by comparing every headline of the last two days with every other (8,962 headlines, about 40 million comparisons) in JavaScript. Headlines can only repeat if they share words, so each is now compared only with earlier ones that share one of its rarest words (a standard "prefix filter"). The result is **identical** to the old method: on the real data both give the same 212 repeats, and `test/v13.test.mjs` compares the two methods on 150 random sets on every test run. The change is in `src/quality.mjs`.

A Postgres move would have left this untouched, because the time was spent in JavaScript, not in the database.

## Measured: SQLite against PostgreSQL 17 (same data, same machine)

Median of 7 runs. PostgreSQL ran in a container on the same computer, reached over the network; SQLite is a file read inside the process. `deploy/postgres/bench-queries.mjs` repeats this.

| Query | SQLite | PostgreSQL |
|---|---|---|
| Stories + readings + enrichments, 35 days (11,923 rows) | 184 ms | 335 ms |
| Their articles (15,729 rows) | 157 ms | 133 ms |
| Both together (what the dashboard reads) | **316 ms** | **450 ms** |
| Authored articles, first page | 6 ms | 4 ms |
| 100 single-row lookups, one at a time | **2 ms** | **138 ms** |

PostgreSQL pays a round trip for every query, so the app's many small lookups get slower. In the cloud, with the database on another machine, the gap would be larger, not smaller. A cache or a precomputed summary would do more for load time than any change of database.

## Why move at all

| Need | SQLite file | PostgreSQL (Cloud SQL) |
|---|---|---|
| More than one app instance (Cloud Run, rolling deploys) | No: one writer on one disk | Yes |
| Survives losing the machine / disk | Only with copies you make | Automatic backups, point-in-time recovery, optional standby |
| Several users and jobs writing at once | One writer at a time | Built for it |
| Schema changes | Ad-hoc `ALTER TABLE` lines in code | Versioned migrations |
| Node support | `node:sqlite` is still flagged experimental by Node | Mature driver |

If none of these matter yet (one team, one machine), **stay on SQLite** and use the container plus the daily backups. Move when you need Cloud Run or more than one instance.

## What is already done (draft, tested)

* `deploy/postgres/make-schema.mjs` writes `deploy/postgres/schema.sql` from the real SQLite definitions: 31 tables, 35 indexes. Timestamps become `bigint` (they are milliseconds), `REAL` becomes `double precision`, the auto-numbered ids become identity columns, JSON stays `text` so the code does not change. The file loads cleanly into PostgreSQL 17 and can be run twice.
* `deploy/postgres/migrate-sqlite-to-postgres.mjs` copies every table, resets the id counters, and then checks itself: row counts per table and a content fingerprint of the four large tables. On the real data: **90,370 rows in 9.4 s, all checks passed**. It can be repeated safely and reads SQLite read-only.
* `deploy/postgres/bench-queries.mjs` is the benchmark above.
* Not done: the application still uses SQLite. Nothing in `src/` talks to PostgreSQL.

## What the application change really is

The data layer (`src/db.mjs`) is **synchronous** (`node:sqlite`), and PostgreSQL is not. Every call becomes `await`, which spreads to every caller:

| Measure | Count |
|---|---|
| Store methods | 130 |
| Calls to the store from other files | 280 (in 16 modules) |
| Queries inside `db.mjs`, `analytics`, `auth`, `quality`, `server`... | about 290 |
| `INSERT OR REPLACE` / `INSERT OR IGNORE` to rewrite as `ON CONFLICT` | 17 / 3 |
| `GLOB`, `PRAGMA`, `VACUUM INTO`, `BEGIN IMMEDIATE`, `.changes` to replace | 4 / 10 / 2 / 2 / 6 |
| Test files that use the store | 11 of 16 |

Differences that will bite if missed: SQLite `LIKE` ignores case and PostgreSQL's does not (use `ILIKE`); SQLite is loose about types; sort order of text differs (`COLLATE "C"`); `?` placeholders become `$1, $2...`; `INSERT ... ON CONFLICT` replaces `INSERT OR REPLACE`; `AUTOINCREMENT` becomes identity; backups use `pg_dump` or Cloud SQL, not `VACUUM INTO`.

## Plan

1. **Interface first.** Define the Store as an async interface. Wrap the current SQLite code in it (adapter), so behaviour does not change; make every caller `await`. All 146 tests must pass unchanged. This is the biggest and riskiest step, and it is worth doing on its own.
2. **PostgreSQL implementation** of the same interface, with a connection pool (`pg`). The first version keeps JSON as `text`; move hot JSON columns to `jsonb` afterwards.
3. **Run the whole test suite against both** (PostgreSQL in a throwaway container), so the two cannot drift apart.
4. **Versioned migrations** (plain numbered `.sql` files and a small runner) replacing the ad-hoc `ALTER TABLE` lines.
5. **Rehearse the cut-over** on a copy: stop the app, run the migration script, point `DATABASE_URL` at PostgreSQL, run the checks, start. Keep the SQLite file untouched for a week as the way back.
6. **Choose with `HIVEMIND_DB`**: `sqlite` (default, local development, tests) or `postgres` (cloud). One code path, two stores.

Effort (an estimate, not measured): a few weeks for one developer, most of it in step 1 and in the tests. The migration script and schema already exist, so the data move itself is hours.

## Cutting load time without PostgreSQL

* Keep the data-quality result cached between requests and refresh it in the background, so the first visitor never waits.
* Compute the dashboard's summary tables when the data changes (after each collection), not when someone opens the page.
* The remaining 1.5 s on a cold load is JavaScript analysis of 11,580 stories (a third is the SQL read); load only the days a page needs.

These change the real load time; a different database does not.
