/**
 * heygen.js — HeyGen Avatar IV integration (DORMANT BY DEFAULT).
 *
 * Flip the switch by setting HEYGEN_ENABLED=true in the service env AND
 * providing HEYGEN_API_KEY + HEYGEN_TALKING_PHOTO_ID. Until then every
 * function in this module short-circuits to `enabled=false` and the
 * orchestrator stays on the current ffmpeg + images render path.
 *
 * When enabled, the render stage runs:
 *   Audio_Generated row
 *     ↓
 *   submitAvatarVideo({ audioUrl, talkingPhotoId })
 *     → POST /v2/video/generate
 *     → returns { video_id }
 *     ↓
 *   (await webhook OR poll /v1/video_status.get)
 *     ↓
 *   downloadToGcs({ videoId, destKey })
 *     → stream HeyGen's signed URL into our bucket
 *     ↓
 *   db.updateStatus(id, 'Rendered', { video_path: 'video/{id}.mp4' })
 *
 * The current imagen + ffmpeg stages are bypassed entirely when this path
 * is active — Avatar IV delivers the whole rendered mp4 with lip-sync,
 * facial motion, and natural gestures.
 *
 * Documentation used:
 *   - https://docs.heygen.com/reference/create-an-avatar-video-v2
 *   - https://docs.heygen.com/reference/video-status
 *   - https://docs.heygen.com/docs/using-audio-source-as-voice
 *   - https://docs.heygen.com/docs/using-heygens-webhook-events
 *   - https://www.heygen.com/blog/announcing-the-avatar-iv-api
 *   - https://help.heygen.com/en/articles/11269603-heygen-avatar-iv-complete-guide
 *   - https://www.heygen.com/api-pricing
 *
 * Cost model (at time of writing): Avatar IV = 1 credit / 10s of output.
 * Pro API plan is $0.99/credit -> ~$5.94 per minute. Our ~45s videos run
 * ~4.5 credits each, so roughly $4.46/video on Pro or $2.23 on Scale.
 */

const https = require('node:https');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { withRetry, isTransientHttpError } = require('./retry');

// ---------------------------------------------------------------------------
// Config — all env-gated, default OFF.
// ---------------------------------------------------------------------------

const ENABLED            = String(process.env.HEYGEN_ENABLED || 'false').toLowerCase() === 'true';
const API_KEY            = process.env.HEYGEN_API_KEY || '';
const TALKING_PHOTO_ID   = process.env.HEYGEN_TALKING_PHOTO_ID || '';
const WEBHOOK_SECRET     = process.env.HEYGEN_WEBHOOK_SECRET || '';
// 9:16 vertical by default — matches the rest of our pipeline. Override
// via env if you ever want to render horizontal for YouTube long-form.
const DIMENSION_W        = Number(process.env.HEYGEN_WIDTH)  || 1080;
const DIMENSION_H        = Number(process.env.HEYGEN_HEIGHT) || 1920;
// v2/video/av4/generate is the newer dedicated Avatar IV path; v2/video/generate
// + use_avatar_iv_model=true works on every account that has Avatar IV enabled
// and is the stable default across v1 and v2 keys.
const API_HOST           = 'api.heygen.com';
const GENERATE_PATH      = '/v2/video/generate';
const STATUS_PATH        = '/v1/video_status.get';
const WEBHOOK_LIST_PATH  = '/v1/webhook/endpoint.list';
const WEBHOOK_ADD_PATH   = '/v1/webhook/endpoint.add';
const HTTP_TIMEOUT_MS    = 30_000;

function assertEnabled() {
  if (!ENABLED) throw new Error('heygen: HEYGEN_ENABLED is false');
  if (!API_KEY) throw new Error('heygen: HEYGEN_API_KEY is not set');
}

// ---------------------------------------------------------------------------
// Low-level HTTPS helpers
// ---------------------------------------------------------------------------

function request({ method, path, body, isBinary = false }) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const opts = {
      method,
      hostname: API_HOST,
      path,
      headers: {
        'x-api-key': API_KEY,
        accept: 'application/json',
        ...(payload ? {
          'content-type': 'application/json',
          'content-length': payload.length,
        } : {}),
      },
      timeout: HTTP_TIMEOUT_MS,
    };
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(
            `HeyGen HTTP ${res.statusCode} ${method} ${path}: ${buf.toString('utf8').slice(0, 400)}`
          ));
        }
        if (isBinary) return resolve({ statusCode: res.statusCode, body: buf, headers: res.headers });
        try { resolve({ statusCode: res.statusCode, body: JSON.parse(buf.toString('utf8')) }); }
        catch (err) { reject(new Error(`HeyGen parse failed: ${err.message}`)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`HeyGen timeout ${method} ${path}`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function retryable(fn, label) {
  return withRetry(fn, { attempts: 5, retryable: isTransientHttpError, label });
}

// ---------------------------------------------------------------------------
// Submit a video generation request.
//   audioUrl      — public HTTPS URL to the mp3 HeyGen should lip-sync to.
//                   Our GCS signed URLs work; they must stay valid long enough
//                   for HeyGen to fetch them (signed URLs are 1h by default —
//                   plenty since HeyGen pulls immediately on submit).
//   talkingPhotoId- the Avatar IV-enabled Talking Photo id, from HeyGen's
//                   voice/avatar library. Required.
//   title         — shown in the HeyGen dashboard for humans; optional.
//   callbackId    — optional tag we get back on the webhook so we can
//                   correlate. Pass the engine video id.
//
// Returns { video_id } which we persist so we can reconcile webhook events
// or poll the status endpoint for progress.
// ---------------------------------------------------------------------------
async function submitAvatarVideo({ audioUrl, talkingPhotoId, title, callbackId }) {
  assertEnabled();
  if (!audioUrl) throw new Error('heygen.submitAvatarVideo: audioUrl is required');
  const photoId = talkingPhotoId || TALKING_PHOTO_ID;
  if (!photoId) throw new Error('heygen.submitAvatarVideo: talkingPhotoId (or HEYGEN_TALKING_PHOTO_ID) is required');

  const body = {
    video_inputs: [
      {
        character: {
          type: 'talking_photo',
          talking_photo_id: photoId,
          // The magic flag that upgrades this request to Avatar IV — more
          // expressive lip-sync + natural head motion + hand gestures vs the
          // legacy "Unlimited" motion engine.
          use_avatar_iv_model: true,
          scale: 1.0,
          talking_style: 'expressive',
          expression: 'default',
        },
        voice: {
          type: 'audio',
          audio_url: audioUrl,
        },
        background: { type: 'color', value: '#0b1120' }, // matches dashboard dark theme
      },
    ],
    dimension: { width: DIMENSION_W, height: DIMENSION_H },
    title: title || 'CFO Engine Avatar IV Video',
    callback_id: callbackId ? String(callbackId) : undefined,
  };

  const res = await retryable(
    () => request({ method: 'POST', path: GENERATE_PATH, body }),
    'heygen/submit'
  );
  const id = res.body?.data?.video_id;
  if (!id) throw new Error(`heygen.submitAvatarVideo: response missing data.video_id — ${JSON.stringify(res.body).slice(0, 300)}`);
  return { video_id: id };
}

// ---------------------------------------------------------------------------
// Poll status. Returns the raw HeyGen response body — callers check
// body.data.status for 'pending' | 'processing' | 'completed' | 'failed'.
// On 'completed', body.data.video_url is a 7-day signed download URL.
// ---------------------------------------------------------------------------
async function getVideoStatus(videoId) {
  assertEnabled();
  if (!videoId) throw new Error('heygen.getVideoStatus: videoId is required');
  const res = await retryable(
    () => request({ method: 'GET', path: `${STATUS_PATH}?video_id=${encodeURIComponent(videoId)}` }),
    'heygen/status'
  );
  return res.body?.data || res.body;
}

// ---------------------------------------------------------------------------
// Poll loop helper. Used only when webhooks aren't wired up — prefer the
// webhook path since it doesn't burn cycles.
//
// Backoff: 5s, 10s, 15s, 20s, ... capped at 60s. Aborts after timeoutMs.
// ---------------------------------------------------------------------------
async function waitForCompletion(videoId, { timeoutMs = 15 * 60_000 } = {}) {
  const start = Date.now();
  let delay = 5_000;
  while (true) {
    const s = await getVideoStatus(videoId);
    if (s?.status === 'completed') return s;
    if (s?.status === 'failed')    throw new Error(`heygen: video ${videoId} failed — ${s.msg || s.error || 'no reason'}`);
    if (Date.now() - start > timeoutMs) {
      throw new Error(`heygen.waitForCompletion: timed out after ${timeoutMs}ms (last status=${s?.status})`);
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay + 5_000, 60_000);
  }
}

// ---------------------------------------------------------------------------
// Stream HeyGen's completed-video URL into a destination file. HeyGen's
// URLs are CDN-backed S3 and work with a plain GET.
// ---------------------------------------------------------------------------
function downloadToFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`heygen.downloadToFile: HTTP ${res.statusCode} for ${url}`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(destPath)));
    }).on('error', (err) => {
      fs.unlink(destPath, () => reject(err));
    });
  });
}

// ---------------------------------------------------------------------------
// Webhook verification + parsing.
//
// HeyGen's signature scheme isn't fully documented at docs.heygen.com — the
// webhooks guide describes event shapes but doesn't spec the signature
// header. Two reasonable guesses based on industry convention:
//
//   1. x-heygen-signature: hex(HMAC_SHA256(body, WEBHOOK_SECRET))
//   2. signature header is a JWT signed with the secret
//
// We try #1 (standard pattern). When we get the real scheme from HeyGen
// support or observe their actual request headers, update `verifySignature`.
// If WEBHOOK_SECRET is unset, signature check is SKIPPED (dev mode) but
// we log a warning so we don't silently accept unauthenticated webhooks in
// production.
//
// In all cases, the POST body is JSON with shape:
//   { event_type: 'avatar_video.success' | 'avatar_video.fail',
//     event_data: { video_id, url?, msg?, callback_id?, ... } }
// ---------------------------------------------------------------------------
function verifySignature({ rawBody, signatureHeader }) {
  if (!WEBHOOK_SECRET) {
    console.warn('[heygen] HEYGEN_WEBHOOK_SECRET not set — webhook signature NOT verified');
    return true; // accept; operator is in dev mode
  }
  if (!signatureHeader) return false;
  const expected = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');
  // Support headers sent as "sha256=..." or bare hex.
  const provided = signatureHeader.replace(/^sha256=/i, '').trim();
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(provided, 'utf8'), Buffer.from(expected, 'utf8'));
}

/**
 * Parse a HeyGen webhook POST. Caller passes the raw body string (NOT the
 * parsed JSON — we need raw bytes for signature check) plus the request
 * headers object. Returns:
 *   { ok: true,  event, data } on success
 *   { ok: false, error }       on signature or parse failure
 */
function parseWebhook({ rawBody, headers }) {
  const sig = headers?.['x-heygen-signature'] || headers?.['x-hub-signature-256'] || '';
  if (!verifySignature({ rawBody, signatureHeader: sig })) {
    return { ok: false, error: 'invalid signature' };
  }
  let body;
  try { body = JSON.parse(rawBody); }
  catch (err) { return { ok: false, error: `bad JSON: ${err.message}` }; }
  const event = body?.event_type || body?.type;
  const data = body?.event_data || body?.data || body;
  if (!event) return { ok: false, error: `missing event_type in payload` };
  return { ok: true, event, data };
}

// ---------------------------------------------------------------------------
// Register our webhook URL with HeyGen. One-time setup — idempotent if the
// URL is already registered for the same events. Safe to call on boot.
// ---------------------------------------------------------------------------
async function ensureWebhookRegistered(publicUrl) {
  assertEnabled();
  if (!publicUrl) throw new Error('heygen.ensureWebhookRegistered: publicUrl required');

  // Check existing.
  const list = await retryable(
    () => request({ method: 'GET', path: WEBHOOK_LIST_PATH }),
    'heygen/webhook-list'
  );
  const existing = (list.body?.data || []).find((w) => w?.url === publicUrl);
  if (existing) return { id: existing.endpoint_id || existing.id, already: true };

  const res = await retryable(
    () => request({
      method: 'POST',
      path: WEBHOOK_ADD_PATH,
      body: {
        url: publicUrl,
        events: ['avatar_video.success', 'avatar_video.fail'],
      },
    }),
    'heygen/webhook-add'
  );
  return { id: res.body?.data?.endpoint_id || res.body?.data?.id, already: false };
}

// ---------------------------------------------------------------------------
// Module export.
// ---------------------------------------------------------------------------
module.exports = {
  // Feature flag — callers check this before exercising any functionality.
  enabled: ENABLED,
  hasApiKey: !!API_KEY,

  // Video ops
  submitAvatarVideo,
  getVideoStatus,
  waitForCompletion,
  downloadToFile,

  // Webhook ops
  parseWebhook,
  ensureWebhookRegistered,

  // Exposed for diagnostics + tests
  _request: request,
  config: {
    enabled: ENABLED,
    hasApiKey: !!API_KEY,
    hasTalkingPhotoId: !!TALKING_PHOTO_ID,
    hasWebhookSecret: !!WEBHOOK_SECRET,
    dimension: { width: DIMENSION_W, height: DIMENSION_H },
    endpoints: {
      generate: `https://${API_HOST}${GENERATE_PATH}`,
      status:   `https://${API_HOST}${STATUS_PATH}`,
    },
  },
};
