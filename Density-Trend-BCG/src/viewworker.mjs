// Builds the dashboard's heavy views in a worker thread, so the 2 s it takes to rebuild the shared data after a change never freezes the web server.
// It has its own read connection to the same database (WAL mode lets it read while the server and the jobs write) and its own Analytics; the server
// asks it for a view by name and gets the finished JSON back. Nothing here writes to the database.
import { parentPort, workerData } from "node:worker_threads";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Store } from "./db.mjs";
import { Analytics } from "./analytics.mjs";
import { CompanyStore } from "./companies.mjs";
import { BracketRegistry } from "./brackets.mjs";
import { registryCache } from "./state.mjs";
import { SourceRegistry } from "./origins.mjs";

const { root } = workerData;
const readJson = (p, fallback) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return fallback; } };
const store = new Store(join(root, "data", "hivemind.db"));
const seed = readJson(join(root, "config", "brackets.seed.json"), []);
const pubs = readJson(join(root, "config", "publications.json"), []);
const cfg = readJson(join(root, "config", "hivemind.json"), {});
const registryFile = registryCache(join(root, "data", "brackets-v3.json"), seed), seedRegistry = new BracketRegistry(null, seed);
const analytics = new Analytics({ store, registry: () => registryFile.get() ?? seedRegistry, sources: new SourceRegistry(pubs), cfg, companies: new CompanyStore(join(root, "data", "companies")), reader: null, pubs });

// Weights re-tuned in Accuracy are written to a file; the server applies them to its own config, so the worker reads the file again whenever it is told to clear.
const loadWeights = () => { const o = readJson(join(root, "data", "weights.override.json"), null); if (o?.weights && Object.keys(o.weights).length === Object.keys(cfg.weights ?? {}).length) cfg.weights = o.weights; };
loadWeights();

parentPort.on("message", (m) => {
  if (m.type === "clear") { Map.prototype.clear.call(analytics.cache); loadWeights(); return; }
  try {
    const value = analytics[m.method](m.args);
    parentPort.postMessage({ id: m.id, ok: true, body: JSON.stringify(value), failed: !!(value && value.error) });
  } catch (e) { parentPort.postMessage({ id: m.id, ok: false, error: String(e?.message ?? e) }); }
});
parentPort.postMessage({ ready: true });
