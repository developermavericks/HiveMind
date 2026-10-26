# Sample processed data

A snapshot of one full run (2026-10-26, last 24 hours, 15 Indian publications), so the dashboard can be explored without calling an LLM:

```
node src/cli.mjs serve      # from Density-Trend-BCG/, no API key needed to view; matching new uploads needs one
```

| File | What it is |
|---|---|
| `stories-v3.json` | 2,607 clustered stories: headline, link, outlets, LLM impact reading (who/what is affected, severity, bracket) |
| `brackets-v3.json` | The keyword-bracket registry (22 seeded areas + 2 added by the model) |
| `readings-v3.json` | Cache of the LLM readings, keyed by headline hash; lets `run` skip stories already read |
| `companies/bcg.json` | BCG's practice areas as sectors, plus the LLM's bracket × sector judgements and article angles |

Contents are headlines, links and LLM-written summaries only; no article body text is stored. Readings are model judgement, not verified facts. Check publisher and Google News terms before sharing beyond your team.
