// Group near-duplicate headlines (same story, different outlets) so the LLM reads each story once
// and "how many outlets ran it" becomes a coverage signal.

const STOP = new Set("a an the of in on at to for and or as by with from is are was were be been will after over says say said new amid into its it this that than more not no vs".split(" "));

export function tokens(title) {
  return new Set(title.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)));
}

function jaccard(a, b) {
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter || 1);
}

export function clusterArticles(articles, threshold = 0.5) {
  const clusters = [];
  for (const art of [...articles].sort((x, y) => x.publishedAt - y.publishedAt)) {
    const tk = tokens(art.title);
    const home = clusters.find((c) => jaccard(tk, c.tokens) >= threshold);
    if (home) {
      home.articles.push(art);
      for (const t of tk) home.tokens.add(t);
    } else {
      clusters.push({ tokens: tk, articles: [art] });
    }
  }
  return clusters.map((c, i) => {
    const arts = c.articles;
    const outlets = [...new Set(arts.map((a) => a.outlet))];
    // Representative: the longest headline carries the most detail.
    const rep = arts.reduce((best, a) => (a.title.length > best.title.length ? a : best), arts[0]);
    return {
      id: `${Math.min(...arts.map((a) => a.publishedAt)).toString(36)}-${i}`,
      title: rep.title,
      url: rep.url,
      snippet: rep.snippet,
      publishedAt: Math.min(...arts.map((a) => a.publishedAt)),
      outlets,
      articles: arts.map((a) => ({ title: a.title, outlet: a.outlet, publication: a.publication, url: a.url, publishedAt: a.publishedAt })),
    };
  });
}
