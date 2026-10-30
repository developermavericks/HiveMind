// External services: which keys are present, whether each is switched on, how it has behaved lately, and whether
// it has run out of credit. Keys live in .env (never in the database, never sent to the browser in full); the
// on/off switches and usage counters live in the database. Everything here is local to this machine.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.mjs";
import { fetchViaProxy, proxyUrl } from "./proxyfetch.mjs";

export const INTEGRATIONS = {
  anthropic: { label: "Anthropic (Claude)", env: "ANTHROPIC_API_KEY", role: "Switched off by default: while it is off, Groq and OpenAI (Luna) do all the work and nothing can fall back to Claude. Switch it on to use Claude (Haiku) again for reading, matching and briefs.", docs: "console.anthropic.com" },
  groq: { label: "Groq (low-cost models)", env: "GROQ_API_KEY", role: "The low-cost workhorse: reads whole articles, labels topics and sentiment, checks topic fit, merges duplicates and reads the print editions. With Claude off it also takes over from OpenAI when OpenAI fails or reaches its daily cap.", docs: "console.groq.com" },
  openai: { label: "OpenAI (GPT)", env: "OPENAI_API_KEY", role: "GPT-5.6 Luna for the heavier jobs: reading headlines, company-sector matching, briefs, the second-opinion review and putting the columns of printed articles back together. A daily spend cap (limits.openaiDailyUsd) sends work to Groq once it is reached. Everything else is Groq.", docs: "platform.openai.com" },
  ollama: { label: "Ollama (local model)", env: null, role: "Runs a model on this machine as a fallback when Claude is unavailable, out of credit or switched off.", docs: "ollama.com" },
  x: { label: "X (Twitter) API", env: "X_BEARER_TOKEN", role: "Hourly post volume per topic, shown as a separate social signal. Never mixed into news coverage.", docs: "developer.x.com" },
  serpapi: { label: "SerpApi", env: "SERPAPI_KEY", role: "Google Trends search interest per topic (relative 0–100).", docs: "serpapi.com" },
  serper: { label: "Serper", env: "SERPER_API_KEY", role: "Google search and news results. Stored and testable; not used for collection yet.", docs: "serper.dev" },
  // JOURNALISTS DISABLED (directory integration):
  // journalists: { label: "Journalist directory", env: null, role: "Directory of journalists (beat, outlet, recent articles) used to suggest who to pitch each opportunity to. Synced into this machine's database.", docs: "" },
  proxy: { label: "Proxy", env: "HTTPS_PROXY", role: "Used for one thing only: an article's text that could not be fetched directly is retried once through it. Google News polling, the model APIs and everything else connect directly.", docs: "" },
};
const EXHAUSTED = /credit|quota|insufficient|exhaust|out of (searches|requests)|limit (reached|exceeded)|billing|payment|\b402\b/i;
const KEY_OK = /^[\w.\-:=+/%~@]{8,400}$/; // no spaces or newlines, so a pasted value can never inject another .env line

export const mask = (v) => (!v ? "" : v.length <= 8 ? "••••" : `${v.slice(0, 4)}…${v.slice(-4)}`);

export class Integrations {
  constructor({ root, store }) { this.root = root; this.store = store; this.envPath = join(root, ".env"); }

  // ---- toggles ----
  // Claude is off until someone switches it on (Settings → Integrations): while it is off Groq and OpenAI do the work. Everything else is on by default.
  enabled(name) { const v = this.store.getMeta(`int.${name}.enabled`); return v == null || v === "" ? name !== "anthropic" : v !== "0"; }
  setEnabled(name, on) { this.store.setMeta(`int.${name}.enabled`, on ? "1" : "0"); }
  key(name) { const e = INTEGRATIONS[name]?.env; return e ? process.env[e] || "" : ""; }
  configured(name) {
    if (name === "proxy") return !!proxyUrl();
    if (name === "ollama") return true;
    return !!this.key(name);
  }
  // Usable = switched on and has what it needs.
  active(name) { return this.enabled(name) && this.configured(name); }

  // ---- keys in .env ----
  #lines() { return existsSync(this.envPath) ? readFileSync(this.envPath, "utf8").split(/\r?\n/) : []; }
  #write(lines) { writeFileAtomic(this.envPath, lines.join("\n").replace(/\n*$/, "\n")); }
  setEnv(envName, value) {
    if (!KEY_OK.test(value)) throw new Error("That doesn't look like a valid key (no spaces or line breaks allowed).");
    const lines = this.#lines(), i = lines.findIndex((l) => l.startsWith(`${envName}=`));
    if (i >= 0) lines[i] = `${envName}=${value}`; else lines.push(`${envName}=${value}`);
    this.#write(lines); process.env[envName] = value;
  }
  removeEnv(envName) {
    this.#write(this.#lines().filter((l) => !l.startsWith(`${envName}=`))); delete process.env[envName];
  }
  setKey(name, value) {
    const spec = INTEGRATIONS[name];
    if (!spec?.env) throw new Error("This integration has no key.");
    if (name === "proxy") { this.setEnv("HTTPS_PROXY", value); this.setEnv("HTTP_PROXY", value); return; }
    this.setEnv(spec.env, value);
    this.store.setMeta(`int.${name}.enabled`, "1");
    this.recordEvent(name, { reset: true });
  }
  removeKey(name) {
    const spec = INTEGRATIONS[name];
    if (!spec?.env) return;
    if (name === "proxy") { this.removeEnv("HTTPS_PROXY"); this.removeEnv("HTTP_PROXY"); return; }
    this.removeEnv(spec.env);
  }
  // The switch is read by each job when it starts (HIVEMIND_NO_PROXY), so it takes effect on the next job. No restart and no .env line are involved.
  setProxyEnabled(on) { this.setEnabled("proxy", on); }

  // ---- usage and health ----
  state(name) { return this.store.getJson(`int.${name}.state`, { calls: 0, ok: 0, errors: 0 }); }
  // ev: { ok, error, credits, detail, reset }. Credit exhaustion is detected from the error text and stays flagged until the next success.
  recordEvent(name, ev = {}) {
    const s = this.state(name), now = Date.now();
    if (ev.reset) { this.store.setJson(`int.${name}.state`, { calls: 0, ok: 0, errors: 0 }); return; }
    s.calls++;
    if (ev.ok) { s.ok++; s.lastOkAt = now; s.exhausted = false; s.lastError = null; }
    else { s.errors++; s.lastErrorAt = now; s.lastError = String(ev.error ?? "failed").slice(0, 240); if (EXHAUSTED.test(s.lastError)) { s.exhausted = true; s.exhaustedAt = now; } }
    if (ev.credits != null) { s.credits = ev.credits; s.creditsAt = now; if (ev.credits <= 0) s.exhausted = true; }
    if (ev.detail) s.detail = ev.detail;
    this.store.setJson(`int.${name}.state`, s);
  }

  status(extra = {}) {
    return Object.entries(INTEGRATIONS).map(([name, spec]) => {
      const v = this.key(name), s = this.state(name), on = this.enabled(name);
      const configured = name === "ollama" ? !!extra.ollama?.reachable : name === "journalists" ? (extra.journalists?.count ?? 0) > 0 : name === "proxy" ? !!proxyUrl() : !!v;
      let health = "off";
      if (on && configured) health = s.exhausted ? "exhausted" : s.lastErrorAt && (!s.lastOkAt || s.lastErrorAt > s.lastOkAt) ? "error" : "ok";
      else if (on && !configured) health = "missing";
      return { name, label: spec.label, role: spec.role, docs: spec.docs, essential: !!spec.essential, hasKey: !!spec.env, configured, enabled: on, health,
        masked: name === "proxy" ? mask(proxyUrl().replace(/^https?:\/\/[^@]*@/, "")) : mask(v), envName: spec.env, state: s,
        needsRestart: false };
    });
  }

  // ---- connection tests (each is one tiny request; the result is recorded like real usage) ----
  async test(name, { ollamaHost } = {}) {
    const fail = (error) => { this.recordEvent(name, { ok: false, error }); return { ok: false, message: error }; };
    const pass = (message, ev = {}) => { this.recordEvent(name, { ok: true, ...ev }); return { ok: true, message }; };
    const timeout = AbortSignal.timeout(25000);
    try {
      if (name === "anthropic") {
        if (!this.key(name)) return { ok: false, message: "No key set." };
        const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", signal: timeout, headers: { "x-api-key": this.key(name), "anthropic-version": "2023-06-01", "content-type": "application/json" },
          body: JSON.stringify({ model: process.env.HIVEMIND_MODEL || "claude-haiku-4-5", max_tokens: 4, messages: [{ role: "user", content: "ok" }] }) });
        if (!r.ok) return fail(`Anthropic ${r.status}: ${(await r.text()).slice(0, 160)}`);
        return pass("Key accepted.");
      }
      if (name === "openai") {
        if (!this.key(name)) return { ok: false, message: "No key set." };
        const r = await fetch("https://api.openai.com/v1/models", { signal: timeout, headers: { authorization: `Bearer ${this.key(name)}` } });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) return fail(`OpenAI ${r.status}: ${j.error?.message ?? "request refused"}`);
        return pass(`Key accepted (using ${process.env.OPENAI_MODEL || "gpt-5.6-luna"}).`);
      }
      if (name === "groq") {
        if (!this.key(name)) return { ok: false, message: "No key set." };
        const r = await fetch("https://api.groq.com/openai/v1/models", { signal: timeout, headers: { authorization: `Bearer ${this.key(name)}` } });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) return fail(`Groq ${r.status}: ${j.error?.message ?? "request refused"}`);
        return pass(`Key accepted; ${(j.data ?? []).length} models available (using ${process.env.GROQ_MODEL || "openai/gpt-oss-120b"}).`);
      }
      if (name === "serpapi") {
        if (!this.key(name)) return { ok: false, message: "No key set." };
        const r = await fetch(`https://serpapi.com/account?api_key=${this.key(name)}`, { signal: timeout }); // the account call does not use a search
        const j = await r.json().catch(() => ({}));
        if (!r.ok || j.error) return fail(j.error ?? `SerpApi ${r.status}`);
        const left = j.total_searches_left ?? j.plan_searches_left;
        return pass(`Key accepted${left != null ? `: ${left} searches left this month` : ""}.`, { credits: left });
      }
      if (name === "serper") {
        if (!this.key(name)) return { ok: false, message: "No key set." };
        const r = await fetch("https://google.serper.dev/search", { method: "POST", signal: timeout, headers: { "X-API-KEY": this.key(name), "content-type": "application/json" }, body: JSON.stringify({ q: "india news", num: 1 }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) return fail(j.message ?? `Serper ${r.status}`);
        return pass(`Key accepted${j.credits != null ? `: ${j.credits} credits used by this call, see serper.dev for balance` : ""}.`);
      }
      if (name === "x") {
        if (!this.key(name)) return { ok: false, message: "No token set." };
        const r = await fetch("https://api.twitter.com/2/tweets/counts/recent?query=india&granularity=day", { signal: timeout, headers: { authorization: `Bearer ${this.key(name)}` } });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) return fail(`X ${r.status}: ${j.detail ?? j.title ?? "request refused"}${r.status === 403 ? " (your API plan may not include tweet counts)" : ""}`);
        return pass("Token accepted and tweet counts are available on your plan.", { detail: `rate limit remaining ${r.headers.get("x-rate-limit-remaining") ?? "?"}` });
      }
      if (name === "journalists") {
        const u = new URL(process.env.JOURNALISTS_API_URL || "https://us-central1-anexar-9820c.cloudfunctions.net/getJournalists");
        u.searchParams.set("limit", "1");
        const r = await fetch(u, { signal: timeout });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.success) return fail(`Directory endpoint returned ${r.status}`);
        return pass(`Reachable: ${j.totalRecords} journalists available.`);
      }
      if (name === "ollama") {
        const host = (ollamaHost || process.env.OLLAMA_HOST || "http://127.0.0.1:11434").replace(/\/$/, "");
        const r = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(4000) });
        if (!r.ok) return fail(`Ollama ${r.status}`);
        const n = ((await r.json()).models ?? []).length;
        return n ? pass(`Running, ${n} model${n > 1 ? "s" : ""} installed.`) : fail("Ollama is running but no model is installed yet.");
      }
      if (name === "proxy") {
        const url = proxyUrl();
        if (!url) return { ok: false, message: "No proxy configured." };
        // the same mechanism the application uses for article-text retries: a tunnel through the proxy to a page that reports the address it sees
        const seen = async (viaProxy) => { const r = viaProxy ? await fetchViaProxy("https://api.ipify.org", { proxyUrl: url, timeout: 20000 }) : await fetch("https://api.ipify.org", { signal: timeout }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return (await r.text()).trim(); };
        let a; try { a = await seen(true); } catch (e) { return fail(`Proxy request failed: ${String(e.message).slice(0, 140)}`); }
        const b = await seen(false).catch(() => "");
        return a && a !== b ? pass(`Working: article-text retries leave from ${a} instead of ${b || "your own IP"}. Nothing else uses the proxy.`) : fail("Requests still leave from your own IP; the proxy is not being used.");
      }
    } catch (e) { return fail(e.name === "TimeoutError" ? "Timed out." : e.message); }
    return { ok: false, message: "Unknown integration." };
  }
}
