import test from "node:test";
import assert from "node:assert/strict";
import { loadBcgMdps, scoreMdpFit, matchMdpsToOpportunities } from "../src/pitch.mjs";
import { Analytics } from "../src/analytics.mjs";

test("pitch: loads all 34 BCG MDPs with sectors and themes", () => {
  const mdps = loadBcgMdps(".");
  assert.equal(mdps.length, 34);

  const leaders = mdps.filter((m) => m.group === "BCG Leaders");
  assert.equal(leaders.length, 6);

  const janmejaya = mdps.find((m) => m.name === "Janmejaya Sinha");
  assert.ok(janmejaya);
  assert.equal(janmejaya.primarySector, "CEO Profiling / Leadership");
  assert.ok(janmejaya.themes.length > 0);

  const natarajan = mdps.find((m) => m.name === "Natarajan Sankar");
  assert.ok(natarajan);
  assert.equal(natarajan.primarySector, "Industrial Goods");

  const vikash = mdps.find((m) => m.name === "Vikash Agarwalla");
  assert.ok(vikash);
  assert.equal(vikash.primarySector, "Healthcare");
});

test("pitch: scores MDP fit based on primary practice, themes and keywords", () => {
  const mdps = loadBcgMdps(".");
  const vikash = mdps.find((m) => m.name === "Vikash Agarwalla");

  const healthOpp = {
    key: "bcg|Healthcare|t:public-health",
    sector: "Healthcare",
    label: { name: "public health" },
    topic: "public health",
    why: "Rapid surge in seasonal respiratory illnesses tests hospital ICU capacity.",
    angle: "Building surge capacity and clinical workforce resilience",
    score: 85,
    stories: [{ title: "Hospitals report surge in respiratory admissions across North India" }]
  };

  const fit = scoreMdpFit(vikash, healthOpp);
  assert.ok(fit.fitScore >= 55 && fit.fitScore < 75, `Expected strong (not top) fit for a practice-only match, got ${fit.fitScore}`);
  assert.equal(fit.fitTier, "Strong Fit");
  assert.match(fit.why, /Healthcare/);
  assert.ok(fit.headline.includes("public health") || fit.headline.includes("Public health") || fit.headline.includes("Healthcare"));
  assert.ok(fit.boardroomQuestions.length >= 3);
});

test("pitch: maps opportunities to MDPs bidirectionally", () => {
  const mdps = loadBcgMdps(".");
  const opps = [
    {
      key: "bcg|Healthcare|t:public-health",
      sector: "Healthcare",
      label: { name: "public health" },
      topic: "public health",
      score: 85,
      action: "write_now",
      stage: "rising",
      stories: [{ id: "s1", title: "Hospital ICU capacity challenged", url: "https://example.com/1" }]
    },
    {
      key: "bcg|Public Sector|b:space",
      sector: "Public Sector",
      label: { name: "Space" },
      topic: "Space",
      score: 82,
      action: "investigate",
      stage: "emerging",
      stories: [{ id: "s2", title: "NavIC satellite deployment expands commercial space applications", url: "https://example.com/2" }]
    }
  ];

  const result = matchMdpsToOpportunities(mdps, opps);
  assert.ok(result.stats);
  assert.equal(result.stats.totalMdps, 34);
  assert.ok(result.stats.totalPitchesReady >= 2);

  const spaceOpp = result.opportunities.find((o) => o.topic === "Space");
  assert.ok(spaceOpp);
  assert.ok(spaceOpp.topMdp);
  assert.equal(spaceOpp.topMdp.primarySector, "Public Sector");

  const healthOpp = result.opportunities.find((o) => o.topic === "public health");
  assert.ok(healthOpp);
  assert.ok(healthOpp.topMdp);
  assert.equal(healthOpp.topMdp.primarySector, "Healthcare");
});

test("pitch: analytics integration method works cleanly", () => {
  const a = new Analytics({
    store: {
      span: () => ({ last: 1, days: 1 }),
      readingCount: () => 1,
      enrichmentCount: () => 1,
      sentimentCount: () => 1,
      mergedTopicCount: () => 1,
      jobRev: () => 1,
      getMeta: () => "1",
      loadTopics: () => [],
      spanTopics: () => ({ last: 1 })
    },
    registry: () => ({ size: 1, get: () => null }),
    sources: null,
    cfg: { intervals: { hourView: 24, dayView: 14, rollingHours: 6, rollingDays: 3, observedLagHours: 12 }, weights: {} },
    companies: null
  });

  // Mock opportunities
  a.opportunities = () => ({
    asOf: 1700000000000,
    company: { id: "bcg", name: "BCG" },
    items: [
      {
        key: "bcg|Industrial Goods|t:ev-manufacturing",
        sector: "Industrial Goods",
        label: { name: "EV Manufacturing" },
        topic: "EV Manufacturing",
        score: 88,
        action: "write_now",
        stage: "rising",
        stories: [{ id: "1", title: "Auto manufacturers ramp up commercial EV battery localisation" }]
      }
    ]
  });

  // Set mock context so memo wrapper succeeds
  a.context = () => ({ asOf: 1700000000000 });

  const res = a.pitch({ company: "bcg" });
  assert.ok(res.mdps);
  assert.ok(res.opportunities);
  assert.ok(res.stats);

  const natarajan = res.mdps.find((m) => m.name === "Natarajan Sankar");
  assert.ok(natarajan);
  assert.ok(natarajan.opportunityCount >= 1);
});

test("pitch: practice-name words are not double counted, so a practice match alone is not a top score", () => {
  const mdps = loadBcgMdps(".");
  const neetu = mdps.find((m) => m.name === "Neetu Vasanta");
  const opp = { key: "bcg|Travel, Cities and Infrastructure|b:x", sector: "Travel, Cities and Infrastructure", label: { name: "Transport" }, why: "Rail timetable changes.", score: 50, stories: [] };
  const fit = scoreMdpFit(neetu, opp);
  assert.ok(fit.fitScore < 75, `practice-only match should not be high priority, got ${fit.fitScore}`);
});

test("pitch: a theme like 'Space Sector' wins the Space angle over a generic public-sector partner", () => {
  const mdps = loadBcgMdps(".");
  const opp = { key: "bcg|Public Sector|b:space", sector: "Public Sector", label: { name: "Space" }, why: "India's space launch cadence rises.", score: 70, stories: [] };
  const best = mdps.map((m) => ({ n: m.name, s: scoreMdpFit(m, opp).fitScore })).sort((a, b) => b.s - a.s)[0];
  assert.equal(best.n, "Girish Thakur");
});

test("pitch: short keywords only match whole words", () => {
  const mdps = loadBcgMdps(".");
  const natarajan = mdps.find((m) => m.name === "Natarajan Sankar");
  const fit = scoreMdpFit(natarajan, { key: "k", sector: "Elections", label: { name: "voting" }, why: "Every voter, every time.", score: 50, stories: [] });
  assert.ok(!/ev\b/i.test(fit.why), fit.why);
});

// topicMatchCandidates: topics behind a current opportunity, judged before the stricter rule went live, are judged again once (any stage, any rank).
test("topic match: old pre-cutoff matches behind a current opportunity are re-judged, each once and only a few per run", () => {
  const NOW = Date.parse("2026-11-25T10:00:00Z"), OLD = Date.parse("2026-11-10T00:00:00Z"), NEW = Date.parse("2026-11-20T00:00:00Z");
  const mk = (id, stage) => ({ id, key: "t:" + id, level: "topic", stage, ratio: 1, count: 4, originsRecent: 3, storiesAll: 5, parent: null });
  const labels = new Map(["a", "b", "c", "d", "e", "f", "g", "h"].map((id) => [id, mk(id, "declining")]));
  const item = (n) => ({ id: "i" + n, at: NOW - 3600e3, maxSev: 2, outletCount: 2, title: "T" + n, summary: "S" });
  const byLabel = new Map([...labels.values()].map((m) => [m.key, [item(1), item(2), item(3)]]));
  const judged = new Map([["a", { judgedAt: OLD, storyCount: 5 }], ["b", { judgedAt: OLD, storyCount: 5 }], ["c", { judgedAt: NEW, storyCount: 5 }], ["d", { judgedAt: OLD, storyCount: 5 }]]);
  const opps = ["a", "b", "c", "d", "e"].map((id) => ({ label: { key: "t:" + id, level: "topic" } })); // e was never judged: the normal path handles it, not this one
  const fake = {
    cfg: { topicMatch: { rematchPerRun: 2, minStories: 2, maxTopics: 30 } },
    context: () => ({ asOf: NOW, analysis: { labels }, byLabel, ctx: { registry: new Map() } }),
    store: { topicMatches: () => judged },
    topicOk: () => true,
    labelName: (c, k) => k,
    opportunities: () => ({ items: opps }),
  };
  const out = Analytics.prototype.topicMatchCandidates.call(fake, "bcg");
  assert.deepEqual(out.map((o) => o.key), ["t:a", "t:b"]); // only old ones, capped at 2 per run; c is already past the cutoff, d waits for the next run
  judged.set("a", { judgedAt: NOW, storyCount: 5 });
  judged.set("b", { judgedAt: NOW, storyCount: 5 });
  assert.deepEqual(Analytics.prototype.topicMatchCandidates.call(fake, "bcg").map((o) => o.key), ["t:d"]); // a and b are never picked again
});
