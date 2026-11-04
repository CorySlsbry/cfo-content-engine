/**
 * db.js — Supabase-backed data layer for the CFO Content Engine.
 *
 * Every function returns a Promise now. The API surface mirrors the previous
 * SQLite version 1:1 — callers only need to add `await` and make the enclosing
 * function async. Event-bus semantics are preserved (synchronous EventEmitter
 * still works; we just emit after the async write completes).
 *
 * Tables live in the shared Supabase project (oxvmsubkebhgvmxkftwa) under the
 * `engine_` prefix in the public schema, so engine rows sit alongside the
 * Salisbury CRM for single-DB attribution joins.
 *
 * Lifecycle statuses:
 *   Idea -> Scripted -> Audio_Generated -> Images_Generated -> Rendered ->
 *   Pending_Approval -> Published  (or -> Rejected at any step)
 */

const { EventEmitter } = require('events');
const { createClient } = require('@supabase/supabase-js');
const scheduler = require('./scheduler');

// ---------------------------------------------------------------------------
// Constants — unchanged from the SQLite version
// ---------------------------------------------------------------------------
const PERSONAS = Object.freeze(['BUILDER', 'SELLER']);
const STATUSES = Object.freeze([
  'Idea',
  'Scripted',
  'Audio_Generated',
  'Images_Generated',
  'Rendered',
  'Pending_Approval',
  'Scheduled',
  'Published',
  'Rejected',
]);
const PLATFORMS = Object.freeze(['TIKTOK', 'YOUTUBE_SHORTS', 'INSTAGRAM_REELS']);

// Env-var-driven so local dev and Cloud Run both work with the same module.
const SUPABASE_URL         = process.env.SUPABASE_URL         || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  // Fail loud at module load — nothing downstream is recoverable without this.
  throw new Error(
    'db.js: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required. ' +
    'Set them in .env (local) or Secret Manager (Cloud Run).'
  );
}

// One client, persisted across requires. service_role bypasses RLS so the
// orchestrator's queries never get blocked by policy.
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  // Keep realtime off on the server — we drive our own Socket.IO events.
  realtime: { params: { eventsPerSecond: 0 } },
});

const events = new EventEmitter();

// Small helper to surface Supabase errors with a stable prefix.
function throwIfError(where, err) {
  if (err) throw new Error(`${where}: ${err.message || err}`);
}

// ---------------------------------------------------------------------------
// Videos — the pipeline table (renamed from `videos` to `engine_videos`)
// ---------------------------------------------------------------------------

/**
 * Normalize a row that came back from Supabase into the same shape the rest
 * of the engine expects. Two things to handle:
 *   1. Column rename from `raw_json` -> `raw` on signals (handled in that section).
 *   2. jsonb columns arrive as parsed JS objects; the old SQLite layer stored
 *      them as strings. Downstream code sometimes JSON.parse()'s them, so we
 *      keep them stringified on the way out to stay 100% backward-compatible.
 */
function rowOut(row) {
  if (!row) return row;
  const out = { ...row };
  for (const k of ['script_json', 'platforms', 'platform_posts', 'source_signals']) {
    if (out[k] != null && typeof out[k] !== 'string') {
      try { out[k] = JSON.stringify(out[k]); } catch { /* leave as-is */ }
    }
  }
  // created_at / updated_at come back as ISO strings with timezone. The old
  // SQLite "datetime('now')" format was "YYYY-MM-DD HH:MM:SS" (no TZ). The
  // dashboard appends 'Z' when rendering, which works fine with ISO too, so
  // this is compatible without change.
  return out;
}

/** Insert a new idea row. Accepts optional platforms[] and source_signals. */
async function insertIdea({ target_persona, topic, platforms, source_signals } = {}) {
  if (!PERSONAS.includes(target_persona)) {
    throw new TypeError(`insertIdea: target_persona must be one of ${PERSONAS.join(', ')} (got ${JSON.stringify(target_persona)})`);
  }
  if (typeof topic !== 'string' || topic.trim().length === 0) {
    throw new TypeError('insertIdea: topic must be a non-empty string');
  }
  const { data, error } = await sb
    .from('engine_videos')
    .insert({
      target_persona,
      topic: topic.trim(),
      status: 'Idea',
      platforms:      platforms      ?? null,
      source_signals: source_signals ?? null,
    })
    .select('*')
    .single();
  throwIfError('insertIdea', error);
  const row = rowOut(data);
  events.emit('change', { kind: 'insert', row });
  return row;
}

/**
 * Update a row's status and optionally patch artifact paths / script JSON.
 * Zeros fail_count on success (the row made it past whatever was blocking
 * it) but preserves last_error for forensics.
 */
async function updateStatus(id, status, patch = {}) {
  if (!Number.isInteger(id) || id <= 0) {
    throw new TypeError(`updateStatus: id must be a positive integer (got ${JSON.stringify(id)})`);
  }
  if (!STATUSES.includes(status)) {
    throw new TypeError(`updateStatus: status must be one of ${STATUSES.join(', ')} (got ${JSON.stringify(status)})`);
  }
  // Build the update payload, letting Postgres handle the COALESCE semantics
  // — only columns present in the patch get overwritten.
  const update = { status, fail_count: 0 };
  if (patch.script_json    !== undefined) update.script_json    = coerceJson(patch.script_json);
  if (patch.audio_path     !== undefined) update.audio_path     = patch.audio_path ?? null;
  if (patch.video_path     !== undefined) update.video_path     = patch.video_path ?? null;
  if (patch.platforms      !== undefined) update.platforms      = patch.platforms ?? null;
  if (patch.platform_posts !== undefined) update.platform_posts = patch.platform_posts ?? null;
  if (patch.source_signals !== undefined) update.source_signals = patch.source_signals ?? null;

  // Successful advance clears any transient-error cooldown so the row
  // doesn't carry cooldown state from stage N into stage N+1.
  update.cooldown_until = null;
  update.transient_fail_count = 0;
  update.last_transient_error = null;

  const { data, error } = await sb
    .from('engine_videos')
    .update(update)
    .eq('id', id)
    .select('*')
    .single();
  throwIfError(`updateStatus(id=${id})`, error);
  if (!data) throw new Error(`updateStatus: no row found with id=${id}`);
  const row = rowOut(data);
  events.emit('change', { kind: 'update', row });
  return row;
}

// Accepts string | object | null; always returns a value supabase-js can
// insert into a jsonb column (native object or null).
function coerceJson(v) {
  if (v == null) return null;
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch { return v; }
  }
  return v;
}

async function fetchOldestByStatus(status) {
  if (!STATUSES.includes(status)) {
    throw new TypeError(`fetchOldestByStatus: status must be one of ${STATUSES.join(', ')}`);
  }
  const nowIso = new Date().toISOString();
  // Skip rows in a cooldown window — Gemini was "high demand" the last time
  // we tried, and we're waiting out the exponential backoff before the next
  // attempt. `.or()` in PostgREST uses comma-separated conditions.
  const { data, error } = await sb
    .from('engine_videos')
    .select('*')
    .eq('status', status)
    .or(`cooldown_until.is.null,cooldown_until.lte.${nowIso}`)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(1)
    .maybeSingle();
  throwIfError(`fetchOldestByStatus(${status})`, error);
  return data ? rowOut(data) : null;
}

/**
 * Record a TRANSIENT (retryable) failure — 5xx, 429, timeouts, parse errors,
 * network blips. Does NOT count toward MAX_FAILS auto-reject. Instead bumps
 * transient_fail_count and sets cooldown_until to (now + p_cooldown_seconds).
 * The orchestrator's next tick will skip this row until cooldown passes.
 *
 * Returns the new transient_fail_count (for logging / observability).
 */
async function markTransientFailure(id, errMsg, cooldownSeconds) {
  if (!Number.isInteger(id) || id <= 0) {
    throw new TypeError('markTransientFailure: id must be a positive integer');
  }
  const msg = String(errMsg ?? '').slice(0, 1000);
  const cooldown = Math.max(1, Math.floor(Number(cooldownSeconds) || 60));
  const { data, error } = await sb.rpc('engine_mark_transient', {
    p_id: id,
    p_error: msg,
    p_cooldown_seconds: cooldown,
  });
  throwIfError(`markTransientFailure(id=${id})`, error);
  // Re-fetch the row so event listeners render the cooldown badge.
  const row = await getVideoById(id);
  events.emit('change', { kind: 'transient_fail', row });
  return Number(data) || 0;
}

/**
 * Clear the cooldown + transient counters. Called automatically on a
 * successful status advance (the row made it past whatever was blocking
 * it, so give it a clean slate).
 */
async function clearCooldown(id) {
  if (!Number.isInteger(id) || id <= 0) return;
  const { error } = await sb.rpc('engine_clear_cooldown', { p_id: id });
  if (error) console.warn(`[db] clearCooldown(${id}) soft-failed:`, error.message);
}

/**
 * Increment fail_count + set last_error via the atomic engine_mark_failed RPC.
 * Returns the new fail_count so the orchestrator can decide on auto-reject.
 */
async function markFailed(id, errMsg) {
  if (!Number.isInteger(id) || id <= 0) {
    throw new TypeError(`markFailed: id must be a positive integer (got ${JSON.stringify(id)})`);
  }
  const msg = String(errMsg ?? '').slice(0, 1000);
  const { data: newCount, error } = await sb.rpc('engine_mark_failed', {
    p_id: id,
    p_error: msg,
  });
  throwIfError(`markFailed(id=${id})`, error);
  // Re-fetch the row so event listeners get the updated state.
  const row = await getVideoById(id);
  events.emit('change', { kind: 'fail', row });
  return Number(newCount) || 0;
}

async function getVideoById(id) {
  if (!Number.isInteger(id) || id <= 0) {
    throw new TypeError('getVideoById: id must be a positive integer');
  }
  const { data, error } = await sb
    .from('engine_videos')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  throwIfError(`getVideoById(${id})`, error);
  return data ? rowOut(data) : null;
}

/**
 * Pull a row back into the pipeline at a specific status and reset the
 * fail_count / last_error so the orchestrator gives it a fresh budget.
 * Used by POST /api/videos/:id/requeue to recover rows that the outer
 * MAX_FAILS guard auto-rejected for transient reasons.
 */
async function requeueRow(id, targetStatus) {
  if (!Number.isInteger(id) || id <= 0) {
    throw new TypeError('requeueRow: id must be a positive integer');
  }
  if (!STATUSES.includes(targetStatus)) {
    throw new TypeError(`requeueRow: status must be one of ${STATUSES.join(', ')}`);
  }
  // Clear scheduled_publish_at when leaving the Scheduled state — otherwise a
  // stale future timestamp sticks around and would re-fire if the row were
  // later approved a second time without a fresh slot computation.
  const update = { status: targetStatus, fail_count: 0, last_error: null };
  if (targetStatus !== 'Scheduled') update.scheduled_publish_at = null;
  const { data, error } = await sb
    .from('engine_videos')
    .update(update)
    .eq('id', id)
    .select('*')
    .single();
  throwIfError(`requeueRow(id=${id})`, error);
  if (!data) throw new Error(`requeueRow: no row found with id=${id}`);
  const row = rowOut(data);
  events.emit('change', { kind: 'requeue', row });
  return row;
}

async function getAllVideos() {
  const { data, error } = await sb
    .from('engine_videos')
    .select('*')
    .order('updated_at', { ascending: false })
    .order('id', { ascending: false });
  throwIfError('getAllVideos', error);
  return (data || []).map(rowOut);
}

async function getCounts() {
  // Supabase-js doesn't support GROUP BY directly; select all IDs grouped by
  // status via head:true count per status. Cheap (index-only scan) and
  // stays one round-trip via Promise.all.
  const out = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  const counts = await Promise.all(
    STATUSES.map((s) =>
      sb.from('engine_videos').select('id', { count: 'exact', head: true }).eq('status', s)
    )
  );
  counts.forEach((res, i) => {
    if (res.error) throw new Error(`getCounts(${STATUSES[i]}): ${res.error.message}`);
    out[STATUSES[i]] = res.count || 0;
  });
  return out;
}

// ---------------------------------------------------------------------------
// Settings (engine_settings key/value store)
// ---------------------------------------------------------------------------

async function getSetting(key, fallback = null) {
  const { data, error } = await sb
    .from('engine_settings')
    .select('value')
    .eq('key', key)
    .maybeSingle();
  throwIfError(`getSetting(${key})`, error);
  return data ? data.value : fallback;
}

async function setSetting(key, value) {
  const { error } = await sb
    .from('engine_settings')
    .upsert({ key, value: String(value) }, { onConflict: 'key' });
  throwIfError(`setSetting(${key})`, error);
  events.emit('settings', await getAllSettings());
  return value;
}

async function getAllSettings() {
  const { data, error } = await sb.from('engine_settings').select('key, value');
  throwIfError('getAllSettings', error);
  const out = {};
  for (const r of data || []) out[r.key] = r.value;
  return out;
}

const APPROVAL_REQUIRED_KEY       = 'approval_required';
const GENERATION_ENABLED_KEY      = 'generation_enabled';
const MAX_IN_FLIGHT_KEY           = 'max_in_flight';
const POSTING_SCHEDULE_KEY        = 'posting_schedule_enabled';
const POSTING_SLOT_TIMES_KEY      = 'posting_slot_times';      // JSON string: ["07:30","12:30","18:00"]
const POSTING_TIMEZONE_KEY        = 'posting_timezone';        // IANA zone

async function isApprovalRequired() {
  const v = await getSetting(APPROVAL_REQUIRED_KEY, 'true');
  return v !== 'false' && v !== '0';
}
async function setApprovalRequired(bool) {
  return setSetting(APPROVAL_REQUIRED_KEY, bool ? 'true' : 'false');
}

async function isGenerationEnabled() {
  const v = await getSetting(GENERATION_ENABLED_KEY, 'false');
  return v !== 'false' && v !== '0';
}
async function setGenerationEnabled(bool) {
  return setSetting(GENERATION_ENABLED_KEY, bool ? 'true' : 'false');
}

async function getMaxInFlight() {
  const n = Number.parseInt(await getSetting(MAX_IN_FLIGHT_KEY, '5'), 10);
  return Number.isFinite(n) && n > 0 ? n : 5;
}
async function setMaxInFlight(n) {
  const v = Number.parseInt(n, 10);
  if (!Number.isFinite(v) || v < 1) throw new TypeError('max_in_flight must be a positive integer');
  return setSetting(MAX_IN_FLIGHT_KEY, String(v));
}

async function isSchedulingEnabled() {
  const v = await getSetting(POSTING_SCHEDULE_KEY, 'true');
  return v !== 'false' && v !== '0';
}
async function setSchedulingEnabled(bool) {
  return setSetting(POSTING_SCHEDULE_KEY, bool ? 'true' : 'false');
}

async function getPostingSlotTimes() {
  const raw = await getSetting(POSTING_SLOT_TIMES_KEY, JSON.stringify(scheduler.DEFAULT_SLOT_TIMES));
  // Return the raw string — scheduler.parseSlotTimes handles both forms.
  return raw;
}
async function setPostingSlotTimes(arr) {
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new TypeError('setPostingSlotTimes: must be a non-empty array of "HH:MM" strings');
  }
  return setSetting(POSTING_SLOT_TIMES_KEY, JSON.stringify(arr));
}

async function getPostingTimezone() {
  return await getSetting(POSTING_TIMEZONE_KEY, scheduler.DEFAULT_TIMEZONE);
}
async function setPostingTimezone(tz) {
  if (typeof tz !== 'string' || !tz.trim()) {
    throw new TypeError('setPostingTimezone: tz must be a non-empty IANA zone string');
  }
  return setSetting(POSTING_TIMEZONE_KEY, tz.trim());
}

async function countInFlight() {
  const { count, error } = await sb
    .from('engine_videos')
    .select('id', { count: 'exact', head: true })
    .not('status', 'in', '(Published,Rejected)');
  throwIfError('countInFlight', error);
  return count || 0;
}

/**
 * Seed default settings on first run. Called explicitly by the server at
 * startup — no side effects at module load (unlike the SQLite version)
 * because network calls at require() time make cold-start tracing miserable.
 */
async function ensureDefaults() {
  const [approval, generation, maxInFlight, sched, slotTimes, tz] = await Promise.all([
    getSetting(APPROVAL_REQUIRED_KEY),
    getSetting(GENERATION_ENABLED_KEY),
    getSetting(MAX_IN_FLIGHT_KEY),
    getSetting(POSTING_SCHEDULE_KEY),
    getSetting(POSTING_SLOT_TIMES_KEY),
    getSetting(POSTING_TIMEZONE_KEY),
  ]);
  const writes = [];
  if (approval    == null) writes.push(setApprovalRequired(true));
  if (generation  == null) writes.push(setGenerationEnabled(false));
  if (maxInFlight == null) writes.push(setMaxInFlight(5));
  if (sched       == null) writes.push(setSchedulingEnabled(true));
  if (slotTimes   == null) writes.push(setPostingSlotTimes(scheduler.DEFAULT_SLOT_TIMES));
  if (tz          == null) writes.push(setPostingTimezone(scheduler.DEFAULT_TIMEZONE));
  if (writes.length) await Promise.all(writes);
}

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

// Taxonomy for approvals (what worked). Mirrors rejection reasons as the
// positive counterpart. Kept permissive at the DB level; enforced at the
// API edge.
const APPROVAL_REASONS = Object.freeze([
  'strong_hook',
  'great_tone',
  'great_cta',
  'on_brand',
  'tight_pacing',
  'great_visuals',
  'sharp_numbers',
  'great_framework',
  'other',
]);

/**
 * Approve a Pending_Approval row and optionally capture what worked. Plain
 * approve (no feedback) still records approved_at — that's useful as a
 * low-signal "this cleared the bar" marker. Starred approvals (with a
 * reason + optional note) flow into the creative agent's system prompt on
 * future script gens so Claude leans into the winning patterns.
 *
 * When posting_schedule_enabled is true (default), approval does NOT publish
 * immediately. Instead the row lands in 'Scheduled' with scheduled_publish_at
 * set to the next available slot. main.js's publisher tick flips it to
 * 'Published' when that timestamp passes. Pass `publishNow: true` to bypass
 * the schedule for a single row (manual override from the dashboard).
 */
async function approveVideo(id, { reason, note, publishNow } = {}) {
  const row = await getVideoById(id);
  if (!row) throw new Error(`approveVideo: no row with id=${id}`);
  if (row.status !== 'Pending_Approval') {
    throw new Error(`approveVideo: row is in ${row.status}, not Pending_Approval`);
  }
  const cleanReason = reason && APPROVAL_REASONS.includes(reason) ? reason : null;
  const cleanNote   = note ? String(note).slice(0, 500).trim() : null;

  const nowIso = new Date().toISOString();

  // Decide: immediate publish or schedule?
  const scheduleOn = !publishNow && await isSchedulingEnabled();
  const update = {
    approval_reason: cleanReason,
    approval_note:   cleanNote,
    approved_at:     nowIso,
    fail_count:      0,
  };

  if (scheduleOn) {
    const taken = await getScheduledSlotSet();
    const slots = scheduler.parseSlotTimes(await getPostingSlotTimes());
    const tz    = await getPostingTimezone();
    const when  = scheduler.nextAvailableSlot(new Date(), slots, tz, taken);
    if (!when) {
      throw new Error('approveVideo: could not find a free slot within the horizon');
    }
    update.status                = 'Scheduled';
    update.scheduled_publish_at  = when.toISOString();
  } else {
    update.status                = 'Published';
    update.scheduled_publish_at  = null;
  }

  const { data, error } = await sb
    .from('engine_videos')
    .update(update)
    .eq('id', id)
    .select('*')
    .single();
  throwIfError(`approveVideo(${id})`, error);
  const updated = rowOut(data);
  events.emit('change', { kind: 'update', row: updated });
  return updated;
}

/**
 * Flip a Scheduled row to Published. Called by the publisher tick in main.js
 * when scheduled_publish_at has passed. Returns the updated row.
 */
async function publishScheduled(id) {
  if (!Number.isInteger(id) || id <= 0) {
    throw new TypeError('publishScheduled: id must be a positive integer');
  }
  const { data, error } = await sb
    .from('engine_videos')
    .update({ status: 'Published' })
    .eq('id', id)
    .eq('status', 'Scheduled') // optimistic guard — don't overwrite if operator requeued it
    .select('*')
    .maybeSingle();
  throwIfError(`publishScheduled(${id})`, error);
  if (!data) return null; // row was already past Scheduled — nothing to do
  const row = rowOut(data);
  events.emit('change', { kind: 'update', row });
  return row;
}

/**
 * Scheduled rows whose publish time has arrived. Main.js polls this on every
 * tick and flips them to Published. Bounded limit so one giant backlog doesn't
 * monopolize a single tick.
 */
async function getDueScheduled({ limit = 10, now = new Date() } = {}) {
  const { data, error } = await sb
    .from('engine_videos')
    .select('*')
    .eq('status', 'Scheduled')
    .lte('scheduled_publish_at', now.toISOString())
    .order('scheduled_publish_at', { ascending: true })
    .limit(limit);
  throwIfError('getDueScheduled', error);
  return (data || []).map(rowOut);
}

/**
 * All upcoming scheduled rows (status=Scheduled with future publish time).
 * Used by the dashboard "upcoming schedule" view and by approveVideo to
 * avoid double-booking a slot.
 */
async function getUpcomingScheduled({ limit = 50 } = {}) {
  const nowIso = new Date().toISOString();
  const { data, error } = await sb
    .from('engine_videos')
    .select('id, topic, target_persona, scheduled_publish_at, status, video_path, platform_posts, script_json')
    .eq('status', 'Scheduled')
    .gte('scheduled_publish_at', nowIso)
    .order('scheduled_publish_at', { ascending: true })
    .limit(limit);
  throwIfError('getUpcomingScheduled', error);
  return (data || []).map(rowOut);
}

async function getScheduledSlotSet() {
  const { data, error } = await sb
    .from('engine_videos')
    .select('scheduled_publish_at')
    .eq('status', 'Scheduled')
    .not('scheduled_publish_at', 'is', null);
  throwIfError('getScheduledSlotSet', error);
  return new Set((data || []).map((r) => new Date(r.scheduled_publish_at).toISOString()));
}

/**
 * Recent approvals with feedback (reason + optional note) for a persona.
 * These are the starred / winner approvals — the ones the operator
 * explicitly flagged as working. Creative.js injects them into the system
 * prompt under "WHAT HAS WORKED" so Claude repeats the wins.
 *
 * Returns [{ id, topic, reason, note, hook, approved_at }] newest first.
 */
async function getRecentApprovals(persona, { limit = 5 } = {}) {
  if (!PERSONAS.includes(persona)) {
    throw new TypeError(`getRecentApprovals: persona must be one of ${PERSONAS.join(', ')}`);
  }
  const { data, error } = await sb
    .from('engine_videos')
    .select('id, topic, script_json, approval_reason, approval_note, approved_at')
    .eq('target_persona', persona)
    .eq('status', 'Published')
    .not('approval_reason', 'is', null)
    .order('approved_at', { ascending: false })
    .limit(limit);
  throwIfError(`getRecentApprovals(${persona})`, error);
  return (data || []).map((r) => {
    let hook = null;
    try {
      const script = typeof r.script_json === 'string' ? JSON.parse(r.script_json) : r.script_json;
      hook = script?.hook || null;
    } catch { /* ignore — hook stays null */ }
    return {
      id:          r.id,
      topic:       r.topic,
      reason:      r.approval_reason,
      note:        r.approval_note,
      hook,
      approved_at: r.approved_at,
    };
  });
}

// Taxonomy enforced at the API edge; DB stays permissive for future tags.
const REJECTION_REASONS = Object.freeze([
  'weak_hook',
  'wrong_tone',
  'bad_cta',
  'off_brand',
  'off_topic',
  'bad_visuals',
  'factual_issue',
  'too_long',
  'too_short',
  'other',
]);

/**
 * Reject a Pending_Approval row and capture the operator's feedback so the
 * creative agent can learn from it. Reason + note flow into the system
 * prompt on future script generations (see creative.js).
 */
async function rejectVideo(id, { reason, note } = {}) {
  const row = await getVideoById(id);
  if (!row) throw new Error(`rejectVideo: no row with id=${id}`);
  if (row.status !== 'Pending_Approval') {
    throw new Error(`rejectVideo: row is in ${row.status}, not Pending_Approval`);
  }
  const cleanReason = reason && REJECTION_REASONS.includes(reason) ? reason : null;
  const cleanNote   = note ? String(note).slice(0, 500).trim() : null;

  // Two-step: updateStatus flips the row + emits change, then we patch the
  // rejection columns in a separate call because updateStatus's whitelist
  // doesn't know about them and I'd rather not widen the happy-path helper.
  const nowIso = new Date().toISOString();
  const { data, error } = await sb
    .from('engine_videos')
    .update({
      status: 'Rejected',
      rejection_reason: cleanReason,
      rejection_note:   cleanNote,
      rejected_at:      nowIso,
      fail_count: 0, // reset; a rejected row won't be retried anyway
    })
    .eq('id', id)
    .select('*')
    .single();
  throwIfError(`rejectVideo(${id})`, error);
  const updated = rowOut(data);
  events.emit('change', { kind: 'update', row: updated });
  return updated;
}

/**
 * Pull the most recent rejections for a persona, each with its reason tag
 * and free-text note. The creative agent summarizes these into the system
 * prompt so Claude learns the operator's preferences over time.
 *
 * Returns [{ id, topic, reason, note, rejected_at }] ordered newest first.
 */
async function getRecentRejections(persona, { limit = 10 } = {}) {
  if (!PERSONAS.includes(persona)) {
    throw new TypeError(`getRecentRejections: persona must be one of ${PERSONAS.join(', ')}`);
  }
  const { data, error } = await sb
    .from('engine_videos')
    .select('id, topic, rejection_reason, rejection_note, rejected_at')
    .eq('target_persona', persona)
    .eq('status', 'Rejected')
    .not('rejection_reason', 'is', null)
    .order('rejected_at', { ascending: false })
    .limit(limit);
  throwIfError(`getRecentRejections(${persona})`, error);
  return (data || []).map((r) => ({
    id: r.id,
    topic: r.topic,
    reason: r.rejection_reason,
    note: r.rejection_note,
    rejected_at: r.rejected_at,
  }));
}

// ---------------------------------------------------------------------------
// Delete + learn (dismissed_topics)
// ---------------------------------------------------------------------------

function normalizeTopic(t) {
  return String(t)
    .toLowerCase()
    .replace(/\s*[-–—|].*$/, '')
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function deleteVideo(id, reason) {
  if (!Number.isInteger(id) || id <= 0) {
    throw new TypeError(`deleteVideo: id must be a positive integer (got ${JSON.stringify(id)})`);
  }
  const row = await getVideoById(id);
  if (!row) throw new Error(`deleteVideo: no row with id=${id}`);

  const norm = normalizeTopic(row.topic);
  let dismissed = false;
  if (norm) {
    const { error } = await sb.from('engine_dismissed_topics').insert({
      original_id:    id,
      target_persona: row.target_persona,
      topic:          row.topic,
      topic_norm:     norm,
      reason:         reason || null,
    });
    if (error) {
      // Not fatal — we still want to delete the row. Log and proceed.
      console.warn(`[db] dismiss insert failed (soft): ${error.message}`);
    } else {
      dismissed = true;
    }
  }

  const { error: delErr } = await sb.from('engine_videos').delete().eq('id', id);
  throwIfError(`deleteVideo(${id})`, delErr);

  events.emit('change', { kind: 'delete', row: { ...row, _deleted: true } });
  return { deleted: row, dismissed };
}

async function getDismissedTopicSet(persona) {
  const { data, error } = await sb
    .from('engine_dismissed_topics')
    .select('topic_norm')
    .eq('target_persona', persona);
  throwIfError(`getDismissedTopicSet(${persona})`, error);
  return new Set((data || []).map((r) => r.topic_norm));
}

async function getDismissedTopics(limit = 200) {
  const { data, error } = await sb
    .from('engine_dismissed_topics')
    .select('*')
    .order('dismissed_at', { ascending: false })
    .limit(limit);
  throwIfError('getDismissedTopics', error);
  return data || [];
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

async function insertSignal({ source, persona, title, url, score, raw_json }) {
  if (!PERSONAS.includes(persona)) {
    throw new TypeError(`insertSignal: persona must be one of ${PERSONAS.join(', ')}`);
  }
  if (typeof title !== 'string' || !title.trim()) {
    throw new TypeError('insertSignal: title must be a non-empty string');
  }
  const { error } = await sb.from('engine_signals').insert({
    source:   String(source || 'unknown'),
    persona,
    title:    title.trim(),
    url:      url ?? null,
    score:    Number.isFinite(score) ? Number(score) : null,
    raw:      coerceJson(raw_json),
  });
  throwIfError('insertSignal', error);
}

async function getRecentSignals(persona, { days = 14, limit = 50 } = {}) {
  const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  const { data, error } = await sb
    .from('engine_signals')
    .select('*')
    .eq('persona', persona)
    .gte('fetched_at', since)
    .order('score', { ascending: false })
    .order('fetched_at', { ascending: false })
    .limit(limit);
  throwIfError(`getRecentSignals(${persona})`, error);
  return data || [];
}

// ---------------------------------------------------------------------------
// Viral playbook — weekly teardown of what's winning per persona
// ---------------------------------------------------------------------------
// Soft-fail everywhere: if the engine_viral_playbook table doesn't exist yet
// (fresh deploy, pre-migration), both helpers warn and return null / no-op so
// the rest of the engine keeps working. Run scripts/create-viral-playbook-table.sql
// once to enable persistence.

// "relation does not exist" from PostgREST — harmless until the migration runs.
function isMissingTable(err) {
  const m = String(err?.message || err || '').toLowerCase();
  return m.includes('does not exist') || m.includes('not found') || err?.code === '42p01';
}

async function saveViralPlaybook(persona, { playbook, sample_count, source_window_days, notes } = {}) {
  if (!PERSONAS.includes(persona)) {
    throw new TypeError(`saveViralPlaybook: persona must be one of ${PERSONAS.join(', ')}`);
  }
  if (!playbook || typeof playbook !== 'object') {
    throw new TypeError('saveViralPlaybook: playbook must be an object');
  }
  const { data, error } = await sb
    .from('engine_viral_playbook')
    .insert({
      persona,
      playbook:            coerceJson(playbook),
      sample_count:        Number.isFinite(sample_count) ? Math.floor(sample_count) : 0,
      source_window_days:  Number.isFinite(source_window_days) ? Math.floor(source_window_days) : 7,
      notes:               notes ? String(notes).slice(0, 1000) : null,
    })
    .select('*')
    .single();
  if (error) {
    if (isMissingTable(error)) {
      console.warn('[db] saveViralPlaybook: engine_viral_playbook table missing — run scripts/create-viral-playbook-table.sql');
      return null;
    }
    throw new Error(`saveViralPlaybook(${persona}): ${error.message}`);
  }
  return data;
}

/**
 * Most recent playbook for a persona, or null if none / table missing / too old.
 * `maxAgeDays` (default 14) keeps us from injecting stale guidance into the
 * creative prompt if the weekly teardown job has been failing silently.
 */
async function getLatestPlaybook(persona, { maxAgeDays = 14 } = {}) {
  if (!PERSONAS.includes(persona)) {
    throw new TypeError(`getLatestPlaybook: persona must be one of ${PERSONAS.join(', ')}`);
  }
  const { data, error } = await sb
    .from('engine_viral_playbook')
    .select('*')
    .eq('persona', persona)
    .order('generated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    if (isMissingTable(error)) return null;
    console.warn(`[db] getLatestPlaybook(${persona}) soft-failed:`, error.message);
    return null;
  }
  if (!data) return null;
  const ageMs = Date.now() - new Date(data.generated_at).getTime();
  if (ageMs > maxAgeDays * 86_400_000) return null;
  return data;
}

// ---------------------------------------------------------------------------
// Shutdown (no-op — nothing to close for a stateless HTTPS client)
// ---------------------------------------------------------------------------
function close() { /* supabase-js has no pool to drain */ }

module.exports = {
  events,
  PERSONAS,
  STATUSES,
  PLATFORMS,

  // Videos / pipeline
  insertIdea,
  updateStatus,
  markFailed,
  markTransientFailure,
  clearCooldown,
  requeueRow,
  fetchOldestByStatus,
  getVideoById,
  getAllVideos,
  getCounts,

  // Settings
  getSetting,
  setSetting,
  getAllSettings,
  isApprovalRequired,
  setApprovalRequired,
  isGenerationEnabled,
  setGenerationEnabled,
  getMaxInFlight,
  setMaxInFlight,
  countInFlight,
  ensureDefaults,

  // Posting schedule
  isSchedulingEnabled,
  setSchedulingEnabled,
  getPostingSlotTimes,
  setPostingSlotTimes,
  getPostingTimezone,
  setPostingTimezone,
  getScheduledSlotSet,
  getUpcomingScheduled,
  getDueScheduled,
  publishScheduled,

  // Approval + rejection learning
  approveVideo,
  rejectVideo,
  getRecentRejections,
  getRecentApprovals,
  REJECTION_REASONS,
  APPROVAL_REASONS,

  // Delete + learn
  deleteVideo,
  getDismissedTopicSet,
  getDismissedTopics,
  normalizeTopic,

  // Signals
  insertSignal,
  getRecentSignals,

  // Viral playbook
  saveViralPlaybook,
  getLatestPlaybook,

  // Misc
  close,
  _backend: 'supabase',
  _dbPath:  SUPABASE_URL, // kept for diagnostic logs that used to read _dbPath
};
