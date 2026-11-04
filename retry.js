/**
 * retry.js — small, dependency-free exponential-backoff wrapper used by
 * every outbound API call in the engine (Gemini text + image, OpenAI TTS,
 * ElevenLabs TTS, Whisper). Surface-level 503 / 429 / network blips from
 * model providers are common; without this each one would crash the
 * Gemini-based stages on first try.
 *
 * Backoff schedule (baseDelayMs=800, maxDelayMs=16000, 5 attempts):
 *   attempt 1 fails -> wait ~0.8s  + jitter
 *   attempt 2 fails -> wait ~1.6s  + jitter
 *   attempt 3 fails -> wait ~3.2s  + jitter
 *   attempt 4 fails -> wait ~6.4s  + jitter
 *   attempt 5 fails -> throw
 *
 * Total max wait before we give up: ~12 seconds of backoff, ~5 attempts.
 * Non-transient errors (4xx that isn't 408/429, auth, parsing, validation)
 * are NOT retried — they'll fail on the first attempt and surface fast.
 *
 * The orchestrator's existing MAX_FAILS=3 outer guard still wraps this,
 * so a persistently broken row still auto-rejects after 5 * 3 = 15 attempts
 * across 3 ticks. This module only shortens the inner retry loop.
 */

const DEFAULTS = Object.freeze({
  attempts:    5,
  baseDelayMs: 800,
  maxDelayMs:  16_000,
  jitterMs:    250,
});

/**
 * Call `fn()` up to `attempts` times, waiting an exponentially-growing
 * interval between tries. Only retries when `retryable(err)` returns true;
 * otherwise throws immediately. Returns whatever `fn` returns on success.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{
 *   attempts?: number,
 *   baseDelayMs?: number,
 *   maxDelayMs?: number,
 *   jitterMs?: number,
 *   retryable?: (err: Error) => boolean,
 *   onRetry?:   (err: Error, attempt: number, nextDelayMs: number) => void,
 *   label?:     string,
 * }} [opts]
 * @returns {Promise<T>}
 */
async function withRetry(fn, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const retryable = cfg.retryable || (() => true);
  let lastErr;
  for (let attempt = 1; attempt <= cfg.attempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const isLast = attempt >= cfg.attempts;
      if (isLast || !retryable(err)) break;
      const base = Math.min(cfg.baseDelayMs * 2 ** (attempt - 1), cfg.maxDelayMs);
      const delay = base + Math.floor(Math.random() * cfg.jitterMs);
      if (typeof cfg.onRetry === 'function') {
        try { cfg.onRetry(err, attempt, delay); } catch { /* noop */ }
      } else if (cfg.label) {
        // eslint-disable-next-line no-console
        console.warn(
          `[retry] ${cfg.label} attempt ${attempt}/${cfg.attempts} failed ` +
          `(${String(err.message || err).slice(0, 120)}) — retrying in ${delay}ms`
        );
      }
      await sleep(delay);
    }
  }
  throw lastErr;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry-predicate for the model-provider calls we make. Retries on:
 *   - 408 Request Timeout
 *   - 429 Too Many Requests
 *   - 5xx server errors (including the 503 "high demand" from Gemini)
 *   - Node/network errors (timeouts, ECONNRESET, EAI_AGAIN, DNS, etc.)
 *
 * Does NOT retry on 4xx client errors (bad request, auth, not found, etc.)
 * because those will never succeed on a re-try and fast-fail is better UX.
 */
function isTransientHttpError(err) {
  if (!err) return false;
  const msg = String(err.message || err);

  // Explicit HTTP status surfaced by our fetch/https wrappers ("HTTP 503: ...").
  const httpMatch = msg.match(/\bHTTP\s+(\d{3})\b/i);
  if (httpMatch) {
    const code = Number(httpMatch[1]);
    return code === 408 || code === 429 || (code >= 500 && code < 600);
  }

  // Provider-branded status lines we emit (e.g. "Gemini HTTP 503: {...}").
  if (/\b(?:Gemini|OpenAI|ElevenLabs|Whisper)\s+HTTP\s+(\d{3})\b/.test(msg)) {
    const code = Number(msg.match(/\bHTTP\s+(\d{3})\b/)[1]);
    return code === 408 || code === 429 || (code >= 500 && code < 600);
  }

  // Node-level network / timeout errors.
  const netRe = /\b(ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|EPIPE|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT)\b/i;
  if (netRe.test(msg)) return true;
  if (/\btimeout\b/i.test(msg)) return true;

  // JSON parse errors on the provider response occasionally happen mid-stream
  // (truncated body on a 200 — Gemini does this under load). Treat as transient.
  if (/\bFailed to parse\b/i.test(msg)) return true;

  // "experiencing high demand" text sometimes shows up without a status code
  // in the bubbled message — catch by content for safety.
  if (/high demand|UNAVAILABLE|overloaded|try again later/i.test(msg)) return true;

  return false;
}

module.exports = {
  withRetry,
  isTransientHttpError,
};
