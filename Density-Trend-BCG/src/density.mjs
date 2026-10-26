// Density fields, in two layers.
//
// 1. Company-agnostic: every impact belongs to a keyword bracket. A story's weight in a bracket is
//      w = severity × coverage × basis
//      severity = the strongest impact the story has in that bracket
//      coverage = 1 + log2(#outlets)     — a 6-outlet story weighs ~3.6× a single-outlet story
//      basis    = 1 for full article text, 0.7 for headline-only readings
//    Each story drops its weight into the 3-hour bin of its first appearance; rows are Gaussian-smoothed.
//
// 2. Company lens: a bracket's relevance to a company sector (judged by the LLM from the bracket's current
//    stories) scales the bracket's density into that sector. Sector field = Σ bracket field × relevance.
//    Each (sector, bracket) pair is a writing recommendation; score = bracket weight × relevance.

export function gaussianSmooth(arr, sigma = 1) {
  const radius = Math.ceil(sigma * 3);
  const kernel = [];
  for (let k = -radius; k <= radius; k++) kernel.push(Math.exp(-(k * k) / (2 * sigma * sigma)));
  const norm = kernel.reduce((a, b) => a + b, 0);
  return arr.map((_, i) => {
    let s = 0;
    for (let k = -radius; k <= radius; k++) {
      const j = i + k;
      if (j >= 0 && j < arr.length) s += arr[j] * kernel[k + radius];
    }
    return s / norm;
  });
}

export const coverageOf = (story) => 1 + Math.log2(Math.max(1, story.outlets.length));
export const basisOf = (story) => (story.basis === "full-text" ? 1 : 0.7);

// bracketId -> { w, direction } for one story (max severity per bracket, so two impacts in one bracket don't double count).
export function storyBracketWeights(story) {
  const best = new Map();
  for (const i of story.analysis.impacts) {
    if (!i.bracket) continue;
    const cur = best.get(i.bracket);
    if (!cur || i.severity > cur.severity) best.set(i.bracket, { severity: i.severity, direction: i.direction });
  }
  const scale = coverageOf(story) * basisOf(story);
  return new Map([...best].map(([id, v]) => [id, { w: v.severity * scale, direction: v.direction }]));
}

export function buildBracketDensity(stories, registry, { now = Date.now(), hours = 48, binHours = 3, sigma = 1 } = {}) {
  const binMs = binHours * 3600e3;
  const nBins = Math.max(1, Math.ceil(hours / binHours));
  const start = now - nBins * binMs;
  const bins = Array.from({ length: nBins }, (_, i) => start + i * binMs);
  const rows = new Map();
  const impactAreas = {}, groups = {}, geography = {};

  for (const s of stories) {
    if (!s.analysis) continue;
    const bin = Math.min(nBins - 1, Math.max(0, Math.floor((s.publishedAt - start) / binMs)));
    const coverage = coverageOf(s);
    for (const i of s.analysis.impacts) {
      impactAreas[i.area] = (impactAreas[i.area] || 0) + i.severity * coverage;
      const g = (groups[i.group] ??= { group: i.group, area: i.area, weight: 0, neg: 0 });
      g.weight += i.severity * coverage;
      if (i.direction === "negative") g.neg++;
    }
    for (const g of s.analysis.geography) geography[g] = (geography[g] || 0) + coverage;

    // Brackets merged after this story was read resolve to the survivor; two of them in one story count once.
    const perStory = new Map();
    for (const [rawId, v] of storyBracketWeights(s)) {
      const meta = registry.get(rawId);
      if (!meta) continue;
      const cur = perStory.get(meta.id);
      if (!cur || v.w > cur.w) perStory.set(meta.id, v);
    }
    for (const [id, { w, direction }] of perStory) {
      const meta = registry.get(id);
      const row = (rows.has(id) ? rows : rows.set(id, {
        id, name: meta.name, description: meta.description, keywords: meta.keywords,
        weight: 0, storyCount: 0, neg: 0, pos: 0, mixed: 0, raw: Array(nBins).fill(0), drivers: [], groups: {},
      })).get(id);
      row.weight += w; row.storyCount++; row.raw[bin] += w;
      row[direction === "negative" ? "neg" : direction === "positive" ? "pos" : "mixed"]++;
      row.drivers.push({ id: s.id, title: s.title, url: s.url, outlets: s.outlets.length, publishedAt: s.publishedAt, w, summary: s.analysis.summary });
      for (const i of s.analysis.impacts) if (i.bracket && registry.canonical(i.bracket) === id) row.groups[i.group] = (row.groups[i.group] || 0) + i.severity * coverage;
    }
  }

  const third = Math.max(1, Math.floor(nBins / 3));
  const brackets = [...rows.values()].map((r) => {
    const recent = r.raw.slice(-third).reduce((a, b) => a + b, 0);
    r.drivers.sort((a, b) => b.w - a.w);
    return {
      id: r.id, name: r.name, description: r.description, keywords: r.keywords,
      weight: r.weight, storyCount: r.storyCount, neg: r.neg, pos: r.pos, mixed: r.mixed,
      // >1 means more than an even share of this bracket's weight landed in the most recent third of the window
      momentum: r.weight ? recent / (r.weight / (nBins / third)) : 0,
      series: gaussianSmooth(r.raw, sigma),
      drivers: r.drivers.slice(0, 6),
      groups: Object.entries(r.groups).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([group, weight]) => ({ group, weight })),
    };
  }).sort((a, b) => b.weight - a.weight);

  const sortObj = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]);
  return {
    bins, binHours, hours, brackets,
    impactAreas: sortObj(impactAreas),
    geography: sortObj(geography).slice(0, 15),
    groups: Object.values(groups).sort((a, b) => b.weight - a.weight).slice(0, 25),
  };
}

export function companyView(density, company, fronts, { minRelevance = 0.3, topics = 40 } = {}) {
  const nBins = density.bins.length;
  const sectors = new Map(company.sectors.map((s) => [s.name, {
    name: s.name, description: s.description, direct: 0, indirect: 0,
    series: Array(nBins).fill(0), fronts: {}, drivers: [],
  }]));
  const topicRows = [];
  let judged = 0;

  for (const b of density.brackets) {
    const m = company.matches[b.id];
    if (!m) continue;
    judged++;
    const hits = m.sectors.filter((s) => s.relevance >= minRelevance && sectors.has(s.sector));
    for (const h of hits) {
      const row = sectors.get(h.sector), c = b.weight * h.relevance;
      row[h.channel] += c;
      row.fronts[h.front] = (row.fronts[h.front] || 0) + c;
      b.series.forEach((v, i) => { row.series[i] += v * h.relevance; });
      row.drivers.push({ bracketId: b.id, name: b.name, relevance: h.relevance, channel: h.channel, front: h.front, why: h.why, writeAbout: h.write_about, c });
      // One recommendation per (sector, bracket): the angle was written for exactly this pairing.
      topicRows.push({
        bracketId: b.id, bracket: b.name, sector: h.sector, keywords: b.keywords, momentum: b.momentum, storyCount: b.storyCount,
        relevance: h.relevance, channel: h.channel, front: h.front, why: h.why, writeAbout: h.write_about,
        score: b.weight * h.relevance, stories: b.drivers.slice(0, 3),
      });
    }
  }

  const sectorRows = [...sectors.values()].map((s) => {
    s.drivers.sort((a, b) => b.c - a.c);
    return { ...s, total: s.direct + s.indirect, drivers: s.drivers.slice(0, 8) };
  }).sort((a, b) => b.total - a.total);

  return {
    id: company.id, name: company.name, builtin: !!company.builtin,
    sectors: company.sectors, fronts: Object.keys(fronts),
    matching: { done: judged, total: density.brackets.length },
    sectorsView: sectorRows,
    topics: topicRows.sort((a, b) => b.score - a.score).slice(0, topics),
    topicCount: topicRows.length,
  };
}
