import test from "node:test";
import assert from "node:assert/strict";
import { seriesFor } from "../src/metrics.mjs";
import { CompanyStore, sectorsHash } from "../src/companies.mjs";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("candlestick: seriesFor returns accurate OHLC and volume data", () => {
  const now = 1793346000000;
  const HOUR = 3600e3;
  const cfg = {
    intervals: { hourView: 24, dayView: 14, rollingHours: 6, rollingDays: 3, observedLagHours: 12 },
    forecast: { minHourPoints: 6, minDayPoints: 4, hourAhead: 6, dayAhead: 3, alpha: 0.3, beta: 0.1, phi: 0.9, sigmaMultiplier: 1.28 },
    evidence: { originsForFullScore: 8, verifiedTriggerOrigins: 3 }
  };
  const ctx = { cfg, elig: null };

  const items = [
    {
      id: "s1", at: now - 3 * HOUR, title: "Aviation incident in Mumbai",
      labels: new Map([["t:aviation", { w: 1, direction: "negative" }]]),
      origins: new Set(["et", "toi"]), originCount: 2, outletCount: 2, maxSev: 0.8, verified: false,
      sentiment: "negative"
    },
    {
      id: "s2", at: now - 2.5 * HOUR, title: "Runway issue at Mumbai airport",
      labels: new Map([["t:aviation", { w: 1, direction: "negative" }]]),
      origins: new Set(["reuters"]), originCount: 1, outletCount: 1, maxSev: 0.7, verified: false,
      sentiment: "negative"
    },
    {
      id: "s3", at: now - 1 * HOUR, title: "Delhi airspace congestion resolved safely",
      labels: new Map([["t:aviation", { w: 0.9, direction: "positive" }]]),
      origins: new Set(["mint", "ht"]), originCount: 2, outletCount: 2, maxSev: 0.6, verified: true,
      sentiment: "positive"
    }
  ];

  const res = seriesFor(items, "t:aviation", "hour", ctx, now);
  assert.ok(res, "seriesFor returned a result");
  assert.ok(Array.isArray(res.ohlc), "ohlc array exists");
  assert.equal(res.ohlc.length, res.bins.length, "ohlc length matches bins");

  // Verify non-zero bins have open, high, low, close, volume, sentiment, and hammer indicators
  const nonZero = res.ohlc.filter((o) => o.volume > 0);
  assert.ok(nonZero.length > 0, "has non-zero volume candles");
  for (const c of nonZero) {
    assert.ok(c.high >= c.low, `high (${c.high}) should be >= low (${c.low})`);
    assert.ok(c.high >= Math.min(c.open, c.close), "high is above or equal to candle body");
    assert.ok(c.low <= Math.max(c.open, c.close), "low is below or equal to candle body");
    assert.ok(c.volume >= 1, "volume is tracked");
    assert.ok(typeof c.isHammer === "boolean", "isHammer pattern detected on candles");
    assert.ok(Array.isArray(c.stories), "candle contains stories array");
    assert.equal(c.stories.length, c.volume, "candle stories count matches volume");
  }
  const negativeCandles = nonZero.filter((c) => c.sentiment === "negative");
  assert.ok(negativeCandles.length > 0, "negative sentiment candles properly recorded");
  const positiveCandles = nonZero.filter((c) => c.sentiment === "positive");
  assert.ok(positiveCandles.length > 0, "positive sentiment candles properly recorded");
});

test("client sectors: CompanyStore update allows modifying sectors & custom descriptions", () => {
  const dir = join(tmpdir(), "hivemind-test-companies-" + Date.now());
  mkdirSync(dir, { recursive: true });
  try {
    const store = new CompanyStore(dir);
    // Create initial company
    const initial = store.put({
      name: "Acme Healthcare",
      sectors: [
        { name: "Healthcare", description: "Broad healthcare" },
        { name: "Pharma", description: "Drug discovery" }
      ]
    });
    assert.equal(initial.name, "Acme Healthcare");
    assert.equal(initial.sectors.length, 2);

    // Update with specific scope description for Healthcare
    const updated = store.update(initial.id, {
      name: "Acme Healthcare",
      sectors: [
        { name: "Healthcare", description: "Hospital equipment, medtech and digital diagnostics only. Exclude generic disease outbreaks." },
        { name: "MedTech", description: "Surgical robotics and diagnostic devices" }
      ]
    });

    assert.equal(updated.sectors.length, 2);
    const hcSector = updated.sectors.find((s) => s.name === "Healthcare");
    assert.ok(hcSector, "Healthcare sector exists");
    assert.ok(hcSector.description.includes("Hospital equipment"), "Updated description was persisted");

    // Verify stored company file
    const retrieved = store.get(initial.id);
    assert.equal(retrieved.sectorsHash, updated.sectorsHash);
    assert.equal(retrieved.sectors[0].description, hcSector.description);
  } finally {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

test("geo & event-specific tracking: clusters specific incidents and generates BCG MDP editorial angles", async () => {
  const { Analytics } = await import("../src/analytics.mjs");
  const now = 1793346000000;
  const HOUR = 3600e3;

  // Mock store, context and analytics
  const items = [
    {
      id: "a1", at: now - 2 * HOUR, title: "Plane crash during emergency landing at Mumbai airport",
      url: "https://news.example.com/mumbai-crash", summary: "Aircraft crash lands on runway 27 in Mumbai.",
      geography: ["Mumbai", "Maharashtra", "India"], eventType: "Accident",
      entities: ["Air India", "DGCA", "CSIA"], outlets: ["Economic Times", "Times of India"],
      origins: new Set(["et", "toi"]), outletCount: 2, originCount: 2, maxSev: 0.9, verified: true, pathways: [],
      labels: new Map([["t:aviation", { w: 1, direction: "negative" }]])
    },
    {
      id: "a2", at: now - 4 * HOUR, title: "Runway closed at Mumbai airport following crash incident",
      url: "https://news.example.com/mumbai-runway", summary: "Flights diverted from Mumbai airport.",
      geography: ["Mumbai", "India"], eventType: "Accident",
      entities: ["Air India", "CSIA"], outlets: ["Reuters", "Mint"],
      origins: new Set(["reuters", "mint"]), outletCount: 2, originCount: 2, maxSev: 0.8, verified: true, pathways: [],
      labels: new Map([["t:aviation", { w: 1, direction: "negative" }]])
    },
    {
      id: "a3", at: now - 6 * HOUR, title: "Delhi airspace congested due to technical radar glitch",
      url: "https://news.example.com/delhi-radar", summary: "Radar failure causes 20 flight delays in Delhi.",
      geography: ["Delhi", "India"], eventType: "Operational Issue",
      entities: ["AAI", "IndiGo"], outlets: ["NDTV", "Hindustan Times"],
      origins: new Set(["ndtv", "ht"]), outletCount: 2, originCount: 2, maxSev: 0.6, verified: false, pathways: [],
      labels: new Map([["t:aviation", { w: 0.8, direction: "mixed" }]])
    }
  ];

  const mockCtx = {
    asOf: now,
    items,
    byLabel: new Map([["t:aviation", items]]),
    analysis: {
      labels: new Map([["t:aviation", { key: "t:aviation", level: "topic", stage: "rising" }]]),
      seasonality: null
    },
    ctx: { cfg: { intervals: { hourView: 24, dayView: 14, rollingHours: 6, rollingDays: 3, observedLagHours: 12 }, forecast: { minHourPoints: 24 } } }
  };

  const analytics = new Analytics({
    store: { getSignal: () => [], lastWebCheck: () => null },
    registry: { get: () => null },
    sources: null,
    cfg: { intervals: { hourView: 24, dayView: 14, rollingHours: 6, rollingDays: 3, observedLagHours: 12 }, action: {} },
    companies: { get: () => null, list: () => [] }
  });

  // Override context and labelName for mock test
  analytics.context = () => mockCtx;
  analytics.labelName = () => "Aviation Incident";
  analytics.labelRow = () => ({ name: "Aviation Incident", ratio: 2.1 });
  analytics.labelSentiment = () => null;
  analytics.opportunities = () => ({ items: [] });

  const topicRes = analytics.topic({ key: "t:aviation" });
  assert.ok(topicRes, "topic returned result");
  assert.equal(topicRes.storyTracking.totalCount, 3);
  assert.equal(topicRes.storyTracking.recent72hCount, 3);
  assert.ok(topicRes.storyTracking.outletsCount >= 5, "tracks unique publications");

  // Verify geographic breakdown
  assert.ok(topicRes.geoBreakdown.length > 0, "has geographical breakdown");
  const mumbaiGeo = topicRes.geoBreakdown.find((g) => g.name === "Mumbai");
  assert.ok(mumbaiGeo, "Mumbai geography is identified");
  assert.equal(mumbaiGeo.count, 2, "Mumbai has 2 stories");

  // Verify event clusters
  assert.ok(topicRes.eventClusters.length >= 2, "distinguishes separate event incidents");
  const mumbaiCluster = topicRes.eventClusters.find((cl) => cl.location === "Mumbai");
  assert.ok(mumbaiCluster, "Mumbai incident cluster formed");
  assert.equal(mumbaiCluster.storyCount, 2, "Mumbai cluster contains 2 stories");
  assert.equal(mumbaiCluster.mdpAngles.length, 1, "Only 1 authoritative BCG MDP thought leadership card per cluster (boardroom memo card removed)");
  assert.ok(mumbaiCluster.mdpAngles[0].role.includes("BCG Managing Director"), "Targeted for BCG MDP");
  assert.ok(!mumbaiCluster.mdpAngles[0].strategicPillars, "Strategic boardroom levers roadmap removed");
  assert.ok(mumbaiCluster.mdpAngles[0].thesis, "Executive POV is retained");
  assert.ok(mumbaiCluster.mdpAngles[0].boardroomQuestions.length >= 4, "Alternate additional strategic angles captured as key C-suite / board questions");
  assert.ok(mumbaiCluster.mdpAngles[0].boardroomQuestions.some((q) => q.includes("Operational Resilience")), "Includes Operational Resilience angle");
  assert.ok(mumbaiCluster.mdpAngles[0].boardroomQuestions.some((q) => q.includes("Regulatory & Statutory")), "Includes Regulatory angle");
  assert.ok(mumbaiCluster.mdpAngles[0].boardroomQuestions.some((q) => q.includes("Capex & Capital Allocation")), "Includes Capex & Margin angle");

  // Test specific filtering by geo
  const filteredRes = analytics.topic({ key: "t:aviation", geo: "Mumbai" });
  assert.equal(filteredRes.stories.length, 2, "Filtered down to only Mumbai stories");
  for (const s of filteredRes.stories) {
    assert.ok(s.geography.includes("Mumbai"), "Every returned story has Mumbai geography");
  }
});

test("opportunity stories include geography for location-based filtering", async () => {
  const { buildOpportunities } = await import("../src/opportunity.mjs");
  const now = 1793346000000;
  const HOUR = 3600e3;

  const items = [
    {
      id: "h1", at: now - 2 * HOUR, title: "India health spending triples",
      url: "https://news.example.com/health-india", summary: "Healthcare spending in India",
      geography: ["India"], eventType: "Policy", outlets: ["Economic Times"],
      origins: new Set(["et"]), outletCount: 1, originCount: 1, maxSev: 0.8, verified: true,
      labels: new Map([["b:health", { w: 1, direction: "positive" }]])
    },
    {
      id: "h2", at: now - 5 * HOUR, title: "US CDC reports respiratory virus season outlook",
      url: "https://news.example.com/health-us", summary: "US healthcare outlook",
      geography: ["United States"], eventType: "Report", outlets: ["Reuters"],
      origins: new Set(["reuters"]), outletCount: 1, originCount: 1, maxSev: 0.7, verified: true,
      labels: new Map([["b:health", { w: 1, direction: "neutral" }]])
    }
  ];

  const analysisResult = {
    labels: new Map([
      ["b:health", {
        key: "b:health", id: "health", level: "bracket", stage: "rising", ratio: 2.5, ratioPrev: 1.8,
        count: 2, countPrev: 1, share: 0.05, baseShare: 0.02, originsRecent: 2, areaCount: 2,
        baselineHours: 168, fullTextCount: 2, verifiedCount: 2, windowHours: 72,
        evidence: { level: "high", count: 2 }
      }]
    ]),
    params: { recentHours: 72 }
  };

  const company = {
    id: "bcg",
    name: "BCG",
    sectors: [{ name: "Healthcare", description: "Healthcare sector" }],
    matches: {
      "health": {
        sectors: [
          { sector: "Healthcare", relevance: 0.9, write_about: "Health surge capacity", why: "Transmission", channel: "Op-Ed", front: "national" }
        ]
      }
    }
  };

  const ctx = {
    cfg: {
      intervals: { baselineHours: 168, stepHours: 24, minBaselineHours: 24 },
      action: { writeNowMinBaselineHours: 24, writeNowMinOrigins: 1 },
      evidence: { minClusters: 1, verifiedTriggerOrigins: 1 },
      weights: { momentum: 25, headroom: 20, breadth: 15, origins: 15, timeliness: 15, sector: 10 }
    },
    registry: { get: () => ({ name: "Health" }), canonical: (id) => id },
    topics: new Map(),
    signals: {}
  };

  const byLabel = new Map([["b:health", items]]);

  const res = buildOpportunities({ company, matches: company.matches, analysisResult, byLabel, ctx, asOf: now });
  assert.ok(res.items.length > 0, "Opportunity generated");
  const opp = res.items[0];
  assert.ok(opp.geoBreakdown.length >= 2, "Has geographical breakdown");
  assert.ok(opp.geoBreakdown.some((g) => g.name === "India"), "Has India location");
  assert.ok(opp.geoBreakdown.some((g) => g.name === "United States"), "Has United States location");
  assert.ok(opp.stories.length >= 2, "Has evidence stories");
  assert.ok(opp.stories[0].geography, "Evidence story retains geography array");
  assert.ok(opp.stories.some((s) => s.geography.includes("United States")), "Story preserves United States geography");
});
