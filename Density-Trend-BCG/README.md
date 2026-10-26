# Density-Trend-BCG

Polls Google News for 15 Indian publications, reads every story **with no company in mind**, files each impact under a reusable **keyword bracket**, then — for any company whose sectors you upload — works out which brackets matter to it and **what to write about**.

```
$env:ANTHROPIC_API_KEY="sk-ant-..."     # or run Ollama locally with a model pulled
node src/cli.mjs run                    # poll → cluster → read → brackets   (writes data/*.json live; resumable)
node src/cli.mjs serve                  # dashboard + upload + matching at http://127.0.0.1:8788
node src/cli.mjs consolidate            # merge duplicate brackets now (also runs during/after `run`)
npm test
```

`run` and `serve` are separate processes; start both. `serve` reads what `run` writes and keeps matching new brackets to every company while the run is going. Zero npm dependencies, Node ≥ 22. Model defaults to `claude-haiku-5-5` (`HIVEMIND_MODEL`). Never put the API key in a file — pass it in the environment.

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
- **Short window.** 24–48h shows momentum, not trend; no baseline yet for "unusual versus a normal day".
- **Cost and privacy.** Thousands of LLM calls per full run; article text goes to the API provider (use Ollama to keep it local, with weaker results).
- **Local server has no auth.** Bound to 127.0.0.1, JSON-only POSTs; don't expose it on a network.
