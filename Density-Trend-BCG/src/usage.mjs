// API usage and what is left, per service. Usage (calls, tokens) is counted locally on every call. Remaining credit is only
// shown where the provider reports it (Serper and SerpApi have account endpoints); for the others it says so plainly
// instead of guessing. Balances are cached so the page loads instantly, and refreshed on demand.
import { dayOf } from "./db.mjs";

const BAL_TTL = 30 * 60e3;
const monthStart = () => { const d = new Date(); return dayOf(new Date(d.getFullYear(), d.getMonth(), 1).getTime()); };

async function fetchBalance(name, key) {
  if (name === "serper") {
    const r = await fetch("https://google.serper.dev/account", { headers: { "X-API-KEY": key }, signal: AbortSignal.timeout(15000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.message ?? `Serper ${r.status}`);
    return { remaining: j.balance ?? null, total: null, unit: "credits", note: "Credits left on your Serper plan (1 credit per search of up to 10 results)." };
  }
  if (name === "serpapi") {
    const r = await fetch(`https://serpapi.com/account?api_key=${key}`, { signal: AbortSignal.timeout(15000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw new Error(j.error ?? `SerpApi ${r.status}`);
    return { remaining: j.total_searches_left ?? j.plan_searches_left ?? null, total: j.searches_per_month ?? j.plan_searches_per_month ?? null, unit: "searches", resetAt: null, note: "Searches left this month on your SerpApi plan." };
  }
  return null;
}

export async function refreshBalances({ store, integrations }) {
  for (const name of ["serper", "serpapi"]) {
    if (!integrations.key(name)) continue;
    try {
      const b = await fetchBalance(name, integrations.key(name));
      if (b) {
        store.setJson(`usage.balance.${name}`, { ...b, checkedAt: Date.now() });
        integrations.recordEvent(name, { ok: true, credits: b.remaining });
      }
    } catch (e) { store.setJson(`usage.balance.${name}`, { error: e.message, checkedAt: Date.now() }); }
  }
}

export async function usageReport({ store, integrations, cfg, refresh = false }) {
  const stale = ["serper", "serpapi"].some((n) => integrations.key(n) && Date.now() - (store.getJson(`usage.balance.${n}`, {}).checkedAt ?? 0) > BAL_TTL);
  if (refresh || stale) await refreshBalances({ store, integrations });
  const today = dayOf(Date.now()), month = monthStart(), h = cfg.hot ?? {}, ft = cfg.fulltext ?? {}, price = cfg.pricing?.anthropic ?? {};
  const NOTES = {
    anthropic: "Anthropic does not report a remaining balance to API keys. Tokens and calls below are counted locally; check console.anthropic.com for credit.",
    x: "X reports limits per request window, not a remaining balance. Add a token and fetch a topic to see them.",
    ollama: "Runs on this machine: no cost, no quota.",
    proxy: "DataImpulse bills by data used and does not report it to this app; check your DataImpulse dashboard.",
  };
  const services = [];
  for (const [name, spec] of Object.entries({ anthropic: "Anthropic (Claude)", groq: "Groq (low-cost models)", serper: "Serper (web news)", serpapi: "SerpApi (search interest)", x: "X (Twitter)", ollama: "Ollama (local model)", proxy: "Proxy (DataImpulse)" })) {
    const t = store.usage(name, today), m = store.usage(name, month), bal = store.getJson(`usage.balance.${name}`, null);
    const estCost = name === "anthropic" && price.inPerMTok != null && price.outPerMTok != null ? (m.tokensIn * price.inPerMTok + m.tokensOut * price.outPerMTok) / 1e6 : null;
    services.push({
      name, label: spec, enabled: integrations.enabled(name), configured: integrations.configured(name), today: t, month: m,
      balance: bal && !bal.error ? bal : null, balanceError: bal?.error ?? null, estCostMonth: estCost,
      health: integrations.state(name).exhausted ? "exhausted" : undefined,
      note: NOTES[name] ?? "", // serper/serpapi: the balance carries its own note
    });
  }
  return {
    day: today, services,
    budgets: {
      serper: { used: store.usage("serper", today).calls, limit: h.serperDailyBudget ?? 20, day: today },
      serpapi: { used: store.usage("serpapi", today).calls, limit: h.serpapiDailyBudget ?? 3, day: today },
      fulltextRetry: { used: store.usage("fulltext", today).calls, limit: ft.dailyRetries ?? 400, day: today },
    },
  };
}
