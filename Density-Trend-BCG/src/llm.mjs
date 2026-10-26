// Two LLM jobs, same provider plumbing (Claude with a forced tool call, or local Ollama):
//   read()  — company-agnostic: what happened, who/what is affected, and which keyword bracket each impact belongs to
//   match() — given a company's sectors, how relevant each bracket is, via which front, and what to write about
//
//   HIVEMIND_LLM=auto|anthropic|ollama   HIVEMIND_MODEL=claude-haiku-5-5
//   OLLAMA_HOST=http://127.0.0.1:11434   OLLAMA_MODEL=<tag>
import { norm } from "./brackets.mjs";

const clamp01 = (x) => (Number.isFinite(+x) ? Math.min(1, Math.max(0, +x)) : 0);
const str = (x, max = 400) => (typeof x === "string" ? x.trim().slice(0, max) : "");

// ---------- Job 1: company-agnostic reading ----------

export function readSystem(bcg) {
  return `You are an analyst reading Indian news to work out its real-world impact. You are NOT working for any company: do not consider any client, brand or industry's interests. Describe the impact on the world.

For the story you are given, record:
- what happened (one sentence), the geography affected, and the event type;
- "impacts": every distinct group or thing affected (e.g. coastal fishing communities, auto OEMs, retail borrowers, state exchequer, urban commuters). area must be one of: ${bcg.impact_areas.join(", ")}. direction: negative|positive|mixed. severity 0-1 (0.1 marginal, 0.5 material to a sector or region, 0.9 national-scale shock). horizon: immediate|near (weeks-months)|long.
- Every impact must be assigned to ONE KEYWORD BRACKET: a reusable impact theme.

Keyword brackets
- A bracket is a BROAD sector or topic area, one or two words, such as People, Education, Economy, Finance, AI & Tech, Startups, Climate, Energy, Health, Politics. Each has a description and keywords that characterise it.
- You are shown the full list. Set bracket_id to the id of the CLOSEST bracket for each impact. Pick by what is affected, not by the event: a cyclone's effect on fishing communities is People, its effect on ports is Infrastructure or Transport, its insured losses are Finance, the weather event itself is Climate. Different impacts of one story can go to different brackets.
- Always prefer an existing bracket, even if the fit is only approximate. Create a new bracket (leave bracket_id out and fill new_bracket) ONLY when the impact is clearly outside every listed bracket AND the area is broad enough to recur across many stories (e.g. "Space"). A new bracket's name must be one or two words, a broad area and never an event, person, company or narrow theme. Give it 6-10 lowercase keywords.
- Use only what the story supports plus well-established background. Do not invent facts, figures or quotes. If you only have a headline, say less and score lower.
- A story with no real-world impact (sport result, celebrity news) should return an empty impacts list.

Call the record_impact tool exactly once.`;
}

export function readTool(bcg) {
  return {
    name: "record_impact",
    description: "Record the company-agnostic impact reading for one news story.",
    input_schema: {
      type: "object",
      required: ["event_type", "summary", "geography", "impacts"],
      properties: {
        event_type: { type: "string" },
        summary: { type: "string" },
        geography: { type: "array", items: { type: "string" } },
        impacts: {
          type: "array",
          items: {
            type: "object",
            required: ["group", "area", "direction", "severity", "horizon"],
            properties: {
              group: { type: "string" },
              area: { type: "string", enum: bcg.impact_areas },
              direction: { type: "string", enum: ["negative", "positive", "mixed"] },
              severity: { type: "number" },
              horizon: { type: "string", enum: ["immediate", "near", "long"] },
              note: { type: "string" },
              bracket_id: { type: "string", description: "id of an EXISTING bracket from the list" },
              new_bracket: {
                type: "object",
                description: "Only when no existing bracket fits",
                properties: { name: { type: "string" }, keywords: { type: "array", items: { type: "string" } }, description: { type: "string" } },
              },
            },
          },
        },
      },
    },
  };
}

// Model output is never trusted as-is: unknown ids are dropped, numbers clamped, new brackets de-duplicated by the registry.
export function normalizeReading(raw, bcg, registry) {
  if (!raw || typeof raw !== "object") return null;
  const areas = new Set(bcg.impact_areas);
  const byName = new Map(registry.list().map((b) => [norm(b.name), b.id]));
  const impacts = [];
  for (const i of Array.isArray(raw.impacts) ? raw.impacts : []) {
    if (!i || typeof i.group !== "string" || !areas.has(i.area)) continue;
    let bracket = null;
    if (typeof i.bracket_id === "string" && registry.get(i.bracket_id)) bracket = registry.get(i.bracket_id).id;
    else if (typeof i.bracket_id === "string" && byName.has(norm(i.bracket_id))) bracket = byName.get(norm(i.bracket_id));
    else if (i.new_bracket) bracket = registry.resolve(i.new_bracket);
    impacts.push({
      group: i.group.trim().slice(0, 120), area: i.area,
      direction: ["negative", "positive", "mixed"].includes(i.direction) ? i.direction : "mixed",
      severity: clamp01(i.severity),
      horizon: ["immediate", "near", "long"].includes(i.horizon) ? i.horizon : "near",
      note: str(i.note), bracket,
    });
  }
  for (const b of new Set(impacts.map((i) => i.bracket).filter(Boolean))) registry.touch(b);
  return {
    event_type: str(raw.event_type, 80) || "other",
    summary: str(raw.summary),
    geography: (Array.isArray(raw.geography) ? raw.geography : []).filter((g) => typeof g === "string" && g.trim()).map((g) => g.trim()),
    impacts,
  };
}

const readUser = (c, body, candidates) =>
  `Story (reported by ${c.outlets.length} outlet${c.outlets.length > 1 ? "s" : ""}: ${c.outlets.slice(0, 6).join(", ")})\nHeadline: ${c.title}\n` +
  (c.articles.length > 1 ? `Other headlines for the same story:\n${c.articles.slice(0, 5).map((a) => `- ${a.title}`).join("\n")}\n` : "") +
  (body.text ? `\nArticle text:\n${body.text}` : `\n(Only the headline${c.snippet ? " and snippet" : ""} is available — no article text.)${c.snippet ? `\nSnippet: ${c.snippet}` : ""}`) +
  `\n\nExisting keyword brackets${candidates.length ? " (reuse where they fit)" : ""}:\n` +
  (candidates.length ? candidates.map((b) => `- ${b.id} | ${b.name} | ${b.keywords.slice(0, 6).join(", ")}`).join("\n") : "(none yet — every bracket you use will be new)");

// ---------- Job 1b: keeping the bracket registry free of repeats ----------

export const consolidateSystem = `You maintain a registry of "keyword brackets": reusable impact themes that news stories are filed under. Over time the same theme gets created more than once under different wording.

Find groups of brackets that are really the SAME impact theme and should be one bracket. Merge when a single article on the theme could sensibly be filed under any of them (e.g. "Ethanol blending and biofuel policy" + "Flex-fuel and ethanol vehicle adoption"; "Coaching centre regulation" + "Student mental health crises in coaching hubs" only if you judge them one theme). Do NOT merge brackets that are merely related, nor different angles that warrant separate articles (e.g. "Crude oil price swings" and "Rupee exchange rate movements" stay separate).

For each group give keep_id (the best existing bracket to survive), merge_ids (the others), and optionally a better combined name (at most 8 words). A bracket may appear in at most one group. Return no groups if nothing should be merged. Call the record_merges tool exactly once.`;

export const consolidateTool = {
  name: "record_merges",
  description: "Record groups of duplicate brackets to merge.",
  input_schema: {
    type: "object",
    required: ["groups"],
    properties: {
      groups: {
        type: "array",
        items: {
          type: "object",
          required: ["keep_id", "merge_ids"],
          properties: { keep_id: { type: "string" }, merge_ids: { type: "array", items: { type: "string" } }, name: { type: "string" } },
        },
      },
    },
  },
};

// Only ids that exist, each used once, keeper never also merged away.
export function normalizeMerges(raw, brackets) {
  const ids = new Set(brackets.map((b) => b.id)), used = new Set(), out = [];
  for (const g of Array.isArray(raw?.groups) ? raw.groups : []) {
    if (!g || !ids.has(g.keep_id) || used.has(g.keep_id)) continue;
    const drops = (Array.isArray(g.merge_ids) ? g.merge_ids : []).filter((id) => ids.has(id) && !used.has(id) && id !== g.keep_id);
    if (!drops.length) continue;
    used.add(g.keep_id); drops.forEach((d) => used.add(d));
    out.push({ keep: g.keep_id, drop: [...new Set(drops)], name: str(g.name, 80) });
  }
  return out;
}

// ---------- Job 2: company-sector matching ----------

export function matchSystem(bcg) {
  const fronts = Object.entries(bcg.fronts).map(([k, v]) => `- ${k}: ${v}`).join("\n");
  return `You help a company's content team decide what to publish. You are given the company's sectors and a batch of broad news areas ("keyword brackets", e.g. Economy, Climate, AI & Tech), each with the most significant Indian news stories in that area right now.

For each news area, decide which of the company's sectors it is relevant to. Use the sector names EXACTLY as given, without any description.
- relevance 0-1: how much a senior leader in that sector would care about what is happening in this area right now. Be discriminating: a broad area touches many sectors weakly, so reserve 0.6+ for real, specific exposure and omit sectors below 0.2.
- channel: "direct" if the area is squarely the sector's own industry/topic; "indirect" if it reaches the sector through second-order effects.
- front: how it reaches the sector, one of:
${fronts}
- why: one sentence on the link, grounded in the stories shown and the sector's name/description. Do not invent facts about the company.
- write_about: ONE concrete article angle for THIS sector that builds on what the stories show — a question, framework, comparison or executive decision, not a restatement of the news and specific enough to commission today.

Return every news area in the batch exactly once (with an empty sectors list if nothing is relevant). Call the record_matches tool exactly once.`;
}

export function matchTool(bcg) {
  return {
    name: "record_matches",
    description: "Record, for each theme, which company sectors it is relevant to.",
    input_schema: {
      type: "object",
      required: ["matches"],
      properties: {
        matches: {
          type: "array",
          items: {
            type: "object",
            required: ["bracket_id", "sectors"],
            properties: {
              bracket_id: { type: "string" },
              sectors: {
                type: "array",
                items: {
                  type: "object",
                  required: ["sector", "relevance", "channel", "front", "why", "write_about"],
                  properties: {
                    sector: { type: "string", description: "Sector name only, copied exactly" },
                    relevance: { type: "number" },
                    channel: { type: "string", enum: ["direct", "indirect"] },
                    front: { type: "string", enum: Object.keys(bcg.fronts) },
                    why: { type: "string" },
                    write_about: { type: "string", description: "One article angle for this sector" },
                  },
                },
              },
            },
          },
        },
      },
    },
  };
}

// Returns Map(bracketId -> {sectors, write_about}) for the brackets of this batch the model answered for.
export function normalizeMatches(raw, bcg, company, batch) {
  const out = new Map();
  if (!raw || !Array.isArray(raw.matches)) return out;
  const ids = new Set(batch.map((b) => b.id));
  const sectorByNorm = new Map(company.sectors.map((s) => [norm(s.name), s.name]));
  const byLength = [...sectorByNorm].sort((a, b) => b[0].length - a[0].length);
  // Models often echo "Name (description)" or "Name - description": accept exact names, else the longest
  // sector name the answer starts with. Anything that isn't one of the company's own sectors is still dropped.
  const lookup = (raw) => {
    const n = norm(raw);
    if (sectorByNorm.has(n)) return sectorByNorm.get(n);
    return byLength.find(([k]) => n.startsWith(`${k} `))?.[1];
  };
  const fronts = new Set(Object.keys(bcg.fronts));
  for (const m of raw.matches) {
    if (!m || !ids.has(m.bracket_id) || out.has(m.bracket_id)) continue;
    const seen = new Set(), sectors = [];
    for (const s of Array.isArray(m.sectors) ? m.sectors : []) {
      const name = lookup(String(s?.sector ?? ""));
      const relevance = clamp01(s?.relevance);
      if (!name || seen.has(name) || relevance < 0.2) continue;
      seen.add(name);
      sectors.push({ sector: name, relevance, channel: s.channel === "direct" ? "direct" : "indirect", front: fronts.has(s.front) ? s.front : "demand", why: str(s.why), write_about: str(s.write_about, 500) });
    }
    out.set(m.bracket_id, { sectors });
  }
  return out;
}

// evidence: Map(bracketId -> { storyCount, stories:[{title, summary, outlets}] }) — what is happening in the area now.
const matchUser = (company, batch, evidence) =>
  `Company: ${company.name}\nSectors (the "sector" field of your answer must be the name only, copied exactly, with no description):\n` +
  `${company.sectors.map((s) => `- name: ${s.name}${s.description ? `\n  covers: ${s.description}` : ""}`).join("\n")}\n\nNews areas:\n` +
  batch.map((b) => {
    const ev = evidence?.get(b.id);
    const stories = (ev?.stories ?? []).map((s) => `    - ${s.title}${s.summary ? ` — ${s.summary}` : ""} [${s.outlets} outlet${s.outlets > 1 ? "s" : ""}]`).join("\n");
    return `- id: ${b.id}\n  area: ${b.name}\n  about: ${b.description || "(no description)"}\n  stories in this area now (${ev?.storyCount ?? 0} total, most significant first):\n${stories || "    (none)"}`;
  }).join("\n");

// ---------- shared provider plumbing ----------

export function extractJson(text) {
  const clean = String(text || "").replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/```(?:json)?/gi, "");
  const a = clean.indexOf("{"), b = clean.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(clean.slice(a, b + 1)); } catch { return null; }
}

export class Reader {
  constructor(bcg, registry) {
    this.bcg = bcg; this.registry = registry;
    this.mode = (process.env.HIVEMIND_LLM || "auto").toLowerCase();
    this.apiKey = process.env.ANTHROPIC_API_KEY || "";
    this.model = process.env.HIVEMIND_MODEL || "claude-haiku-5-5";
    this.ollamaHost = (process.env.OLLAMA_HOST || "http://127.0.0.1:11434").replace(/\/$/, "");
    this.ollamaModel = process.env.OLLAMA_MODEL || "";
    this.provider = null;
    this.readSys = readSystem(bcg); this.readTool = readTool(bcg);
    this.matchSys = matchSystem(bcg); this.matchTool = matchTool(bcg);
  }

  get label() { return this.provider === "anthropic" ? this.model : `ollama:${this.ollamaModel}`; }

  async detect() {
    if (this.mode === "anthropic" || (this.mode === "auto" && this.apiKey)) {
      if (!this.apiKey) throw new Error("HIVEMIND_LLM=anthropic but ANTHROPIC_API_KEY is not set");
      this.provider = "anthropic";
      return `anthropic:${this.model}`;
    }
    if (this.mode === "ollama" || this.mode === "auto") {
      try {
        const r = await fetch(`${this.ollamaHost}/api/tags`, { signal: AbortSignal.timeout(2500) });
        const pick = this.ollamaModel || (await r.json()).models?.[0]?.name;
        if (pick) { this.ollamaModel = pick; this.provider = "ollama"; return `ollama:${pick}`; }
      } catch { /* fall through */ }
    }
    throw new Error("No LLM available. Set ANTHROPIC_API_KEY, or start Ollama with a model pulled.");
  }

  async read(cluster, body) {
    const text = `${cluster.title}\n${cluster.articles.map((a) => a.title).join("\n")}\n${body.text || cluster.snippet || ""}`;
    const candidates = this.registry.candidates(text);
    const raw = await this.#call(this.readSys, this.readTool, readUser(cluster, body, candidates), 1800);
    return normalizeReading(raw, this.bcg, this.registry);
  }

  // One pass over (up to) the 400 most-used brackets, listed alphabetically so similar wording sits together.
  async consolidate(brackets) {
    const pool = [...brackets].sort((a, b) => b.count - a.count).slice(0, 400).sort((a, b) => a.name.localeCompare(b.name));
    const list = pool.map((b) => `- ${b.id} | ${b.name} | ${b.keywords.slice(0, 6).join(", ")} | ${b.count} stories`).join("\n");
    const raw = await this.#call(consolidateSystem, consolidateTool, `Brackets:\n${list}`, 4000);
    return normalizeMerges(raw, pool);
  }

  async match(company, batch, evidence) {
    const raw = await this.#call(this.matchSys, this.matchTool, matchUser(company, batch, evidence), 6000);
    return normalizeMatches(raw, this.bcg, company, batch);
  }

  #call(system, tool, user, maxTokens) {
    return this.provider === "anthropic" ? this.#claude(system, tool, user, maxTokens) : this.#ollama(system, tool, user);
  }

  async #claude(system, tool, user, maxTokens) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": this.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({
          model: this.model, max_tokens: maxTokens,
          system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
          tools: [tool], tool_choice: { type: "tool", name: tool.name },
          messages: [{ role: "user", content: user }],
        }),
        signal: AbortSignal.timeout(90000),
      });
      if (res.status === 429 || res.status >= 500) { await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt)); continue; }
      if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return (await res.json()).content?.find((b) => b.type === "tool_use")?.input ?? null;
    }
    throw new Error("Anthropic: retries exhausted");
  }

  async #ollama(system, tool, user) {
    const res = await fetch(`${this.ollamaHost}/api/chat`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.ollamaModel, stream: false, format: "json", options: { temperature: 0.1 },
        messages: [
          { role: "system", content: `${system}\nReturn one JSON object with these properties (JSON-schema fragment): ${JSON.stringify(tool.input_schema.properties)}` },
          { role: "user", content: user },
        ],
      }),
      signal: AbortSignal.timeout(300000),
    });
    if (!res.ok) throw new Error(`Ollama ${res.status}`);
    return extractJson((await res.json()).message?.content);
  }
}
