#!/usr/bin/env node
/**
 * migrate-sqlite-to-supabase.js — one-shot port of local SQLite rows into
 * the shared Supabase project.
 *
 * Reads data/content_engine.db via node:sqlite (sync) and inserts into:
 *   videos            -> engine_videos
 *   dismissed_topics  -> engine_dismissed_topics
 *   settings          -> engine_settings
 *
 * Signals (580+ rows of RSS/Reddit cache) are intentionally NOT migrated —
 * the researcher will rebuild them on its next tick, and they're noise in
 * production.
 *
 * Run once:
 *   node scripts/migrate-sqlite-to-supabase.js
 *
 * Safe to re-run: uses upsert on (original SQLite id) so duplicate runs
 * don't create ghost rows. Preserves SQLite ids to keep existing output
 * directory names (output/images/{id}/, output/audio/{id}.mp3) addressable.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createClient } = require('@supabase/supabase-js');

const SQLITE_PATH = path.join(__dirname, '..', 'data', 'content_engine.db');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const sql = new DatabaseSync(SQLITE_PATH);

// Batch size — supabase-js can handle 500+ in a single upsert but network
// latency on a big batch adds up; chunking makes failures easier to isolate.
const BATCH = 50;

// Parse a SQLite JSON-in-TEXT cell back into a JS object; null if empty.
function parseJson(v) {
  if (v == null || v === '') return null;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return null; }
}

// SQLite's datetime('now') produces "YYYY-MM-DD HH:MM:SS" (UTC, no TZ).
// Postgres timestamptz needs an ISO string; tack on Z and Postgres is happy.
function toIso(v) {
  if (!v) return new Date().toISOString();
  if (typeof v !== 'string') return new Date(v).toISOString();
  // Already ISO? Return as-is.
  if (v.includes('T')) return v;
  return v.replace(' ', 'T') + 'Z';
}

async function migrateVideos() {
  const rows = sql.prepare('SELECT * FROM videos ORDER BY id ASC').all();
  console.log(`[videos] ${rows.length} to migrate`);

  const mapped = rows.map((r) => ({
    id: r.id,                                       // preserve SQLite ids
    target_persona: r.target_persona,
    topic: r.topic,
    script_json:    parseJson(r.script_json),
    audio_path:     r.audio_path || null,
    video_path:     r.video_path || null,
    platforms:      parseJson(r.platforms),
    platform_posts: parseJson(r.platform_posts),
    source_signals: parseJson(r.source_signals),
    fail_count:     r.fail_count || 0,
    last_error:     r.last_error || null,
    status:         r.status,
    created_at:     toIso(r.created_at),
    updated_at:     toIso(r.updated_at),
  }));

  let ok = 0, failed = 0;
  for (let i = 0; i < mapped.length; i += BATCH) {
    const chunk = mapped.slice(i, i + BATCH);
    const { error } = await sb.from('engine_videos').upsert(chunk, { onConflict: 'id' });
    if (error) {
      console.error(`[videos] batch ${i}-${i + chunk.length} FAILED: ${error.message}`);
      failed += chunk.length;
    } else {
      ok += chunk.length;
      process.stdout.write(`  [videos] ${ok}/${mapped.length}\r`);
    }
  }
  console.log(`\n[videos] ok=${ok} failed=${failed}`);

  // Reset the serial sequence so the next INSERT picks up after the highest
  // migrated id. Without this, new inserts start at 1 and collide.
  const maxId = mapped.reduce((m, r) => Math.max(m, r.id), 0);
  if (maxId > 0) await resetSequence(maxId);
}

async function resetSequence(maxId) {
  // Supabase-js has no direct "execute raw SQL" — we rely on a helper RPC
  // we add below. If that RPC doesn't exist yet, fall back to manual SQL
  // advice printed to stdout.
  const { error } = await sb.rpc('engine_set_videos_id_seq', { p_value: maxId });
  if (error) {
    console.warn(
      `[seq] could not auto-reset engine_videos id sequence: ${error.message}\n` +
      `      Run this SQL in the Supabase SQL editor:\n` +
      `      SELECT setval(pg_get_serial_sequence('public.engine_videos', 'id'), ${maxId});`
    );
  } else {
    console.log(`[seq] engine_videos id sequence reset to ${maxId}`);
  }
}

async function migrateDismissed() {
  const rows = sql.prepare('SELECT * FROM dismissed_topics ORDER BY id ASC').all();
  console.log(`[dismissed] ${rows.length} to migrate`);
  const mapped = rows.map((r) => ({
    id:              r.id,
    original_id:     r.original_id,
    target_persona:  r.target_persona,
    topic:           r.topic,
    topic_norm:      r.topic_norm,
    reason:          r.reason || null,
    dismissed_at:    toIso(r.dismissed_at),
  }));
  if (mapped.length === 0) return;
  const { error } = await sb.from('engine_dismissed_topics').upsert(mapped, { onConflict: 'id' });
  if (error) console.error(`[dismissed] FAILED: ${error.message}`);
  else console.log(`[dismissed] ok=${mapped.length}`);
}

async function migrateSettings() {
  const rows = sql.prepare('SELECT key, value FROM settings').all();
  console.log(`[settings] ${rows.length} to migrate`);
  if (rows.length === 0) return;
  const { error } = await sb.from('engine_settings').upsert(rows, { onConflict: 'key' });
  if (error) console.error(`[settings] FAILED: ${error.message}`);
  else {
    console.log(`[settings] ok=${rows.length}`);
    for (const r of rows) console.log(`  ${r.key} = ${r.value}`);
  }
}

async function verify() {
  const videosCount = sql.prepare('SELECT COUNT(*) AS n FROM videos').get().n;
  const { count: sbVideos } = await sb
    .from('engine_videos')
    .select('id', { count: 'exact', head: true });
  const { count: sbDismissed } = await sb
    .from('engine_dismissed_topics')
    .select('id', { count: 'exact', head: true });
  const { count: sbSettings } = await sb
    .from('engine_settings')
    .select('key', { count: 'exact', head: true });
  console.log('\n--- VERIFY ---');
  console.log(`videos:     sqlite=${videosCount}  supabase=${sbVideos}  ${videosCount === sbVideos ? 'OK' : 'MISMATCH'}`);
  console.log(`dismissed:  supabase=${sbDismissed}`);
  console.log(`settings:   supabase=${sbSettings}`);
}

(async () => {
  console.log('MIGRATION START');
  console.log('  from:', SQLITE_PATH);
  console.log('  to:  ', SUPABASE_URL);
  console.log('');
  await migrateVideos();
  await migrateDismissed();
  await migrateSettings();
  await verify();
  console.log('\nMIGRATION DONE');
})().catch((e) => {
  console.error('MIGRATION FAILED:', e);
  process.exit(1);
});
