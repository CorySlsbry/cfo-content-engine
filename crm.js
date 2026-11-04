/**
 * crm.js — Content Engine ➜ Salisbury Bookkeeping bridge.
 *
 * When a video reaches Published status the orchestrator calls
 * `pushPublishedRow(row)` here. This module posts the campaign metadata
 * to the Salisbury site's /api/campaigns/ingest endpoint, which creates
 * or updates the public landing page at salisburybookkeeping.com/go/{slug}.
 *
 * The landing page captures leads and writes them back to the Salisbury
 * CRM with source_campaign_id pointing at the campaign we just created,
 * so attribution flows end-to-end: video → landing page → email lead.
 *
 * Failure mode: soft. If the ingest call fails we log and move on — the
 * video is already published; we don't want to stall the pipeline over a
 * CRM hiccup. The orchestrator can re-push manually via a dashboard button.
 */

const https = require('node:https');
const http = require('node:http');
const { URL } = require('node:url');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const SALISBURY_API_URL =
  process.env.SALISBURY_API_URL ||
  process.env.NEXT_PUBLIC_SITE_URL ||
  'https://salisburybookkeeping.com';

const CONTENT_ENGINE_SECRET = process.env.CONTENT_ENGINE_SECRET || '';
const INGEST_PATH = '/api/campaigns/ingest';
const REQUEST_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Script payload extraction
// ---------------------------------------------------------------------------

/**
 * Parse a row's script_json (stored as a JSON string or an object) and
 * return the fields the ingest endpoint needs. Never throws — returns
 * `null` if the script is unusable.
 */
function extractCampaignFields(row) {
  if (!row) return null;
  let script;
  try {
    script = typeof row.script_json === 'string' ? JSON.parse(row.script_json) : row.script_json;
  } catch {
    return null;
  }
  if (!script || typeof script !== 'object') return null;

  const landingSlug = String(script.landing_slug || '').trim().toLowerCase();
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(landingSlug) || landingSlug.length > 60) {
    return null;
  }

  // Extract the resource description from the framework named in the body.
  // Falls back to the topic if we can't find a framework reference.
  const framework = detectFrameworkName(script.body_text || '');
  const resourceDescription = framework || row.topic || 'the free resource';

  return {
    engine_video_id: row.id,
    persona: row.target_persona,
    topic: row.topic,
    landing_slug: landingSlug,
    hook: String(script.hook || '').trim(),
    body_text: String(script.body_text || '').trim() || undefined,
    call_to_action: String(script.call_to_action || '').trim() || undefined,
    resource_description: resourceDescription,
    video_url: row.video_path ? `/media/video/${row.id}.mp4` : undefined,
    metadata: {
      script_json: script,
      platform_posts: row.platform_posts || null,
      published_from_status: row.status,
      pushed_at: new Date().toISOString(),
    },
  };
}

// Try to pull the "named framework" the script introduces. The creative
// prompt tells the model to name ONE framework per video (e.g. "the
// 3-minute margin check"); we look for common phrasings.
function detectFrameworkName(bodyText) {
  const text = String(bodyText);
  const patterns = [
    /\bcalled\s+(?:the\s+|a\s+)?['"]?([^'".?!]{4,60})['"]?/i,
    /\b(?:the|our|my)\s+([A-Za-z0-9][A-Za-z0-9\s-]{3,40}(?:check|review|close|audit|worksheet|template|list|refresh|rundown|kill-list))/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m && m[1]) {
      const cleaned = m[1].replace(/\s+/g, ' ').trim();
      if (cleaned.length >= 4 && cleaned.length <= 60) return cleaned;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// HTTPS POST helper — no fetch dependency so this works on older Node too.
// ---------------------------------------------------------------------------
function postJson(urlStr, payload, headers) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(urlStr); } catch (e) { return reject(e); }
    const body = Buffer.from(JSON.stringify(payload));
    const client = url.protocol === 'http:' ? http : https;
    const req = client.request(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': body.length,
          'accept': 'application/json',
          ...headers,
        },
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        let chunks = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (chunks += c));
        res.on('end', () => {
          let parsed = null;
          try { parsed = chunks ? JSON.parse(chunks) : null; } catch { /* text body */ }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ status: res.statusCode, body: parsed });
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${chunks.slice(0, 300)}`));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error(`timeout after ${REQUEST_TIMEOUT_MS}ms`)));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Public: push one row
// ---------------------------------------------------------------------------

/**
 * Push a single Published row to Salisbury's content_campaigns. Returns:
 *   { ok: true,  landing_url, campaign }
 *   { ok: false, error }
 */
async function pushPublishedRow(row) {
  if (!CONTENT_ENGINE_SECRET) {
    return { ok: false, error: 'CONTENT_ENGINE_SECRET not set — skipping CRM push' };
  }
  const payload = extractCampaignFields(row);
  if (!payload) {
    return { ok: false, error: `row #${row?.id} has no valid script_json/landing_slug` };
  }
  const url = SALISBURY_API_URL.replace(/\/$/, '') + INGEST_PATH;

  try {
    const res = await postJson(url, payload, {
      'x-content-engine-secret': CONTENT_ENGINE_SECRET,
    });
    return {
      ok: true,
      landing_url: res.body?.landing_url || null,
      campaign: res.body?.campaign || null,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Build the public landing URL for a row without calling the site.
 * Used by the dashboard's "Copy landing URL" button so operators can paste
 * the link into a video's first/pinned comment.
 */
function landingUrlForRow(row) {
  if (!row?.script_json) return null;
  let script;
  try {
    script = typeof row.script_json === 'string' ? JSON.parse(row.script_json) : row.script_json;
  } catch { return null; }
  const slug = String(script?.landing_slug || '').trim().toLowerCase();
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) return null;
  return SALISBURY_API_URL.replace(/\/$/, '') + '/go/' + slug;
}

module.exports = {
  pushPublishedRow,
  landingUrlForRow,
  extractCampaignFields, // exported for tests
};
