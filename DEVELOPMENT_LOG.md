# HiveMind — Development Log & Feature Updates

**Date**: 2026-11-26  
**Target Branch**: `Sample`  
**Base Commit**: `109a24a` (pulled from `satyam`)  

---

## 1. Executive Summary

This release incorporates major feature integrations and editorial intelligence capabilities into the HiveMind platform, pulled from the latest updates on the `satyam` branch and extended to the `Sample` branch:
1. **Extended Publications**: Added **Forbes India**, **Fortune India**, and **Business Today** (both Print and Online editions).
2. **Journalist & Topic Intelligence**: Cross-publication and beat intelligence to find out which journalists write about which topics, made accessible to **both Admin and Member dashboards**.
3. **AI Overview in Trends & Topics**: An executive briefing widget providing narrative triggers, velocity/trend metrics, coverage tone, and boardroom editorial angles, with a one-click copy function.
4. **Custom Topic Mapping (Admin Only)**: Keyword-to-bracket topic mapping tool that enables administrators to manually define high-priority themes so that automated NLP pipelines never miss emerging stories.
5. **Client Custom Priorities**: Configurable sector and topic prioritization per client (e.g., BCG), adding custom score multiplier boosts to strategic opportunities and filtering them in the UI.
6. **Negative News Trends ("Boom" Edge & Color Scale)**: Persistent adverse news momentum detection that provides opportunity scoring boosts (`💥 Negative Trend Edge`) and a prominence-based visual color scale where darker red signifies more prominent negative sentiment.
7. **Manual Op-Ed Submission (Admin Only)**: Ability for editors and administrators to directly log print and online opinion/analysis pieces into the authored articles queue.
8. **UI Bug Fixes**: Restored `contactLinks` helper and added null-safe ratio formatting to ensure zero crash states on emerging trends and unassigned topics.

---

## 2. Detailed Technical Breakdown

### A. Publications Expansion (Print & Online)
- **`config/publications.json`**:
  - Registered `Forbes India` (`forbesindia.com`), `Fortune India` (`fortuneindia.com`), and `Business Today` (`businesstoday.in`).
  - Flagged `print: true` and `online: true` with `editions: ["print", "online"]`.
- **`src/pitch.mjs`**:
  - Added Forbes India, Fortune India, and Business Today to `DEFAULT_OUTLETS` and key practice areas (TMT, BCG X, Financial Institutions, Industrial Goods, Consumer Goods, Leadership).

### B. Journalist & Topic Intelligence (Admin & Member Dashboards)
- **`src/auth.mjs`**:
  - Removed `journalists` from `MEMBER_DENY_GET` so member roles have full read access to journalist intelligence without privilege escalation.
- **`src/server.mjs`**:
  - Enabled `/api/journalists/status`, `/api/journalists/sync`, `/api/journalists`, and `/api/journalists/matches`.
  - Added query param `topic` to `/api/journalists` to filter journalists across beats and past article contents.
- **`src/db.mjs`**:
  - Updated `searchJournalists({ q, topic, beat, publication, limit, offset })` with SQL queries matching topics in designations, beats, and article titles/summaries.
- **`src/ui/app.js` & `src/ui/pages.js`**:
  - Added `journalists` top-level page and navigation entry (`#/journalists`) visible to both Admin and Member roles.
  - Implemented `pgJournalists()` with topic search input, quick preset pills (AI, Semiconductors, Banking, Clean Energy, Healthcare, Startups, Economy), publication filter, beat filter, expandable article lists, and contact links.

### C. AI Overview & Quick Brief (`/trends/topics`)
- **`src/ui/pages.js`**:
  - Implemented `renderAiOverview()` in `pgMomentum`:
    - **Media Narrative & Trigger**: Identifies leading headlines and outlet distribution.
    - **Velocity & Trend**: Formats growth cadence, momentum ratio, stage, and independent origin counts.
    - **Coverage Tone**: Highlights adverse vs positive tone percentages.
    - **Boardroom / Editorial Angle**: Summarizes strategic angles for executive consumption.
    - **📋 Copy Brief**: Copies a formatted executive brief to clipboard in one click.

### D. Custom Topic Mapping (Admin Only)
- **`src/db.mjs`**:
  - Created SQLite table `custom_topic_mappings` (`id`, `topic_name`, `bracket_id`, `keywords`, `created_at`, `updated_at`).
  - Added Store methods: `putCustomTopicMapping`, `listCustomTopicMappings`, `deleteCustomTopicMapping`.
- **`src/metrics.mjs`**:
  - Updated `prepareItems` to check custom mappings against story headlines and excerpts, dynamically labeling matching stories with `t:<id>` and `b:<bracketId>`.
- **`src/server.mjs`**:
  - Added REST endpoint `GET|POST|DELETE /api/admin/topic-mapping` guarded by admin role.
- **`src/ui/pages.js`**:
  - Added `⚙️ Custom Topic Mapping` button for admins on the Trends tab.
  - Implemented `showCustomTopicMapModal()` to view, add, and delete topic mappings.

### E. Client Custom Priorities
- **`src/db.mjs`**:
  - Created SQLite table `client_priorities` (`company_id`, `sectors`, `topics`, `boost_factor`, `updated_at`).
  - Added Store methods: `getClientPriorities`, `setClientPriorities`.
- **`src/opportunity.mjs`**:
  - In `buildOpportunities()`, applied custom score multiplier boost (`priorityBoost`) when sector or topic matches client preferences.
  - Added `Client Priority ⭐` badge in opportunity cards and table rows.
- **`src/server.mjs`**:
  - Added REST endpoint `GET|POST /api/companies/:id/priorities`.
- **`src/ui/app.js`**:
  - Added `⭐ Client Priorities` modal button and `showClientPrioritiesModal()` in the Opportunities view.
  - Added quick filter checkbox `⭐ Client Priority`.

### F. Negative News Trends Edge & Prominence Color Scale
- **`src/opportunity.mjs`**:
  - Added `isNegativeBoom` detection for persistent adverse momentum.
  - Injected `negativeEdge` (+4 to +15 pts) and flag `Negative Trend Edge 💥 (+N)`.
  - Added `💥 Adverse Trends` filter checkbox in `pgOpportunities`.
- **`src/analytics.mjs`**:
  - Added `negativeTrends` ranking in `sentiment()` analytics.
- **`src/ui/extra.js`**:
  - In `pgSentiment()`, added **💥 Negative News Trends & Adverse Momentum** section.
  - Integrated dynamic prominence color scale:
    - Normal negative: `#fecaca`
    - Moderate adverse: `#dc2626`
    - Prominent negative: `#991b1b`
    - Extreme adverse momentum: `#4a0e17` (darker colour = more prominent negative sentiment).

### G. Manual Op-Ed Addition (Admin Only)
- **`src/db.mjs`**:
  - Added `addManualAuthoredArticle({ headline, author, source, date, page, kind, body, oppKey, company })`.
- **`src/server.mjs`**:
  - Added `POST /api/admin/authored/manual` route.
- **`src/ui/pages.js`**:
  - In `pgAuthored()`, added `+ Add Op-Ed Manually` button for Admins.
  - Implemented `showManualOpEdModal()` with publication selector (including Forbes India, Fortune India, Business Today in Print and Online), date picker, page number, kind (opinion/analysis), and excerpt.

### H. UI & Stability Fixes
- Restored `contactLinks` helper in [app.js](file:///e:/Mavericks - October and later projects 2026/HiveMind/Density-Trend-BCG/src/ui/app.js) and [pages.js](file:///e:/Mavericks - October and later projects 2026/HiveMind/Density-Trend-BCG/src/ui/pages.js) to fix the undefined reference error on `#/journalists`.
- Handled `null` momentum ratio values in `renderAiOverview()` to prevent `Cannot read properties of null (reading 'toFixed')` on emerging topics without historical baselines.

---

## 3. Verification & Test Coverage

- **Automated Tests**: Created and executed [test/features_update.test.mjs](file:///e:/Mavericks - October and later projects 2026/HiveMind/Density-Trend-BCG/test/features_update.test.mjs):
  - Publications configuration & edition checks (passed).
  - Default outlets integration (passed).
  - Store Custom Topic Mapping CRUD (passed).
  - Store Client Priorities get & set (passed).
  - Store Manual Op-Ed insertion (passed).
  - Store Journalist search by topic (passed).
- **Server Health**:
  - Validated authentication endpoints and session handling.
  - Verified live server daemon responsiveness (HTTP 200) on port 8788.
