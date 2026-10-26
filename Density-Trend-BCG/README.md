# Density-Trend-BCG

Polls Google News for 15 Indian publications, reads every story **with no company in mind**, files each impact under a reusable **keyword bracket**, then — for any company whose sectors you upload — works out which brackets matter to it and **what to write about**.

```
$env:ANTHROPIC_API_KEY="sk-ant-..."     # or run Ollama locally with a model pulled
node src/cli.mjs run                    # poll → cluster → read → brackets   (writes data/*.json live; resumable)
node src/cli.mjs run --date 2026-10-24  # fetch and read one whole past day instead of the last 24h
node src/cli.mjs serve                  # dashboard + upload + matching at http://127.0.0.1:8788 (has a Run button)
node src/cli.mjs consolidate            # merge duplicate brackets now (also runs during/after `run`)
npm test
```

`run` and `serve` are separate processes; start both. `serve` reads what `run` writes and keeps matching new brackets to every company while the run is going. Zero npm dependencies, Node ≥ 22.13 (uses the built-in `node:sqlite`). Model defaults to `claude-haiku-5-5` (`HIVEMIND_MODEL`). Never put the API key in a file — pass it in the environment.

## Run button
At the top of the dashboard: choose **latest 24 hours** or **a specific day**, press **Run**, confirm. The server starts `cli.mjs run` (one at a time), the page shows progress, and a failure message (e.g. Google throttling) appears next to the button. It needs the server to have been started with the API key, and it reads every story not already in the database, so a full day is thousands of LLM calls. A past day uses Google's whole-day filter (`after:`/`before:`), which returns at most ~100 headlines per publication for that day, so a past day is less complete than a day captured live. **This past-day query has not been confirmed against Google yet** (Google was returning 503 when it was built); try one day and check its headline counts in the publication table.

## Database and date-wise history
Everything the pipeline reads and learns is kept in a local SQLite file, `data/hivemind.db` (WAL mode, so `run` can write while `serve` reads):

| Table | Holds |
|---|---|
| `readings` | the LLM's reading of each story — the cache; a story is never read (or paid for) twice, and each reading is saved the moment it is made |
| `stories` / `articles` | every story and headline ever seen, tagged with the local calendar day it was first published. A re-seen link keeps its story, so overlapping daily runs don't double count |
| `runs` | each run's start/finish, headline count, per-publication counts and live progress |

Run it daily and history accumulates. The dashboard's **View** picker switches between the latest rolling 48h and any stored day (that day's brackets, impacts, geography, publications, and company lens). The first start imports any earlier `readings-v3.json` / `stories-v3.json`. Bracket registry (`brackets-v3.json`) and company profiles (`data/companies/`) are still JSON files. To inspect the database: `sqlite3 data/hivemind.db "select day, count(*) from stories group by day"`.

For a past day the company lens uses the *latest* sector matches, so its article angles were written from the most recent news, not that day's. Back up `data/hivemind.db` (copy it with the server stopped) — it is the only copy of your history.

## Pipeline
1. **Poll** — `site:<domain> when:24h` per publication; where Google's ~100-item ceiling is hit, narrower recent windows are merged by URL. No cap.
2. **Cluster** — near-duplicate headlines become one story with an outlet count.
3. **Read (company-agnostic)** — article text if retrievable, else headline. The LLM records what happened, who/what is affected (area, direction, severity, horizon) and geography, and files **every impact under a keyword bracket**.
4. **Brackets are broad sector areas and never repeat** — a fixed starter taxonomy of 22 one/two-word brackets (`config/brackets.seed.json`: People, Education, Economy, Finance, AI & Tech, Startups, Climate, Energy, Health, Politics, Law, Infrastructure, Transport, Agriculture, Industry, Consumer, Jobs, Security, Real Estate, Media & Culture, Trade, Geopolitics), each defined by keywords. The LLM sees the whole list for every story and picks the closest bracket per impact; it may add a new bracket only for an area clearly outside all of them, and a proposal is merged into an existing bracket if name/keywords overlap ≥ 60%. Seeded brackets are never merged away; extras can be folded into them by a consolidation pass. Edit the seed file to change the taxonomy (and use fresh `data/*-v3.json`).
5. **Company lens** — upload a company's sectors (CSV with a `sector` column, TXT one per line or comma-separated with optional `Company: Name` first line, JSON, or paste). For each bracket the LLM is shown the area's most significant current stories and judges, from the sector names/descriptions only, which sectors it matters to: relevance 0–1, direct/indirect, front (demand, cost, supply chain, regulation…), and an article angle for that exact sector × bracket pairing. Cached per company and refreshed when a bracket's stories grow ~50% or age. BCG's 25 practice areas ship as the built-in company.
6. **Density** — bracket weight = Σ over stories of severity × (1 + log₂ outlets) × (1, or 0.7 if headline-only), binned by 3h and Gaussian-smoothed. Sector field = Σ bracket field × relevance. Each sector × bracket pair is a recommendation, ranked by bracket weight × relevance.

## Verified vs. not
- Verified: live Google polling and full-text resolution; bracket reuse and merging on real stories; matching on real brackets after fixing a bug where sector names echoed with their description were rejected; atomic file swaps under concurrent read on Windows; 19 tests (parsing, registry, merging, validation, density math, company store, server upload).
- Not verified: the dashboard's visual rendering in a browser (script syntax-checked and served only); quality against human judgement.

## Merits
- **Impact before client.** The news is analysed on its own terms, so one reading serves any number of companies; adding a company costs one match per bracket, not a re-read of the news.
- **Reusable themes.** Brackets give a stable vocabulary: the same theme accumulates density across days instead of fragmenting into per-event labels.
- **Actionable output.** Ranked topics with direct/indirect, front, rationale and an article angle answer "what should we write about", with the stories as evidence.
- **Second-order reach.** Indirect links (cyclone → claims → insurance; port closures → operations) surface what keyword matching can't.
- **Auditable and cheap.** Every score traces to stories, outlet counts and written rationale; readings and matches are cached; Haiku-class models suffice.

## Demerits / risks
- **Source is lossy and unofficial.** Google News caps queries, `site:` matching is imperfect, the endpoint and the URL-resolution RPC are undocumented; paywalled outlets give headline-only readings. Terms of Google/publishers restrict bulk use — keep internal.
- **LLM judgement, uncalibrated.** Severity, relevance and direct/indirect are opinions that vary by model and run; no human-labelled test set exists yet. Matching is only as good as the sector names/descriptions supplied.
- **Broad brackets are blunt.** With ~22 areas, "Politics" or "Economy" collect a large share of stories and touch almost every sector weakly. Ranking by bracket weight × relevance therefore lets a big bracket with a weak link (relevance 0.3) outrank a small bracket with a strong one; treat the relevance tag as seriously as the rank. The taxonomy is my starter list, not BCG's — edit it.
- **Weights are heuristics.** The log₂ outlet bonus, 0.7 headline discount, 3-hour bins, 0.3 relevance threshold are reasoned defaults. Coverage ≠ importance: press attention skews to politics/crime and metros.
- **Matching lags reading.** Each company needs one LLM judgement per bracket, so topics fill in behind the reading and can reorder as more brackets are judged.
- **Short window.** Each run sees only the last 24h, so history exists only for days you actually run it; there is no backfill. With history you can now build a baseline for "unusual versus a normal day", but nothing computes one yet.
- **Google throttles.** Heavy polling returns HTTP 503/429 (it happened during development); the poller backs off and retries, but a run can still fail with "No articles retrieved". Wait and retry rather than hammering.
- **Cost and privacy.** Thousands of LLM calls per full run; article text goes to the API provider (use Ollama to keep it local, with weaker results).
- **Local server has no auth.** Bound to 127.0.0.1, JSON-only POSTs; don't expose it on a network.
