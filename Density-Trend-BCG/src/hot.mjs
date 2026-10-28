// Hot topics get a wider look, and only they do: a Serper news search ("is the wider web covering this too, and who?") and,
// within a smaller budget, a Google Trends search-interest fetch. Both are capped per day so credits are spent where they
// change a decision, and each topic is re-checked at most every few hours. Results are stored separately from news coverage.
import { norm } from "./brackets.mjs";
import { fetchSerpApi } from "./signals.mjs";
import { dayOf } from "./db.mjs";

const SERPER_NEWS = "https://google.serper.dev/news";

export async function serperNews(query, { key = process.env.SERPER_API_KEY, hours = 24 } = {}) {
  if (!key) throw new Error("SERPER_API_KEY is not set");
  const res = await fetch(SERPER_NEWS, {
    method: "POST", headers: { "X-API-KEY": key, "content-type": "application/json" }, signal: AbortSignal.timeout(25000),
    body: JSON.stringify({ q: query, gl: "in", hl: "en", num: 10, tbs: hours <= 1 ? "qdr:h" : hours <= 24 ? "qdr:d" : "qdr:w" }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Serper ${res.status}: ${j.message ?? "request refused"}`);
  return j.news ?? [];
}

// Which topics are hot: rising or emerging, scoring well, with something to act on. One entry per topic.
export function pickHot(opps, cfg, recentlyChecked = new Set()) {
  const h = cfg.hot ?? {}, seen = new Set(), out = [];
  for (const o of opps) {
    if (seen.has(o.label.key)) continue;
    seen.add(o.label.key);
    if (o.action === "skip" || o.score < (h.minScore ?? 60) || !(h.stages ?? ["emerging", "rising"]).includes(o.stage)) continue;
    if (recentlyChecked.has(norm(o.label.name))) continue;
    out.push(o);
  }
  return out.slice(0, h.maxTopicsPerPass ?? 5);
}

export function summariseNews(results, sources) {
  const names = [...new Set(results.map((r) => r.source).filter(Boolean))];
  const outside = names.filter((n) => !sources.find(n));
  return {
    total: results.length, outlets: names.length, outsideOurSources: outside, ourSources: names.filter((n) => sources.find(n)),
    top: results.slice(0, 5).map((r) => ({ title: r.title, link: r.link, source: r.source, date: r.date })),
  };
}

// Runs one pass. Returns what was done so the log can say it. Never throws for a single topic's failure.
export async function refreshHot({ store, integrations, opps, cfg, sources, log = () => {} }) {
  const h = cfg.hot ?? {}, today = dayOf(Date.now());
  const out = { checked: 0, serper: 0, serpapi: 0, errors: 0, topics: [], skipped: "" };
  const recent = new Set(store.webChecksSince("serper:news", Date.now() - (h.recheckHours ?? 12) * 3600e3).map((r) => r.topic));
  const picks = pickHot(opps, cfg, recent);
  if (!picks.length) { out.skipped = "no new hot topics to check"; return out; }
  const serperOn = integrations.active("serper"), serpapiOn = integrations.active("serpapi");
  let serperLeft = Math.max(0, (h.serperDailyBudget ?? 20) - store.usage("serper", today).calls);
  let serpapiLeft = Math.max(0, (h.serpapiDailyBudget ?? 3) - store.usage("serpapi", today).calls);
  if (!serperOn && !serpapiOn) { out.skipped = "Serper and SerpApi are off or have no key"; return out; }
  for (const o of picks) {
    const name = o.label.name, topic = norm(name);
    const row = { topic: name };
    if (serperOn && serperLeft > 0) {
      try {
        const data = summariseNews(await serperNews(`${name} India`, { key: integrations.key("serper") }), sources);
        store.addUsage("serper", { calls: 1 }); serperLeft--; out.serper++;
        store.putWebCheck(topic, "serper:news", { query: `${name} India`, ...data });
        integrations.recordEvent("serper", { ok: true });
        Object.assign(row, { webArticles: data.total, outsideSources: data.outsideOurSources.length });
      } catch (e) { store.addUsage("serper", { calls: 0, errors: 1 }); integrations.recordEvent("serper", { ok: false, error: e.message }); out.errors++; row.error = e.message; log(`serper check failed for "${name}": ${e.message}`); }
    }
    if (serpapiOn && serpapiLeft > 0 && !store.getSignal(topic).some((p) => p.t > Date.now() - 6 * 24 * 3600e3)) {
      try {
        const r = await fetchSerpApi(name, { key: integrations.key("serpapi") });
        store.addUsage("serpapi", { calls: 1 }); serpapiLeft--; out.serpapi++;
        if (r.points.length) store.putSignal(topic, r.source, r.points);
        integrations.recordEvent("serpapi", { ok: true });
        row.searchPoints = r.points.length;
      } catch (e) { store.addUsage("serpapi", { calls: 0, errors: 1 }); integrations.recordEvent("serpapi", { ok: false, error: e.message }); out.errors++; row.searchError = e.message; }
    }
    out.checked++; out.topics.push(row);
  }
  return out;
}
