# Sample processed data

A snapshot of one full run (2026-10-25 and 26 — the last 24 hours at poll time spans two calendar days): 2,607 stories from 15 Indian publications, so the dashboard can be explored without calling an LLM or polling Google.

```
cd Density-Trend-BCG
node src/cli.mjs serve        # http://127.0.0.1:8788 — no API key needed just to view
```

The app keeps its data in a SQLite database, `data/hivemind.db`. That file is not committed (it is binary and local). **On first start the server imports the JSON files below into a fresh database**, so the View picker lists both days and every chart is populated. After that the database is the source of truth and these JSON files are not read again.

| File | What it is |
|---|---|
| `stories-v3.json` | 2,607 clustered stories: headline, link, outlets, LLM impact reading (who/what is affected, severity, bracket) |
| `brackets-v3.json` | The keyword-bracket registry (22 seeded areas + 2 added by the model) — read directly, not imported |
| `readings-v3.json` | Cache of the LLM readings, keyed by headline hash |
| `companies/bcg.json` | BCG's practice areas as sectors, plus the LLM's bracket × sector judgements and article angles — read directly |

To add more, set `ANTHROPIC_API_KEY` and use the dashboard's Run button (or `node src/cli.mjs run`). New stories are added to the database and stories already in it are not re-read.

Contents are headlines, links and LLM-written summaries only; no article body text is stored. Readings are model judgement, not verified facts. Check publisher and Google News terms before sharing beyond your team.

## Full sample database (2026-10-30)

`hivemind.sample.db.gz` is a copy of the working database from 2026-10-30 (about 20,400 stories with their readings, topics, print-edition matches and the Leadership data), gzipped (44 MB). To use it instead of the small JSON snapshot:

```
cd Density-Trend-BCG
gunzip -k data/hivemind.sample.db.gz && mv data/hivemind.sample.db data/hivemind.db    # Windows: 7-Zip, or: node -e "require('fs').writeFileSync('data/hivemind.db', require('zlib').gunzipSync(require('fs').readFileSync('data/hivemind.sample.db.gz')))"
node src/cli.mjs serve        # the first account you create is the administrator
```

It is sanitized: user accounts, sessions and login history are removed (the app shows first-run account setup), the journalist contact list is removed, and the article text of the print editions and the text excerpts of online pieces are cleared (headlines, authors, kinds and angle matches are kept). It replaces the earlier 72 MB `hivemind.sample.db`.
