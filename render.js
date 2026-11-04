/**
 * render.js — The Render Agent for the CFO Content Engine.
 *
 * Two independent state transitions, one module:
 *
 *   Part 1  Scripted          -> Audio_Generated
 *           Pull hook + body + CTA out of script_json, send to the TTS API
 *           (OpenAI gpt-4o-mini-tts by default with per-persona delivery
 *           instructions; ElevenLabs optional), save the mp3 to
 *           output/audio/{id}.mp3, persist audio_path.
 *
 *   Part 2  Images_Generated  -> Rendered
 *           Pull the 5 AI-generated stills from output/images/{id}/, build
 *           word-level timings from the audio (Whisper, with an
 *           even-distribution fallback), emit an ASS subtitle file showing
 *           ONE WORD AT A TIME centered on screen, then ffmpeg:
 *             - split audio duration into N equal image segments
 *             - Ken Burns zoompan each image for its segment
 *             - xfade crossfade between them
 *             - burn the ASS subtitles on top
 *             - mix in the audio track
 *           Save to output/video/{id}.mp4, persist video_path.
 *
 *           If NO images exist for the row (opt-out, image gen turned off,
 *           or legacy row that predates the image stage), we fall back to
 *           looping assets/background.mp4 — same behavior as before Patch C.
 *
 * Credit-safe failures: if any step throws, the row stays at its current
 * status. The next tick retries. We never advance a row we couldn't
 * actually produce the artifact for.
 *
 * ffmpeg is provided in-repo via ffmpeg-static / ffprobe-static so
 * operators don't need a system install.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;

const db = require('./db');
const imagen = require('./imagen');
const storage = require('./storage');
const { withRetry, isTransientHttpError } = require('./retry');

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

// -----------------------------------------------------------------------------
// Config
// -----------------------------------------------------------------------------
const PROJECT_ROOT = __dirname;
const ASSETS_DIR   = path.join(PROJECT_ROOT, 'assets');
const OUT_DIR      = path.join(PROJECT_ROOT, 'output');
const AUDIO_DIR    = path.join(OUT_DIR, 'audio');
const VIDEO_DIR    = path.join(OUT_DIR, 'video');
const SUBS_DIR     = path.join(OUT_DIR, 'subs');

// Legacy on-disk dirs — only needed for STORAGE_BACKEND=local. In gcs mode
// storage.js routes through /tmp, so these can't-write errors are harmless.
for (const d of [ASSETS_DIR, OUT_DIR, AUDIO_DIR, VIDEO_DIR, SUBS_DIR]) {
  try {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  } catch (err) {
    if (err.code !== 'EACCES') throw err;
  }
}

const BG_VIDEO_PATH =
  process.env.BG_VIDEO_PATH || path.join(ASSETS_DIR, 'background.mp4');

// 9:16 vertical target.
const FRAME_W = 1080;
const FRAME_H = 1920;

// TTS provider selection. Default: OpenAI.
const TTS_PROVIDER   = (process.env.TTS_PROVIDER || 'openai').toLowerCase();
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_TTS_MODEL   = process.env.OPENAI_TTS_MODEL   || 'gpt-4o-mini-tts';
const OPENAI_STT_MODEL   = process.env.OPENAI_STT_MODEL   || 'whisper-1';
// OpenAI voice per persona. Override with env if desired.
// `nova`   = bright, lively female — energetic operator, smile in the voice.
// `ballad` = expressive/narrative, strong for story-led seller content.
// (Both are gpt-4o-mini-tts voices that respond to the `instructions` field.)
const OPENAI_VOICES = {
  BUILDER: process.env.OPENAI_VOICE_BUILDER || 'nova',
  SELLER:  process.env.OPENAI_VOICE_SELLER  || 'ballad',
};

// gpt-4o-mini-tts accepts a free-text `instructions` field that shapes
// delivery (pace, energy, emotion, accent). This is what stops the voice
// from sounding like a robot reading a prompt. Persona-tuned.
const OPENAI_TTS_INSTRUCTIONS = {
  BUILDER: process.env.OPENAI_TTS_INSTRUCTIONS_BUILDER || [
    'Voice: a sharp, confident female CFO who builds with contractors all day — early-thirties, genuine, zero corporate stiffness.',
    'Tone: bright, upbeat, grinning. She is hyped to share this. Never somber, never flat, never "reading".',
    'Energy: HIGH. A real smile in every sentence. Lean forward on the hook, land the punchline, pop the dollar amounts.',
    'Pace: FAST — noticeably quicker than a default narrator. Crisp, lively, podcast-host cadence. Short breaths between sentences. Keep momentum high; do not drag.',
    'Pronunciation: natural American English, conversational contractions, zero newsreader cadence. Treat the joke like a joke and the CTA like a friend hyping you.',
    'Avoid: monotone, somber, mournful, slow, "serious news anchor", or coached-training delivery. If a take feels heavy, lighten it.',
  ].join(' '),
  SELLER: process.env.OPENAI_TTS_INSTRUCTIONS_SELLER || [
    'Voice: an expressive e-commerce operator telling a story to a friend.',
    'Tone: curious and punchy. Rising energy through the body, confident drop on the takeaway.',
    'Pace: fast but clear. Hit the hook with a real human emphasis, not a newsreader cadence.',
    'Energy: like you just figured something out and you can’t wait to share it. Smile through the voice where it fits.',
    'Pronunciation: natural American English. Treat numbers and brand names like they matter.',
  ].join(' '),
};

const ELEVENLABS_API_KEY  = process.env.ELEVENLABS_API_KEY || '';
const ELEVENLABS_MODEL_ID = process.env.ELEVENLABS_MODEL_ID || 'eleven_v3';
// Voice IDs are comma-separated LISTS — the renderer picks one per row by
// (row.id % list.length) so videos alternate between voices for channel
// variety. Single ID is fine (acts like a 1-item list).
function parseVoiceList(s, fallback) {
  const list = String(s || fallback).split(',').map((v) => v.trim()).filter(Boolean);
  return list.length ? list : [fallback];
}
const ELEVENLABS_VOICES = {
  BUILDER: parseVoiceList(process.env.ELEVENLABS_VOICE_BUILDER, 'EXAVITQu4vr4xnSDxMaL'),
  SELLER:  parseVoiceList(process.env.ELEVENLABS_VOICE_SELLER,  'EXAVITQu4vr4xnSDxMaL'),
};
function pickVoiceForRow(persona, rowId) {
  const list = ELEVENLABS_VOICES[persona] || [];
  if (list.length === 0) return null;
  return list[Math.abs(Number(rowId) || 0) % list.length];
}

// Per-persona voice_settings. Low stability = more expressive/emotional
// variation (= more upbeat energy, less flat). High similarity_boost keeps
// it on-voice. High style nudges the model to lean into the coached emotion
// implied by the voice sample. use_speaker_boost sharpens enunciation.
// `speed` is an eleven_v3-only parameter (0.5–2.0). v2 models ignore it.
const ELEVENLABS_SETTINGS = {
  BUILDER: {
    stability:         Number(process.env.ELEVENLABS_STABILITY_BUILDER)          || 0.30,
    similarity_boost:  Number(process.env.ELEVENLABS_SIMILARITY_BUILDER)         || 0.75,
    style:             Number(process.env.ELEVENLABS_STYLE_BUILDER)              || 0.85,
    speed:             Number(process.env.ELEVENLABS_SPEED_BUILDER)              || 1.15,
    use_speaker_boost: process.env.ELEVENLABS_SPEAKER_BOOST_BUILDER !== 'false',
  },
  SELLER: {
    stability:         Number(process.env.ELEVENLABS_STABILITY_SELLER)           || 0.35,
    similarity_boost:  Number(process.env.ELEVENLABS_SIMILARITY_SELLER)          || 0.75,
    style:             Number(process.env.ELEVENLABS_STYLE_SELLER)               || 0.75,
    speed:             Number(process.env.ELEVENLABS_SPEED_SELLER)               || 1.10,
    use_speaker_boost: process.env.ELEVENLABS_SPEAKER_BOOST_SELLER !== 'false',
  },
};

// -----------------------------------------------------------------------------
// Part 1 — Script -> Audio
// -----------------------------------------------------------------------------

/**
 * Combine hook + body + CTA into the string we actually send to TTS.
 * Runs a post-processing normalizer (ttsNormalize) so numbers, percents,
 * and common abbreviations sound natural even if the LLM forgot to spell
 * them out — belt-and-suspenders on the prompt-level instruction.
 */
function scriptToSpokenText(scriptJson) {
  let s;
  try {
    s = typeof scriptJson === 'string' ? JSON.parse(scriptJson) : scriptJson;
  } catch (err) {
    throw new Error(`script_json is not valid JSON: ${err.message}`);
  }
  const { hook, body_text, call_to_action } = s || {};
  if (!hook || !body_text || !call_to_action) {
    throw new Error('script_json missing required fields hook/body_text/call_to_action');
  }
  const joined = [hook, body_text, call_to_action]
    .map((x) => String(x).trim())
    .filter(Boolean)
    .join('  ');
  return ttsNormalize(joined);
}

// ---------------------------------------------------------------------------
// ttsNormalize — make the script pronounce cleanly in ElevenLabs v3.
//
// Belt-and-suspenders for the TTS-friendly prompt rules. The LLM is told to
// spell numbers out, but regressions are common, so we normalize here too.
// Order matters: dollars before bare numbers; percents before bare numbers;
// compound tokens like "14-day" before digit-only sweep.
// ---------------------------------------------------------------------------
function ttsNormalize(s) {
  if (!s) return s;
  let out = String(s);

  // Dollar amounts — order matters: most specific first. Each pattern consumes
  // the `$` + digits + optional `.cents` so later patterns don't re-match.
  //   $1,234,567.89  →  "one million two hundred thirty-four thousand ... dollars and eighty-nine cents"
  //   $1,234         →  "one thousand two hundred thirty-four dollars"
  //   $2.47          →  "two dollars and forty-seven cents"
  //   $2M / $4.5B    →  "two million dollars" / "four point five billion dollars"
  //   $42            →  "forty-two dollars"
  out = out.replace(/\$(\d{1,3}(?:,\d{3})+)\.(\d{1,2})\b/g, (_, whole, cents) =>
    `${numberToWords(parseInt(whole.replace(/,/g, ''), 10))} dollars and ${numberToWords(parseInt(cents, 10))} cents`);
  out = out.replace(/\$(\d{1,3}(?:,\d{3})+)\b/g, (_, whole) =>
    `${numberToWords(parseInt(whole.replace(/,/g, ''), 10))} dollars`);
  out = out.replace(/\$(\d+)\.(\d{1,2})\b/g, (_, d, c) =>
    `${numberToWords(parseInt(d, 10))} dollars and ${numberToWords(parseInt(c, 10))} cents`);
  out = out.replace(/\$(\d+(?:\.\d+)?)([MmKkBb])\b/g, (_, d, suffix) => {
    const map = { M: 'million', K: 'thousand', B: 'billion' };
    if (!d.includes('.')) return `${numberToWords(parseInt(d, 10))} ${map[suffix.toUpperCase()]} dollars`;
    const [whole, frac] = d.split('.');
    const fracWords = frac.split('').map((ch) => numberToWords(parseInt(ch, 10))).join(' ');
    return `${numberToWords(parseInt(whole, 10))} point ${fracWords} ${map[suffix.toUpperCase()]} dollars`;
  });
  out = out.replace(/\$(\d+)\b/g, (_, d) => `${numberToWords(parseInt(d, 10))} dollars`);

  // Percentages: "62%" -> "sixty-two percent"
  out = out.replace(/(\d+(?:\.\d+)?)%/g, (_, n) => {
    const num = parseFloat(n);
    if (Number.isInteger(num)) return `${numberToWords(num)} percent`;
    const [whole, frac] = n.split('.');
    return `${numberToWords(parseInt(whole, 10))} point ${frac.split('').map((d) => numberToWords(parseInt(d, 10))).join(' ')} percent`;
  });

  // Compound "14-day", "30-day", "7-figure" — spell the number, keep the rest.
  out = out.replace(/\b(\d{1,3})-([a-zA-Z]+)\b/g, (_, n, word) =>
    `${numberToWords(parseInt(n, 10))}-${word}`);

  // Bare numbers standing alone (e.g. "11 days", "4 hours"). Careful not to
  // touch digits inside words or already-expanded phrases. Also skip phone
  // numbers (\d{3}-\d{4}) by only matching runs not adjacent to a dash.
  out = out.replace(/\b(\d{1,6})\b/g, (m, n) => numberToWords(parseInt(n, 10)));

  // Common punctuation + abbreviations TTS mangles.
  const replacements = [
    [/\bP&L\b/g,     'P and L'],
    [/\bR&D\b/g,     'R and D'],
    [/\bB2B\b/g,     'B to B'],
    [/\bB2C\b/g,     'B to C'],
    [/\bD2C\b/g,     'D to C'],
    [/\betc\./gi,    'and so on'],
    [/\be\.g\./gi,   'for example'],
    [/\bi\.e\./gi,   'that is'],
    [/\bvs\./gi,     'versus'],
    [/\bvs\b/gi,     'versus'],
    [/\bw\//gi,      'with '],
    [/\bw\/o\b/gi,   'without'],
    [/\bft\b/gi,     'feet'],
    [/\bsq\.?\s*ft\b/gi, 'square feet'],
    [/\bROAS\b/g,    'return on ad spend'],
    [/\bAOV\b/g,     'average order value'],
    [/\bROI\b/g,     'R O I'],

    // Pronunciation fixes — TTS models read unknown acronyms as letters
    // ("S K U") but human ears expect the spoken word. Enforce the human
    // pronunciation by rewriting the token phonetically.
    [/\bSKUs\b/g,    'skews'],   // plural first, so singular doesn't match it
    [/\bSKU\b/g,     'skew'],
    [/\bFAQs\b/g,    'frequently asked questions'],
    [/\bFAQ\b/g,     'frequently asked questions'],
    [/\bASAP\b/g,    'as soon as possible'],
    [/\bSaaS\b/g,    'sass'],    // otherwise TTS says "S A A S"
    [/\bCOGS\b/g,    'cogs'],    // reads as "cogs", a word, not initials

    [/&/g,           'and'], // any stray ampersand
  ];
  for (const [re, rep] of replacements) out = out.replace(re, rep);

  // Collapse multi-space artifacts the substitutions may introduce.
  return out.replace(/\s+/g, ' ').trim();
}

// Minimal integer-to-words (0–999,999,999) — no external dep. Handles every
// whole-dollar amount we'd realistically put in a 50-second script.
function numberToWords(num) {
  if (num === 0) return 'zero';
  if (num < 0)  return 'negative ' + numberToWords(-num);
  const belowTwenty = [
    'zero','one','two','three','four','five','six','seven','eight','nine',
    'ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen',
    'seventeen','eighteen','nineteen',
  ];
  const tens = ['', '', 'twenty','thirty','forty','fifty','sixty','seventy','eighty','ninety'];
  const chunk = (n) => {
    if (n < 20) return belowTwenty[n];
    if (n < 100) return tens[Math.floor(n / 10)] + (n % 10 ? '-' + belowTwenty[n % 10] : '');
    return belowTwenty[Math.floor(n / 100)] + ' hundred' + (n % 100 ? ' ' + chunk(n % 100) : '');
  };
  const parts = [];
  const b = Math.floor(num / 1_000_000_000); if (b) parts.push(chunk(b) + ' billion');
  const m = Math.floor((num % 1_000_000_000) / 1_000_000); if (m) parts.push(chunk(m) + ' million');
  const k = Math.floor((num % 1_000_000) / 1_000); if (k) parts.push(chunk(k) + ' thousand');
  const r = num % 1_000; if (r) parts.push(chunk(r));
  return parts.join(' ');
}

async function ttsOpenAIOnce({ text, voice, instructions }) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set');
  const body = {
    model: OPENAI_TTS_MODEL,
    voice,
    input: text,
    response_format: 'mp3',
  };
  // `instructions` is only honored by gpt-4o-mini-tts and newer. Guard so
  // older models (tts-1, tts-1-hd) don't 400 out.
  if (instructions && /mini-tts|4o.*tts|gpt-.*tts/i.test(OPENAI_TTS_MODEL)) {
    body.instructions = instructions;
  }
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${OPENAI_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`OpenAI TTS ${res.status}: ${err.slice(0, 400)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

// Retrying wrapper — 5 attempts. Writes to disk only after a successful
// response, so no partial mp3 files on failure.
async function ttsOpenAI({ text, voice, outPath, instructions }) {
  const buf = await withRetry(
    () => ttsOpenAIOnce({ text, voice, instructions }),
    { attempts: 5, retryable: isTransientHttpError, label: 'render/OpenAI-TTS' }
  );
  await fsp.writeFile(outPath, buf);
}

async function ttsElevenLabsOnce({ text, voiceId, voiceSettings, modelId }) {
  if (!ELEVENLABS_API_KEY) throw new Error('ELEVENLABS_API_KEY is not set');
  const chosenModel = modelId || ELEVENLABS_MODEL_ID;
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
        'content-type': 'application/json',
        accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: chosenModel,
        // v3 supports `speed` + larger `style` range + inline audio tags in the
        // text. v2 ignores unknown fields silently so the same payload is safe
        // on both models — callers can flip the model via env without schema
        // changes.
        voice_settings: voiceSettings || {
          stability: 0.3,
          similarity_boost: 0.75,
          style: 0.8,
          use_speaker_boost: true,
          speed: 1.1,
        },
      }),
    }
  );
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`ElevenLabs TTS ${res.status}: ${err.slice(0, 400)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function ttsElevenLabs({ text, voiceId, outPath, voiceSettings, modelId }) {
  const buf = await withRetry(
    () => ttsElevenLabsOnce({ text, voiceId, voiceSettings, modelId }),
    { attempts: 5, retryable: isTransientHttpError, label: 'render/ElevenLabs' }
  );
  await fsp.writeFile(outPath, buf);
}

/**
 * Drain ONE Scripted row, generating the audio artifact. Returns the
 * updated DB row, or null if the queue was empty.
 */
async function processOneScripted() {
  const row = await db.fetchOldestByStatus('Scripted');
  if (!row) return null;
  return processScriptedRow(row);
}

/**
 * Generate audio for ONE specific row. Used by the dashboard "Run next
 * stage" button so operators can push a targeted Scripted row through audio
 * without waiting for the orchestrator's tick or the queue order.
 */
async function processScriptedRow(row) {
  if (!row) throw new Error('processScriptedRow: row is required');
  if (row.status !== 'Scripted') {
    throw new Error(`processScriptedRow: row #${row.id} is in status "${row.status}", not Scripted`);
  }

  const text = scriptToSpokenText(row.script_json);
  // Write to a staging path ffmpeg can read later without hitting the network;
  // storage.putFile moves it into GCS (or leaves it in place for local mode).
  const key = `audio/${row.id}.mp3`;
  const outPath = storage.localPathFor(key, { staging: true });

  if (TTS_PROVIDER === 'elevenlabs') {
    const voiceId = pickVoiceForRow(row.target_persona, row.id);
    const voiceSettings = ELEVENLABS_SETTINGS[row.target_persona];
    console.log(`[render] TTS ElevenLabs voice=${voiceId} (row ${row.id} of ${ELEVENLABS_VOICES[row.target_persona].length} in rotation)`);
    await ttsElevenLabs({ text, voiceId, outPath, voiceSettings });
  } else {
    const voice = OPENAI_VOICES[row.target_persona];
    const instructions = OPENAI_TTS_INSTRUCTIONS[row.target_persona];
    await ttsOpenAI({ text, voice, outPath, instructions });
  }

  // Upload to the active storage backend and persist the KEY (not an absolute
  // path) so the row survives across Cloud Run instances and rebuilds.
  await storage.putFile(key, outPath, { contentType: 'audio/mpeg' });

  const updated = await db.updateStatus(row.id, 'Audio_Generated', { audio_path: key });
  return updated;
}

// -----------------------------------------------------------------------------
// Word timings — Whisper, with an even-distribution fallback
// -----------------------------------------------------------------------------

function probeDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) return reject(err);
      const d = data?.format?.duration;
      if (!Number.isFinite(d)) return reject(new Error(`could not probe duration of ${filePath}`));
      resolve(d);
    });
  });
}

/**
 * Ask OpenAI Whisper for word-level timestamps. Returns [{word, start, end}]
 * in seconds. If OPENAI_API_KEY is missing or the call fails, returns null
 * so the caller can fall back to even distribution.
 */
async function whisperWordTimings(mp3Path) {
  if (!OPENAI_API_KEY) return null;
  try {
    const fileBuf = await fsp.readFile(mp3Path);
    const fd = new FormData();
    fd.append('file', new Blob([fileBuf], { type: 'audio/mpeg' }), path.basename(mp3Path));
    fd.append('model', OPENAI_STT_MODEL);
    fd.append('response_format', 'verbose_json');
    fd.append('timestamp_granularities[]', 'word');

    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { authorization: `Bearer ${OPENAI_API_KEY}` },
      body: fd,
    });
    if (!res.ok) return null;
    const data = await res.json();
    const words = Array.isArray(data?.words) ? data.words : null;
    if (!words || words.length === 0) return null;
    return words.map((w) => ({
      word: String(w.word || '').trim(),
      start: Number(w.start),
      end: Number(w.end),
    })).filter((w) => w.word && Number.isFinite(w.start) && Number.isFinite(w.end));
  } catch (_) {
    return null;
  }
}

/**
 * Fallback: split `text` into words and distribute evenly across
 * `duration` seconds. Minimum floor per word so a 1-word flash isn't
 * unreadable.
 */
function evenTimings(text, duration) {
  const words = String(text).split(/\s+/).filter(Boolean);
  if (words.length === 0 || !(duration > 0)) return [];
  const per = duration / words.length;
  return words.map((word, i) => ({
    word,
    start: i * per,
    end:   (i + 1) * per,
  }));
}

// -----------------------------------------------------------------------------
// ASS subtitle builder — one word visible at a time, centered
// -----------------------------------------------------------------------------

function fmtAssTime(seconds) {
  // ASS expects H:MM:SS.cs (centiseconds).
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s - h * 3600 - m * 60;
  const whole = Math.floor(sec);
  const cs = Math.round((sec - whole) * 100);
  return `${h}:${String(m).padStart(2,'0')}:${String(whole).padStart(2,'0')}.${String(cs).padStart(2,'0')}`;
}

function escapeAssText(t) {
  return String(t)
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\r?\n/g, '\\N');
}

function buildAss(timings) {
  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${FRAME_W}`,
    `PlayResY: ${FRAME_H}`,
    'ScaledBorderAndShadow: yes',
    'WrapStyle: 2',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    // Alignment 5 = center-middle of the frame.
    // Large, bold, white text with a thick black outline reads clearly on any bg.
    'Style: Word,Impact,140,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,1,0,0,0,100,100,2,0,1,8,0,5,60,60,0,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ].join('\n');

  const lines = timings.map((w) =>
    `Dialogue: 0,${fmtAssTime(w.start)},${fmtAssTime(w.end)},Word,,0,0,0,,${escapeAssText(w.word.toUpperCase())}`
  );
  return `${header}\n${lines.join('\n')}\n`;
}

// -----------------------------------------------------------------------------
// Part 2 — Audio -> Rendered
// -----------------------------------------------------------------------------

/**
 * ffmpeg path-safe escape for use inside a filtergraph `subtitles=...`
 * argument (Windows colons and backslashes need careful handling).
 */
function ffmpegSubtitlePath(p) {
  // fluent-ffmpeg + libass expect forward slashes; escape the drive colon.
  const fwd = p.replace(/\\/g, '/');
  return fwd.replace(/:/g, '\\:');
}

/**
 * OLD RENDER PATH — kept as a fallback for rows that have no AI-generated
 * images. Loops the static background.mp4 and burns captions on top.
 */
function runFfmpegBackgroundRender({ bgVideo, audioPath, assPath, outPath }) {
  return new Promise((resolve, reject) => {
    const vf = [
      `scale=${FRAME_W}:${FRAME_H}:force_original_aspect_ratio=increase`,
      `crop=${FRAME_W}:${FRAME_H}`,
      `subtitles='${ffmpegSubtitlePath(assPath)}'`,
    ].join(',');

    ffmpeg()
      .input(bgVideo)
      .inputOptions(['-stream_loop -1'])        // loop the background forever
      .input(audioPath)
      .outputOptions([
        '-map 0:v:0',
        '-map 1:a:0',
        '-shortest',
        '-c:v libx264',
        '-preset veryfast',
        '-crf 20',
        '-pix_fmt yuv420p',
        '-c:a aac',
        '-b:a 192k',
        '-movflags +faststart',
        '-r 30',
      ])
      .videoFilter(vf)
      .on('error', (err) => reject(new Error(`ffmpeg failed: ${err.message}`)))
      .on('end', () => resolve(outPath))
      .save(outPath);
  });
}

// ---- Ken Burns renderer ----------------------------------------------------

// Ken Burns zoom envelope. Max zoom is the target at the end of the segment;
// the per-segment rate (z increment per frame) is recomputed from segDur so
// zoom reaches MAX right as the segment ends — regardless of clip length.
const KB_ZOOM_MAX = 1.18;
const KB_FPS = 30;

/**
 * Per-slot motion "move" descriptors. We cycle through these so a 5-image
 * sequence never feels monotone. All x/y expressions use the running
 * `zoom` state (which we control via the rate in `z`), so drift animates
 * in lockstep with the zoom envelope — no dependency on `on` (which
 * resets per input frame and broke the timing in the old version).
 *
 * `zoom - 1` goes from 0 → (KB_ZOOM_MAX - 1), so `(zoom-1)/(KB_ZOOM_MAX-1)`
 * is a clean 0→1 progress factor usable for drift.
 */
const KB_PROGRESS = `((zoom-1)/${(KB_ZOOM_MAX - 1).toFixed(4)})`;
const KEN_BURNS_MOVES = [
  // 1. Zoom in, centered — classic dramatic open.
  { x: 'iw/2-(iw/zoom/2)',                                 y: 'ih/2-(ih/zoom/2)' },
  // 2. Zoom in + drift up-right — energy rising.
  { x: `iw/2-(iw/zoom/2)+iw*0.06*${KB_PROGRESS}`,          y: `ih/2-(ih/zoom/2)-ih*0.04*${KB_PROGRESS}` },
  // 3. Zoom in + drift left — settles the eye.
  { x: `iw/2-(iw/zoom/2)-iw*0.07*${KB_PROGRESS}`,          y: 'ih/2-(ih/zoom/2)' },
  // 4. Zoom in + drift down — grounds the CTA moment.
  { x: 'iw/2-(iw/zoom/2)',                                 y: `ih/2-(ih/zoom/2)+ih*0.05*${KB_PROGRESS}` },
  // 5. Zoom in + drift up — final lift into the close.
  { x: 'iw/2-(iw/zoom/2)',                                 y: `ih/2-(ih/zoom/2)-ih*0.07*${KB_PROGRESS}` },
];

/**
 * Build a Ken-Burns + concat filtergraph for an arbitrary number of images.
 * Each image becomes an exactly-segDur 1080×1920 clip; clips are
 * concatenated head-to-tail and the subtitle file is burned on top.
 *
 * IMPLEMENTATION NOTES (these details are load-bearing for timing):
 *   - Input is fed as `-framerate 30 -loop 1 -t <segDur>` so each input
 *     stream is EXACTLY segDur seconds of 30fps duplicate frames.
 *   - zoompan uses d=1 so it emits one output frame per input frame and
 *     the `zoom` variable persists across frames — this is the proven
 *     idiom for a smoothly animating ken-burns effect.
 *   - zoomRate is calibrated so zoom climbs from 1.0 to KB_ZOOM_MAX
 *     exactly at the last frame of the segment, regardless of segDur.
 *   - trim=duration=segDur + setpts=PTS-STARTPTS is belt-and-suspenders:
 *     guarantees every segment is exactly segDur even if ffmpeg emits an
 *     extra frame at the seam.
 *   - Concat (not xfade) because xfade chains get brittle with 5+ inputs.
 *     A short fade in/out per clip gives a comparable feel with 10× less
 *     filter-graph complexity.
 *
 * @returns { filter, segDur, totalSegmentDuration }
 *   totalSegmentDuration is the true output duration — use it as `-t` on
 *   the output so `-shortest` can't truncate the video early.
 */
function buildKenBurnsFilter({ images, totalDuration, assPath, fps = KB_FPS, segmentDurations = null }) {
  const n = images.length;
  // If segmentDurations is provided (one per image), use those. Otherwise
  // split total audio into N equal chunks like the legacy behavior.
  const durs = (Array.isArray(segmentDurations) && segmentDurations.length === n)
    ? segmentDurations.map((d) => Math.max(1.0, Number(d) || 0))
    : Array(n).fill(Math.max(1.8, totalDuration / n));

  // Per-frame zoom delta is calibrated per-segment so the zoom-in finishes
  // right at each segment's end regardless of whether segments vary.
  const chains = [];
  for (let i = 0; i < n; i += 1) {
    const segDur = durs[i];
    const fadeDur = Math.min(0.35, segDur * 0.15);
    const fadeOutStart = Math.max(0, segDur - fadeDur);
    const frames = Math.max(1, Math.round(segDur * fps));
    const zoomRate = ((KB_ZOOM_MAX - 1) / frames).toFixed(6);
    const zExpr = `min(zoom+${zoomRate},${KB_ZOOM_MAX})`;
    const move = KEN_BURNS_MOVES[i % KEN_BURNS_MOVES.length];
    const up = `scale=${FRAME_W * 2}:${FRAME_H * 2}:force_original_aspect_ratio=increase,crop=${FRAME_W * 2}:${FRAME_H * 2}`;
    const kb = `zoompan=z='${zExpr}':x='${move.x}':y='${move.y}':d=1:s=${FRAME_W}x${FRAME_H}:fps=${fps}`;
    const trim = `trim=duration=${segDur.toFixed(3)},setpts=PTS-STARTPTS`;
    const fades =
      `fade=t=in:st=0:d=${fadeDur.toFixed(3)},` +
      `fade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fadeDur.toFixed(3)}`;
    chains.push(`[${i}:v]${up},${kb},${trim},setsar=1,${fades}[v${i}]`);
  }

  const concatIns = Array.from({ length: n }, (_, i) => `[v${i}]`).join('');
  chains.push(`${concatIns}concat=n=${n}:v=1:a=0[vcat]`);
  chains.push(`[vcat]subtitles='${ffmpegSubtitlePath(assPath)}'[vout]`);

  const total = durs.reduce((a, b) => a + b, 0);
  return {
    filter: chains.join(';'),
    segDur: durs[0], // legacy return shape — first-segment duration
    segmentDurations: durs,
    totalSegmentDuration: total,
  };
}

/**
 * Compute per-image segment durations from the operator-supplied visual
 * anchors + Whisper word-timings. For each anchor, we find the earliest
 * point in the spoken text where that anchor phrase appears; the image
 * is on-screen from that moment until the NEXT anchor's moment (or until
 * the audio ends for the last image).
 *
 * If any anchor can't be located, returns null — caller falls back to
 * equal-segment splitting so the video still renders.
 */
function segmentDurationsFromAnchors({ anchors, timings, totalDuration }) {
  if (!Array.isArray(anchors) || anchors.length === 0) return null;
  if (!Array.isArray(timings) || timings.length === 0) return null;

  // Normalize Whisper's word stream into a single string with per-word
  // offsets so we can do substring searches and map hits to timestamps.
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const wordsNorm = timings.map((t) => ({ norm: norm(t.word), start: Number(t.start), end: Number(t.end) }));
  const joined = wordsNorm.map((w) => w.norm).join(' ');
  const wordStartOffsets = []; // char index where each word begins in `joined`
  {
    let cursor = 0;
    for (const w of wordsNorm) {
      wordStartOffsets.push(cursor);
      cursor += w.norm.length + 1; // +1 for the space separator
    }
  }

  const anchorStarts = [];
  for (const raw of anchors) {
    const needle = norm(raw);
    if (!needle) { anchorStarts.push(null); continue; }
    const hitChar = joined.indexOf(needle);
    if (hitChar < 0) { anchorStarts.push(null); continue; }
    // Find which word index this char offset falls within.
    let lo = 0, hi = wordStartOffsets.length - 1, wordIdx = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (wordStartOffsets[mid] <= hitChar) { wordIdx = mid; lo = mid + 1; }
      else { hi = mid - 1; }
    }
    anchorStarts.push(Number(wordsNorm[wordIdx]?.start));
  }

  // Any anchor failed to match? Bail — caller uses equal-segment fallback.
  if (anchorStarts.some((s) => !Number.isFinite(s))) return null;

  // Anchors must be monotonic (operator was told to write them in order).
  // If they aren't, treat as unusable rather than producing reversed segments.
  for (let i = 1; i < anchorStarts.length; i += 1) {
    if (anchorStarts[i] < anchorStarts[i - 1]) return null;
  }

  // Turn start-points into per-segment durations. Segment i runs from its
  // own anchor start to segment i+1's anchor start (or audio end).
  const durs = [];
  for (let i = 0; i < anchorStarts.length; i += 1) {
    const start = anchorStarts[i];
    const next = i + 1 < anchorStarts.length ? anchorStarts[i + 1] : totalDuration;
    const d = Math.max(1.0, next - start); // clamp so ffmpeg doesn't reject <1s
    durs.push(d);
  }
  return durs;
}

/**
 * Drive ffmpeg directly via spawn — our filtergraph is too intricate for
 * fluent-ffmpeg's helper API, and spawning keeps it easy to log the exact
 * command for debugging.
 */
function runFfmpegKenBurns({ images, audioPath, assPath, outPath, totalDuration, segmentDurations }) {
  return new Promise((resolve, reject) => {
    const filterResult = buildKenBurnsFilter({
      images, totalDuration, assPath, segmentDurations,
    });
    const { filter, totalSegmentDuration } = filterResult;
    const perSegmentDurs = filterResult.segmentDurations; // always an array

    const args = [];
    // Each image: exactly its own segment duration of 30fps looped frames.
    // Per-image -t is required when segments vary (anchor-driven timing);
    // when segments are equal this collapses to the legacy behavior.
    images.forEach((imgPath, idx) => {
      args.push(
        '-framerate', '30',
        '-loop', '1',
        '-t', perSegmentDurs[idx].toFixed(3),
        '-i', imgPath,
      );
    });
    // Audio input (indexed after all images).
    args.push('-i', audioPath);

    // Cap output at whichever is SHORTER: total visual duration or audio
    // duration. This is the key to "visuals last as long as the video":
    // segDur is computed such that segDur*N >= audio duration, then
    // -t totalSegmentDuration lets the audio play to its natural end
    // because totalSegmentDuration >= audio. We do NOT use -shortest, to
    // avoid a race between the concat stream end and audio end truncating
    // the visual early.
    const outDuration = Math.min(totalSegmentDuration, totalDuration);

    args.push(
      '-filter_complex', filter,
      '-map', '[vout]',
      '-map', `${images.length}:a:0`,
      '-t', outDuration.toFixed(3),
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '20',
      '-pix_fmt', 'yuv420p',
      '-r', '30',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-movflags', '+faststart',
      '-y',
      outPath,
    );

    const proc = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', (c) => { stderr += c.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) return resolve(outPath);
      reject(new Error(`ffmpeg Ken-Burns render failed (exit ${code}): ${stderr.slice(-800)}`));
    });
  });
}

/**
 * Drain ONE Images_Generated row into a finished mp4 using the Ken Burns
 * pipeline. Falls back to the looping-background renderer if no images
 * are present on disk (legacy rows or opt-out mode).
 */
async function processOneImaged() {
  const row = await db.fetchOldestByStatus('Images_Generated');
  if (!row) return null;
  return processImagedRow(row);
}

/**
 * Render video for ONE specific Images_Generated row. Used by the dashboard
 * "Run next stage" button so operators can push a targeted row through
 * rendering without waiting for the orchestrator's tick or the queue order.
 */
async function processImagedRow(row) {
  if (!row) throw new Error('processImagedRow: row is required');
  if (row.status !== 'Images_Generated') {
    throw new Error(`processImagedRow: row #${row.id} is in status "${row.status}", not Images_Generated`);
  }
  if (!row.audio_path) {
    throw new Error(`audio_path missing for id=${row.id}`);
  }

  // audio_path is a storage key (e.g. "audio/74.mp3"). Resolve to a local
  // file ffmpeg / whisper can consume; in gcs mode this downloads into TMP.
  const audioLocal = await storage.ensureLocal(row.audio_path);
  const images = await imagen.imagesForRow(row.id);
  const usingKenBurns = images.length > 0;

  // Timings — prefer Whisper, fall back to even distribution.
  const duration = await probeDuration(audioLocal);
  let timings = await whisperWordTimings(audioLocal);
  if (!timings || timings.length === 0) {
    const text = scriptToSpokenText(row.script_json);
    timings = evenTimings(text, duration);
  }
  if (timings.length === 0) {
    throw new Error(`could not derive any word timings for id=${row.id}`);
  }

  // Output keys + staging paths. ffmpeg writes to the staging path; we
  // putFile it into storage after it completes so a mid-render crash
  // doesn't leave a truncated mp4 in GCS.
  const subsKey   = `subs/${row.id}.ass`;
  const videoKey  = `video/${row.id}.mp4`;
  const assPath   = storage.localPathFor(subsKey,  { staging: true });
  const videoPath = storage.localPathFor(videoKey, { staging: true });
  await fsp.writeFile(assPath, buildAss(timings), 'utf8');

  if (usingKenBurns) {
    // Scene-anchored timing: if the script provided visual_anchors (verbatim
    // quotes tied to each image), locate each anchor in the Whisper word
    // stream and build per-image segment durations. This makes image N
    // appear DURING the exact spoken beat it illustrates, instead of during
    // a generic N-th slice of the audio.
    //
    // Any mismatch (missing anchor, reversed order, parse problem) -> null,
    // and buildKenBurnsFilter falls back to equal segments so we still ship.
    let anchors = null;
    try {
      const script = typeof row.script_json === 'string' ? JSON.parse(row.script_json) : row.script_json;
      anchors = Array.isArray(script?.visual_anchors) ? script.visual_anchors : null;
    } catch { /* ignore; no anchors */ }
    const segmentDurations = anchors
      ? segmentDurationsFromAnchors({ anchors, timings, totalDuration: duration })
      : null;
    if (segmentDurations) {
      console.log(`[render] scene-anchored timing engaged for row ${row.id}: ` +
        segmentDurations.map((d) => d.toFixed(2)).join('s, ') + 's');
    }

    await runFfmpegKenBurns({
      images,
      audioPath: audioLocal,
      assPath,
      outPath: videoPath,
      totalDuration: duration,
      segmentDurations,
    });
  } else {
    if (!fs.existsSync(BG_VIDEO_PATH)) {
      throw new Error(
        `no generated images found for id=${row.id} and fallback background video missing at ${BG_VIDEO_PATH}`
      );
    }
    await runFfmpegBackgroundRender({
      bgVideo:   BG_VIDEO_PATH,
      audioPath: audioLocal,
      assPath,
      outPath:   videoPath,
    });
  }

  // Push the completed mp4 + subtitles into the store. Keep the mp4 local
  // in gcs mode too so ffprobe / previews still work on the box that just
  // rendered it — TMP gets cleaned up by the OS between cold starts.
  await storage.putFile(videoKey, videoPath, { contentType: 'video/mp4' });
  await storage.putFile(subsKey,  assPath,   { contentType: 'text/x-ssa' });

  const updated = await db.updateStatus(row.id, 'Rendered', { video_path: videoKey });
  return updated;
}

// -----------------------------------------------------------------------------
// Batch processors + scheduler
// -----------------------------------------------------------------------------

async function processScriptedBatch({ max = Infinity } = {}) {
  const out = { processed: 0, ok: 0, failed: 0, errors: [] };
  while (out.processed < max) {
    const peek = await db.fetchOldestByStatus('Scripted');
    if (!peek) break;
    out.processed += 1;
    try {
      await processOneScripted();
      out.ok += 1;
    } catch (err) {
      out.failed += 1;
      out.errors.push({ id: peek.id, error: err.message });
      // Row stays at 'Scripted'. Break to avoid a hot loop re-hitting the same row.
      break;
    }
  }
  return out;
}

async function processImagedBatch({ max = Infinity } = {}) {
  const out = { processed: 0, ok: 0, failed: 0, errors: [] };
  while (out.processed < max) {
    const peek = await db.fetchOldestByStatus('Images_Generated');
    if (!peek) break;
    out.processed += 1;
    try {
      await processOneImaged();
      out.ok += 1;
    } catch (err) {
      out.failed += 1;
      out.errors.push({ id: peek.id, error: err.message });
      break; // same reason — don't busy-retry a broken row
    }
  }
  return out;
}

let _timer = null;
/**
 * Periodically drain BOTH queues: Scripted -> Audio, then Audio -> Rendered.
 * First run fires immediately.
 */
function start({ intervalMs = 5 * 60 * 1000 } = {}) {
  stop();
  const tick = async () => {
    try {
      const a = await processScriptedBatch();
      if (a.processed) console.log(`[render] TTS   processed=${a.processed} ok=${a.ok} failed=${a.failed}`);
      for (const e of a.errors) console.warn(`[render] TTS  #${e.id}: ${e.error}`);

      const b = await processImagedBatch();
      if (b.processed) console.log(`[render] VIDEO processed=${b.processed} ok=${b.ok} failed=${b.failed}`);
      for (const e of b.errors) console.warn(`[render] VIDEO #${e.id}: ${e.error}`);
    } catch (err) {
      console.error('[render] tick failed:', err.message);
    }
  };
  tick();
  _timer = setInterval(tick, intervalMs);
  return stop;
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

// ---------------------------------------------------------------------------
// HeyGen Avatar IV path (DORMANT until HEYGEN_ENABLED=true).
//
// When a HeyGen webhook POSTs avatar_video.success to /api/webhooks/heygen,
// the webhook handler calls into this function. We stream the completed mp4
// from HeyGen's signed URL into our GCS bucket at video/{id}.mp4, then
// advance the row to Rendered — at which point the orchestrator's next
// tick passes it to the packager like any other Rendered row.
//
// The submit/audio_url + status-polling paths live in heygen.js.
// ---------------------------------------------------------------------------
async function finalizeHeygenRow(rowId, { videoId, downloadUrl }) {
  if (!Number.isInteger(rowId) || rowId <= 0) {
    throw new Error('finalizeHeygenRow: rowId must be a positive integer');
  }
  const heygen = require('./heygen');
  if (!heygen.enabled) {
    console.warn(`[heygen] finalize called while disabled — skipping row ${rowId}`);
    return null;
  }

  const row = await db.getVideoById(rowId);
  if (!row) throw new Error(`finalizeHeygenRow: no row ${rowId}`);
  if (row.status === 'Rendered' || row.status === 'Pending_Approval' ||
      row.status === 'Published' || row.status === 'Rejected') {
    console.log(`[heygen] row ${rowId} already at ${row.status}, skipping finalize`);
    return row;
  }

  // Stream the mp4 into TMP, then push to storage. putFile handles local-vs-gcs.
  const stagingPath = storage.localPathFor(`video/${rowId}.mp4`, { staging: true });
  await heygen.downloadToFile(downloadUrl, stagingPath);

  const videoKey = `video/${rowId}.mp4`;
  await storage.putFile(videoKey, stagingPath, { contentType: 'video/mp4' });

  const updated = await db.updateStatus(rowId, 'Rendered', {
    video_path: videoKey,
    source_signals: {
      ...(row.source_signals ? (typeof row.source_signals === 'string' ? JSON.parse(row.source_signals) : row.source_signals) : {}),
      heygen: { video_id: videoId, downloaded_at: new Date().toISOString() },
    },
  });
  console.log(`[heygen] row ${rowId} Rendered via HeyGen video_id=${videoId}`);
  return updated;
}

module.exports = {
  // Part 1 — Scripted -> Audio_Generated (TTS)
  processOneScripted,
  processScriptedRow,
  processScriptedBatch,
  scriptToSpokenText,
  // Part 2 — Images_Generated -> Rendered (Ken Burns reel)
  processOneImaged,
  processImagedRow,
  processImagedBatch,
  // Part 2b — Audio_Generated -> Rendered (HeyGen Avatar IV, dormant)
  finalizeHeygenRow,
  buildAss,
  buildKenBurnsFilter,
  whisperWordTimings,
  evenTimings,
  // Scheduler
  start,
  stop,
  // Paths (handy for the server / UI)
  AUDIO_DIR,
  VIDEO_DIR,
  SUBS_DIR,
  BG_VIDEO_PATH,
};

// -----------------------------------------------------------------------------
// Self-test — `node render.js`
// -----------------------------------------------------------------------------
if (require.main === module) {
  (async () => {
    console.log('--- Render Agent self-test ---');
    console.log('ffmpeg :', ffmpegPath);
    console.log('ffprobe:', ffprobePath);
    console.log('bg     :', BG_VIDEO_PATH, fs.existsSync(BG_VIDEO_PATH) ? '(found)' : '(MISSING)');
    console.log('DB     :', await db.getCounts());

    if (TTS_PROVIDER === 'openai' && !OPENAI_API_KEY) {
      console.error('OPENAI_API_KEY is not set. export it and rerun.');
      process.exit(1);
    }
    if (TTS_PROVIDER === 'elevenlabs' && !ELEVENLABS_API_KEY) {
      console.error('ELEVENLABS_API_KEY is not set. export it and rerun.');
      process.exit(1);
    }

    // Part 1
    console.log('\n>>> Part 1: Scripted -> Audio_Generated');
    const a = await processScriptedBatch({ max: 1 });
    console.log('   result:', a);

    // Part 2
    console.log('\n>>> Part 2: Images_Generated -> Rendered');
    const b = await processImagedBatch({ max: 1 });
    console.log('   result:', b);

    console.log('\nDB after:', await db.getCounts());
  })();
}
