/**
 * packager.js — The Packager Agent.
 *
 * Takes a Rendered video and writes the platform-specific post copy
 * (caption, hashtags, CTA) for each target platform. Outputs are stored
 * on the row as `platform_posts` JSON; status advances to
 * `Pending_Approval` (or `Published` directly if Full Auto is on — that
 * decision is made by the orchestrator, not here).
 *
 * Uses the same Gemini infrastructure as creative.js with a different
 * system prompt and responseSchema tuned for short-form social copy.
 *
 * Platform rules baked into the schema description:
 *   TIKTOK           — caption ≤ 150 chars, 3–5 hashtags, hook-first,
 *                      peer-to-peer tone
 *   YOUTUBE_SHORTS   — title ≤ 60 chars, description 2–4 sentences,
 *                      5–10 hashtags
 *   INSTAGRAM_REELS  — caption 120–220 chars, 5–10 hashtags, line breaks
 *                      ok, one CTA
 */

const https = require('node:https');
const { withRetry, isTransientHttpError } = require('./retry');
const db = require('./db');
const llm = require('./llm');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
const GEMINI_MODEL   = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_HOST    = 'generativelanguage.googleapis.com';
const GEMINI_TIMEOUT_MS = 45_000;

const DEFAULT_PLATFORMS = ['TIKTOK', 'YOUTUBE_SHORTS', 'INSTAGRAM_REELS'];

// -----------------------------------------------------------------------------
// Prompts
// -----------------------------------------------------------------------------

const GLOBAL_RULES = `
GLOBAL RULES:
- No corporate jargon. No "synergy", "solutions", "leverage", "unlock", "best-in-class".
- Never write the phrase "At Salisbury".
- Every caption leads with the hook — first 5 words must do the work.
- One CTA per platform, concrete (no "learn more", no "link in bio" unless specific).
- Hashtags are lowercase, no spaces, no duplicates across platforms' arrays.
`.trim();

const BUILDER_CONTEXT = `
AUDIENCE: trades operators — custom home builders, remodelers, GCs, specialty contractors — including shops with a CFO/controller in seat.
VOICE: contractor-to-contractor. Respectful of sophisticated finance teams; plainspoken with smaller shops.
SUBJECT MATTER: job costing tied to field reality, gross margin per job, WIP/backlog, connecting Procore/Buildertrend/QuickBooks/Sage, cash flow on draws vs. vendor terms.
`.trim();

const SELLER_CONTEXT = `
AUDIENCE: founders/operators running Shopify, Amazon FBA, or multi-channel DTC brands.
VOICE: peer-to-peer operator who's stared at a P&L that "grew 40%" while the bank account shrank.
SUBJECT MATTER: SKU-level contribution margin, true landed COGS (freight/duty/3PL/fees/returns), reconciling Shopify + Amazon + wholesale, moving from "what we sold" to "what we kept".
`.trim();

function systemPromptFor(persona, platforms) {
  const ctx = persona === 'BUILDER' ? BUILDER_CONTEXT : SELLER_CONTEXT;
  return [
    `You are writing short-form social copy for a 9:16 vertical video.`,
    ctx,
    GLOBAL_RULES,
    `Platforms requested: ${platforms.join(', ')}.`,
    `Return a JSON object keyed by platform. Each platform's object has {caption, hashtags[], cta} as described in the schema.`,
    `TIKTOK       caption ≤ 150 chars; 3–5 hashtags; peer-to-peer, no emojis heavier than one.`,
    `YOUTUBE_SHORTS title ≤ 60 chars (put it in "caption"); description in "cta" field can be 2–4 sentences; 5–10 hashtags.`,
    `INSTAGRAM_REELS caption 120–220 chars, soft line breaks ok; 5–10 hashtags; emojis allowed but sparing.`,
  ].join('\n\n');
}

function buildSchema(platforms) {
  const platformObj = {
    type: 'OBJECT',
    properties: {
      caption:  { type: 'STRING' },
      hashtags: { type: 'ARRAY', items: { type: 'STRING' } },
      cta:      { type: 'STRING' },
    },
    required: ['caption', 'hashtags', 'cta'],
  };
  const properties = {};
  for (const p of platforms) properties[p] = platformObj;
  return { type: 'OBJECT', properties, required: platforms.slice() };
}

// -----------------------------------------------------------------------------
// Gemini call
// -----------------------------------------------------------------------------

function callGeminiOnce({ systemInstruction, userText, schema }) {
  if (!GEMINI_API_KEY) return Promise.reject(new Error('GEMINI_API_KEY is not set'));

  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: systemInstruction }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig: {
      temperature: 0.7,
      responseMimeType: 'application/json',
      responseSchema: schema,
    },
  });

  const options = {
    method: 'POST',
    hostname: GEMINI_HOST,
    path: `/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`,
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    timeout: GEMINI_TIMEOUT_MS,
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let chunks = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (chunks += c));
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`Gemini HTTP ${res.statusCode}: ${chunks.slice(0, 400)}`));
        }
        try {
          const parsed = JSON.parse(chunks);
          const text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (!text) return reject(new Error('Gemini returned no text'));
          resolve(text);
        } catch (err) {
          reject(new Error(`Failed to parse Gemini: ${err.message}`));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`Gemini timeout after ${GEMINI_TIMEOUT_MS}ms`)));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Retrying wrapper — 5 attempts with exponential backoff. Absorbs Gemini's
// transient 503 "high demand" and 429 rate-limit responses before they
// reach the row's fail_count.
function callGemini(args) {
  return withRetry(() => callGeminiOnce(args), {
    attempts: 5,
    retryable: isTransientHttpError,
    label: 'packager/Gemini',
  });
}

function validatePosts(obj, platforms) {
  if (!obj || typeof obj !== 'object') return ['posts is not an object'];
  const problems = [];
  for (const p of platforms) {
    const v = obj[p];
    if (!v || typeof v !== 'object') { problems.push(`${p}: missing`); continue; }
    if (typeof v.caption !== 'string' || !v.caption.trim()) problems.push(`${p}.caption missing`);
    if (!Array.isArray(v.hashtags) || v.hashtags.length === 0) problems.push(`${p}.hashtags missing`);
    if (typeof v.cta !== 'string' || !v.cta.trim()) problems.push(`${p}.cta missing`);
  }
  const joined = JSON.stringify(obj);
  if (/at salisbury/i.test(joined)) problems.push('banned phrase "At Salisbury" detected');
  return problems;
}

// -----------------------------------------------------------------------------
// Public: generate posts for one row, persist, advance status
// -----------------------------------------------------------------------------

async function packageOne({ platforms = DEFAULT_PLATFORMS } = {}) {
  const row = await db.fetchOldestByStatus('Rendered');
  if (!row) return null;
  return packageRow(row, { platforms });
}

/**
 * Package ONE specific Rendered row. Used by the dashboard "Run next
 * stage" button so operators can push a targeted row through to
 * Pending_Approval without waiting for the orchestrator's tick or
 * the queue order.
 */
async function packageRow(row, { platforms = DEFAULT_PLATFORMS } = {}) {
  if (!row) throw new Error('packageRow: row is required');
  if (row.status !== 'Rendered') {
    throw new Error(`packageRow: row #${row.id} is in status "${row.status}", not Rendered`);
  }

  let script;
  try { script = typeof row.script_json === 'string' ? JSON.parse(row.script_json) : row.script_json; }
  catch (err) { throw new Error(`row #${row.id} script_json is invalid: ${err.message}`); }
  if (!script?.hook) throw new Error(`row #${row.id} missing script.hook`);

  const userText =
    `Topic: ${row.topic}\n` +
    `Persona: ${row.target_persona}\n` +
    `Hook: ${script.hook}\n` +
    `Body: ${script.body_text}\n` +
    `Script CTA: ${script.call_to_action}\n\n` +
    `Write platform-specific social copy for a 9:16 vertical video of this script. ` +
    `Return JSON keyed by platform exactly as the schema requires.`;

  const parsed = await llm.generateStructured({
    system: systemPromptFor(row.target_persona, platforms),
    user:   userText,
    schema: buildSchema(platforms),
    label:  `packager:${row.target_persona}`,
  });

  const problems = validatePosts(parsed, platforms);
  if (problems.length) throw new Error(`post validation failed: ${problems.join('; ')}`);

  // Always advance to Pending_Approval; the orchestrator decides whether
  // to skip ahead to Published based on the approval_required setting.
  return await db.updateStatus(row.id, 'Pending_Approval', {
    platforms,
    platform_posts: parsed,
  });
}

async function packageBatch({ max = Infinity, platforms } = {}) {
  const out = { processed: 0, ok: 0, failed: 0, errors: [] };
  while (out.processed < max) {
    const peek = await db.fetchOldestByStatus('Rendered');
    if (!peek) break;
    out.processed += 1;
    try { await packageOne({ platforms }); out.ok += 1; }
    catch (err) {
      out.failed += 1;
      out.errors.push({ id: peek.id, error: err.message });
      break; // don't busy-retry a broken row in the same batch
    }
  }
  return out;
}

module.exports = {
  packageOne,
  packageRow,
  packageBatch,
  systemPromptFor,
  buildSchema,
  DEFAULT_PLATFORMS,
};

if (require.main === module) {
  (async () => {
    console.log('--- Packager Agent self-test ---');
    if (!GEMINI_API_KEY) { console.error('GEMINI_API_KEY not set'); process.exit(1); }
    const res = await packageBatch({ max: 1 });
    console.log('result:', res);
    console.log('counts:', await db.getCounts());
  })();
}
