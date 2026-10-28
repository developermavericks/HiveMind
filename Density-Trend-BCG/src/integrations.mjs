// External services: which keys are present, whether each is switched on, how it has behaved lately, and whether
// it has run out of credit. Keys live in .env (never in the database, never sent to the browser in full); the
// on/off switches and usage counters live in the database. Everything here is local to this machine.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { writeFileAtomic } from "./atomic.mjs";

export const INTEGRATIONS = {
  anthropic: { label: "Anthropic (Claude)", env: "ANTHROPIC_API_KEY", role: "Reads stories, matches sectors to companies and drafts briefs.", essential: true, docs: "console.anthropic.com" },
  groq: { label: "Groq (low-cost models)", env: "GROQ_API_KEY", role: "Reads whole articles and checks topic fit at a fraction of the cost. Claude stays the fallback and makes the final decisions.", docs: "console.groq.com" },
  ollama: { label: "Ollama (local model)", env: null, role: "Runs a model on this machine as a fallback when Claude is unavailable, out of credit or switched off.", docs: "ollama.com" },
  x: { label: "X (Twitter) API", env: "X_BEARER_TOKEN", role: "Hourly post volume per topic, shown as a separate social signal. Never mixed into news coverage.", docs: "developer.x.com" },
  serpapi: { label: "SerpApi", env: "SERPAPI_KEY", role: "Google Trends search interest per topic (relative 0–100).", docs: "serpapi.com" },
  serper: { label: "Serper", env: "SERPER_API_KEY", role: "Google search and news results. Stored and testable; not used for collection yet.", docs: "serper.dev" },
  journalists: { label: "Journalist directory", env: null, role: "Directory of journalists (beat, outlet, recent articles) used to suggest who to pitch each opportunity to. Synced into this machine's database.", docs: "" },
  proxy: { label: "Proxy", env: "HTTPS_PROXY", role: "Routes Google News collection through a proxy if Google throttles this machine's IP.", docs: "" },
};
const EXHAUSTED = /credit|quota|insufficient|exhaust|out of (searches|requests)|limit (reached|exceeded)|billing|payment|\b402\b/i;
const KEY_OK = /^[\w.\-:=+/%~@]{8,400}$/; // no spaces or newlines, so a pasted value can never inject another .env line

export const mask = (v) => (!v ? "" : v.length <= 8 ? "••••" : `${v.slice(0, 4)}…${v.slice(-4)}`);

export class Integrations {
  constructor({ root, store }) { this.root = root; this.store = store; this.envPath = join(root, ".env"); }

  // ---- toggles ----
  enabled(name) { return this.store.getMeta(`int.${name}.enabled`) !== "0"; }
  setEnabled(name, on) { this.store.setMeta(`int.${name}.enabled`, on ? "1" : "0"); }
  key(name) { const e = INTEGRATIONS[name]?.env; return e ? process.env[e] || "" : ""; }
  configured(name) {
    if (name === "proxy") return !!(process.env.HTTPS_PROXY || process.env.HTTP_PROXY);
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
  // Node only reads NODE_USE_ENV_PROXY at startup, so the proxy switch takes effect after a restart.
  setProxyEnabled(on) { this.setEnv("NODE_USE_ENV_PROXY", on ? "1" : "0"); this.setEnabled("proxy", on); }

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
      const configured = name === "ollama" ? !!extra.ollama?.reachable : name === "journalists" ? (extra.journalists?.count ?? 0) > 0 : name === "proxy" ? !!(process.env.HTTPS_PROXY || process.env.HTTP_PROXY) : !!v;
      let health = "off";
      if (on && configured) health = s.exhausted ? "exhausted" : s.lastErrorAt && (!s.lastOkAt || s.lastErrorAt > s.lastOkAt) ? "error" : "ok";
      else if (on && !configured) health = "missing";
      return { name, label: spec.label, role: spec.role, docs: spec.docs, essential: !!spec.essential, hasKey: !!spec.env, configured, enabled: on, health,
        masked: name === "proxy" ? mask((process.env.HTTPS_PROXY || "").replace(/^https?:\/\/[^@]*@/, "")) : mask(v), envName: spec.env, state: s,
        needsRestart: name === "proxy" ? (process.env.NODE_USE_ENV_PROXY === "1") !== on : false };
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
        const url = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
        if (!url) return { ok: false, message: "No proxy configured." };
        const code = "Promise.all([fetch('https://api.ipify.org').then(r=>r.text())]).then(([ip])=>console.log(ip)).catch(e=>{console.error(e.message);process.exit(1)})";
        const via = spawnSync(process.execPath, ["-e", code], { encoding: "utf8", timeout: 30000, env: { ...process.env, NODE_USE_ENV_PROXY: "1" } });
        const direct = spawnSync(process.execPath, ["-e", code], { encoding: "utf8", timeout: 30000, env: { ...process.env, NODE_USE_ENV_PROXY: "0", HTTPS_PROXY: "", HTTP_PROXY: "" } });
        if (via.status !== 0) return fail(`Proxy request failed: ${String(via.stderr).trim().slice(0, 140)}`);
        const a = via.stdout.trim(), b = direct.stdout.trim();
        return a && a !== b ? pass(`Working: requests leave from ${a} instead of ${b || "your own IP"}.`) : fail("Requests still leave from your own IP; the proxy is not being used.");
      }
    } catch (e) { return fail(e.name === "TimeoutError" ? "Timed out." : e.message); }
    return { ok: false, message: "Unknown integration." };
  }
}
