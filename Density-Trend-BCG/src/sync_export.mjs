import https from "node:https";
import http from "node:http";
import { URL } from "node:url";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getJson(urlStr, apiKey, options = {}) {
  const maxRetries = options.retries ?? 3;
  const timeoutMs = options.timeoutMs ?? 25000;

  return new Promise((resolve, reject) => {
    let attempt = 0;

    function execute() {
      attempt++;
      const parsed = new URL(urlStr);
      const isHttps = parsed.protocol === "https:";
      const client = isHttps ? https : http;

      const req = client.request(parsed, {
        method: "GET",
        family: 4,
        headers: {
          "Accept": "application/json",
          "User-Agent": "HiveMind-Sync/1.0",
          ...(apiKey ? { "X-API-Key": apiKey } : {})
        },
        timeout: timeoutMs
      }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(body));
            } catch (err) {
              reject(new Error(`Failed to parse JSON from ${urlStr}: ${err.message}`));
            }
          } else if (res.statusCode === 429 || res.statusCode >= 500) {
            if (attempt <= maxRetries) {
              const delay = Math.min(1000 * Math.pow(2, attempt), 8000);
              console.warn(`[sync] Request ${urlStr} got HTTP ${res.statusCode}. Retrying in ${delay}ms (attempt ${attempt}/${maxRetries})...`);
              setTimeout(execute, delay);
            } else {
              reject(new Error(`HTTP ${res.statusCode} from ${urlStr}: ${body.slice(0, 200)}`));
            }
          } else {
            reject(new Error(`HTTP ${res.statusCode} from ${urlStr}: ${body.slice(0, 200)}`));
          }
        });
      });

      req.on("timeout", () => {
        req.destroy();
        if (attempt <= maxRetries) {
          console.warn(`[sync] Timeout requesting ${urlStr}. Retrying (attempt ${attempt}/${maxRetries})...`);
          setTimeout(execute, 1000 * attempt);
        } else {
          reject(new Error(`Request timed out for ${urlStr}`));
        }
      });

      req.on("error", (err) => {
        if (attempt <= maxRetries) {
          console.warn(`[sync] Network error requesting ${urlStr} (${err.message}). Retrying (attempt ${attempt}/${maxRetries})...`);
          setTimeout(execute, 1000 * attempt);
        } else {
          reject(err);
        }
      });

      req.end();
    }

    execute();
  });
}

export class ExportSyncer {
  constructor({ baseUrl, apiKey, store, rootDir, log = console.log }) {
    this.baseUrl = (baseUrl || process.env.HIVEMIND_EXPORT_BASE_URL || "https://34-100-157-5.sslip.io/api/export").replace(/\/+$/, "");
    this.apiKey = apiKey || process.env.HIVEMIND_EXPORT_KEY;
    this.store = store;
    this.rootDir = rootDir;
    this.log = log;
    this._tableCols = new Map();
  }

  getTableColumns(tableName) {
    if (this._tableCols.has(tableName)) return this._tableCols.get(tableName);
    try {
      const rows = this.store.db.prepare(`PRAGMA table_info(${tableName})`).all();
      if (!rows || rows.length === 0) {
        this._tableCols.set(tableName, null);
        return null;
      }
      const info = {
        names: new Set(rows.map((r) => r.name)),
        pk: rows.filter((r) => r.pk > 0).map((r) => r.name)
      };
      this._tableCols.set(tableName, info);
      return info;
    } catch {
      this._tableCols.set(tableName, null);
      return null;
    }
  }

  upsertRows(datasetName, keyCols, rows) {
    if (!rows || rows.length === 0) return 0;
    const tableInfo = this.getTableColumns(datasetName);
    if (!tableInfo) {
      this.log(`[sync] Warning: table '${datasetName}' does not exist in local SQLite. Skipping rows.`);
      return 0;
    }

    const { names: validCols } = tableInfo;
    const effectiveKeys = (keyCols && keyCols.length > 0) ? keyCols.filter((k) => validCols.has(k)) : tableInfo.pk;
    if (effectiveKeys.length === 0) {
      this.log(`[sync] Warning: No key found for table '${datasetName}'. Skipping rows.`);
      return 0;
    }

    const first = rows[0];
    const insertCols = Object.keys(first).filter((k) => k !== "_changed_at" && validCols.has(k));
    if (insertCols.length === 0) return 0;

    const keySet = new Set(effectiveKeys);
    const updateCols = insertCols.filter((c) => !keySet.has(c));

    let sql = `INSERT INTO ${datasetName} (${insertCols.join(", ")}) VALUES (${insertCols.map(() => "?").join(", ")}) `;
    if (updateCols.length > 0) {
      sql += `ON CONFLICT (${effectiveKeys.join(", ")}) DO UPDATE SET ${updateCols.map((c) => `${c} = excluded.${c}`).join(", ")}`;
    } else {
      sql += `ON CONFLICT (${effectiveKeys.join(", ")}) DO NOTHING`;
    }

    const stmt = this.store.db.prepare(sql);

    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        const values = insertCols.map((c) => {
          const val = row[c];
          if (val === undefined) return null;
          if (typeof val === "object" && val !== null) {
            return JSON.stringify(val);
          }
          return val;
        });
        stmt.run(...values);
      }
      this.store.db.exec("COMMIT");
      return rows.length;
    } catch (err) {
      this.store.db.exec("ROLLBACK");
      throw err;
    }
  }

  async syncReferenceData() {
    this.log(`[sync] Polling reference data...`);
    const results = {};

    // 1. Brackets
    try {
      const bData = await getJson(`${this.baseUrl}/brackets`, this.apiKey);
      if (bData && bData.brackets) {
        const bracketsPath = join(this.rootDir, "data", "brackets-v3.json");
        writeFileAtomic(bracketsPath, JSON.stringify(bData, null, 2));
        results.brackets = bData.brackets.length;
        this.log(`[sync] Reference: synced ${bData.brackets.length} brackets to data/brackets-v3.json`);
      }
    } catch (e) {
      this.log(`[sync] Warning: failed to fetch /brackets: ${e.message}`);
    }

    // 2. Companies
    try {
      const cData = await getJson(`${this.baseUrl}/companies`, this.apiKey);
      const list = cData?.companies || (Array.isArray(cData) ? cData : []);
      const companiesDir = join(this.rootDir, "data", "companies");
      mkdirSync(companiesDir, { recursive: true });

      for (const comp of list) {
        if (!comp.id) continue;
        const filePath = join(companiesDir, `${comp.id}.json`);
        let current = {};
        if (existsSync(filePath)) {
          try { current = JSON.parse(readFileSync(filePath, "utf8")); } catch { current = {}; }
        }

        const sectorMap = new Map();
        for (const s of (current.sectors || [])) {
          if (s?.name) sectorMap.set(s.name, s);
        }
        for (const s of (comp.sectors || [])) {
          if (s?.name) {
            const existing = sectorMap.get(s.name);
            sectorMap.set(s.name, {
              name: s.name,
              description: s.description || existing?.description || ""
            });
          }
        }

        const merged = {
          ...current,
          ...comp,
          sectors: [...sectorMap.values()],
          matches: { ...(current.matches || {}), ...(comp.matches || {}) }
        };

        writeFileAtomic(filePath, JSON.stringify(merged, null, 2));
      }
      results.companies = list.length;
      this.log(`[sync] Reference: synced ${list.length} companies to data/companies/`);
    } catch (e) {
      this.log(`[sync] Warning: failed to fetch /companies: ${e.message}`);
    }

    // 3. X Trends
    try {
      const xtData = await getJson(`${this.baseUrl}/xtrends`, this.apiKey);
      if (xtData && (xtData.india || xtData.worldwide || xtData.trends)) {
        this.store.setJson("social.xtrends.cache", xtData);
        results.xtrends = (xtData.india?.length || 0) + (xtData.worldwide?.length || 0);
        this.log(`[sync] Reference: saved ${results.xtrends} X trends to cache`);
      }
    } catch (e) {
      this.log(`[sync] Warning: failed to fetch /xtrends: ${e.message}`);
    }

    return results;
  }

  async syncDataset(name, opts = {}) {
    const full = opts.full ?? false;
    const limit = Math.min(2000, Math.max(1, opts.limit ?? 2000));
    const metaKey = `export.since.${name}`;
    const lastSince = opts.since !== undefined && opts.since !== null
      ? opts.since
      : (full ? 0 : (Number(this.store.getMeta(metaKey)) || 0));

    const tableInfo = this.getTableColumns(name);
    let cursor = null;
    let hasMore = true;
    let totalUpserted = 0;
    let pages = 0;
    let nextSince = null;

    const t0 = Date.now();

    while (hasMore) {
      pages++;
      const params = new URLSearchParams();
      params.set("limit", String(limit));
      if (lastSince > 0) params.set("since", String(lastSince));
      if (cursor) params.set("cursor", cursor);
      if (opts.company && tableInfo?.names.has("company")) params.set("company", opts.company);

      const url = `${this.baseUrl}/${name}?${params.toString()}`;
      const data = await getJson(url, this.apiKey);

      const rows = data.rows || [];
      const keyCols = data.key || [];
      nextSince = data.next_since ?? nextSince;
      hasMore = Boolean(data.has_more);
      cursor = data.next_cursor || null;

      if (rows.length > 0) {
        const count = this.upsertRows(name, keyCols, rows);
        totalUpserted += count;
      }

      if (pages % 5 === 0 || !hasMore || rows.length === 0) {
        this.log(`[sync] ${name}: page ${pages}, upserted ${totalUpserted} records (${Date.now() - t0}ms)`);
      }

      if (!cursor) break;
      await sleep(100); // polite rate pacing
    }

    if (nextSince) {
      this.store.setMeta(metaKey, String(nextSince));
    }

    return { name, totalUpserted, pages, nextSince, durationMs: Date.now() - t0 };
  }

  async syncAll(opts = {}) {
    const startTime = Date.now();
    this.log(`[sync] Starting HiveMind export sync from ${this.baseUrl}...`);

    if (!this.apiKey) {
      throw new Error("Missing HiveMind export API key (HIVEMIND_EXPORT_KEY).");
    }

    let catalog;
    try {
      catalog = await getJson(this.baseUrl, this.apiKey);
    } catch (err) {
      throw new Error(`Failed to contact export API at ${this.baseUrl}: ${err.message}`);
    }

    const availableDatasets = (catalog.datasets || []).map((d) => d.name);
    this.log(`[sync] Connected successfully. Server time: ${catalog.server_time}. Available datasets: ${availableDatasets.length}`);

    await this.syncReferenceData();

    let targets = availableDatasets;
    if (opts.datasets && opts.datasets.length > 0) {
      targets = opts.datasets;
    }

    const summary = [];
    for (const dname of targets) {
      try {
        const res = await this.syncDataset(dname, opts);
        summary.push(res);
      } catch (err) {
        this.log(`[sync] Error syncing dataset '${dname}': ${err.message}`);
        summary.push({ name: dname, error: err.message });
      }
    }

    const totalRecords = summary.reduce((acc, s) => acc + (s.totalUpserted || 0), 0);
    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    this.store.setMeta("export.lastSyncAt", String(Date.now()));
    this.log(`[sync] Finished sync in ${totalTime}s. Upserted ${totalRecords} records across ${summary.length} datasets.`);

    return { summary, totalRecords, totalTimeSeconds: totalTime };
  }
}
