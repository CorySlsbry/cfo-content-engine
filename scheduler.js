/**
 * scheduler.js — Pure slot math for the "3 posts per day" publishing schedule.
 *
 * Responsibilities:
 *   1. Parse a list of "HH:MM" slot strings into hour/minute tuples.
 *   2. Given (now, slot times, target timezone, already-taken timestamps),
 *      return the next available UTC ISO timestamp to schedule a post at.
 *   3. Enumerate upcoming slots (open or taken) for the dashboard to render.
 *
 * No DB, no side effects. db.js calls these with settings + already-scheduled
 * rows; main.js's publisher tick compares `scheduled_publish_at <= now()`.
 *
 * Timezone handling: all arithmetic happens in the operator-configured zone
 * (`posting_timezone`, default "America/Denver"), then we convert back to a
 * UTC ISO string for DB storage. We use Intl.DateTimeFormat rather than a
 * date library to stay dependency-free.
 */

const DEFAULT_TIMEZONE = 'America/Denver';
const DEFAULT_SLOT_TIMES = ['07:30', '12:30', '18:00'];
const MAX_HORIZON_DAYS = 30; // safety — never schedule farther than this out

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse a JSON array string OR array of "HH:MM" strings into sorted tuples.
 * Invalid entries are dropped; caller gets back only valid slots.
 */
function parseSlotTimes(input) {
  let arr;
  if (Array.isArray(input)) {
    arr = input;
  } else if (typeof input === 'string' && input.trim()) {
    try {
      const parsed = JSON.parse(input);
      arr = Array.isArray(parsed) ? parsed : null;
    } catch {
      arr = null;
    }
  }
  if (!arr) return DEFAULT_SLOT_TIMES.map((s) => splitHhmm(s));

  const out = [];
  for (const raw of arr) {
    const parsed = splitHhmm(raw);
    if (parsed) out.push(parsed);
  }
  if (out.length === 0) return DEFAULT_SLOT_TIMES.map((s) => splitHhmm(s));
  // Sort ascending so the "next slot today" scan is in clock order.
  out.sort((a, b) => (a.hour - b.hour) || (a.minute - b.minute));
  return out;
}

function splitHhmm(s) {
  const m = typeof s === 'string' && s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]); const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return { hour: h, minute: min };
}

// ---------------------------------------------------------------------------
// Timezone-aware datetime construction
// ---------------------------------------------------------------------------

// Returns the year/month/day in the given timezone for a reference Date.
// Using Intl.DateTimeFormat + 'en-CA' gives us "YYYY-MM-DD HH:mm:ss" reliably.
function ymdInZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const find = (type) => parts.find((p) => p.type === type)?.value;
  return {
    year:   Number(find('year')),
    month:  Number(find('month')),
    day:    Number(find('day')),
    hour:   Number(find('hour')),
    minute: Number(find('minute')),
    second: Number(find('second')),
  };
}

/**
 * Given a calendar day (y/m/d) and an HH:MM pair, return the UTC Date whose
 * wall-clock time in `timeZone` matches. Handles DST transitions correctly by
 * computing the offset for the target wall time and adjusting.
 */
function dateFromZoneWallTime(year, month, day, hour, minute, timeZone) {
  // Start with a naive UTC date interpreted as the wall time.
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  // Discover what that wall-time is in the target zone when read FROM that
  // UTC instant. If zone time differs from the intent, apply the delta.
  const observed = ymdInZone(new Date(asUtc), timeZone);
  const observedUtc = Date.UTC(
    observed.year, observed.month - 1, observed.day,
    observed.hour, observed.minute, observed.second, 0
  );
  const offset = asUtc - observedUtc; // how much UTC lags the zone at that moment
  return new Date(asUtc + offset);
}

// ---------------------------------------------------------------------------
// Next-slot computation
// ---------------------------------------------------------------------------

/**
 * Find the earliest slot (across the next MAX_HORIZON_DAYS days) whose UTC
 * timestamp is strictly after `now` AND does not match any timestamp in
 * `takenIsoSet`. Returns a UTC Date, or null if no slot is available within
 * the horizon (shouldn't happen in practice).
 *
 * @param {Date|string} now
 * @param {Array<{hour:number, minute:number}>} slots
 * @param {string} timeZone IANA zone, e.g. "America/Denver"
 * @param {Set<string>} takenIsoSet ISO strings of already-scheduled slots (UTC)
 */
function nextAvailableSlot(now, slots, timeZone, takenIsoSet) {
  const nowDate = now instanceof Date ? now : new Date(now);
  const today = ymdInZone(nowDate, timeZone);
  const taken = takenIsoSet instanceof Set ? takenIsoSet : new Set(takenIsoSet || []);

  for (let dayOffset = 0; dayOffset <= MAX_HORIZON_DAYS; dayOffset += 1) {
    // Roll (y, m, d) forward dayOffset days using a UTC-midnight anchor in the zone.
    const anchor = dateFromZoneWallTime(today.year, today.month, today.day, 0, 0, timeZone);
    const rolled = new Date(anchor.getTime() + dayOffset * 86_400_000);
    const rolledYmd = ymdInZone(rolled, timeZone);

    for (const slot of slots) {
      const slotUtc = dateFromZoneWallTime(
        rolledYmd.year, rolledYmd.month, rolledYmd.day,
        slot.hour, slot.minute, timeZone
      );
      if (slotUtc.getTime() <= nowDate.getTime()) continue;
      if (taken.has(slotUtc.toISOString())) continue;
      return slotUtc;
    }
  }
  return null;
}

/**
 * Enumerate the next N slots (open + taken), for the dashboard "upcoming
 * schedule" view. Returns [{ isoUtc, localLabel, taken, videoId? }].
 * Caller supplies a Map<isoUtc, videoInfo> for the decoration.
 */
function upcomingSlots(now, slots, timeZone, takenMap, count = 9) {
  const nowDate = now instanceof Date ? now : new Date(now);
  const today = ymdInZone(nowDate, timeZone);
  const map = takenMap instanceof Map ? takenMap : new Map();
  const out = [];

  outer:
  for (let dayOffset = 0; dayOffset < MAX_HORIZON_DAYS; dayOffset += 1) {
    const anchor = dateFromZoneWallTime(today.year, today.month, today.day, 0, 0, timeZone);
    const rolled = new Date(anchor.getTime() + dayOffset * 86_400_000);
    const rolledYmd = ymdInZone(rolled, timeZone);

    for (const slot of slots) {
      const slotUtc = dateFromZoneWallTime(
        rolledYmd.year, rolledYmd.month, rolledYmd.day,
        slot.hour, slot.minute, timeZone
      );
      if (slotUtc.getTime() <= nowDate.getTime()) continue;

      const iso = slotUtc.toISOString();
      const taken = map.get(iso) || null;
      out.push({
        isoUtc: iso,
        localLabel: formatSlotLabel(slotUtc, timeZone),
        taken: !!taken,
        video: taken,
      });
      if (out.length >= count) break outer;
    }
  }
  return out;
}

function formatSlotLabel(date, timeZone) {
  // "Fri 5:30 PM" — short and scannable for the sidebar card.
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: 'numeric', minute: '2-digit',
    hour12: true,
  }).format(date);
}

module.exports = {
  DEFAULT_TIMEZONE,
  DEFAULT_SLOT_TIMES,
  parseSlotTimes,
  nextAvailableSlot,
  upcomingSlots,
  formatSlotLabel,
  // Exposed for tests.
  _dateFromZoneWallTime: dateFromZoneWallTime,
  _ymdInZone: ymdInZone,
};
