# Twitter (X) Trending Validation Architecture

## Overview
HiveMind features automated, real-time cross-verification of suggested editorial angles against active Twitter (X) trends. Whenever the system recommends a content angle or topic for BCG or other clients, it cross-checks whether that angle is actively trending in **India (🇮🇳)** or **Worldwide (🌐)**.

### Core Principles
1. **Zero Twitter API Cost:** No enterprise Twitter/X API v2 pricing or monthly search volume costs.
2. **Zero Headless Scraping / Bot Risk:** No headless Chromium scrapers, IP bans, login credentials, or CAPTCHA risks.
3. **Dual Region Streams:** Captures both India (`/india/`) and Worldwide (`/`) public Top 70 trending streams.
4. **Deterministic Token & Compound Matching:** Matches angles, hashtags, and keywords without noisy false positives.
5. **Automated 8-Hour Sync:** Automated scheduler polls fresh trend data every 8 hours, coordinated with regular collection runs.

---

## Architecture & Data Flow

```
┌─────────────────────────────────┐
│     Public Trending Feeds       │
│  - India Top 70 (/india/)       │
│  - Worldwide Top 70 (/)         │
└────────────────┬────────────────┘
                 │ (8-Hour Polling / On-Demand Refresh)
                 ▼
┌─────────────────────────────────┐
│        src/xtrends.mjs          │
│  - parseTrendsHtml()            │
│  - fetchAllTrends()             │
│  - extractTokens() & match()    │
└────────────────┬────────────────┘
                 │
        ┌────────┴────────┐
        ▼                 ▼
┌───────────────┐ ┌─────────────────────────────────┐
│ SQLite Store  │ │        src/analytics.mjs        │
│ Cache & Jobs  │ │ Enriches opportunities with     │
│ (job_log)     │ │ xTrending: { trending, rank,    │
└───────────────┘ │              name, count, ... } │
                  └───────────────┬─────────────────┘
                                  ▼
                  ┌─────────────────────────────────┐
                  │       Frontend UI Layer         │
                  │  - Drawer: X Trending Status    │
                  │  - Table: 𝕏 #Rank 🇮🇳/🌐 Chips   │
                  │  - Filter: 𝕏 Trending Only      │
                  │  - Tab: #/trends/xtrends        │
                  └─────────────────────────────────┘
```

---

## Components

### 1. Engine (`src/xtrends.mjs`)
- **`fetchAllTrends(opts)`**: Fetches both India and Worldwide streams in parallel with timeouts and fallbacks.
- **`getTrends({ store, maxAgeMs, forceRefresh, region })`**: Non-blocking read from memory cache or SQLite `social.xtrends.cache`. If either stream is unpopulated or older than 8 hours, it automatically invalidates the cache and fetches fresh trends.
- **`matchOpportunityTrend(opp, trends)`**: Multi-tier matching algorithm:
  - Exact token match on cleaned hashtags (e.g., `#DefExpo2026` → `defexpo`).
  - Token intersection between angle phrases, topics, and multi-word trending keywords.
  - Excludes high-frequency editorial stop-words to eliminate false positives.
  - Returns `{ trending: true, rank, name, count, region, reason }`.

### 2. Analytics Integration (`src/analytics.mjs`)
- `opportunities()` and `opportunity()` automatically evaluate the latest cached trends.
- Injects `xTrending` metadata into each opportunity item, enabling instantaneous UI rendering without per-request network calls.

### 3. Server Integration (`src/server.mjs`)
- **API Endpoints:**
  - `GET /api/xtrends?region=all|india|worldwide`: Returns trend lists with regional counts, matched opportunities, and `nextScheduledIn` countdown.
  - `POST /api/xtrends/refresh`: Triggers an immediate manual poll of fresh trends.
- **Scheduler & Follow-up Chain:**
  - Registered as `runXTrendsSync(trigger)` in the 8-hour background timer and collection follow-up sequence.
  - Audited in SQLite `job_log` under `kind: "xtrends"` with status, summary, and item counts.

### 4. UI Dashboard (`src/ui/app.js` & `src/ui/pages.js`)
- **Opportunity Drawer:**
  - Replaced obsolete "X Social Pulse" (which required a non-configured API key) with the dynamic **Twitter / X Trending Status** card.
  - Shows rank badge (`#1` to `#70`), region flag (`🇮🇳 India` or `🌐 Worldwide`), tweet volume, trending hashtag/phrase, and matching explanation.
  - Includes a `↻ Refresh X Trends` button for instant updates.
- **Opportunities Table:**
  - Displays `𝕏 #Rank 🇮🇳` and `𝕏 #Rank 🌐` chips directly alongside opportunity scores.
  - Includes a `[ ] 𝕏 Trending only` quick filter.
- **Dedicated Trends Page (`#/trends/xtrends`):**
  - Tab located under **Trends → 𝕏 Twitter Trends**.
  - KPI summary cards: India Stream count, Worldwide Stream count, Editorial Matches count, and 8-Hour Schedule countdown.
  - Interactive Region Filter: `All Streams`, `🇮🇳 India`, `🌐 Worldwide`.
  - Interactive Type Filter: `All`, `Matched (BCG)`, `Hashtags`, `Keywords`.
  - Search bar and click-to-open drawer for any matched editorial angle.

---

## Unit Testing

Automated unit tests are located in [test/xtrends.test.mjs](file:///e:/Mavericks%20-%20October%20and%20later%20projects%202026/HiveMind/Density-Trend-BCG/test/xtrends.test.mjs):
- **Accuracy:** Verifies angle matching on relevant keywords without false positives.
- **Store caching:** Confirms non-blocking synchronous store reads and cache persistence.
- **Cross-matching:** Verifies multi-trend matching against opportunity arrays.
- **Region separation:** Validates independent handling and filtering of India vs. Worldwide feeds.

Run the test suite anytime:
```bash
node test/xtrends.test.mjs
```

