/**
 * imagen.js — The Image Agent for the CFO Content Engine.
 *
 * Pulls every row at status='Audio_Generated', reads the `visual_prompts`
 * array from its script_json, and generates one photoreal 9:16 still per
 * prompt via the Gemini image API. Images land in:
 *
 *     output/images/{id}/01.png ... output/images/{id}/NN.png
 *
 * On success the row advances to status='Images_Generated'. The downstream
 * render stage then composites those stills into a Ken-Burns + crossfade
 * reel with the word-captions burned on top.
 *
 * Idempotency: before calling the API for a given slot, we check if that
 * image already exists on disk. If 03.png is already present from a prior
 * partial run, we skip it. This means a failure mid-batch costs at most
 * the few unfinished frames on retry, not the whole set.
 *
 * Credit-safe failures: if any prompt fails AND we end up with < MIN_OK
 * images, we throw — the row stays at Audio_Generated, orchestrator retry
 * guard counts it, auto-rejects after MAX_ROW_FAILS. If we got at least
 * MIN_OK images we advance anyway; the render stage will cycle through
 * whatever exists.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const https = require('node:https');

const db = require('./db');
const storage = require('./storage');
const { withRetry, isTransientHttpError } = require('./retry');

// -----------------------------------------------------------------------------
// Config
// -----------------------------------------------------------------------------
const GEMINI_API_KEY   = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
const GEMINI_IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';
const GEMINI_HOST      = 'generativelanguage.googleapis.com';
const GEMINI_TIMEOUT_MS = 60_000;

const PROJECT_ROOT = __dirname;
const IMAGES_DIR   = path.join(PROJECT_ROOT, 'output', 'images');

// Minimum successful images needed to advance the row. If we end up below
// this threshold after trying every prompt, the stage fails and the row
// stays at Audio_Generated for retry.
const MIN_OK = Number(process.env.IMAGEN_MIN_OK) || 3;

// Gentle per-prompt pacing so we don't spam free-tier quota.
const PER_PROMPT_DELAY_MS = 400;

// Legacy on-disk dir — only needed for STORAGE_BACKEND=local. In gcs mode
// storage.js routes through /tmp, so an EACCES here on read-only /app is safe.
try {
  if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });
} catch (err) {
  if (err.code !== 'EACCES') throw err;
}

// -----------------------------------------------------------------------------
// Prompt shaping — wrap the creative prompt in framing + negative cues so
// every image comes out the right aspect + style, regardless of what the
// LLM wrote. Persona-aware: SELLER must read as Amazon/Etsy/TikTok/Shopify
// commerce; BUILDER must read as BuilderCFO dashboard or builder jobsite.
// -----------------------------------------------------------------------------

const BASE_STYLE = [
  'Cinematic photography, 35mm full-frame, natural light, shallow depth of field where appropriate.',
  'Vertical 9:16 composition, subject placed for a portrait crop, rich tonal contrast.',
  'No people. No faces. No hands. No watermarks.',
  'Not a 3D render, not CGI, not an illustration, not a cartoon.',
].join(' ');

// SELLER anchor — every image is either (a) a SellerCFO dashboard/software shot
// with real SaaS UI, or (b) a platform commerce scene (Amazon/Etsy/TikTok/Shopify)
// tied to an emotional pain-to-relief beat. Both UI branding and platform
// branding are REQUIRED where natural — not forbidden.
const SELLER_ANCHOR = [
  'THIS IS A SELLER/CFO SCENE: the shot MUST be either (a) the SellerCFO software dashboard with real SaaS UI — SKU / channel margin charts, hero metrics color-coded green or red, the "SellerCFO" wordmark or "sellercfo.com" URL visible where natural — or (b) a platform commerce scene unmistakably set in Amazon/FBA, Etsy, TikTok Shop, or Shopify DTC.',
  'For dashboard shots: render believable modern SaaS UI. Clean sans-serif typography, bar charts or trend lines, one hero metric color-coded, sharp pixel-clean screen rendering. UI/text/wordmark are EXPECTED and REQUIRED here, not forbidden.',
  'For platform shots: platform identifiers are required where natural — the Prime-blue arrow-curve tape stripe on a brown Amazon mailer, an FBA poly-bag with a barcode suffocation label, kraft paper with twine and pressed flora for Etsy, a phone mounted vertically on a ring light for TikTok Shop, a custom-printed Shopify merchant mailer with a thermal shipping label. Each carries emotion — chaos for pain, relief/pride for solution.',
  'HARD BAN — reject generic office desks, laptops as the whole subject, coffee mugs, factory floors, assembly lines, stamping presses, product-on-white catalog shots, handshakes, skylines, boardrooms, and generic business stock. Also reject Shopify / Amazon Seller Central / Etsy Studio UI standing alone without SellerCFO — we are the solution.',
  'Sell SellerCFO as THE solution, and sell the emotion of finally knowing what makes money.',
].join(' ');

// BUILDER anchor — every image is EITHER a BuilderCFO dashboard/UI shot OR a
// builder-jobsite beat tied to emotion. UI, text, dashboard elements, and the
// BuilderCFO wordmark / topbuildercfo.com URL are required when rendering a
// Type A shot — NOT banned. Jobsite shots must carry a feeling (chaos / relief).
const BUILDER_ANCHOR = [
  'THIS IS A BUILDER/CFO SCENE: the shot MUST be either (a) the BuilderCFO software dashboard with real SaaS UI — charts, P&L tables, hero metric in red or green, the "BuilderCFO" wordmark or "topbuildercfo.com" URL visible where natural — or (b) a builder-jobsite moment tied to an emotional pain-to-relief beat.',
  'For dashboard shots: render believable modern SaaS UI. Clean sans-serif typography, bar charts or trend lines, one hero metric color-coded green or red, sharp pixel-clean screen rendering. UI/text/wordmark are EXPECTED and REQUIRED here, not forbidden.',
  'For jobsite shots: carry emotion. Chaos for pain (scattered lumber-yard receipts on a truck dashboard, a scratched-out whiteboard). Precision/relief for solution (framed high-end walls at magic hour, a level on fresh concrete, a walnut trailer desk at dusk).',
  'HARD BAN — reject tract housing, cookie-cutter subdivisions, men in suits, boardrooms, handshakes, city skylines, crane silhouettes, Home Depot / Hilti catalog vibes, and QuickBooks / Procore / Buildertrend UIs standing alone without BuilderCFO.',
  'Sell BuilderCFO as THE solution, and sell the emotion of finally seeing the numbers.',
].join(' ');

function buildImagePrompt(userPrompt, persona) {
  const anchor =
    persona === 'SELLER'  ? SELLER_ANCHOR  :
    persona === 'BUILDER' ? BUILDER_ANCHOR :
    '';
  return `${String(userPrompt).trim()}\n\n${BASE_STYLE}${anchor ? '\n\n' + anchor : ''}`;
}

// -----------------------------------------------------------------------------
// Gemini image call
// -----------------------------------------------------------------------------

/**
 * Call Gemini to generate one image. Returns a Buffer of PNG/JPEG bytes,
 * or throws if the API returned no image.
 */
function callGeminiImageOnce(prompt) {
  if (!GEMINI_API_KEY) return Promise.reject(new Error('GEMINI_API_KEY is not set'));

  const body = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    // gemini-2.5-flash-image requires IMAGE in responseModalities.
    generationConfig: {
      responseModalities: ['IMAGE'],
      temperature: 0.9,
    },
  });

  const options = {
    method: 'POST',
    hostname: GEMINI_HOST,
    path: `/v1beta/models/${encodeURIComponent(GEMINI_IMAGE_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`,
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    },
    timeout: GEMINI_TIMEOUT_MS,
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`Gemini image HTTP ${res.statusCode}: ${raw.slice(0, 400)}`));
        }
        try {
          const parsed = JSON.parse(raw);
          const parts = parsed?.candidates?.[0]?.content?.parts || [];
          const imgPart = parts.find((p) => p.inlineData?.data);
          if (!imgPart) {
            // Sometimes the model refuses and returns only a text explanation.
            const txt = parts.map((p) => p.text).filter(Boolean).join(' ').slice(0, 300);
            return reject(new Error(`Gemini returned no image data${txt ? `: ${txt}` : ''}`));
          }
          resolve(Buffer.from(imgPart.inlineData.data, 'base64'));
        } catch (err) {
          reject(new Error(`Failed to parse Gemini image response: ${err.message}`));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`Gemini image timeout after ${GEMINI_TIMEOUT_MS}ms`)));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Retrying wrapper — 5 attempts. Image model 503 spikes are the most
// common failure mode on shared credits, so this is where retries pay
// off most. Non-transient failures (bad prompt, safety refusal) fall
// through fast.
function callGeminiImage(prompt) {
  return withRetry(() => callGeminiImageOnce(prompt), {
    attempts: 5,
    retryable: isTransientHttpError,
    label: 'imagen/Gemini',
  });
}

// -----------------------------------------------------------------------------
// Per-row processing
// -----------------------------------------------------------------------------

function imageSlotKey(rowId, slotIndex) {
  // 01-based two-digit slot names so ffmpeg globs list them in order.
  const name = String(slotIndex + 1).padStart(2, '0') + '.png';
  return `images/${rowId}/${name}`;
}

function imageSlotPath(rowId, slotIndex) {
  // Back-compat: some callers still expect an absolute local path.
  // Resolve via storage so it works in both local and gcs modes.
  return storage.localPathFor(imageSlotKey(rowId, slotIndex));
}

function visualPromptsFromScript(scriptJson) {
  let s;
  try {
    s = typeof scriptJson === 'string' ? JSON.parse(scriptJson) : scriptJson;
  } catch (err) {
    throw new Error(`script_json is not valid JSON: ${err.message}`);
  }
  const list = Array.isArray(s?.visual_prompts) ? s.visual_prompts : [];
  const clean = list.map((p) => String(p || '').trim()).filter(Boolean);
  if (clean.length === 0) {
    throw new Error('script_json.visual_prompts is empty or missing');
  }
  return clean;
}

/**
 * Drain ONE Audio_Generated row into an Images_Generated row by generating
 * its visual_prompts as PNGs. Returns the updated DB row, or null if the
 * queue was empty.
 */
async function processOneAudio() {
  const row = await db.fetchOldestByStatus('Audio_Generated');
  if (!row) return null;
  return processAudioRow(row);
}

/**
 * Generate images for ONE specific Audio_Generated row. Used by the
 * dashboard "Run next stage" button so operators can push a targeted row
 * through image generation without waiting for the orchestrator's tick
 * or the queue order.
 */
async function processAudioRow(row) {
  if (!row) throw new Error('processAudioRow: row is required');
  if (row.status !== 'Audio_Generated') {
    throw new Error(`processAudioRow: row #${row.id} is in status "${row.status}", not Audio_Generated`);
  }

  const prompts = visualPromptsFromScript(row.script_json);

  let okCount = 0;
  const errors = [];

  for (let i = 0; i < prompts.length; i += 1) {
    const key = imageSlotKey(row.id, i);

    // Skip slots we already generated in a prior partial run. storage.exists
    // checks the active backend (local fs OR GCS) transparently.
    if (await storage.exists(key)) {
      okCount += 1;
      continue;
    }

    try {
      const buf = await callGeminiImage(buildImagePrompt(prompts[i], row.target_persona));
      await storage.putBytes(key, buf, { contentType: 'image/png' });
      okCount += 1;
    } catch (err) {
      errors.push({ slot: i + 1, error: err.message });
      // Don't bail — a later prompt may still succeed and push us over MIN_OK.
    }

    if (PER_PROMPT_DELAY_MS > 0 && i < prompts.length - 1) {
      await new Promise((r) => setTimeout(r, PER_PROMPT_DELAY_MS));
    }
  }

  if (okCount < MIN_OK) {
    const first = errors[0]?.error || 'no images succeeded';
    throw new Error(`image gen produced ${okCount}/${prompts.length} images (need ${MIN_OK}+). First error: ${first}`);
  }

  const updated = await db.updateStatus(row.id, 'Images_Generated');
  return updated;
}

// -----------------------------------------------------------------------------
// Batch + scheduler (symmetric with render.js / creative.js)
// -----------------------------------------------------------------------------

async function processAudioBatch({ max = Infinity } = {}) {
  const out = { processed: 0, ok: 0, failed: 0, errors: [] };
  while (out.processed < max) {
    const peek = await db.fetchOldestByStatus('Audio_Generated');
    if (!peek) break;
    out.processed += 1;
    try {
      await processOneAudio();
      out.ok += 1;
    } catch (err) {
      out.failed += 1;
      out.errors.push({ id: peek.id, error: err.message });
      break; // don't hot-loop a bad row
    }
  }
  return out;
}

let _timer = null;
function start({ intervalMs = 5 * 60 * 1000 } = {}) {
  stop();
  const tick = async () => {
    try {
      const r = await processAudioBatch();
      if (r.processed) console.log(`[imagen] processed=${r.processed} ok=${r.ok} failed=${r.failed}`);
      for (const e of r.errors) console.warn(`[imagen] #${e.id}: ${e.error}`);
    } catch (err) {
      console.error('[imagen] tick failed:', err.message);
    }
  };
  tick();
  _timer = setInterval(tick, intervalMs);
  return stop;
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

/**
 * Return all image paths for a given row, in slot order, that actually
 * exist on disk. Used by render.js to build the ffmpeg filtergraph.
 */
/**
 * Return all local image paths for a given row, in slot order. In gcs mode
 * this downloads missing images to TMP_ROOT before returning paths, so
 * ffmpeg can consume them as normal files. Local mode is zero-cost.
 */
async function imagesForRow(rowId) {
  const keys = await storage.list(`images/${rowId}/`);
  const imgKeys = keys.filter((k) => /\.(png|jpe?g|webp)$/i.test(k)).sort();
  const paths = [];
  for (const k of imgKeys) {
    paths.push(await storage.ensureLocal(k));
  }
  return paths;
}

module.exports = {
  processOneAudio,
  processAudioRow,
  processAudioBatch,
  imagesForRow,
  buildImagePrompt,
  visualPromptsFromScript,
  start,
  stop,
  IMAGES_DIR,
};

// -----------------------------------------------------------------------------
// Self-test — `node imagen.js`
// -----------------------------------------------------------------------------
if (require.main === module) {
  (async () => {
    console.log('--- Image Agent self-test ---');
    if (!GEMINI_API_KEY) {
      console.error('GEMINI_API_KEY is not set.');
      process.exit(1);
    }
    console.log('Model:', GEMINI_IMAGE_MODEL);
    console.log('DB before:', await db.getCounts());
    const res = await processAudioBatch({ max: 1 });
    console.log('Result:', res);
    console.log('DB after:', await db.getCounts());
  })();
}
