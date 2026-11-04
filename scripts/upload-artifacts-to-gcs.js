#!/usr/bin/env node
/**
 * upload-artifacts-to-gcs.js — one-shot migration of on-disk artifacts into
 * the GCS bucket, and rewrite of Supabase engine_videos.audio_path /
 * video_path columns from Windows absolute paths into storage keys.
 *
 * Before:
 *   audio_path = "C:\\Users\\you\\Downloads\\Content Engine\\output\\audio\\74.mp3"
 *   video_path = "C:\\Users\\you\\Downloads\\Content Engine\\output\\video\\74.mp4"
 *
 * After:
 *   audio_path = "audio/74.mp3"
 *   video_path = "video/74.mp4"
 *
 * Also uploads output/images/{id}/ trees (not persisted on the row; the
 * render stage lists them via storage.list).
 *
 * Idempotent — skips files that already exist in GCS at the same key.
 *
 * Run once:
 *   STORAGE_BACKEND=gcs node scripts/upload-artifacts-to-gcs.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('node:fs');
const path = require('node:path');
const { createClient } = require('@supabase/supabase-js');
const { Storage } = require('@google-cloud/storage');

const BUCKET = process.env.GCS_BUCKET || 'cs-cory-apps-cfo-engine';
const OUT_ROOT = path.join(__dirname, '..', 'output');

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } },
);
const bucket = new Storage().bucket(BUCKET);

// Helper: upload a single file if the remote key doesn't already exist.
async function uploadIfMissing(localPath, key) {
  const [exists] = await bucket.file(key).exists();
  if (exists) return 'skip';
  if (!fs.existsSync(localPath)) return 'missing';
  await bucket.upload(localPath, {
    destination: key,
    resumable: false,
    metadata: { cacheControl: 'public, max-age=86400' },
  });
  return 'uploaded';
}

// Recursively list files under a local dir as [{abs, rel}, ...]
function walk(dir, base = dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) out.push(...walk(abs, base));
    else out.push({ abs, rel: path.relative(base, abs).replace(/\\/g, '/') });
  }
  return out;
}

(async () => {
  console.log(`Uploading artifacts from ${OUT_ROOT} to gs://${BUCKET}`);

  // ---- 1. Upload every file under output/audio, output/video, output/images, output/subs ----
  const counts = { audio: 0, video: 0, images: 0, subs: 0, skipped: 0, missing: 0 };
  for (const sub of ['audio', 'video', 'images', 'subs']) {
    const subDir = path.join(OUT_ROOT, sub);
    const entries = walk(subDir);
    for (const { abs, rel } of entries) {
      const key = `${sub}/${rel}`;
      const result = await uploadIfMissing(abs, key);
      if (result === 'uploaded') counts[sub] = (counts[sub] || 0) + 1;
      else if (result === 'skip') counts.skipped += 1;
      else counts.missing += 1;
      if ((counts.audio + counts.video + counts.images + counts.subs) % 10 === 0) {
        process.stdout.write(
          `  audio=${counts.audio} video=${counts.video} images=${counts.images} subs=${counts.subs} skipped=${counts.skipped}\r`
        );
      }
    }
  }
  console.log(
    `\nUpload: audio=${counts.audio}  video=${counts.video}  images=${counts.images}  subs=${counts.subs}  skipped=${counts.skipped}  missing=${counts.missing}`
  );

  // ---- 2. Rewrite Supabase rows: audio_path + video_path -> storage keys ----
  const { data: rows, error } = await sb
    .from('engine_videos')
    .select('id, audio_path, video_path')
    .or('audio_path.not.is.null,video_path.not.is.null');
  if (error) throw new Error(`supabase select: ${error.message}`);

  console.log(`\nRewriting ${rows.length} row paths -> keys`);
  let rewritten = 0;
  for (const r of rows) {
    const update = {};
    if (r.audio_path && !/^audio\//i.test(r.audio_path)) {
      update.audio_path = `audio/${r.id}.mp3`;
    }
    if (r.video_path && !/^video\//i.test(r.video_path)) {
      update.video_path = `video/${r.id}.mp4`;
    }
    if (Object.keys(update).length === 0) continue;
    const { error: upErr } = await sb
      .from('engine_videos')
      .update(update)
      .eq('id', r.id);
    if (upErr) {
      console.error(`  id=${r.id} rewrite failed: ${upErr.message}`);
    } else {
      rewritten += 1;
    }
  }
  console.log(`Rewrote ${rewritten} rows.`);

  console.log('\nDONE');
})().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
