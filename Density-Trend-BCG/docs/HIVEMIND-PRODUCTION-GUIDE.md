# HiveMind: operations and production guide

One place for how to run it, what state it is in, what was measured, and what comes next. It was assembled on 2026-10-28. The detailed plans are in `DOCKER.md`, `POSTGRES-MIGRATION.md` and `GCP-ROADMAP.md`; this page summarises them and links to them.

## 1. Run it, stop it

Run these in a normal terminal (PowerShell), from the project folder:

```powershell
cd "E:\Mavericks - October and later projects 2026\HiveMind\Density-Trend-BCG"
```

| What you want | Command |
|---|---|
| **Start (recommended)**: dashboard, restarts itself when code or config changes, nothing collected or sent to a model until you press a button | `npm run dev` |
| Start, plain: the same dashboard without the auto-restart | `node src/cli.mjs serve --no-auto` |
| **Start in automatic mode**: the same, plus the schedule below | `npm run dev:auto` (or `node src/cli.mjs serve --schedule 480`) |
| **Stop** | `Ctrl+C` in the terminal that runs it |
| Stop, if it was started in a hidden window | `Get-CimInstance Win32_Process -Filter "Name='node.exe'" \| Where-Object { $_.CommandLine -match 'dev\.mjs\|cli\.mjs' } \| ForEach-Object { Stop-Process -Id $_.ProcessId -Force }` |
| Back up the database now | `node src/cli.mjs backup` (copies go to `data/backups/`, newest 7 kept) |
| Run the tests | `npm test` (150 tests) |

Open **http://127.0.0.1:8788** and sign in. Accounts live in the database, so they survive a restart.

### The schedule (automatic mode only; `--no-auto` and `npm run dev` schedule nothing)

| What | When | Notes |
|---|---|---|
| News collection | About every 7 hours (checked every 5 minutes; due 432 minutes after the previous one started, i.e. 3 to 4 times a day) | Each run covers the time since the last one, plus an hour. Set by `--schedule 480` / `HIVEMIND_SCHEDULE_MINUTES`. |
| **Print editions** | **Once a day from 11:15** local time (`ocr.dailyAt` in `config/hivemind.json`) | The slowest paper finishes extracting by about 10:57 IST. A time that passed while the server was off is made up when it next runs; a failed run is retried an hour later, at most 3 times a day; a successful run, scheduled or by hand, counts as that day's. Each run looks back 3 days (`ocr.scheduledDays`), so an edition that was not out yet is picked up next day. |
| Start-up follow-ups | About 20 seconds after the server starts | Labelling, sentiment, topic checks and merges, company matching. Small Luna and Groq cost. |

Start the print editions by hand any time: the dashboard's job button (`POST /api/job {"kind":"ocr"}`) or `node src/cli.mjs ocr`. Their progress shows on the dashboard as "Reading the print editions".

In Docker instead: `docker compose up -d --build` to start, `docker compose down` to stop (data stays in the `hivemind-data` volume). See `DOCKER.md`.

Stopping with `Ctrl+C` or `docker stop` closes the database cleanly. A forced stop is also safe (SQLite recovers), but take a backup first if in doubt. On 2026-10-28 the application was stopped with a forced stop after a fresh backup; the database passed its integrity check afterwards.

## 2. Where it stands

**Not production grade yet; a solid pilot for a small team on one machine.**

| Good | Missing |
|---|---|
| Passwords hashed with scrypt, HttpOnly SameSite=Strict sessions, CSRF checks, login lockout, body-size caps | No HTTPS of its own (use a proxy or load balancer) and no rate limit beyond login |
| Security headers (CSP, frame denial, no-sniff, referrer and permissions policy) and a host allow-list against DNS rebinding | No monitoring, alerting or structured logging |
| Zero npm dependencies | No CI; **38 files uncommitted** |
| 150 tests pass | Tests stub the network; no UI tests (the dashboard was only syntax-checked) |
| Cost tracking, a daily spend cap on Luna, retries and fallbacks | SQLite is flagged experimental by Node; schema changes are ad-hoc `ALTER TABLE` lines |
| Health check, clean shutdown, daily backup command, first-admin lock (added and tested) | Result quality is approximate and not yet measured against human labels |

## 3. Loading speed

| Step | Before | After |
|---|---|---|
| First Opportunities page load | 22.9 s | 0.7 s |
| of which the data-quality check | 21.8 s | 0.2 s |

The delay was a pair-by-pair comparison of about 9,000 headlines in JavaScript, not the database. Each headline is now compared only with earlier ones that share its rarest words. The answer is identical on the real data (the same 212 repeats) and a regression test compares the two methods on 150 random sets (`test/v13.test.mjs`). The change is in `src/quality.mjs`.

**Postgres does not speed this up.** Measured on the same data and machine (median of 7 runs): the dashboard's heavy read took 316 ms on SQLite and 450 ms on PostgreSQL 17; 100 single lookups took 2 ms and 138 ms. PostgreSQL is a network hop away. Move to it for the cloud, not for speed.

## 4. Models and cost

**Claude is switched off.** Groq and OpenAI (GPT-5.6 Luna) do all the work, and nothing can fall back to Claude. Turn Claude back on in Settings → Integrations (it needs `ANTHROPIC_API_KEY`); that restores the old behaviour.

| Luna (OpenAI) | Groq (gpt-oss-120b) |
|---|---|
| Reading headlines, company-sector matching, briefs, the second-opinion review, page layout of print editions | Everything else: sentiment, topic labels and checks, merges, full-article reading, judging print articles, writer names, headline repair |

The lists are `routingNoClaude` in `config/hivemind.json`. Luna falls back to Groq on failure or when its **daily cap** (`limits.openaiDailyUsd`, 3 USD) is reached.

Measured (reference = Claude's stored answers; this shows agreement, not correctness):

| Reading 80 stories | Luna | Groq |
|---|---|---|
| Same impact / no-impact call | 85 to 86% | 85% |
| Shares a topic label | 63% (no reasoning) | 39% |
| Sentiment agrees | 79% | 74% |
| Cost per 1,000 stories | about 0.48 USD | about 0.35 USD |
| Time for 80 stories | 207 s | 71 s |

Claude Haiku at list price for the same volume would be about 2.14 USD per 1,000 stories (an overestimate, since the app caches part of the prompt). On 2026-10-28 Claude handled 8.9M input and 1.7M output tokens.

| Page layout of print editions (30 pages, against Sonnet's groupings) | Luna | Groq |
|---|---|---|
| Pair-level agreement | 88% | 81% |
| Sonnet's groups reproduced exactly | 43 of 57 | 32 of 57 |
| Cost for the 30 pages | 0.06 USD | 0.04 USD |

Other savings in place: reasoning switched off where it did not help, prompt-cache keys, no stored responses on OpenAI's side, three collections a day instead of hourly, a wider junk filter, fewer second-opinion and matching calls.

## 4b. Network: proxy and certificates

* **No global proxy.** Google News polling, the model APIs (Groq, OpenAI), Serper and everything else connect **directly**. The earlier behaviour, where the command line re-launched itself so that every request went through the proxy, was removed. One side effect of it: OpenAI refused the proxy's exit country (HTTP 403), so Luna calls failed.
* **The proxy has one job.** An article's text is fetched directly. Only when that fails (blocked, throttled, timed out) is it retried **once** through the proxy (`src/proxyfetch.mjs`, used by `fetchArticleBody` in `src/gnews.mjs`). A page that loads but is short (a paywall teaser) is not retried, since a proxy would not change it. With a proxy available the direct attempt fails fast instead of waiting through Google's back-off.
* **Which proxy.** `HIVEMIND_BODY_PROXY`, else `DATAIMPULSE_PROXY_URL`, else `HTTPS_PROXY` / `HTTP_PROXY`. `HIVEMIND_NO_PROXY=1`, or the proxy switch in Settings → Integrations, turns it off for the next job. In `.env` the old `NODE_USE_ENV_PROXY` and `NO_PROXY` lines are commented out.
* **Verified live:** through the real proxy, five requests left from five different addresses, none of them this machine's; direct requests leave from this machine's address. A test with a host that only the proxy can resolve guards against the retry silently skipping the proxy (it did, once, during development: see `test/v16.test.mjs`).
* **Certificates are always checked.** The environment variable `NODE_TLS_REJECT_UNAUTHORIZED=0` (found set in the shell used for this work) switches certificate checking off for every connection, including the ones that carry API keys. The program now switches it back on at start-up (`src/tls.mjs`); `HIVEMIND_ALLOW_INSECURE_TLS=1` keeps the machine's setting. Groq, OpenAI, Google News, the print-edition service, Serper and Anthropic were all reached with checking on. Remove the variable from the Windows environment, too.
* **Collections are visible at once.** A collection records itself on the dashboard from its first second (with a heartbeat while Google News is polled), so the progress bar appears however the run was started.

## 5. Docker

`Dockerfile`, `docker-compose.yml`, `.dockerignore`. Verified by building and running the image: healthy in 5 s, non-root, `tini` as PID 1, the health endpoint answers before login, a stranger cannot become administrator when `HIVEMIND_ADMIN_EMAIL` is set, the account survives a restart, backups work, `docker stop` exits cleanly. One instance only (SQLite). Keys come from environment variables. The compose file itself was only syntax-validated. Full details: `DOCKER.md`.

## 6. PostgreSQL

Drafted and tested but **not wired into the application**: `deploy/postgres/schema.sql` (31 tables, 35 indexes, generated from the SQLite definitions), `migrate-sqlite-to-postgres.mjs` (90,370 rows in 9.4 s, all checks passed) and `bench-queries.mjs`. The real change is making the synchronous data layer async: 130 methods, 280 call sites, about 290 queries. Estimated at a few weeks. Full plan: `POSTGRES-MIGRATION.md`.

## 7. Google Cloud roadmap

| Phase | Effort (estimate) | Result |
|---|---|---|
| 0: commit, CI, rotate the OpenAI key, off-machine backup | 2 to 3 days | Work in git, tests on every push |
| 1: one VM, HTTPS, snapshots, monitoring (no code change, SQLite stays) | 3 to 5 days | Live for the team |
| 2: PostgreSQL on Cloud SQL | 2 to 4 weeks | Several instances, managed backups |
| 3: Cloud Run, scheduled Cloud Run Jobs | 1 to 2 weeks | No single machine |
| 4: staging, alerts, hand-labelled quality check, governance | ongoing | Run as a product |

Nothing has been run on GCP; costs are guesses. Decisions needed from you: who uses it, how reliable it must be, region and data residency, budget, domain, whether a staging environment is wanted. Full plan: `GCP-ROADMAP.md`.

## 8. What was built around the print editions

* **Print editions** from the OCR service (5 papers, 2026-10-20 to 28): 8,000 articles stored; **opinion and analysis** pieces ("authored") found by a model, with writer, headline repair and column re-assembly; each matched to the suggested angle it takes up.
* **Two scoring views** on the Opportunities page: "Nobody has written it" (fewer authored pieces scores higher) and "Others have written it" (more scores higher). An angle with no authored piece is damped in both.
* **Authored articles page** replaces the journalist directory (which is commented out, not deleted), with a "Read full article" view.
* Pipeline: `node src/cli.mjs ocr` (Groq and Luna only; Claude only with `--claude` and the switch on).
* Known limits: layout re-assembly is about 88% in agreement with Sonnet, so some articles are missing a column; a few loose fragments are still counted as pieces; model-written headlines are marked as such; matching is lenient.

## 8b. Leadership view and online opinion pieces

* **Leadership page** (left menu, under Overview): trending now and why, next up, what people are writing about (print and online), nobody has written it yet, hot right now. Computed from the database when the page opens: no model call, no web request.
* **Online pieces count in the headroom** next to the print pieces (`online.countInHeadroom`). A piece counts for a specific topic by its label; for a broad area only once it has been matched to that exact angle. Stock-market notes are left out, and a headline that says "Opinion:" or "Explained:" counts.
* **Opinion pages** of 11 papers are polled during each collection with the same Google News query (`site:domain/opinion`, paths in `config/publications.json` as `opinionPath`). No model. Stories already collected that appear there are marked opinion. `online.sectionRead` (off) would also read the stories found only there: that is the only part that adds model cost.
* **Reading the text** (`node src/cli.mjs online`, or the "Read online pieces now" button): fetch the text of pieces not yet looked at (the proxy retry applies as everywhere), confirm opinion or analysis, name the writer, match the exact angle. Groq only, at most `online.dailyCap` (150) pieces a day, off until pressed. `online.analyze: true` runs it after each collection.
* **Keeping the trend honest:** greetings, horoscopes, mehendi and ritual-explainer headlines are treated as non-news (`junk.titlePatterns`, free; marked, never deleted). The topic-fit job also checks each topic's headlines against the topic's best angle (`angleFit` in the config, Groq only, each headline once per angle, at most 40 topics x 40 headlines a pass). A headline that fails is left out of that topic, reversibly.
* Tables: `online_pieces`, `online_matches`, `section_pieces`.

## 9. Open items

1. **Rotate the OpenAI key**: it was pasted into a chat. It is stored only in `.env`, which is gitignored.
2. Commit and push the work (nothing from this session is in git).
3. Choose between staying on one machine with backups and moving through the cloud phases.
4. Hand-label about 200 articles to measure real accuracy before relying on the opinion/analysis counts for decisions.
5. Decide what text may go to which model provider (article text goes to Groq and OpenAI; client sector names go to the matching job).

## 10. File map (all under `Density-Trend-BCG/`)

| Path | What it is |
|---|---|
| `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `.env.example` | Container and settings |
| `docs/DOCKER.md`, `POSTGRES-MIGRATION.md`, `GCP-ROADMAP.md`, this file | Documentation |
| `deploy/postgres/` | Schema, migration and benchmark tools (own `package.json`; `npm install` there first) |
| `src/dev.mjs` | Development launcher (auto-restart) |
| `src/ocr.mjs`, `src/ocrjobs.mjs` | Print-edition pipeline |
| `config/hivemind.json` | Routing, effort, limits, pricing, scoring settings |
| `data/hivemind.db`, `data/backups/`, `data/ocr_archive/` | The database, backups and raw downloads (not in git) |

## 8c. Load speed (2026-10-30)

Measured through the real server on the real database (about 17,000 stories). Before: the shared context took about 2.3 s to build and was rebuilt every 5 s; overview 0.55 s, entities 5 s, backtest 0.55 s on every request. Now: the context lives for 5 minutes but is rebuilt the moment its signature changes (new stories or readings, labels, a finished job) and is dropped after any edit, so it never serves older data. The heavy views (overview, opportunities, series, entities, sentiment, sources, labels, backtest, topic, origins, leadership) are remembered against that context, a background warm-up rebuilds them every minute when something changed, and API answers over 2 KB are gzipped. Warm calls take 18 to 30 ms. No UI change, no data change, no model calls. Still about 150 to 280 ms: `/api/status`, `/api/logs`, `/api/state`.

### 8c (continued): worker thread, saved views, slim lists, version tags

* **Worker thread** (`src/viewworker.mjs`): the heavy views are built off the main thread with their own read connection, so a rebuild (about 2.3 s after a change) no longer freezes the server. Measured: the server's slowest answer while a rebuild ran was 334 ms. If the worker cannot start the server builds views itself; `HIVEMIND_NO_WORKER=1` switches it off.
* **Saved views** (table `response_cache`, derived data): each finished answer is stored with the data signature it was built for (`Analytics.signature`: stories, readings, labels, weights, finished jobs, edits, and the code version). A restart or a second copy reads them back: the first request after a restart took 23 to 40 ms. They are used only while the signature matches; anything that changes data or finishes a job moves it on.
* **Slim opportunity list**: `/api/opportunities?slim=1` leaves out each row's stories, score components and article lists (counts stay); the opened row gets them from `/api/opportunity?key=`. 2,455 KB became 566 KB (100 KB gzipped).
* **Version tags**: view answers carry an ETag and `Cache-Control: private, no-cache`; a browser that has the current version gets a 304 with no body (21 ms).
* A background warm-up (every minute, only when data changed) builds the views the pages ask for.
