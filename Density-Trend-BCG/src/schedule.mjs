// When the print editions are due. Pure, so it can be tested without waiting for the clock.
//
// The rule: once a day, from a set time (local clock, default 11:15). The slowest paper has finished extracting by about 10:57 IST, so a few minutes
// after 11:00 leaves a margin. If the time has passed while the server was off, the day is made up as soon as the server runs again. A run that fails
// is tried again an hour later, up to three times that day. Once a run succeeds, nothing more that day.

export function parseTime(at, fallback = "11:15") {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(at ?? fallback).trim()) ?? /^(\d{1,2}):(\d{2})$/.exec(fallback);
  const hh = Math.min(23, +m[1]), mm = Math.min(59, +m[2]);
  return { hh, mm, label: `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}` };
}

// now: Date. state: { okDay, tries (today's attempts), lastTryAt (ms) }. Returns true when a run should start now.
export function ocrDue(now, at, { okDay = null, tries = 0, lastTryAt = 0 } = {}, { maxTries = 3, retryMs = 3600e3 } = {}) {
  const { hh, mm } = parseTime(at), day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  if (now.getTime() < new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm).getTime()) return false; // not yet today
  if (okDay === day) return false; // already done today
  if (tries >= maxTries) return false;
  if (lastTryAt && now.getTime() - lastTryAt < retryMs) return false;
  return true;
}
