// test/xtrends.test.mjs
// Validates Twitter / X India trending validation feature (Method A).
import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/db.mjs";
import { Analytics } from "../src/analytics.mjs";
import {
  fetchIndiaTrends,
  refreshIndiaTrends,
  getIndiaTrends,
  getCachedIndiaTrends,
  matchOpportunityTrend,
} from "../src/xtrends.mjs";

test("xtrends: matchOpportunityTrend accurately matches relevant angles without false positives", () => {
  const trends = [
    { rank: 1, name: "#UpperCkt_Ai_Infra_Stock", clean: "UpperCkt Ai Infra Stock", count: "12.4K" },
    { rank: 2, name: "#WorldPneumoniaDay", clean: "WorldPneumoniaDay", count: "8.1K" },
    { rank: 3, name: "#धरती_पर_भगवान", clean: "धरती पर भगवान", count: "25.2K" },
    { rank: 4, name: "Electric Vehicles", clean: "Electric Vehicles", count: "50.1K" },
    { rank: 5, name: "#TrainAccident", clean: "TrainAccident", count: "33.2K" },
  ];

  // 1. Matches topic/angle on AI infra
  const aiOpp = {
    key: "bcg|Technology|t:ai-infra",
    sector: "Technology",
    label: { name: "AI Infrastructure", key: "t:ai-infra" },
    angle: "India's data centers and GPU capacity race",
  };
  const aiMatch = matchOpportunityTrend(aiOpp, trends);
  assert.ok(aiMatch, "AI Infra should match");
  assert.equal(aiMatch.rank, 1);
  assert.equal(aiMatch.name, "#UpperCkt_Ai_Infra_Stock");

  // 2. Matches health / pneumonia topic
  const healthOpp = {
    key: "bcg|Healthcare|t:pneumonia-prevention",
    sector: "Healthcare",
    label: { name: "Pneumonia Prevention", key: "t:pneumonia-prevention" },
    angle: "Child health and respiratory vaccine rollout",
  };
  const healthMatch = matchOpportunityTrend(healthOpp, trends);
  assert.ok(healthMatch, "Pneumonia should match");
  assert.equal(healthMatch.rank, 2);

  // 3. Electric Vehicles match
  const evOpp = {
    key: "bcg|Automotive|t:ev-battery",
    sector: "Automotive",
    label: { name: "Battery Ecosystem", key: "t:ev-battery" },
    angle: "Adoption of Electric Vehicles in Indian commercial fleets",
  };
  const evMatch = matchOpportunityTrend(evOpp, trends);
  assert.ok(evMatch, "EV should match");
  assert.equal(evMatch.rank, 4);

  // 4. No false positive: "rain" must NOT match "#TrainAccident"
  const rainOpp = {
    key: "bcg|Agriculture|t:rain-forecast",
    sector: "Agriculture",
    label: { name: "Monsoon", key: "t:rain-forecast" },
    angle: "Excess rain impact on Kharif harvest",
  };
  const rainMatch = matchOpportunityTrend(rainOpp, trends);
  assert.equal(rainMatch, null, "Rain should NOT match TrainAccident");

  // 5. No false positive for unrelated sector
  const fertOpp = {
    key: "bcg|Agriculture|t:fertilizers",
    sector: "Agriculture",
    label: { name: "Fertilizer Subsidies", key: "t:fertilizers" },
    angle: "Urea and DAP supply chain logistics across northern states",
  };
  const fertMatch = matchOpportunityTrend(fertOpp, trends);
  assert.equal(fertMatch, null, "Fertilizers should have no match");
});

test("xtrends: store caching and non-blocking sync read", () => {
  const store = new Store(":memory:");
  const sample = {
    fetchedAt: Date.now(),
    trends: [
      { rank: 1, name: "#Budget2027", clean: "Budget2027", count: "100K" },
      { rank: 2, name: "#RenewableEnergy", clean: "RenewableEnergy", count: "40K" },
    ]
  };
  store.setJson("social.xtrends.cache", sample);

  const cached = getCachedIndiaTrends(store);
  assert.ok(Array.isArray(cached));
  assert.equal(cached.length, 2);
  assert.equal(cached[0].name, "#Budget2027");
  store.close();
});

test("xtrends: multi-trend cross-matching against opportunities", () => {
  const trends = [
    { rank: 1, name: "#UpperCkt_Ai_Infra_Stock", clean: "UpperCkt Ai Infra Stock", count: "12.4K" },
    { rank: 2, name: "#RandomTopic", clean: "RandomTopic", count: "" }
  ];
  const opps = [
    { key: "bcg|Technology|t:ai-infra", sector: "Technology", label: { name: "AI Infrastructure" }, score: 85, angle: "Data centers" }
  ];
  const enriched = trends.map((tr) => {
    let matchedOpp = null;
    for (const o of opps) {
      const m = matchOpportunityTrend(o, [tr]);
      if (m) {
        matchedOpp = { oppKey: o.key, sector: o.sector, topic: o.label.name, score: Math.round(o.score) };
        break;
      }
    }
    return { ...tr, match: matchedOpp };
  });

  assert.ok(enriched[0].match);
  assert.equal(enriched[0].match.sector, "Technology");
  assert.equal(enriched[1].match, null);
});

test("xtrends: worldwide and india region separation and caching", () => {
  const store = new Store(":memory:");
  const sample = {
    fetchedAt: Date.now(),
    india: [
      { rank: 1, name: "#IndiaTrend", clean: "IndiaTrend", count: "50K", region: "india" }
    ],
    worldwide: [
      { rank: 1, name: "#GlobalSummit", clean: "GlobalSummit", count: "200K", region: "worldwide" }
    ],
    trends: [
      { rank: 1, name: "#IndiaTrend", clean: "IndiaTrend", count: "50K", region: "india" },
      { rank: 1, name: "#GlobalSummit", clean: "GlobalSummit", count: "200K", region: "worldwide" }
    ]
  };
  store.setJson("social.xtrends.cache", sample);

  const ind = getCachedIndiaTrends(store);
  assert.ok(ind.length >= 1);

  const worldOpp = {
    key: "bcg|Public Sector|t:global-summit",
    sector: "Public Sector",
    label: { name: "Global Summit" },
    angle: "Diplomatic discussions"
  };
  const match = matchOpportunityTrend(worldOpp, sample.trends);
  assert.ok(match);
  assert.equal(match.region, "worldwide");
  assert.equal(match.name, "#GlobalSummit");
  store.close();
});

