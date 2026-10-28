// Source registry and reporting origins.
//
// "Ten websites repeating one report are not ten independent confirmations." A story's outlet count measures
// distribution; its origin count measures independence. Outlets owned by the same media group count as one
// origin, and a story carrying a wire credit (PTI, ANI, ...) is one origin however many outlets reran it.
// Primary sources (regulators, ministries, weather agencies) are always their own origin.
import { norm } from "./brackets.mjs";

export class SourceRegistry {
  constructor(list = []) {
    this.list = list;
    this.byName = new Map();
    for (const s of list) {
      this.byName.set(norm(s.name), s);
      if (s.domain) this.byName.set(norm(s.domain), s);
    }
  }
  find(name) { return this.byName.get(norm(name ?? "")) ?? null; }
  groupOf(name) { return this.find(name)?.group ?? name ?? "unknown"; }
  isPrimary(name) { return this.find(name)?.type === "primary"; }
}

const WIRES = ["PTI", "ANI", "IANS", "UNI", "Reuters", "Bloomberg", "AFP", "AP"];
const WIRE_PATTERNS = [
  new RegExp(`\\((${WIRES.join("|")})\\)`),
  new RegExp(`(?:^|\\n)\\s*(${WIRES.join("|")})\\s*[:|–—-]`),
  new RegExp(`[–—-]\\s*(${WIRES.join("|")})\\s*(?:\\n|$)`),
  /\b(Press Trust of India)\b/i,
  /\b(Asian News International)\b/i,
];
const WIRE_OUTLET = new RegExp(`^(${WIRES.join("|")})$`, "i");
const WIRE_NAMES = { "press trust of india": "PTI", "asian news international": "ANI" };

// The wire agency credited in an article body, or null. Needs the article text, so it is only known for
// stories read from full text; headline-only stories are treated as having no wire credit.
export function detectWire(text) {
  const head = String(text ?? "").slice(0, 1500);
  for (const re of WIRE_PATTERNS) {
    const m = head.match(re);
    if (m) return WIRE_NAMES[m[1].toLowerCase()] ?? m[1];
  }
  return null;
}

// { origins: [id], count, primary, wire } for one story. `wire` is only present when the body was read.
export function originsOf(story, sources) {
  const set = new Set();
  let primary = false;
  for (const a of story.articles ?? []) {
    // `publication` is the site that was queried (stable); `outlet` is Google's label for it ("Livemint", "ET Infra", ...).
    const name = a.publication || a.outlet;
    if (sources.isPrimary(name)) { primary = true; set.add(`primary:${sources.groupOf(name)}`); continue; }
    const w = WIRE_OUTLET.exec(String(a.outlet ?? "").trim()); // e.g. Google labels the carrier "Bloomberg" or "PTI"
    if (w) { set.add(`wire:${WIRE_NAMES[w[1].toLowerCase()] ?? w[1]}`); continue; }
    set.add(`group:${sources.groupOf(name)}`);
  }
  const wire = story.meta?.wire ?? null;
  if (wire) {
    for (const o of [...set]) if (o.startsWith("group:")) set.delete(o);
    set.add(`wire:${wire}`);
  }
  if (!set.size) set.add("group:unknown");
  return { origins: [...set], count: set.size, primary, wire };
}
