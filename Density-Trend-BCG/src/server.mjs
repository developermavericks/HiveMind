// Local dashboard server: serves the page, answers /api/state, accepts company-sector uploads, and keeps
// matching new brackets against every company in the background while the pipeline is running.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSectors, slugify, CompanyStore, matchPending } from "./companies.mjs";
import { Reader } from "./llm.mjs";
import { BracketRegistry } from "./brackets.mjs";
import { buildState, storiesCache, registryCache } from "./state.mjs";
import { buildBracketDensity } from "./density.mjs";

const MAX_BODY = 1_000_000;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > MAX_BODY) { reject(new Error("Upload too large (1 MB max)")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export async function serve({ root, bcg, port = 8788, log = console.log }) {
  const data = storiesCache(join(root, "data", "stories-v3.json"));
  let seed = [];
  try { seed = JSON.parse(readFileSync(join(root, "config", "brackets.seed.json"), "utf8")); } catch { /* no seed file: registry starts empty */ }
  const registry = registryCache(join(root, "data", "brackets-v3.json"), seed);
  const store = new CompanyStore(join(root, "data", "companies"));

  // BCG ships as a ready-made company whose sectors are its practice areas.
  if (!store.get("bcg")) {
    store.put({ name: "BCG", builtin: true, sectors: bcg.practice_areas.map((p) => ({ name: p.name, description: p.sub.join(", ") })) });
  }

  const reader = new Reader(bcg, new BracketRegistry(null));
  let llm = { ok: false, message: "" };
  try { llm = { ok: true, message: await reader.detect() }; } catch (e) { llm = { ok: false, message: e.message }; }
  log(llm.ok ? `Matching LLM: ${llm.message}` : `Matching disabled: ${llm.message}`);

  let matching = false;
  async function matchNow() {
    if (matching || !llm.ok) return;
    matching = true;
    try {
      const reg = registry.get(), d = data.get();
      if (reg && d) {
        // What is in the news right now, per bracket — the matcher writes its angles from these stories.
        const dens = buildBracketDensity(d.stories.filter((s) => s.analysis), reg, { now: d.meta.generatedAt });
        const evidence = new Map(dens.brackets.map((b) => [b.id, { storyCount: b.storyCount, stories: b.drivers }]));
        const n = await matchPending(store, reg, reader, { evidence, log });
        if (n) log(`matched ${n} bracket×company judgements`);
      }
    } catch (e) { log(`matching error: ${e.message}`); }
    finally { matching = false; }
  }
  matchNow();
  setInterval(matchNow, 8000).unref();

  const json = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(obj)); };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return res.end(readFileSync(join(root, "src", "dashboard.html")));
      }
      if (req.method === "GET" && url.pathname === "/api/state") {
        const companies = store.list();
        const wanted = url.searchParams.get("company") || "bcg";
        return json(res, 200, buildState({
          data: data.get(), registry: registry.get(), companies, companyId: wanted, bcg,
          hours: Math.min(168, Math.max(6, +url.searchParams.get("window") || 48)), llm,
        }));
      }
      if (req.method === "POST" && url.pathname === "/api/company") {
        // Requiring JSON blocks cross-site form posts: browsers can't send this content type without a CORS preflight.
        if (!(req.headers["content-type"] || "").startsWith("application/json")) return json(res, 415, { error: "Send application/json" });
        const body = JSON.parse(await readBody(req) || "{}");
        const parsed = parseSectors(body.text, String(body.name || "").trim());
        const name = String(body.name || parsed.name || "").trim();
        if (!name) return json(res, 400, { error: "Enter a company name (or add a 'Company: …' first line to the file)." });
        if (!parsed.sectors.length) return json(res, 400, { error: "No sectors found. Use one sector per line, a comma-separated list, a CSV with a 'sector' column, or JSON." });
        const company = store.put({ name, sectors: parsed.sectors });
        matchNow();
        return json(res, 200, { id: company.id, name: company.name, sectors: company.sectors });
      }
      if (req.method === "DELETE" && url.pathname === "/api/company") {
        const id = slugify(url.searchParams.get("id") || "");
        const c = store.get(id);
        if (!c) return json(res, 404, { error: "Unknown company" });
        if (c.builtin) return json(res, 400, { error: "The built-in company can't be removed" });
        store.remove(id);
        return json(res, 200, { ok: true });
      }
      json(res, 404, { error: "Not found" });
    } catch (e) {
      json(res, e instanceof SyntaxError ? 400 : 500, { error: e instanceof SyntaxError ? "Invalid JSON" : e.message });
    }
  });

  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  log(`Dashboard: http://127.0.0.1:${port}`);
  return server;
}
