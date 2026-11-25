// pitch.mjs — Matches BCG Managing Directors & Partners (MDPs) to live editorial opportunities and op-ed angles.
// Maps each MDP's practice areas, designations, and core themes from BCG-MDP'S/BCG_Hivemind.xlsx to live topic opportunities.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export function loadBcgMdps(root = process.cwd()) {
  const p1 = join(root, "config", "bcg_mdps.json");
  const p2 = join(root, "Density-Trend-BCG", "config", "bcg_mdps.json");
  const file = existsSync(p1) ? p1 : existsSync(p2) ? p2 : null;
  if (!file) return [];
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}

function tokenize(text = "") {
  return new Set(
    String(text)
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !STOP_WORDS.has(w))
  );
}

const phraseIn = (ph, text) => new RegExp("(^|[^a-z0-9])" + ph.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "s?([^a-z0-9]|$)").test(text);
const stem = (w) => (w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
const GENERIC_WORDS = new Set(["advice", "board", "large", "offices", "family", "profiling", "ceo", "leadership", "development", "business", "corporate", "strategy", "sector", "practice", "management", "growth", "services", "value", "creation", "global", "new", "one", "now", "linkedin", "industry"]);
const STOP_WORDS = new Set([
  "and", "the", "for", "with", "from", "that", "this", "what", "which", "will", "are", "now", "all",
  "into", "over", "more", "also", "their", "about", "other", "than", "then", "have", "were", "been"
]);

// Media outlets tailored by practice area
const OUTLET_BY_PRACTICE = {
  "Healthcare": "Mint, The Economic Times, Financial Express, Pharmabiz",
  "Technology, Media, Telecommunications": "The Economic Times, Mint, TechCrunch, FactorDaily, Financial Express",
  "BCG X": "The Economic Times (Tech), Mint, TechCircle, MIT Technology Review India",
  "Technology and Digital Advantage": "The Economic Times, Mint, CIO India, Business Standard",
  "Financial Institutions": "The Economic Times, Mint, Business Standard, Bloomberg Quint",
  "Energy": "The Economic Times (Energy), Financial Express, Business Standard, Powerline",
  "Industrial Goods": "The Economic Times, Business Standard, AutoCar Pro, Construction World",
  "Consumer Goods": "The Economic Times (Brand Equity), Mint, Retail4Growth, Financial Express",
  "Marketing, Sales and Pricing": "The Economic Times (Brand Equity), Mint (Lounge), Storyboard18, Campaign India",
  "Public Sector": "The Economic Times, Indian Express, Business Standard, ORF / Policy Portals",
  "Travel, Cities and Infrastructure": "The Economic Times, Mint, Infrastructure Today, Construction Week",
  "Principal Investors and Private Equity": "VCCircle, Mint, The Economic Times (Deals), DealStreetAsia",
  "Climate & Sustainability": "Mint (ESG), The Economic Times, DownToEarth, Clean Energy Wire",
  "CEO Profiling / Leadership": "The Economic Times (Corporate), Mint, Financial Express, BCG Henderson Institute"
};

const DEFAULT_OUTLETS = "The Economic Times, Mint, Business Standard, Financial Express, BCG Henderson Institute";

// Map an opportunity to an MDP with scoring and tailored pitch details
export function scoreMdpFit(mdp, opp) {
  let score = 0;
  const whyParts = [];

  const oppSector = opp.sector || "";
  const oppTopic = opp.label?.name || opp.topic || "";
  const oppAngle = opp.angle || "";
  const oppWhy = opp.why || "";
  const storyText = (opp.stories || []).slice(0, 5).map((s) => s.title || "").join(" ");
  // The sector label is left out of the searched text: it is scored on its own above, and searching it again would count the practice name twice.
  const allOppText = `${oppTopic} ${oppAngle} ${oppWhy} ${storyText}`.toLowerCase();
  const oppTokens = tokenize(allOppText);

  // 1. Sector Alignment
  const mdpPrimary = mdp.primarySector || "";
  const mdpSecondaries = mdp.secondarySectors || [];

  if (oppSector && mdpPrimary && oppSector.toLowerCase() === mdpPrimary.toLowerCase()) {
    score += 55;
    whyParts.push(`Primary Practice match: ${mdpPrimary}`);
  } else if (mdpSecondaries.some((s) => s.toLowerCase() === oppSector.toLowerCase())) {
    score += 42;
    whyParts.push(`Cross-practice relevance: ${oppSector}`);
  } else if (mdpPrimary === "CEO Profiling / Leadership") {
    // Leadership partners (Chairman, India Head) can write on high-impact macroeconomic or policy topics
    score += 35;
    whyParts.push("Macro / Leadership mandate across all major economic sectors");
  } else {
    // Check moreSectors on the opportunity
    const matchedMore = (opp.moreSectors || []).find((s) => s.sector && s.sector.toLowerCase() === mdpPrimary.toLowerCase());
    if (matchedMore) {
      const pts = Math.round(30 * (matchedMore.relevance || 0.6));
      score += pts;
      whyParts.push(`Sector link (${matchedMore.sector}, rel ${(matchedMore.relevance || 0.6).toFixed(2)})`);
    }
  }

  // 2. Theme & keyword overlap. Whole-word matching only (no substrings like "ev" in "every"); words that are just the practice's own name are not counted
  // again when the practice already matched, and generic words ("board", "advice", "large"...) never count.
  const practiceMatched = whyParts.some((w) => w.startsWith("Primary Practice"));
  const practiceWords = new Set([...tokenize(mdpPrimary)].map(stem));
  const oppStems = new Set([...oppTokens].map(stem));
  const hitWords = [];
  for (const kw of mdp.keywords || []) {
    const k = stem(String(kw).toLowerCase());
    if (k.length < 3 || GENERIC_WORDS.has(k) || (practiceMatched && practiceWords.has(k))) continue;
    if (oppStems.has(k) && !hitWords.includes(kw)) hitWords.push(kw);
  }
  let themeBonus = 0, themeHits = 0;
  for (const theme of mdp.themes || []) {
    const phrases = [theme, ...String(theme).split(/\s*(?:&|,|\/| and )\s*/)].map((t) => t.toLowerCase().trim()).filter((t) => t.length >= 4);
    const tWords = [...tokenize(theme)].map(stem);
    const isPracticeName = tWords.length > 0 && tWords.every((w) => practiceWords.has(w));
    if (isPracticeName && practiceMatched) continue;
    // "Space Sector" matches an angle about "space": its distinctive words (not "sector", not the practice's own name) are all present.
    const core = tWords.filter((w) => w.length >= 3 && !GENERIC_WORDS.has(w) && !(practiceMatched && practiceWords.has(w)));
    const coreHit = core.length >= 1 && core.length <= 2 && core.every((w) => oppStems.has(w));
    const hit = coreHit || phrases.find((ph) => !GENERIC_WORDS.has(stem(ph)) && phraseIn(ph, allOppText));
    if (hit && themeHits < 2) {
      themeBonus += themeHits === 0 ? 16 : 8;
      themeHits++;
      whyParts.push(`Theme match: "${theme}"`);
    }
  }
  score += Math.min(24, hitWords.length * 6) + themeBonus;
  if (hitWords.length) whyParts.push(`Keywords matched: ${hitWords.slice(0, 4).join(", ")}`);

  // 3. A hotter opportunity is a more urgent editorial moment; a cold one is held back slightly.
  if (opp.score) score += Math.max(-5, Math.min(8, Math.round((opp.score - 50) * 0.15)));

  score = Math.max(0, Math.min(100, Math.round(score)));

  // Generate tailored Op-Ed Headline & Pitch Brief
  const cleanTopic = oppTopic.charAt(0).toUpperCase() + oppTopic.slice(1);
  const headline = generateOpEdHeadline(mdp, opp, cleanTopic);
  const thesis = oppWhy
    ? `${cleanTopic}: ${oppWhy}`
    : `In the wake of rapid shifts in ${cleanTopic}, ${mdpPrimary || "business"} leaders must look beyond reactive adjustments and formulate a resilient, value-creating strategy.`;

  const boardroomQuestions = generateBoardroomQuestions(mdp, opp, cleanTopic);
  const targetOutlets = OUTLET_BY_PRACTICE[mdpPrimary] || DEFAULT_OUTLETS;
  const pitchHook = `Why ${mdp.name} should author this op-ed for ${targetOutlets.split(",")[0]}: As BCG's ${mdp.designation || mdpPrimary + " leader"}, ${mdp.name} brings authoritative strategic depth on ${mdp.themes?.[0] || mdpPrimary} to address ${cleanTopic}.`;

  const fitTier = score >= 75 ? "High Priority Pitch" : score >= 55 ? "Strong Fit" : score >= 40 ? "Relevant" : "Low";

  return {
    fitScore: score,
    fitTier,
    why: whyParts.join(" • ") || "General practice relevance",
    headline,
    thesis,
    boardroomQuestions,
    targetOutlets,
    pitchHook,
  };
}

function generateOpEdHeadline(mdp, opp, topic) {
  const primary = mdp.primarySector || "";
  const name = mdp.name;

  if (opp.angle && opp.angle.length > 15) {
    return `${topic}: ${opp.angle}`;
  }

  if (primary.includes("Healthcare")) {
    return `${topic}: The Strategic Playbook for Healthcare and Pharma Leaders`;
  }
  if (primary.includes("Technology") || primary.includes("BCG X")) {
    return `Navigating the ${topic} Disruption: What Enterprise Tech Leaders Must Do Now`;
  }
  if (primary.includes("Financial") || primary.includes("Risk")) {
    return `${topic}: Capital Allocation, Risk Resilience, and the New Regulatory Horizon`;
  }
  if (primary.includes("Energy") || primary.includes("Climate")) {
    return `${topic}: Accelerating Energy Transition Without Sacrificing Margins`;
  }
  if (primary.includes("Consumer") || primary.includes("Retail")) {
    return `The ${topic} Shift: Re-engineering Value Propositions for Tomorrow's Consumer`;
  }
  if (primary.includes("Industrial") || primary.includes("Operations")) {
    return `${topic}: Building Resilient Supply Chains and Industrial Capacity`;
  }
  if (primary.includes("Public Sector")) {
    return `${topic}: Public-Private Collaboration in Building National Infrastructure`;
  }

  return `${topic}: What Every Board and CEO Should Know About the Road Ahead`;
}

function generateBoardroomQuestions(mdp, opp, topic) {
  const primary = mdp.primarySector || "";
  return [
    `Strategic Exposure: How directly does the current acceleration in ${topic} impact our medium-term margin and volume targets?`,
    `Execution Capabilities: Do our operational and digital capabilities allow us to respond proactively, or are we lagging peers?`,
    `Regulatory & Capital Planning: What capex, statutory or policy compliance risks must the board review this quarter?`,
    `Market Differentiation: Where does this structural shift create space for us to take share while competitors manage near-term friction?`
  ];
}

// Master matching function: maps an array of MDPs to opportunities
export function matchMdpsToOpportunities(mdps, opportunities) {
  const oppList = opportunities || [];
  const mdpList = mdps || [];

  const mdpResults = [];
  const oppToMdps = new Map();

  for (const opp of oppList) {
    oppToMdps.set(opp.key, []);
  }

  for (const mdp of mdpList) {
    const matchedOpps = [];

    for (const opp of oppList) {
      const fit = scoreMdpFit(mdp, opp);
      if (fit.fitScore >= 38) { // Qualified match threshold
        const item = {
          oppKey: opp.key,
          topic: opp.label?.name || opp.topic,
          sector: opp.sector,
          score: opp.score,
          action: opp.action,
          stage: opp.stage,
          relevance: opp.relevance,
          fitScore: fit.fitScore,
          fitTier: fit.fitTier,
          why: fit.why,
          headline: fit.headline,
          thesis: fit.thesis,
          boardroomQuestions: fit.boardroomQuestions,
          targetOutlets: fit.targetOutlets,
          pitchHook: fit.pitchHook,
          topStories: (opp.stories || []).slice(0, 3).map((s) => ({ id: s.id, title: s.title, url: s.url }))
        };

        matchedOpps.push(item);
        oppToMdps.get(opp.key)?.push({
          mdpId: mdp.id,
          mdpName: mdp.name,
          designation: mdp.designation,
          primarySector: mdp.primarySector,
          group: mdp.group,
          fitScore: fit.fitScore,
          fitTier: fit.fitTier,
          why: fit.why,
          headline: fit.headline,
          thesis: fit.thesis,
          boardroomQuestions: fit.boardroomQuestions,
          targetOutlets: fit.targetOutlets,
          pitchHook: fit.pitchHook
        });
      }
    }

    matchedOpps.sort((a, b) => b.fitScore - a.fitScore || (b.score || 0) - (a.score || 0));

    const highPriorityCount = matchedOpps.filter((o) => o.fitScore >= 75).length;

    mdpResults.push({
      ...mdp,
      opportunities: matchedOpps,
      topOpportunity: matchedOpps[0] || null,
      opportunityCount: matchedOpps.length,
      highPriorityCount,
      bestFitScore: matchedOpps[0]?.fitScore || 0
    });
  }

  // Sort MDPs: those with high priority pitches first, then by count, then by best fit score
  mdpResults.sort((a, b) => {
    if (b.highPriorityCount !== a.highPriorityCount) return b.highPriorityCount - a.highPriorityCount;
    if (b.opportunityCount !== a.opportunityCount) return b.opportunityCount - a.opportunityCount;
    return b.bestFitScore - a.bestFitScore;
  });

  // Build opportunities with recommended MDPs
  const enrichedOpportunities = oppList.map((opp) => {
    const candidates = oppToMdps.get(opp.key) || [];
    candidates.sort((a, b) => b.fitScore - a.fitScore);

    return {
      oppKey: opp.key,
      topic: opp.label?.name || opp.topic,
      sector: opp.sector,
      score: opp.score,
      action: opp.action,
      stage: opp.stage,
      relevance: opp.relevance,
      topMdp: candidates[0] || null,
      alternateMdps: candidates.slice(1, 4),
      candidateCount: candidates.length
    };
  });

  // Calculate high-level stats
  const mdpsWithPitches = mdpResults.filter((m) => m.opportunityCount > 0).length;
  const totalPitchesReady = mdpResults.reduce((acc, m) => acc + m.opportunityCount, 0);
  const highFitPitches = mdpResults.reduce((acc, m) => acc + m.highPriorityCount, 0);
  const activeSectors = new Set(mdpResults.filter((m) => m.opportunityCount > 0).map((m) => m.primarySector));

  return {
    mdps: mdpResults,
    opportunities: enrichedOpportunities,
    stats: {
      totalMdps: mdpResults.length,
      mdpsWithPitches,
      totalPitchesReady,
      highFitPitches,
      sectorsCovered: activeSectors.size,
    }
  };
}
