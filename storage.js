/**
 * storage.js — Artifact storage abstraction for the CFO Content Engine.
 *
 * Hides where audio/images/video bytes actually live. Callers deal in KEYS
 * (e.g. "audio/74.mp3"), never absolute paths. This lets us:
 *
 *   - Run locally (artifacts in ./output/)
 *   - Run on Cloud Run (artifacts in GCS bucket cs-cory-apps-cfo-engine)
 *
 * ...without changing the stage processors.
 *
 * Mode is chosen by the STORAGE_BACKEND env var:
 *   STORAGE_BACKEND=local     — write/read ./output/<key>  (default when unset)
 *   STORAGE_BACKEND=gcs       — write/read gs://$GCS_BUCKET/<key>
 *
 * Keys used by the rest of the engine:
 *   audio/<id>.mp3
 *   images/<id>/01.png ... 05.png
 *   video/<id>.mp4
 *   subs/<id>.ass
 *
 * When you write, you give a local temp file plus a key; we upload and return
 * the key. When you read, we hand back a local temp path (downloading if
 * needed). When you need a URL for the dashboard / email, we return either
 * a localhost /media URL or a GCS signed URL depending on mode.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const BACKEND = (process.env.STORAGE_BACKEND || 'local').toLowerCase();
const BUCKET  = process.env.GCS_BUCKET || 'cs-cory-apps-cfo-engine';

// Base dirs used in both modes. The `local` backend uses <PROJECT>/output/*
// as the actual store; the `gcs` backend uses os.tmpdir() as a staging area
// between ffmpeg and the bucket (Cloud Run's /app/ is read-only; only /tmp
// is writable, which is what os.tmpdir() points at).
const PROJECT_ROOT = path.join(__dirname);
// In gcs mode, LOCAL_ROOT is never actually read/written — we point it at
// TMP_ROOT so any stale code path that touches it degrades gracefully instead
// of EACCES-ing on a read-only container fs.
const TMP_ROOT   = path.join(os.tmpdir(), 'cfo-engine');
const LOCAL_ROOT = (BACKEND === 'gcs')
  ? TMP_ROOT
  : path.join(PROJECT_ROOT, 'output');

for (const d of [LOCAL_ROOT, TMP_ROOT]) {
  try {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  } catch (err) {
    // Cloud Run marks /app as read-only; only /tmp is writable. If we can't
    // create LOCAL_ROOT it's because we're in a read-only env AND we're not
    // really going to use it. Log and proceed.
    if (err.code !== 'EACCES') throw err;
    console.warn(`[storage] could not mkdir ${d} (${err.code}); continuing`);
  }
}

// Lazy GCS client so the module loads fine without the dep when STORAGE_BACKEND=local.
let _gcsBucket = null;
function gcs() {
  if (_gcsBucket) return _gcsBucket;
  const { Storage } = require('@google-cloud/storage');
  const storage = new Storage(); // uses ADC — on Cloud Run this is the service account
  _gcsBucket = storage.bucket(BUCKET);
  return _gcsBucket;
}

// ---------------------------------------------------------------------------
// Key ↔ path helpers
// ---------------------------------------------------------------------------

/** Absolute local path for a key. For `local` mode this is where the file
 *  actually lives; for `gcs` mode this is a tmp staging path. */
function localPathFor(key, { staging = false } = {}) {
  if (!isSafeKey(key)) throw new Error(`storage: unsafe key ${JSON.stringify(key)}`);
  const root = (BACKEND === 'gcs' || staging) ? TMP_ROOT : LOCAL_ROOT;
  const full = path.join(root, key);
  const dir = path.dirname(full);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return full;
}

/** Only allow relative, no-`..`, no-backslash keys. Stops directory-escape attacks
 *  if a key is ever derived from user input (today they're not, but cheap to enforce). */
function isSafeKey(k) {
  return typeof k === 'string'
      && k.length > 0
      && k.length < 300
      && !/(^|\/)\.{1,2}(\/|$)/.test(k)
      && !/[\\:]/.test(k)
      && !k.startsWith('/');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Write Buffer bytes to `key`. Returns the key so callers can persist it.
 * Used by the TTS / image-gen paths where we have the bytes in memory and
 * want to skip the "write to tmp then upload" dance.
 */
async function putBytes(key, buf, { contentType } = {}) {
  if (!isSafeKey(key)) throw new Error(`storage: unsafe key ${JSON.stringify(key)}`);
  if (BACKEND === 'gcs') {
    await gcs().file(key).save(buf, {
      contentType: contentType || guessContentType(key),
      resumable: false,
      metadata: { cacheControl: 'public, max-age=86400' },
    });
  } else {
    const full = localPathFor(key);
    await fsp.writeFile(full, buf);
  }
  return key;
}

/**
 * Copy a file that's already on local disk into the store. Used by ffmpeg-produced
 * artifacts — ffmpeg wrote to a local path, we lift it into GCS (or leave it where
 * it is for local mode).
 */
async function putFile(key, localPath, { contentType, deleteSource = false } = {}) {
  if (!isSafeKey(key)) throw new Error(`storage: unsafe key ${JSON.stringify(key)}`);
  if (BACKEND === 'gcs') {
    await gcs().upload(localPath, {
      destination: key,
      contentType: contentType || guessContentType(key),
      resumable: false,
      metadata: { cacheControl: 'public, max-age=86400' },
    });
    if (deleteSource) await fsp.unlink(localPath).catch(() => undefined);
  } else {
    const full = localPathFor(key);
    if (path.resolve(localPath) === path.resolve(full)) return key; // already in place
    await fsp.copyFile(localPath, full);
    if (deleteSource) await fsp.unlink(localPath).catch(() => undefined);
  }
  return key;
}

/**
 * Ensure the bytes for `key` are available as a local file. In gcs mode we
 * download to TMP_ROOT; in local mode we just return the existing path.
 * Returns the local path.
 */
async function ensureLocal(key) {
  if (!isSafeKey(key)) throw new Error(`storage: unsafe key ${JSON.stringify(key)}`);
  const full = localPathFor(key, { staging: BACKEND === 'gcs' });
  if (BACKEND === 'gcs') {
    if (!fs.existsSync(full)) {
      await gcs().file(key).download({ destination: full });
    }
  }
  // local mode: the file is already the local path — caller reads from it directly.
  return full;
}

/**
 * Does this key exist in the store?
 */
async function exists(key) {
  if (!isSafeKey(key)) return false;
  if (BACKEND === 'gcs') {
    const [e] = await gcs().file(key).exists();
    return e;
  }
  return fs.existsSync(localPathFor(key));
}

/**
 * Delete. Non-fatal if missing.
 */
async function remove(key) {
  if (!isSafeKey(key)) return;
  if (BACKEND === 'gcs') {
    await gcs().file(key).delete({ ignoreNotFound: true }).catch(() => undefined);
  } else {
    await fsp.unlink(localPathFor(key)).catch(() => undefined);
  }
}

/**
 * List keys under a prefix. Returns just the key strings, sorted.
 */
async function list(prefix) {
  if (BACKEND === 'gcs') {
    const [files] = await gcs().getFiles({ prefix });
    return files.map((f) => f.name).sort();
  }
  const dir = path.join(LOCAL_ROOT, prefix);
  if (!fs.existsSync(dir)) return [];
  const walk = (d, acc = []) => {
    for (const name of fs.readdirSync(d)) {
      const abs = path.join(d, name);
      const stat = fs.statSync(abs);
      if (stat.isDirectory()) walk(abs, acc);
      else acc.push(path.relative(LOCAL_ROOT, abs).replace(/\\/g, '/'));
    }
    return acc;
  };
  return walk(dir).sort();
}

/**
 * URL for the dashboard / delivery emails. In local mode returns a
 * relative /media/<key> URL served by Express. In gcs mode returns a
 * signed URL valid for `expiresSec` (default 1 hour).
 *
 * Signed URLs work from anywhere (IG/TT/YT viewers, dashboard, etc.) and
 * don't require the bucket to be public.
 */
async function urlFor(key, { expiresSec = 3600 } = {}) {
  if (!isSafeKey(key)) throw new Error(`storage: unsafe key ${JSON.stringify(key)}`);
  if (BACKEND === 'gcs') {
    const [url] = await gcs().file(key).getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: Date.now() + expiresSec * 1000,
    });
    return url;
  }
  return `/media/${key}`;
}

// ---------------------------------------------------------------------------
// Content-type guesser (lightweight; no mime dependency)
// ---------------------------------------------------------------------------
function guessContentType(key) {
  const ext = path.extname(key).toLowerCase();
  return {
    '.mp3':  'audio/mpeg',
    '.mp4':  'video/mp4',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.ass':  'text/x-ssa',
    '.srt':  'application/x-subrip',
    '.json': 'application/json',
    '.txt':  'text/plain',
  }[ext] || 'application/octet-stream';
}

module.exports = {
  backend: BACKEND,
  bucket:  BUCKET,
  putBytes,
  putFile,
  ensureLocal,
  exists,
  remove,
  list,
  urlFor,
  // Exposed for stage modules that need to hand ffmpeg a staging path
  // before calling putFile.
  localPathFor,
  TMP_ROOT,
  LOCAL_ROOT,
};
