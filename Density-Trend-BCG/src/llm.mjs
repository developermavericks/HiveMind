// Two LLM jobs, same provider plumbing (Claude with a forced tool call, or local Ollama):
//   read()  — company-agnostic: what happened, who/what is affected, and which keyword bracket each impact belongs to
//   match() — given a company's sectors, how relevant each bracket is, via which front, and what to write about
//
//   HIVEMIND_LLM=auto|anthropic|ollama   HIVEMIND_MODEL=claude-haiku-4-5
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

Beyond the impacts, also record (all optional but encouraged):
- content_type: "reported" (confirmed facts), "opinion" (a columnist's or commentator's view), "analysis" (explainer built on facts) or "unverified" (claims, rumours or allegations not confirmed by an official or primary source).
- topics: 1-2 THEME labels (1-3 lowercase words) naming the recurring subject area this story belongs to: something that will also describe dozens of other stories over the coming weeks, such as "air pollution", "cricket series", "student elections", "port disruption", "fuel prices", "bank earnings", "court rulings". Strongly prefer a label from the list you are shown; create a new one only when none fits. Never describe this one story's details, and never use a person, company, party, place or event name. Give a topic ONLY when the story is mainly about that subject: a story that merely mentions the police, a court, a company or a place is not about "police misconduct", "corporate earnings" or a city. Fewer, accurate labels beat many loose ones. Never use vague filler such as "personal stories", "general news", "human interest", "welfare payouts" or "miscellaneous"; if no specific recurring subject fits, return no topic.
- entities: up to 6 named organisations, places or people central to the story.
- sentiment: the overall tone of the coverage toward its main subject: "positive", "negative", "neutral" or "mixed". stance: "supportive", "critical" or "neutral" toward the main actor, policy or company the story is about.
- pathways: up to 3 causal chains event → direct disruption → affected sector → the business or public question it raises. Mark each "observed" only if the story itself reports the disruption; otherwise "hypothesis". Do not claim a hypothesis as fact.

Call the record_impact tool exactly once.`;
}

const SENTIMENTS = ["positive", "negative", "neutral", "mixed"], STANCES = ["supportive", "critical", "neutral"];
const enrichProps = {
  sentiment: { type: "string", enum: SENTIMENTS },
  stance: { type: "string", enum: STANCES },
  content_type: { type: "string", enum: ["reported", "opinion", "analysis", "unverified"] },
  topics: { type: "array", items: { type: "string" }, description: "1-2 recurring theme labels, 1-3 lowercase words each" },
  entities: { type: "array", items: { type: "string" } },
  pathways: {
    type: "array",
    items: {
      type: "object", required: ["disruption", "sector", "question", "status"],
      properties: { disruption: { type: "string" }, sector: { type: "string" }, question: { type: "string" }, status: { type: "string", enum: ["observed", "hypothesis"] } },
    },
  },
};

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
        ...enrichProps,
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

// Optional labels (content type, topics, entities, pathways) are validated here and kept apart from the impact
// reading, whose shape the caches and charts depend on. `topics` is a TopicRegistry (or null to skip topics).
const CONTENT_TYPES = ["reported", "opinion", "analysis", "unverified"];
export function normalizeEnrichment(raw, topics = null, bracketHint = null) {
  if (!raw || typeof raw !== "object") return null;
  const ids = [];
  if (topics) for (const t of Array.isArray(raw.topics) ? raw.topics : []) { const id = typeof t === "string" ? topics.resolve(t, bracketHint) : null; if (id && !ids.includes(id)) ids.push(id); }
  for (const id of ids.slice(0, 2)) topics.touch(id);
  return {
    contentType: CONTENT_TYPES.includes(raw.content_type) ? raw.content_type : null,
    topics: topics ? ids.slice(0, 2) : null,
    entities: (Array.isArray(raw.entities) ? raw.entities : []).filter((e) => typeof e === "string" && e.trim()).map((e) => e.trim().slice(0, 60)).slice(0, 6),
    sentiment: SENTIMENTS.includes(raw.sentiment) ? raw.sentiment : null, stance: STANCES.includes(raw.stance) ? raw.stance : null,
    pathways: (Array.isArray(raw.pathways) ? raw.pathways : []).filter((p) => p && typeof p.disruption === "string" && typeof p.sector === "string")
      .map((p) => ({ disruption: str(p.disruption, 160), sector: str(p.sector, 80), question: str(p.question, 200), status: p.status === "observed" ? "observed" : "hypothesis" })).slice(0, 3),
  };
}

// ---------- Job 1c: topic labels for stories that were read before topics existed ----------

export const enrichSystem = `You label news stories for an editorial team. You are given a story's headline, a short factual summary and the groups it affects, all already extracted. Record:
- content_type: "reported", "opinion", "analysis" or "unverified" (claims not confirmed by an official or primary source).
- topics: 1-2 THEME labels (1-3 lowercase words) naming the recurring subject area this story belongs to: something that will also describe dozens of other stories over the coming weeks, such as "air pollution", "cricket series", "student elections", "port disruption", "fuel prices", "bank earnings", "court rulings". Strongly prefer a label from the list you are shown; create a new one only when none fits. Never describe this one story's details, and never use a person, company, party, place or event name. Give a topic ONLY when the story is mainly about that subject: a story that merely mentions the police, a court, a company or a place is not about "police misconduct", "corporate earnings" or a city. Fewer, accurate labels beat many loose ones. Never use vague filler such as "personal stories", "general news", "human interest", "welfare payouts" or "miscellaneous"; if no specific recurring subject fits, return no topic.
- entities: up to 6 named organisations, places or people central to the story.
- pathways: up to 3 chains event → direct disruption → affected sector → the question it raises, each "observed" (the story reports it) or "hypothesis". Never present a hypothesis as fact.
Use only what is given. Call the record_labels tool exactly once.`;

export const enrichTool = {
  name: "record_labels",
  description: "Record topic labels and editorial metadata for one story.",
  input_schema: { type: "object", required: ["content_type", "topics"], properties: enrichProps },
};

const enrichUser = (s, topicCands) =>
  `Headline: ${s.title}\nSummary: ${s.analysis.summary || "(none)"}\nEvent type: ${s.analysis.event_type}\nAffected: ${(s.analysis.impacts || []).slice(0, 5).map((i) => i.group).join("; ") || "(none)"}\n\n` +
  `Existing topics (reuse one whenever it fits):\n${topicCands.length ? topicCands.map((t) => `- ${t.name}`).join("\n") : "(none yet)"}`;

// ---------- Job 1d: sentiment and stance for stories read earlier (batched: many stories per call) ----------

export const sentimentSystem = `You label the tone of news coverage. For each numbered story you get a headline, a short factual summary and the groups it affects. Record:
- sentiment: the overall tone toward the story's main subject. "positive" (good news, gains, relief, success), "negative" (harm, loss, risk, failure, conflict), "neutral" (routine facts, no clear valence) or "mixed" (clearly both).
- stance: how the coverage treats the main actor, policy or company: "supportive", "critical" or "neutral".
Judge the coverage, not your own opinion. Use only what is given. Return one entry for EVERY story number, once each. Call the record_sentiment tool exactly once.`;

export const sentimentTool = {
  name: "record_sentiment",
  description: "Record sentiment and stance for each numbered story.",
  input_schema: {
    type: "object", required: ["items"],
    properties: { items: { type: "array", items: { type: "object", required: ["n", "sentiment", "stance"], properties: { n: { type: "integer" }, sentiment: { type: "string", enum: SENTIMENTS }, stance: { type: "string", enum: STANCES } } } } },
  },
};
const sentimentUser = (batch) => batch.map((s, i) => `${i + 1}. ${s.title}\n   ${s.analysis?.summary || "(no summary)"}\n   affects: ${(s.analysis?.impacts || []).slice(0, 4).map((x) => `${x.group} (${x.direction})`).join("; ") || "-"}`).join("\n");
export function normalizeSentiments(raw, batch) {
  const out = [];
  for (const it of Array.isArray(raw?.items) ? raw.items : []) {
    const s = batch[(+it?.n || 0) - 1];
    if (s && SENTIMENTS.includes(it.sentiment) && !out.some((o) => o.key === s.key)) out.push({ key: s.key, sentiment: it.sentiment, stance: STANCES.includes(it.stance) ? it.stance : "neutral" });
  }
  return out;
}

// ---------- Job 1e: merge near-duplicate topics (meaning, not wording) ----------

export const topicMergeSystem = `You maintain a registry of short TOPIC labels used to track recurring news subjects. Some labels name the same subject in different words (e.g. "ev manufacturing" and "electric vehicle production"; "fuel prices" and "petrol diesel rates"). Find groups of labels that mean the SAME recurring subject and should be merged.
Rules:
- Merge ONLY labels that are INTERCHANGEABLE: any news story that fits one label would fit the other equally well, with no loss of meaning. Typical cases are plural/singular, word order, or two wordings of the same thing ("ai jobs impact" / "ai employment"; "misinformation" / "disinformation"; "astrology" / "astrology horoscope").
- Do NOT merge when one label is broader or narrower than the other ("public health" vs "community health", "defence policy" vs "defence technology"), when they describe different aspects of a subject (policy vs technology, awareness vs campaign, safety vs accidents, offers vs advice, crisis vs aid), or when they merely share a word. If you would hesitate, do not merge.
- For each group choose "keep": the clearest, most commonly used wording (the story counts are shown; use the exact id), and list the other ids in "drop".
- A label may appear in at most one group. Labels with no interchangeable twin must not be listed. Most lists should produce few or no merges.
- Call the merge_topics tool exactly once; an empty list is fine.`;

export const topicMergeTool = {
  name: "merge_topics",
  description: "Groups of topic labels that mean the same thing.",
  input_schema: {
    type: "object", required: ["merges"],
    properties: { merges: { type: "array", items: { type: "object", required: ["keep", "drop"], properties: { keep: { type: "string" }, drop: { type: "array", items: { type: "string" } }, name: { type: "string", description: "optional clearer name for the kept topic, 1-3 lowercase words" } } } } },
  },
};
export function normalizeTopicMerges(raw, pool) {
  const ids = new Set(pool.map((t) => t.id)), used = new Set(), out = [];
  for (const m of Array.isArray(raw?.merges) ? raw.merges : []) {
    if (!ids.has(m?.keep) || used.has(m.keep)) continue;
    const drop = [...new Set((Array.isArray(m.drop) ? m.drop : []).filter((d) => ids.has(d) && d !== m.keep && !used.has(d)))];
    if (!drop.length) continue;
    used.add(m.keep); drop.forEach((d) => used.add(d));
    const name = typeof m.name === "string" ? m.name.replace(/[^\p{L}\p{N}\s&/-]/gu, " ").replace(/\s+/g, " ").trim().toLowerCase() : "";
    out.push({ keep: m.keep, drop, name: name && name.split(" ").length <= 4 ? name : null });
  }
  return out;
}

// A second, strict opinion on every proposed merge: a merge is applied only if this reviewer also calls the pair interchangeable.
export const mergeVerifySystem = `You review proposed merges between news topic labels. For each numbered pair "A <-> B", answer true when the two labels name the SAME recurring subject in different words (synonyms, plural/singular, reordered or reworded, e.g. "ai employment" / "ai jobs impact", "misinformation" / "disinformation", "astrology" / "astrology horoscope", "banking regulation" / "bank regulation"), so a reader following one would want the other's stories too. Answer false when one covers a clearly wider or narrower scope ("public health" vs "community health"), a different aspect (policy vs technology, awareness vs campaign, safety vs accidents), a different sector or industry (edtech vs fintech), or they only share a word. Call the verify_merges tool exactly once, with an entry for every number.`;
export const mergeVerifyTool = {
  name: "verify_merges",
  description: "For each numbered pair, whether the labels are fully interchangeable.",
  input_schema: { type: "object", required: ["items"], properties: { items: { type: "array", items: { type: "object", required: ["n", "interchangeable"], properties: { n: { type: "integer" }, interchangeable: { type: "boolean" } } } } } },
};

// ---------- Job 1f: second opinion on a reading (a stronger model checks the first one) ----------

export const reviewSystem = `You are a second reviewer of an AI reading of Indian news stories. For each numbered item you get the headline (and snippet if any) and the first reader's record: summary, who it affects (area, direction, severity 0-1), sentiment and topics. Judge ONLY against what the headline and snippet support: do not use outside knowledge to add facts.
Answer agrees=true when the record is a fair reading of the headline: the summary is accurate, the main affected groups and directions are reasonable, severity is not wildly off, and the sentiment fits. Answer agrees=false when it invents facts, misses the main subject, gets a direction or sentiment clearly wrong, or overstates severity. Add a short note (under 20 words) only when agrees=false. Call the record_review tool exactly once with an entry for every number.`;
export const reviewTool = {
  name: "record_review",
  description: "For each numbered reading, whether it is a fair reading.",
  input_schema: { type: "object", required: ["items"], properties: { items: { type: "array", items: { type: "object", required: ["n", "agrees"], properties: { n: { type: "integer" }, agrees: { type: "boolean" }, note: { type: "string" } } } } } },
};
const reviewUser = (batch) => batch.map((s, i) => `${i + 1}. Headline: ${s.title}\n   Snippet: ${s.snippet || "(none)"}\n   Record: ${s.analysis?.summary || "(none)"}\n   Affects: ${(s.analysis?.impacts || []).slice(0, 4).map((x) => `${x.group} [${x.area}, ${x.direction}, severity ${x.severity}]`).join("; ") || "-"}\n   Sentiment: ${s.sentiment || "-"} / ${s.stance || "-"}; topics: ${(s.topics || []).join(", ") || "-"}`).join("\n");

export const entityMergeSystem = `You maintain a list of named entities (organisations, people, places) found in Indian news. Some entries are the SAME real-world entity written differently (e.g. "Tata Motors" and "Tata Motors Passenger Vehicles"; "Reserve Bank of India" and "RBI"; "PM Modi" and "Narendra Modi"). Find groups of entries that are the same entity. Do NOT merge a parent company with a subsidiary that is reported separately, different people who share a surname, or places at different levels (a city and its state). For each group choose "keep": the clearest full name (use the exact id given) and list the others in "drop". An entry may be in only one group. Be conservative: when unsure do not merge. Call the merge_topics tool exactly once; an empty list is fine.`;

// ---------- Job 1g: does this headline really belong to the topic it was filed under? ----------

export const topicFitSystem = `You check topic labels on news headlines. You are given a topic and numbered headlines that were filed under it. Answer fits=true ONLY if the story is mainly about that subject. Mentioning a related word, institution or place is not enough (for example a crime investigated by the police, a police arrest or a police-led operation is NOT "police misconduct"; a court mentioned in passing is not "court rulings"). When fits=false give a very short reason (under 8 words); for fits=true give none. Call the judge_fit tool once, with an entry for every number.`;
export const topicFitTool = {
  name: "judge_fit",
  description: "Whether each numbered headline is mainly about the topic.",
  input_schema: { type: "object", required: ["items"], properties: { items: { type: "array", items: { type: "object", required: ["n", "fits"], properties: { n: { type: "integer" }, fits: { type: "boolean" }, why: { type: "string" } } } } } },
};

// ---------- Job 3: drafting an author brief (editor approves before anything is used) ----------

export const briefSystem = `You draft a short editorial brief for an editor to review. You are given an opportunity (a company sector paired with a news topic, and a suggested angle), the news stories behind it, and optionally an author's own profile.

Rules:
- "confirmed_facts" may contain ONLY statements the supplied stories support, each with the source_url of the story that supports it, copied exactly. Anything else belongs in "assumptions".
- Never invent the author's experience, quotes, business exposure, research, figures or predictions. Use only the author fields supplied; whatever the author would need to add or check goes in "evidence_needed".
- Do not say prices will rise, firms will close or any outcome will occur unless a supplied story says so. Phrase consequences as questions or conditions.
- The headline and core argument must be specific and useful to the stated audience, not a restatement of the news.
- "reason_now" explains why this is worth writing in the stated window, using the supplied momentum and trigger facts.
- "review_condition" states what development would make the angle outdated or wrong.
Call the draft_brief tool exactly once.`;

export const briefTool = {
  name: "draft_brief",
  description: "Draft an author brief for editor review.",
  input_schema: {
    type: "object",
    required: ["headline", "core_argument", "audience", "reason_now", "confirmed_facts", "assumptions", "evidence_needed", "publication_window", "review_condition"],
    properties: {
      headline: { type: "string" }, core_argument: { type: "string" }, audience: { type: "string" }, reason_now: { type: "string" },
      confirmed_facts: { type: "array", items: { type: "object", required: ["fact", "source_url"], properties: { fact: { type: "string" }, source_url: { type: "string" } } } },
      assumptions: { type: "array", items: { type: "string" } }, evidence_needed: { type: "array", items: { type: "string" } },
      publication_window: { type: "string" }, review_condition: { type: "string" },
    },
  },
};

// Facts must cite a supplied story; anything uncited is demoted to an assumption so it can't pass as confirmed.
export function normalizeBrief(raw, allowedUrls, fallback = {}) {
  if (!raw || typeof raw !== "object" || typeof raw.headline !== "string") return null;
  const allowed = new Set(allowedUrls), facts = [], assumptions = (Array.isArray(raw.assumptions) ? raw.assumptions : []).map((a) => str(a, 300)).filter(Boolean);
  for (const f of Array.isArray(raw.confirmed_facts) ? raw.confirmed_facts : []) {
    const fact = str(f?.fact, 300);
    if (!fact) continue;
    if (allowed.has(f?.source_url)) facts.push({ fact, source_url: f.source_url });
    else assumptions.push(`Not source-backed: ${fact}`);
  }
  return {
    headline: str(raw.headline, 200), core_argument: str(raw.core_argument, 700), audience: str(raw.audience, 200) || fallback.audience || "",
    reason_now: str(raw.reason_now, 500), confirmed_facts: facts, assumptions: assumptions.slice(0, 8),
    evidence_needed: (Array.isArray(raw.evidence_needed) ? raw.evidence_needed : []).map((a) => str(a, 300)).filter(Boolean).slice(0, 8),
    publication_window: str(raw.publication_window, 120) || fallback.window || "", review_condition: str(raw.review_condition, 400) || fallback.review || "",
    source_links: [...new Set([...facts.map((f) => f.source_url), ...allowedUrls])].slice(0, 8),
  };
}

const briefUser = ({ opp, stories, author }) =>
  `Opportunity\nSector: ${opp.sector}\nTopic: ${opp.label.name}${opp.label.parentName ? ` (within ${opp.label.parentName})` : ""}\nSuggested angle: ${opp.angle || "(none)"}\nWhy the topic matters to the sector: ${opp.why || "(none)"}\n` +
  `Signals: coverage share ${(opp.metrics.share * 100).toFixed(1)}%, momentum ${opp.metrics.ratio == null ? "n/a" : "×" + opp.metrics.ratio.toFixed(2)}, stage ${opp.stage}, ${opp.metrics.originsRecent} independent origins, evidence ${opp.evidence.level}.\n` +
  `Recommended window: ${opp.window.label}\nTrigger: ${opp.trigger ? `${opp.trigger.title} (${opp.trigger.reason})` : "none verified"}\n\n` +
  `Stories (the only source of confirmed facts):\n${stories.map((s, i) => `${i + 1}. ${s.title}\n   url: ${s.url}\n   summary: ${s.summary || "(none)"}\n   reported by ${s.outlets} outlet(s), ${s.origins} independent origin(s); ${s.fullText ? "read from full text" : "headline only"}`).join("\n")}\n\n` +
  (author ? `Author profile (use only these fields):\nName: ${author.name}\nExpertise: ${(author.expertise || []).join(", ") || "(not given)"}\nSectors: ${(author.sectors || []).join(", ") || "(not given)"}\nAudience: ${author.audience || "(not given)"}\nGeography: ${(author.geography || []).join(", ") || "(not given)"}\nCan contribute: ${(author.evidence || []).join("; ") || "(nothing stated)"}\n` : "No author selected: write for a general expert author and list what any author must add.");

const readUser = (c, body, candidates, topicCands = []) =>
  `Story (reported by ${c.outlets.length} outlet${c.outlets.length > 1 ? "s" : ""}: ${c.outlets.slice(0, 6).join(", ")})\nHeadline: ${c.title}\n` +
  (c.articles.length > 1 ? `Other headlines for the same story:\n${c.articles.slice(0, 5).map((a) => `- ${a.title}`).join("\n")}\n` : "") +
  (body.text ? `\nArticle text:\n${body.text}` : `\n(Only the headline${c.snippet ? " and snippet" : ""} is available — no article text.)${c.snippet ? `\nSnippet: ${c.snippet}` : ""}`) +
  `\n\nExisting keyword brackets${candidates.length ? " (reuse where they fit)" : ""}:\n` +
  (candidates.length ? candidates.map((b) => `- ${b.id} | ${b.name} | ${b.keywords.slice(0, 6).join(", ")}`).join("\n") : "(none yet — every bracket you use will be new)") +
  `\n\nExisting topic labels (reuse where they fit):\n${topicCands.length ? topicCands.map((t) => `- ${t.name}`).join("\n") : "(none yet)"}`;

// The story-specific part of a reading request. Brackets, topic labels and examples are in the cached context (Reader.staticContext).
const readUserLean = (c, body, extraTopics = []) =>
  `Story (reported by ${c.outlets.length} outlet${c.outlets.length > 1 ? "s" : ""}: ${c.outlets.slice(0, 6).join(", ")})\nHeadline: ${c.title}\n` +
  (c.articles.length > 1 ? `Other headlines for the same story:\n${c.articles.slice(0, 5).map((a) => `- ${a.title}`).join("\n")}\n` : "") +
  (body.text ? `\nArticle text:\n${body.text}` : `\n(Only the headline${c.snippet ? " and snippet" : ""} is available — no article text.)${c.snippet ? `\nSnippet: ${c.snippet}` : ""}`) +
  (extraTopics.length ? `\n\nOther existing topic labels that may fit:\n${extraTopics.map((t) => `- ${t.name}`).join("\n")}` : "");

const READ_EXAMPLES = `Examples of good readings (judgement and format only; do not copy their wording):
1. Headline: "RBI keeps repo rate unchanged, signals cautious stance on inflation". event_type: monetary policy decision. One impact: bank borrowers and savers, area economy, direction mixed, severity 0.4, horizon near, bracket Finance. topics: ["interest rates"]. sentiment neutral, stance neutral, content_type reported.
2. Headline: "Heavy rain floods low-lying Chennai areas, schools shut for a second day". event_type: extreme weather. Impacts: urban residents and commuters, area people, direction negative, severity 0.5, horizon immediate; small shops in flooded areas, area economy, negative, 0.3, immediate. topics: ["urban flooding"]. sentiment negative, stance neutral.
3. Headline: "Kohli scores 70 as India win third ODI". A sport result with no real-world impact: return an EMPTY impacts list. topics: ["cricket results"]. sentiment positive, stance neutral.
4. Headline: "Police inspector suspended after man dies in custody, family alleges torture". event_type: custodial death. Impacts: the victim's family and local residents, area people, direction negative, severity 0.7, horizon near, bracket Justice; public trust in the police force, area governance, negative, 0.5, near. topics: ["police misconduct"] (the story is about officers accused of wrongdoing). sentiment negative, stance critical, content_type reported.
5. Headline: "Police arrest two men for stealing two-wheelers in Pune". A routine crime and arrest: the police are doing their job, so this is NOT "police misconduct". Little real-world impact beyond local crime: one small impact (local residents, area people, negative, 0.2, immediate) or none. topics: ["crime reports"]. sentiment negative, stance neutral.
6. Headline: "Tata Motors, Amazon to deploy 3,000 electric trucks for logistics". event_type: corporate partnership. Impacts: commercial vehicle makers and logistics operators, area economy, direction positive, severity 0.4, horizon near, bracket Transport; urban air quality, area people, positive, 0.2, long. topics: ["ev manufacturing"]. sentiment positive, stance supportive.

Topic discipline: give a topic only when the story is MAINLY about that subject. Mentioning the police, a court, a company, a minister or a city does not make a story about police misconduct, court rulings, corporate earnings or a place. When no common label fits, create a short new theme label (1-3 lowercase words) rather than forcing a loose one. Sentiment is the tone of the coverage toward its main subject; stance is how the coverage treats the main actor, policy or company.`;

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

// Providers are tried in order: Claude first (unless switched off or set as secondary), then the local Ollama model
// when it is installed, running and allowed as a fallback. A provider that fails hard (bad key, no credit) is skipped
// for ten minutes so a dead key doesn't slow every call; transient failures cool down for one minute.
//   opts.settings()      -> { primary: "anthropic"|"ollama", fallback: boolean, ollamaModel, ollamaHost }   (per-machine)
//   opts.integrations    -> Integrations (is Claude switched on?)
//   opts.onEvent(name, { ok, error })  -> usage and credit tracking
const FATAL = /\b(401|402|403)\b|credit|billing|api key|authentication|permission/i;

// Groq rejects a whole answer when one value is outside an enum. Our own validators already drop or default bad values, so for Groq the
// enums are turned into plain strings with the allowed values spelled out in the description.
export function relaxEnums(sch) {
  if (Array.isArray(sch)) return sch.map(relaxEnums);
  if (!sch || typeof sch !== "object") return sch;
  const o = {};
  for (const [k, v] of Object.entries(sch)) o[k] = relaxEnums(v);
  if (Array.isArray(o.enum)) { o.description = (o.description ? o.description + " " : "") + "One of: " + o.enum.join(", ") + "."; delete o.enum; }
  return o;
}

export class Reader {
  constructor(bcg, registry, topics = null, opts = {}) {
    this.bcg = bcg; this.registry = registry; this.topics = topics; this.opts = opts;
    this.model = process.env.HIVEMIND_MODEL || "claude-haiku-4-5";
    this.ollamaHost = (process.env.OLLAMA_HOST || "http://127.0.0.1:11434").replace(/\/$/, "");
    this.ollamaModel = process.env.OLLAMA_MODEL || "";
    this.apiKey = process.env.ANTHROPIC_API_KEY || "";
    this.groqKey = ""; this.groqModel = process.env.GROQ_MODEL || "openai/gpt-oss-120b"; this.groqOk = false;
    this.provider = null; this.chain = []; this.down = {}; this.lastOk = {};
    this.readSys = readSystem(bcg); this.readTool = readTool(bcg);
    // Several stories per call: the shared instructions and context are sent (and cached) once, not once per story.
    this.readBatchSys = this.readSys.replace("Call the record_impact tool exactly once.", "You are given several numbered stories at once. Treat each one independently and never mix details between stories. Give every story the same completeness you would if it were the only story: list every distinct group affected, up to 6 entities, and the topic labels and pathways that apply. Do not shorten answers because there are several stories. Call the record_impacts tool exactly once, with one entry per story (n = the story's number).");
    this.readBatchTool = { name: "record_impacts", description: "Record the impact reading for each numbered news story.", input_schema: { type: "object", required: ["stories"], properties: { stories: { type: "array", items: { type: "object", required: ["n", "event_type", "summary", "geography", "impacts"], properties: { n: { type: "integer" }, ...this.readTool.input_schema.properties } } } } } };
    this.matchSys = matchSystem(bcg); this.matchTool = matchTool(bcg);
  }

  get label() { return this.provider === "anthropic" ? this.model : this.provider ? "ollama:" + this.ollamaModel : ""; }
  get fallbackActive() { return this.chain.length > 1 && this.provider !== this.chain[0]; }

  // Works out which providers can be used right now. Safe to call again after a key, toggle or setting changes.
  async detect() {
    const mode = (process.env.HIVEMIND_LLM || "auto").toLowerCase();
    if (mode === "off") throw new Error("LLM disabled (HIVEMIND_LLM=off)");
    const s = this.opts.settings?.() ?? {};
    this.apiKey = process.env.ANTHROPIC_API_KEY || "";
    if (s.ollamaHost) this.ollamaHost = s.ollamaHost.replace(/\/$/, "");
    const claudeSwitch = this.opts.integrations ? this.opts.integrations.enabled("anthropic") : true;
    const ollamaSwitch = this.opts.integrations ? this.opts.integrations.enabled("ollama") : true;
    if (mode === "anthropic" && !this.apiKey) throw new Error("HIVEMIND_LLM=anthropic but ANTHROPIC_API_KEY is not set");
    const primary = mode === "ollama" ? "ollama" : s.primary || "anthropic";
    const claudeOk = mode !== "ollama" && !!this.apiKey && claudeSwitch;
    const wantOllama = ollamaSwitch && (mode === "ollama" || mode === "auto" || primary === "ollama" || s.fallback !== false);
    let ollamaOk = false;
    if (wantOllama) {
      try {
        const r = await fetch(this.ollamaHost + "/api/tags", { signal: AbortSignal.timeout(2500) });
        const names = ((await r.json()).models ?? []).map((m) => m.name);
        const pick = [s.ollamaModel, process.env.OLLAMA_MODEL].find((m) => m && names.includes(m)) || names[0];
        if (pick) { this.ollamaModel = pick; ollamaOk = true; }
      } catch { /* not installed or not running */ }
    }
    this.groqKey = process.env.GROQ_API_KEY || "";
    this.groqModel = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
    this.groqOk = !!this.groqKey && (this.opts.integrations ? this.opts.integrations.enabled("groq") : true);
    const chain = [];
    if (claudeOk) chain.push("anthropic");
    if (ollamaOk) chain.push("ollama");
    if (primary === "ollama") chain.reverse();
    this.chain = chain; this.down = {};
    this.provider = chain[0] ?? null;
    if (!chain.length) {
      throw new Error(!claudeSwitch && !ollamaOk ? "Claude is switched off and no local model is available." : "No LLM available. Add an Anthropic key, or install Ollama and pull a model.");
    }
    return chain.map((p) => (p === "anthropic" ? "anthropic:" + this.model : "ollama:" + this.ollamaModel)).join(" → ");
  }

  async read(cluster, body) { return (await this.readFull(cluster, body))?.analysis ?? null; }

  // The impact reading plus the optional editorial labels (topics, content type, entities, pathways).
  // opts.skipTopics: keep the story's existing topic labels (a re-read of the same story must not coin or count labels).
  async readFull(cluster, body, opts = {}) {
    const text = cluster.title + "\n" + cluster.articles.map((a) => a.title).join("\n") + "\n" + (body.text || cluster.snippet || "");
    const ctx = this.staticContext();
    const raw = await this.#call(this.readSys, this.readTool, readUserLean(cluster, body, this.extraTopics(text, ctx)), 2400, { context: ctx.text, prefer: body.text ? this.routeFor("readFullText") : this.routeFor("readHeadlines") });
    return this.#finishReading(raw, opts.skipTopics);
  }
  #finishReading(raw, skipTopics = false) {
    const analysis = normalizeReading(raw, this.bcg, this.registry);
    if (!analysis) return null;
    return { analysis, enrichment: normalizeEnrichment(raw, skipTopics ? null : this.topics, analysis.impacts.find((i) => i.bracket)?.bracket ?? null) };
  }

  // The part of the reading prompt that is the same for every story: the bracket list, the most-used topic labels and a few worked
  // examples. It goes in a cached block, so after the first call it is billed at a fraction. Rebuilt only when the lists change.
  staticContext() {
    const brackets = [...this.registry.list()].sort((a, b) => a.id.localeCompare(b.id));
    const tops = this.topics ? [...this.topics.asMap().values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, 260) : [];
    const key = brackets.map((b) => b.id).join(",") + "|" + tops.map((t) => t.id).join(",");
    if (this._ctx?.key !== key) {
      this._ctx = { key, topIds: new Set(tops.map((t) => t.id)), text:
        `Existing keyword brackets (reuse where they fit):\n${brackets.map((b) => `- ${b.id} | ${b.name} | ${b.keywords.slice(0, 6).join(", ")}`).join("\n")}` +
        `\n\nCommon topic labels (reuse where they fit; a few more may be suggested with each story):\n${tops.length ? tops.map((t) => `- ${t.name}`).join("\n") : "(none yet)"}` + `\n\n${READ_EXAMPLES}` };
    }
    return this._ctx;
  }
  // Up to 12 topic labels especially close to this text that are not already in the cached list.
  extraTopics(text, ctx = this.staticContext()) {
    return this.topics ? this.topics.candidates(text, 30).filter((t) => !ctx.topIds.has(t.id)).slice(0, 12) : [];
  }

  // Several headlines in one call. Returns an array aligned with `clusters` (null where the model skipped a story, so the caller
  // can read that one on its own). Used for headline-only reading, where each story is short and the shared context dominates the cost.
  async readBatch(clusters) {
    const ctx = this.staticContext();
    const text = clusters.map((c) => c.title + " " + (c.snippet || "")).join(" ");
    const user = clusters.map((c, i) => `Story ${i + 1} (reported by ${c.outlets.length} outlet${c.outlets.length > 1 ? "s" : ""}: ${c.outlets.slice(0, 6).join(", ")})\nHeadline: ${c.title}\n` +
      (c.articles.length > 1 ? `Other headlines for the same story:\n${c.articles.slice(0, 4).map((a) => `- ${a.title}`).join("\n")}\n` : "") + (c.snippet ? `Snippet: ${c.snippet}\n` : "(Headline only.)\n")).join("\n");
    const extra = this.extraTopics(text, ctx);
    const raw = await this.#call(this.readBatchSys, this.readBatchTool, user + (extra.length ? `\nOther existing topic labels that may fit:\n${extra.map((t) => `- ${t.name}`).join("\n")}` : ""), 600 + clusters.length * 1100, { context: ctx.text, prefer: this.routeFor("readHeadlines") });
    const out = new Array(clusters.length).fill(null);
    for (const it of Array.isArray(raw?.stories) ? raw.stories : []) {
      const k = (+it?.n || 0) - 1;
      if (k >= 0 && k < clusters.length && !out[k]) out[k] = this.#finishReading(it);
    }
    return out;
  }

  // Topic labels for a story that was read before topics existed. Never re-reads or changes the impact reading.
  async enrich(story) {
    const text = story.title + " " + story.analysis.summary;
    const raw = await this.#call(enrichSystem, enrichTool, enrichUser(story, this.topics ? this.topics.candidates(text) : []), 900);
    return normalizeEnrichment(raw, this.topics, story.analysis.impacts.find((i) => i.bracket)?.bracket ?? null);
  }

  // Sentiment and stance for a batch of already-read stories (one call, no re-reading).
  async sentiments(batch) {
    const raw = await this.#call(sentimentSystem, sentimentTool, sentimentUser(batch), 150 + batch.length * 40, { prefer: this.routeFor("sentiment") });
    return normalizeSentiments(raw, batch);
  }

  // Groups of topics (one broad bracket at a time, or the top topics overall) that name the same subject.
  async mergeTopics(pool) {
    const list = pool.map((t) => "- " + t.id + " | " + t.name + " | " + t.count + " stories").join("\n");
    const raw = await this.#call(topicMergeSystem, topicMergeTool, "Topics:\n" + list, 3000);
    return normalizeTopicMerges(raw, pool);
  }

  // A stronger model's opinion on a batch of readings. batch: [{title, snippet, analysis, sentiment, stance, topics}]. Returns [{ n, agrees, note }].
  async reviewReadings(batch, model) {
    const raw = await this.#call(reviewSystem, reviewTool, reviewUser(batch), 200 + batch.length * 60, { model, only: "anthropic" });
    return (Array.isArray(raw?.items) ? raw.items : []).filter((x) => Number.isInteger(+x?.n) && +x.n >= 1 && +x.n <= batch.length && typeof x.agrees === "boolean").map((x) => ({ n: +x.n, agrees: x.agrees, note: str(x.note, 200) }));
  }

  // headlines: [{ key, title }] filed under `topic` (name, optional aliases). Returns [{ key, fits, why }] for those the model answered.
  async verifyTopicFit(topic, aliases, headlines) {
    const user = `Topic: "${topic}"${aliases?.length ? ` (also called: ${aliases.slice(0, 5).join("; ")})` : ""}\nHeadlines:\n${headlines.map((h, i) => `${i + 1}. ${h.title}`).join("\n")}`;
    const raw = await this.#call(topicFitSystem, topicFitTool, user, 200 + headlines.length * 24, { prefer: this.routeFor("topicFit") });
    return (Array.isArray(raw?.items) ? raw.items : []).filter((x) => Number.isInteger(+x?.n) && +x.n >= 1 && +x.n <= headlines.length && typeof x.fits === "boolean")
      .map((x) => ({ key: headlines[+x.n - 1].key, fits: x.fits, why: str(x.why, 80) }));
  }

  async mergeEntities(pool) {
    const list = pool.map((t) => "- " + t.id + " | " + t.name + " | " + t.count + " stories").join("\n");
    const raw = await this.#call(entityMergeSystem, topicMergeTool, "Entities:\n" + list, 3000);
    return normalizeTopicMerges(raw, pool);
  }

  // pairs: [{a, b}] of topic names. Returns a Set of the (1-based) pair numbers the reviewer accepts.
  async verifyMerges(pairs) {
    const raw = await this.#call(mergeVerifySystem, mergeVerifyTool, pairs.map((p, i) => `${i + 1}. "${p.a}" <-> "${p.b}"`).join("\n"), 200 + pairs.length * 20);
    return new Set((Array.isArray(raw?.items) ? raw.items : []).filter((x) => x?.interchangeable === true).map((x) => +x.n));
  }

  async brief(input) {
    const raw = await this.#call(briefSystem, briefTool, briefUser(input), 1800);
    return normalizeBrief(raw, input.stories.map((s) => s.url), { audience: input.author?.audience, window: input.opp.window.label, review: input.opp.review });
  }

  // One pass over (up to) the 400 most-used brackets, listed alphabetically so similar wording sits together.
  async consolidate(brackets) {
    const pool = [...brackets].sort((a, b) => b.count - a.count).slice(0, 400).sort((a, b) => a.name.localeCompare(b.name));
    const list = pool.map((b) => "- " + b.id + " | " + b.name + " | " + b.keywords.slice(0, 6).join(", ") + " | " + b.count + " stories").join("\n");
    const raw = await this.#call(consolidateSystem, consolidateTool, "Brackets:\n" + list, 4000);
    return normalizeMerges(raw, pool);
  }

  async match(company, batch, evidence) {
    const raw = await this.#call(this.matchSys, this.matchTool, matchUser(company, batch, evidence), 6000);
    return normalizeMatches(raw, this.bcg, company, batch);
  }

  #event(name, ev) {
    if (!this.opts.onEvent) return;
    const now = Date.now();
    if (ev.ok && now - (this.lastOk[name] ?? 0) < 30000) return; // successes are recorded at most every 30 s
    if (ev.ok) this.lastOk[name] = now;
    try { this.opts.onEvent(name, ev); } catch { /* usage tracking must never break a reading */ }
  }

  // Jobs routed to the cheap provider (config routing.<job> = "groq") try it first and fall back to the normal chain if it fails.
  routeFor(job) { return this.groqOk && (this.opts.routing?.[job] ?? "claude") === "groq" ? "groq" : null; }

  async #groq(system, tool, user, maxTokens, context = null) {
    const body = {
      model: this.groqModel, max_completion_tokens: maxTokens + 2500, reasoning_effort: "low", temperature: 0.1,
      messages: [{ role: "system", content: context ? system + "\n\n" + context : system }, { role: "user", content: user }],
      tools: [{ type: "function", function: { name: tool.name, description: tool.description, parameters: relaxEnums(tool.input_schema) } }],
      tool_choice: { type: "function", function: { name: tool.name } },
    };
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer " + this.groqKey, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(90000) });
      if (res.status === 429 || res.status >= 500) { const ra = +res.headers.get("retry-after") || 0; await new Promise((r) => setTimeout(r, Math.max(1500 * 2 ** attempt, ra * 1000))); continue; }
      if (!res.ok) throw new Error("Groq " + res.status + ": " + (await res.text()).slice(0, 200));
      const j = await res.json();
      try { this.opts.onUsage?.("groq", { tokensIn: j.usage?.prompt_tokens ?? 0, tokensOut: j.usage?.completion_tokens ?? 0 }); } catch { /* ignore */ }
      const m = j.choices?.[0]?.message, args = m?.tool_calls?.[0]?.function?.arguments;
      if (args) { try { return JSON.parse(args); } catch { /* fall through to the text answer */ } }
      return extractJson(m?.content);
    }
    throw new Error("Groq: retries exhausted (rate limited or overloaded)");
  }

  async #call(system, tool, user, maxTokens, opts = {}) {
    const now = Date.now();
    if (opts.prefer === "groq" && this.groqOk && (this.down.groq ?? 0) <= now) {
      try {
        const out = await this.#groq(system, tool, user, maxTokens, opts.context);
        if (out) { delete this.down.groq; this.#event("groq", { ok: true }); return out; }
        throw new Error("Groq returned no usable answer");
      } catch (e) {
        this.#event("groq", { ok: false, error: e.message });
        try { this.opts.onUsage?.("groq", { calls: 0, errors: 1 }); } catch { /* ignore */ }
        this.down.groq = Date.now() + (FATAL.test(e.message) ? 600000 : 30000); // then the normal chain answers this call
      }
    }
    let order = this.chain.filter((p) => (this.down[p] ?? 0) <= now && (!opts.only || p === opts.only));
    if (opts.only && !this.chain.includes(opts.only)) throw new Error(`${opts.only} is not available for this request`);
    if (!order.length) order = opts.only ? this.chain.filter((p) => p === opts.only) : this.chain; // everything is cooling down: try anyway rather than fail outright
    let last;
    for (const p of order) {
      try {
        const out = p === "anthropic" ? await this.#claude(system, tool, user, maxTokens, opts.model, opts.context) : await this.#ollama(opts.context ? system + "\n\n" + opts.context : system, tool, user);
        this.provider = p; delete this.down[p]; this.#event(p, { ok: true });
        if (p === "ollama") { try { this.opts.onUsage?.("ollama", { tokensIn: 0, tokensOut: 0 }); } catch { /* ignore */ } }
        return out;
      } catch (e) {
        last = e; this.#event(p, { ok: false, error: e.message });
        try { this.opts.onUsage?.(p, { calls: 0, errors: 1 }); } catch { /* ignore */ }
        this.down[p] = Date.now() + (FATAL.test(e.message) ? 600000 : 60000);
        if (order.length === 1) throw e;
      }
    }
    throw last ?? new Error("No LLM provider available");
  }

  // The request body for one message (shared by live calls and the discounted batch service). The shared context, when given, is a
  // cached system block: it is billed in full once and at a fraction on later calls within the cache window.
  #body(system, tool, user, maxTokens, model = null, context = null) {
    return {
      model: model || this.model, max_tokens: maxTokens,
      system: context ? [{ type: "text", text: system }, { type: "text", text: context, cache_control: { type: "ephemeral" } }] : [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      tools: [tool], tool_choice: model && model !== this.model ? { type: "auto" } : { type: "tool", name: tool.name }, // a different (stronger) model may not allow a forced tool; it is told to call it
      messages: [{ role: "user", content: user }],
    };
  }
  #usage(j, batch = false) {
    const u = j?.usage ?? {}, read = u.cache_read_input_tokens ?? 0, write = u.cache_creation_input_tokens ?? 0;
    try { this.opts.onUsage?.("anthropic", { tokensIn: (u.input_tokens ?? 0) + write + read, tokensOut: u.output_tokens ?? 0, cacheRead: read, batchTokens: batch ? (u.input_tokens ?? 0) + write + read + (u.output_tokens ?? 0) : 0, calls: batch ? 0 : 1 }); } catch { /* usage tracking must never break a reading */ }
  }

  // Non-urgent work (backlogs, weekly jobs) can use the batch service: about half price, results within hours. items: [{ id, system, tool,
  // user, maxTokens, context }] -> Map(id -> tool input | null). Throws if the batch cannot be created or does not finish in time.
  async batchMessages(items, { pollMs = 20000, maxWaitMs = 3 * 3600e3, onProgress = null } = {}) {
    if (!this.chain.includes("anthropic")) throw new Error("The batch service needs Claude");
    const hdr = { "x-api-key": this.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" };
    const create = await fetch("https://api.anthropic.com/v1/messages/batches", { method: "POST", headers: hdr, signal: AbortSignal.timeout(60000),
      body: JSON.stringify({ requests: items.map((it) => ({ custom_id: String(it.id), params: this.#body(it.system, it.tool, it.user, it.maxTokens, null, it.context) })) }) });
    if (!create.ok) throw new Error("Batch create " + create.status + ": " + (await create.text()).slice(0, 200));
    const job = await create.json(), t0 = Date.now();
    let st = job;
    while (st.processing_status !== "ended") {
      if (Date.now() - t0 > maxWaitMs) throw new Error("Batch did not finish in time");
      await new Promise((r) => setTimeout(r, pollMs));
      const r = await fetch("https://api.anthropic.com/v1/messages/batches/" + job.id, { headers: hdr, signal: AbortSignal.timeout(60000) });
      if (!r.ok) throw new Error("Batch status " + r.status);
      st = await r.json();
      onProgress?.(st.request_counts ?? {});
    }
    const res = await fetch(st.results_url, { headers: hdr, signal: AbortSignal.timeout(120000) });
    if (!res.ok) throw new Error("Batch results " + res.status);
    const out = new Map(items.map((it) => [String(it.id), null]));
    for (const line of (await res.text()).split("\n")) {
      if (!line.trim()) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      if (r.result?.type === "succeeded") { this.#usage(r.result.message, true); out.set(r.custom_id, r.result.message.content?.find((b) => b.type === "tool_use")?.input ?? null); }
    }
    return out;
  }

  // Sentiment for many batches through the batch service. Returns an array aligned with `batches` (null where one failed).
  async sentimentsViaBatchApi(batches, opts) {
    const m = await this.batchMessages(batches.map((b, i) => ({ id: "s" + i, system: sentimentSystem, tool: sentimentTool, user: sentimentUser(b), maxTokens: 150 + b.length * 40 })), opts);
    return batches.map((b, i) => (m.get("s" + i) ? normalizeSentiments(m.get("s" + i), b) : null));
  }
  // Topic labels for many stories through the batch service. Returns an array aligned with `stories` (null where one failed).
  async enrichViaBatchApi(stories, opts) {
    const m = await this.batchMessages(stories.map((s, i) => ({ id: "e" + i, system: enrichSystem, tool: enrichTool, user: enrichUser(s, this.topics ? this.topics.candidates(s.title + " " + s.analysis.summary) : []), maxTokens: 900 })), opts);
    return stories.map((s, i) => (m.get("e" + i) ? normalizeEnrichment(m.get("e" + i), this.topics, s.analysis.impacts.find((x) => x.bracket)?.bracket ?? null) : null));
  }

  async #claude(system, tool, user, maxTokens, model = null, context = null) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": this.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify(this.#body(system, tool, user, maxTokens, model, context)),
        signal: AbortSignal.timeout(90000),
      });
      if (res.status === 429 || res.status >= 500) { await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt)); continue; }
      if (!res.ok) throw new Error("Anthropic " + res.status + ": " + (await res.text()).slice(0, 200));
      const j = await res.json();
      this.#usage(j);
      return j.content?.find((b) => b.type === "tool_use")?.input ?? null;
    }
    throw new Error("Anthropic: retries exhausted (rate limited or overloaded)");
  }

  async #ollama(system, tool, user) {
    const res = await fetch(this.ollamaHost + "/api/chat", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.ollamaModel, stream: false, format: "json", options: { temperature: 0.1, num_ctx: 8192 },
        messages: [
          { role: "system", content: system + "\nReturn one JSON object with these properties (JSON-schema fragment): " + JSON.stringify(tool.input_schema.properties) },
          { role: "user", content: user },
        ],
      }),
      signal: AbortSignal.timeout(600000),
    });
    if (!res.ok) throw new Error("Ollama " + res.status + (res.status === 404 ? ": model " + this.ollamaModel + " is not installed (run: ollama pull " + this.ollamaModel + ")" : ""));
    return extractJson((await res.json()).message?.content);
  }
}
