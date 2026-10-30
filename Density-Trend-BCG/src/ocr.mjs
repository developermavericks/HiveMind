// Print-edition articles from the OCR e-paper service: download the daily JSON exports, keep the raw files, and tell authored /
// opinion pieces (a named writer's view, a column, an editorial) from ordinary reported news.
//
//   fetchArchive()   GET /exports?date=…  then  GET /exports/{source}/{date}   -> data/ocr_archive/<source>_<date>.json
//   looksAuthored()  cheap text rules (byline, column labels). Only articles that pass them are sent to the model.
//
// The service is open (no key). OCR_REPORTS_BASE_URL overrides the address.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export const OCR_BASE = (process.env.OCR_REPORTS_BASE_URL || "https://reports-api-k4ubn7ievq-uc.a.run.app").replace(/\/$/, "");

const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export function dateRange(from, to) {
  const out = [];
  for (let d = new Date(from + "T00:00:00"); ymd(d) <= to; d.setDate(d.getDate() + 1)) out.push(ymd(d));
  return out;
}

async function getJson(url, { retries = 3, timeoutMs = 90000 } = {}) {
  let last;
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) { last = e; await new Promise((res) => setTimeout(res, 1500 * 2 ** i)); }
  }
  throw new Error(`${url}: ${last?.message ?? last}`);
}

const fileFor = (dir, source, date) => join(dir, `${source.replace(/\s+/g, "_")}_${date}.json`);

// Downloads every edition between two dates (inclusive). Editions already saved are reused unless `refresh` is set, so the
// current day can be re-fetched as it fills in while older ones are not downloaded twice.
// Returns [{ source, date, file, articles: n, payload }].
export async function fetchArchive({ from, to, dir, refresh = false, log = () => {} }) {
  mkdirSync(dir, { recursive: true });
  const out = [], today = ymd(new Date());
  for (const date of dateRange(from, to)) {
    const list = await getJson(`${OCR_BASE}/exports?date=${date}`);
    for (const item of Array.isArray(list) ? list : []) {
      const source = item.source, file = fileFor(dir, source, date);
      let payload = null;
      if (existsSync(file) && !(refresh || date === today)) { try { payload = JSON.parse(readFileSync(file, "utf8")); } catch { /* re-download a damaged file */ } }
      if (!payload) {
        payload = await getJson(`${OCR_BASE}/exports/${encodeURIComponent(source)}/${date}`);
        if (!payload) { log(`  ${source} ${date}: not available`); continue; }
        writeFileSync(file, JSON.stringify(payload));
      }
      const n = (payload.articles ?? []).length;
      log(`  ${source} ${date}: ${n} articles`);
      out.push({ source, date, file, articles: n, payload });
    }
  }
  return out;
}

// Flattens an export into rows for the store. The id is stable across re-downloads.
export function articleRows(payload, source, date) {
  return (payload.articles ?? []).map((a) => ({
    id: `${source}|${date}|${a.id ?? a.content_hash}`, source, date, page: Number.isFinite(+a.page_number) ? +a.page_number : null,
    headline: String(a.headline ?? "").trim(), body: String(a.body_text ?? "").trim(), hash: a.content_hash ?? null,
  })).filter((r) => r.headline || r.body);
}

// ---------- cheap rules: which articles could be authored or opinion ----------
// A byline ("By Jane Doe", "Jane Doe | Mumbai") near the top, a signature line at the end, or an opinion label. These rules
// only choose what the model is asked about; they never decide an article IS authored.
const NAME = "[A-Z][a-zA-Z.'’-]{1,20}(?:\\s+(?:[A-Z][a-zA-Z.'’-]{1,20}|de|van|von|bin|al)){0,3}";
const BYLINE_TOP = new RegExp(`^\\s*(?:by|written by|text by)\\s+${NAME}`, "i");
const BYLINE_ANY = new RegExp(`(?:^|\\n|\\s)(?:By|BY)\\s+${NAME}(?:\\s+(?:and|&)\\s+${NAME})?\\s*(?:\\n|,|\\||$|-)`);
const SIGNATURE_END = new RegExp(`(?:\\n|\\.\\s)[—–-]\\s*${NAME}(?:,\\s*[^\\n]{3,80})?\\s*$|\\bThe (?:writer|author|views? )[^.]{0,80}(?:is|are|expressed)[^.]{0,80}\\.?\\s*$`);
const OPINION_WORDS = /\b(opinion|editorial|op-?ed|column|columnist|viewpoint|comment|perspective|analysis|explained|my take|the view from|guest column|letters?)\b/i;
const AUTHOR_NOTE = /(?:views? (?:expressed )?(?:are|is) (?:the )?(?:author|writer)'?s? own|is (?:a|an|the) [^.]{3,80}(?:professor|economist|columnist|analyst|fellow|founder|former|director|editor|researcher)[^.]{0,80}\.?\s*$)/i;

export function looksAuthored(a) {
  const head = a.headline ?? "", body = a.body ?? "", first = body.slice(0, 300), last = body.slice(-350);
  const signals = [];
  if (BYLINE_TOP.test(first)) signals.push("byline");
  else if (BYLINE_ANY.test(first)) signals.push("byline");
  if (SIGNATURE_END.test(last)) signals.push("signature");
  if (AUTHOR_NOTE.test(last)) signals.push("author note");
  if (OPINION_WORDS.test(head)) signals.push("label in headline");
  if (/^\s*(opinion|editorial|comment|column|perspective|viewpoint|analysis)\b/i.test(first)) signals.push("label in text");
  return signals;
}

// Opinion pages often carry no byline in the OCR text, so length is a candidate signal too: very short items (briefs, listings,
// captions) are skipped; everything else the rules or the length let through is judged by the model.
export const wordCount = (a) => (a.body ? a.body.split(/\s+/).length : 0);
export const isCandidate = (a, minWords = 200) => wordCount(a) >= minWords || (wordCount(a) >= 60 && looksAuthored(a).length > 0);

// The part of an article the model reads: the start (headline, byline, argument) and the end (signature, author note).
export function excerpt(a, headChars = 650, tailChars = 260) {
  const b = a.body ?? "";
  return b.length <= headChars + tailChars + 40 ? b : `${b.slice(0, headChars)} […] ${b.slice(-tailChars)}`;
}

// ---------- headlines the OCR got wrong ----------
// The OCR often reports something else as the headline: a section label ("OPINION 7"), a column name ("MACRO PULSE"), the writer's name,
// a web address or id, or the tail of a sentence. These rules only flag; the model then looks for the real title.
const normText = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
export function isWeakHeadline(h, author = "") {
  const t = String(h ?? "").replace(/\s+/g, " ").trim();
  if (t.length < 8) return true;
  if (/@|www\.|https?:|[0-9a-f]{8}-[0-9a-f]{4}/i.test(t)) return true;
  if (/^[a-z]/.test(t)) return true; // starts mid-sentence
  if (/^(opinion|editorial|comment|analysis|perspective|viewpoint|the edit page|edit page|letters?|column)\b[\s\d.:|-]*$/i.test(t)) return true;
  const words = t.split(" ");
  if (t === t.toUpperCase() && /[A-Z]/.test(t) && words.length <= 4) return true; // "MACRO PULSE", "JOSE MOURINHO"
  if (author && normText(t) === normText(author)) return true;
  if (words.length >= 9 && /[.]$/.test(t)) return true; // a whole sentence, not a title
  if (words.length <= 3 && words.every((w) => /^[A-Z][a-zA-Z.'’-]*$/.test(w))) return true; // "V. Venkatesan I", "Rajesh Kumar"
  return false;
}
// Like textHas but ignoring spaces, for names the OCR ran together ("RAHULJACOB" for "Rahul Jacob").
export const textHasLoose = (haystack, needle) => { const n = normText(needle).replace(/ /g, ""); return n.length > 3 && normText(haystack).replace(/ /g, "").includes(n); };
// A block that starts in the middle of a sentence is the continuation of an article cut into columns.
export const startsMidSentence = (body) => /^[a-z]/.test(String(body ?? "").trim());

export const sameText = (a, b) => normText(a) === normText(b);
export const textHas = (haystack, needle) => { const n = normText(needle); return n.length > 3 && normText(haystack).includes(n); };

