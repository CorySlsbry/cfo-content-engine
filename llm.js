/**
 * llm.js — Structured-output LLM wrapper with provider failover.
 *
 * Primary: Anthropic Claude Sonnet (project-scoped quota, rare 503s).
 * Fallback: Google Gemini (shared AI Studio quota — we only use it when
 *           Claude has an outage, because Gemini free-tier 503s a lot).
 *
 * Public surface:
 *   generateStructured({ system, user, schema, label }) -> Promise<object>
 *
 * Both providers receive the same semantic schema but need different
 * wire formats. This module converts schemas on the fly so callers only
 * declare the schema once.
 *
 * The caller's `schema` uses Gemini's OpenAPI-style types ("OBJECT",
 * "STRING", "ARRAY") — that's what creative.js has historically used.
 * We translate to standard JSON Schema for Claude ("object", "string",
 * "array") internally.
 */

const https = require('node:https');
const Anthropic = require('@anthropic-ai/sdk');
const { withRetry, isTransientHttpError } = require('./retry');

// ---------------------------------------------------------------------------
// Config — both providers are env-gated. If a key is absent, that provider
// is skipped (no init errors). Set either or both.
// ---------------------------------------------------------------------------
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const CLAUDE_MODEL      = process.env.CLAUDE_MODEL || 'claude-sonnet-4-5';
const CLAUDE_MAX_TOKENS = Number(process.env.CLAUDE_MAX_TOKENS) || 2048;
const CLAUDE_TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS) || 60_000;

const GEMINI_API_KEY     = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
const GEMINI_MODEL       = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_FALLBACKS   = (process.env.GEMINI_MODEL_FALLBACKS
  || 'gemini-2.5-flash-lite,gemini-2.0-flash-001'
).split(',').map((s) => s.trim()).filter(Boolean);
const GEMINI_HOST        = 'generativelanguage.googleapis.com';
const GEMINI_TIMEOUT_MS  = 45_000;

// One Anthropic client reused across calls (keeps the keep-alive pool).
let _anthropicClient = null;
function anthropic() {
  if (_anthropicClient) return _anthropicClient;
  if (!ANTHROPIC_API_KEY) return null;
  _anthropicClient = new Anthropic({
    apiKey: ANTHROPIC_API_KEY,
    timeout: CLAUDE_TIMEOUT_MS,
    maxRetries: 0, // we own the retry loop via retry.js
  });
  return _anthropicClient;
}

// ---------------------------------------------------------------------------
// Schema conversion — Gemini OpenAPI → JSON Schema for Claude tool_use.
// ---------------------------------------------------------------------------
function toJsonSchema(geminiSchema) {
  if (!geminiSchema || typeof geminiSchema !== 'object') return geminiSchema;
  const out = {};
  for (const [k, v] of Object.entries(geminiSchema)) {
    if (k === 'type' && typeof v === 'string') {
      out.type = v.toLowerCase();
    } else if (k === 'properties' && v && typeof v === 'object') {
      out.properties = {};
      for (const [pk, pv] of Object.entries(v)) out.properties[pk] = toJsonSchema(pv);
    } else if (k === 'items') {
      out.items = toJsonSchema(v);
    } else if (k === 'required' && Array.isArray(v)) {
      out.required = v.slice();
    } else {
      out[k] = v; // description, enum, format, minLength, etc. pass through
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Claude call — uses tool_use to force a JSON shape matching the schema.
// ---------------------------------------------------------------------------
async function callClaudeOnce({ system, user, schema }) {
  const client = anthropic();
  if (!client) throw new Error('ANTHROPIC_API_KEY is not set');

  const tool = {
    name: 'emit_structured_output',
    description: 'Emit the structured result. This is the only way to reply.',
    input_schema: toJsonSchema(schema),
  };

  const res = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: CLAUDE_MAX_TOKENS,
    system,
    tools: [tool],
    tool_choice: { type: 'tool', name: tool.name },
    messages: [{ role: 'user', content: user }],
  });

  // Find the tool_use block in the response content.
  const block = (res.content || []).find((b) => b.type === 'tool_use');
  if (!block || !block.input) {
    throw new Error(
      `Claude returned no tool_use block. stop_reason=${res.stop_reason}`
    );
  }
  return block.input;
}

function callClaudeWithRetry(args, label) {
  return withRetry(() => callClaudeOnce(args), {
    attempts: 5,
    retryable: (err) => {
      // Anthropic SDK throws APIError subclasses with `status` on them.
      if (err?.status === 429 || (err?.status >= 500 && err?.status < 600)) return true;
      return isTransientHttpError(err);
    },
    label: `${label || 'llm'}/Claude:${CLAUDE_MODEL}`,
  });
}

// ---------------------------------------------------------------------------
// Gemini call — kept as a fallback when Claude has an outage. Same wire
// shape as the existing creative.js callGemini, minus the fallback-chain
// logic (we now handle that here).
// ---------------------------------------------------------------------------
function callGeminiOnce({ system, user, schema, model }) {
  if (!GEMINI_API_KEY) return Promise.reject(new Error('GEMINI_API_KEY is not set'));

  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: {
      temperature: 0.85,
      topP: 0.95,
      responseMimeType: 'application/json',
      responseSchema: schema, // Gemini wants OpenAPI-style, same as our inputs
    },
  });

  const options = {
    method: 'POST',
    hostname: GEMINI_HOST,
    path: `/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`,
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    },
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
          if (!text) return reject(new Error(`Gemini returned no text. Raw: ${chunks.slice(0, 400)}`));
          // Gemini responseMimeType:application/json guarantees JSON-parseable text.
          try { resolve(JSON.parse(text)); }
          catch (e) {
            // Some models occasionally wrap in ```json fences.
            const stripped = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
            resolve(JSON.parse(stripped));
          }
        } catch (err) {
          reject(new Error(`Failed to parse Gemini response: ${err.message}`));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`Gemini timeout after ${GEMINI_TIMEOUT_MS}ms`)));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function callGeminiChain(args, label) {
  const chain = [GEMINI_MODEL, ...GEMINI_FALLBACKS];
  let lastErr;
  for (let i = 0; i < chain.length; i += 1) {
    const model = chain[i];
    try {
      return await withRetry(
        () => callGeminiOnce({ ...args, model }),
        {
          attempts: i === 0 ? 5 : 3,
          retryable: isTransientHttpError,
          label: `${label || 'llm'}/Gemini:${model}`,
        }
      );
    } catch (err) {
      lastErr = err;
      if (!isTransientHttpError(err)) throw err;
      if (i < chain.length - 1) {
        console.warn(`[llm] ${model} exhausted, falling back to ${chain[i + 1]}`);
      }
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Public: generateStructured
// ---------------------------------------------------------------------------

/**
 * Generate a structured object matching `schema` using the best available
 * provider. Tries Claude first (if ANTHROPIC_API_KEY is set). On transient
 * provider outage, falls through to Gemini. On permanent errors (validation,
 * auth), surfaces immediately — fallback wouldn't help.
 *
 * @param {{ system: string, user: string, schema: object, label?: string }} args
 * @returns {Promise<object>} parsed response matching schema
 */
async function generateStructured(args) {
  const label = args.label || 'llm';
  if (ANTHROPIC_API_KEY) {
    try {
      return await callClaudeWithRetry(args, label);
    } catch (err) {
      if (!isTransientHttpError(err) && err?.status !== 429 && !(err?.status >= 500)) {
        // Permanent Claude error (auth, validation) — don't mask by falling
        // back to Gemini, because a schema mismatch would repeat on Gemini too.
        throw err;
      }
      if (!GEMINI_API_KEY) throw err;
      console.warn(`[${label}] Claude transient-failed, falling back to Gemini: ${err.message.slice(0, 120)}`);
      return callGeminiChain(args, label);
    }
  }
  if (GEMINI_API_KEY) return callGeminiChain(args, label);
  throw new Error('llm.js: neither ANTHROPIC_API_KEY nor GEMINI_API_KEY is set');
}

module.exports = {
  generateStructured,
  // Exposed for diagnostics / tests.
  _callClaudeOnce: callClaudeOnce,
  _callGeminiOnce: callGeminiOnce,
  _toJsonSchema: toJsonSchema,
  providers: {
    claude:  { enabled: !!ANTHROPIC_API_KEY, model: CLAUDE_MODEL },
    gemini:  { enabled: !!GEMINI_API_KEY,    model: GEMINI_MODEL, fallbacks: GEMINI_FALLBACKS },
  },
};
