/**
 * viral.js — Viral Teardown Agent (free-source edition).
 *
 * Once a week, pull the top-upvoted threads of the last 7 days from each
 * persona's subreddits, feed their titles + engagement counts to Claude, and
 * ask for a structured "what's winning right now" playbook:
 *
 *   - this_week_summary      : one-sentence thesis
 *   - dominant_hook_patterns : the hook/framing shapes that are resonating
 *   - typical_length_seconds : target length (inferred from pattern density)
 *   - pacing_notes           : cut cadence, talking-head vs b-roll, text density
 *   - cta_styles             : close patterns that fit the mood
 *   - visual_motifs          : recurring staging patterns
 *   - avoid                  : what's conspicuously absent from the winners
 *
 * Why Reddit-only: YouTube Data API requires a billing-linked project; the
 * free Reddit JSON feed works unauthenticated and the competitor.js scaffolding
 * already pulls and scores persona-relevant threads. Reddit titles ARE the
 * pain-point vocabulary the next batch of viral short-form creators will
 * exploit — a Reddit thread with 4k upvotes in r/Construction this week IS
 * the demand signal for "what's about to go viral on TikTok for contractors."
 *
 * The collector function is structured so new sources (Apify TikTok,
 * YouTube Data API, IG reels scraper) drop in later as additional inputs to
 * `collectSamples()` without changing the teardown or save logic.
 *
 * The playbook is stored in engine_viral_playbook (one row per run) and
 * creative.js reads the most recent row on every script generation, prepending
 * it to the system prompt. The hand-coded hook formulas in creative.js stay
 * as the floor; the playbook is the week-to-week adaptive layer on top.
 *
 * This module does NOT auto-start on require. Call runOnce(persona) for a
 * one-shot pull, or start({ intervalMs }) to schedule periodic runs.
 *
 * Run directly (`node viral.js`) to execute the self-test at the bottom.
 */

const db = require('./db');
const llm = require('./llm');
const competitor = require('./competitor');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const WINDOW_DAYS       = Number(process.env.VIRAL_WINDOW_DAYS) || 7;
const MAX_SAMPLES       = Number(process.env.VIRAL_MAX_SAMPLES) || 40;
const MIN_SAMPLES       = Number(process.env.VIRAL_MIN_SAMPLES) || 8;
const PERSONAS = ['BUILDER', 'SELLER'];

// ---------------------------------------------------------------------------
// Collector — blends Reddit demand signals with YouTube view-count signals.
// Apify TikTok can drop in here later as a third source returning the same
// shape: { samples: [{ source, title, score, ups, comments, url, ... }], errors }
//
// Reddit: titles represent community pain-points and framings (demand signal).
// YouTube: view counts represent videos already winning the algorithm (supply
//   signal). Blending both gives Claude the topic-pain-AND-format-pattern view
//   rather than just one side.
// ---------------------------------------------------------------------------
async function collectSamples(persona) {
  const [redditRes, ytRes] = await Promise.all([
    competitor.collectReddit(persona),
    competitor.collectYouTube(persona), // returns {signals:[], errors:[]} with no key
  ]);

  const errors = [...redditRes.errors, ...ytRes.errors];

  const redditSamples = redditRes.signals.map((s) => {
    const r = s.raw_json || {};
    return {
      source: 'reddit',
      title: s.title,
      score: s.score,
      ups: Number(r.ups || 0),
      comments: Number(r.num_comments || 0),
      url: s.url,
      subreddit: r.subreddit || null,
      is_video_link: isShortFormVideoLink(r.url),
    };
  });

  const ytSamples = ytRes.signals.map((s) => {
    const r = s.raw_json || {};
    return {
      source: 'youtube',
      title: s.title,
      score: s.score,
      ups: Number(r.viewCount || 0),       // views go in the "ups" slot for display parity
      comments: Number(r.commentCount || 0),
      url: s.url,
      channel: r.channel || null,
      is_video_link: true,                  // YouTube videos are always video links
    };
  });

  // Balance the blend — neither source should dominate the 40-sample cap.
  // We take up to MAX_SAMPLES/2 from each side, then fill the remainder with
  // whichever has more headroom. competitor.collectYouTube is a no-op when
  // YT_API_KEY is absent, so the budget collapses naturally to Reddit-only.
  const half = Math.floor(MAX_SAMPLES / 2);
  redditSamples.sort((a, b) => b.score - a.score);
  ytSamples.sort((a, b) => b.score - a.score);

  const rTake = Math.min(half, redditSamples.length);
  const yTake = Math.min(MAX_SAMPLES - rTake, ytSamples.length);
  const rFinal = redditSamples.slice(0, rTake);
  const yFinal = ytSamples.slice(0, yTake);
  // If YouTube under-delivered, fill the leftover with more Reddit.
  const leftover = MAX_SAMPLES - rFinal.length - yFinal.length;
  const extras = leftover > 0 ? redditSamples.slice(rTake, rTake + leftover) : [];

  const samples = [...rFinal, ...yFinal, ...extras];
  return { samples, errors };
}

function isShortFormVideoLink(url) {
  if (!url || typeof url !== 'string') return false;
  return /youtube\.com\/shorts\/|youtu\.be\/|tiktok\.com|instagram\.com\/reel|instagram\.com\/reels|instagram\.com\/p\//i.test(url);
}

// ---------------------------------------------------------------------------
// Claude teardown — structured output
// ---------------------------------------------------------------------------
const PLAYBOOK_SCHEMA = {
  type: 'OBJECT',
  properties: {
    this_week_summary: {
      type: 'STRING',
      description: 'One sentence: the dominant theme or emotional pattern in this persona\'s community RIGHT NOW — the thing a viral short-form video could ride.',
    },
    dominant_hook_patterns: {
      type: 'ARRAY',
      description: 'Ranked, most-to-least common. 2-5 entries. Each entry names the pattern and quotes one real example headline from the samples.',
      items: {
        type: 'OBJECT',
        properties: {
          pattern: { type: 'STRING' },
          example: { type: 'STRING' },
        },
        required: ['pattern', 'example'],
      },
    },
    typical_length_seconds: {
      type: 'OBJECT',
      description: 'Recommended script length for THIS WEEK based on the complexity of the patterns you see. 25-45s range for short-form.',
      properties: {
        median: { type: 'NUMBER' },
        p25:    { type: 'NUMBER' },
        p75:    { type: 'NUMBER' },
      },
      required: ['median'],
    },
    pacing_notes: {
      type: 'STRING',
      description: 'Short paragraph on how a video should feel to match the week\'s energy: cut cadence, talking-head vs b-roll, on-screen-text density.',
    },
    cta_styles: {
      type: 'ARRAY',
      description: '2-4 CTA patterns that would land given the emotional register of the week (soft, comment-keyword, pattern-break, etc.).',
      items: { type: 'STRING' },
    },
    visual_motifs: {
      type: 'ARRAY',
      description: '3-6 visual or staging patterns a creator should reach for this week (dashboards, site walkthrough, whiteboard, split-screen before/after, etc.).',
      items: { type: 'STRING' },
    },
    avoid: {
      type: 'ARRAY',
      description: '2-4 patterns conspicuously absent from the winners — what NOT to do this week.',
      items: { type: 'STRING' },
    },
  },
  required: [
    'this_week_summary',
    'dominant_hook_patterns',
    'typical_length_seconds',
    'pacing_notes',
    'cta_styles',
    'visual_motifs',
    'avoid',
  ],
};

function buildUserText(persona, samples) {
  const redditLines = samples.filter((v) => v.source === 'reddit').map((v, i) => {
    const tag = v.is_video_link ? ' [VIDEO]' : '';
    return `  R${i + 1}. [${v.ups.toLocaleString()}↑ ${v.comments}💬 r/${v.subreddit || '?'}${tag}] "${v.title}"`;
  }).join('\n');

  const ytLines = samples.filter((v) => v.source === 'youtube').map((v, i) => {
    const views = v.ups.toLocaleString();
    const ch = v.channel ? ` · @${v.channel}` : '';
    return `  Y${i + 1}. [${views} views · ${v.comments}💬${ch}] "${v.title}"`;
  }).join('\n');

  const personaDescription = persona === 'BUILDER'
    ? 'Custom home builders / general contractors running construction businesses ($500k-$10M revenue, tracking margins and job profitability). We sell BuilderCFO — a QuickBooks + Procore/Buildertrend overlay.'
    : 'Shopify / Amazon FBA / e-commerce sellers running online product businesses. We sell SellerCFO — accounting + margin visibility for operators.';

  const parts = [
    `Persona: ${personaDescription}`,
    '',
    `Below are the top signals from this persona's world over the last ${WINDOW_DAYS} days, blended from two sources:`,
    '',
    '  REDDIT — top-engaged community threads (demand signal: what the audience is obsessed with — pain points, rants, wins, framings that resonate enough to get upvoted and discussed).',
    '  YOUTUBE — highest-view videos in this niche (supply signal: the formats/hooks the algorithm is already rewarding RIGHT NOW).',
    '',
  ];

  if (redditLines) {
    parts.push(
      `Reddit (${samples.filter((v) => v.source === 'reddit').length} threads). Format: [upvotes↑ comments💬 r/sub] "title"  —  [VIDEO] tag marks threads linking to TikTok/YouTube-short/IG-reel.`,
      '',
      redditLines,
      ''
    );
  }
  if (ytLines) {
    parts.push(
      `YouTube (${samples.filter((v) => v.source === 'youtube').length} videos). Format: [views · comments💬 · @channel] "title".`,
      '',
      ytLines,
      ''
    );
  }

  parts.push(
    'Produce a structured teardown matching the schema. Blend both sources: Reddit tells you what the audience is hungry to hear; YouTube tells you the hook/format shapes already winning the algorithm. A viral video this week sits at the intersection. Cite specific examples from the list (use the R#/Y# prefix when quoting). Be tactical — we\'re writing 30-45s videos, not LinkedIn posts.'
  );

  return parts.join('\n');
}

const SYSTEM_PROMPT = [
  'You are a short-form content strategist. You read community signals (Reddit threads, YouTube videos,',
  'TikTok discourse) and translate them into tactical playbooks for creators making 30-45s vertical videos.',
  '',
  'You will be given TWO kinds of samples blended into one list:',
  '  · Reddit threads — demand signal (pain-points, framings, emotional beats the audience is upvoting).',
  '  · YouTube videos — supply signal (hook shapes and formats the algorithm is already rewarding).',
  '',
  'Your job is to find the intersection: what the audience is hungry for AND what format is winning,',
  'and translate that into a tactical playbook.',
  '',
  'Be specific. "Numbers in the hook" is weak; "a single odd-specific number in the first 2 seconds',
  'followed by an immediate contradiction" is what we need. Quote real phrasing from the samples.',
  '',
  'Avoid evergreen platitudes ("start with a hook"). Assume the reader already knows the basics —',
  'tell them what is DIFFERENT about this week.',
].join(' ');

// ---------------------------------------------------------------------------
// Core: collect + teardown + save
// ---------------------------------------------------------------------------
async function runOnce(persona, { saveToDb = true } = {}) {
  if (!PERSONAS.includes(persona)) {
    throw new TypeError(`runOnce: persona must be one of ${PERSONAS.join(', ')} (got ${persona})`);
  }

  const t0 = Date.now();
  const { samples, errors } = await collectSamples(persona);
  if (samples.length < MIN_SAMPLES) {
    return {
      persona,
      skipped: `too_few_samples (${samples.length})`,
      errors,
    };
  }

  const playbook = await llm.generateStructured({
    system: SYSTEM_PROMPT,
    user:   buildUserText(persona, samples),
    schema: PLAYBOOK_SCHEMA,
    label:  `viral:${persona}`,
  });

  let saved = null;
  if (saveToDb) {
    const sources = [...new Set(samples.map((s) => s.source))].join(',');
    saved = await db.saveViralPlaybook(persona, {
      playbook,
      sample_count:       samples.length,
      source_window_days: WINDOW_DAYS,
      notes: `sources=${sources}; video-linked=${samples.filter((s) => s.is_video_link).length}`,
    });
  }

  return {
    persona,
    samples: samples.length,
    errors,
    playbook,
    saved_id: saved?.id ?? null,
    duration_ms: Date.now() - t0,
  };
}

async function runAllPersonas(opts) {
  const out = [];
  for (const p of PERSONAS) out.push(await runOnce(p, opts));
  return out;
}

// ---------------------------------------------------------------------------
// Scheduler — weekly by default.
// ---------------------------------------------------------------------------
let _timer = null;

function start({ intervalMs = 7 * 24 * 60 * 60 * 1000, immediate = true } = {}) {
  stop();
  const tick = async () => {
    for (const p of PERSONAS) {
      try {
        const r = await runOnce(p);
        if (r.skipped) {
          console.log(`[viral] ${p}: skipped (${r.skipped})`);
        } else {
          console.log(`[viral] ${p}: saved playbook from ${r.samples} samples in ${r.duration_ms}ms`);
        }
        for (const e of r.errors?.slice?.(0, 3) || []) console.warn(`[viral] ${p}: ${e}`);
      } catch (err) {
        console.error(`[viral] ${p} run failed:`, err.message);
      }
    }
  };
  if (immediate) tick();
  _timer = setInterval(tick, intervalMs);
  return stop;
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = {
  runOnce,
  runAllPersonas,
  start,
  stop,
  PERSONAS,
  _collectSamples: collectSamples,
  _PLAYBOOK_SCHEMA: PLAYBOOK_SCHEMA,
};

// ---------------------------------------------------------------------------
// Self-test — `node -r dotenv/config viral.js`
// ---------------------------------------------------------------------------
if (require.main === module) {
  (async () => {
    console.log('--- Viral Teardown self-test (free sources) ---');
    console.log('Window:', WINDOW_DAYS, 'days  ·  samples cap:', MAX_SAMPLES);

    for (const p of PERSONAS) {
      console.log(`\n>>> ${p}`);
      try {
        const r = await runOnce(p);
        if (r.skipped) {
          console.log(`   skipped: ${r.skipped}`);
          if (r.errors?.length) for (const e of r.errors.slice(0, 3)) console.log('     !', e);
          continue;
        }
        console.log(`   samples: ${r.samples}  ·  saved_id: ${r.saved_id}  ·  ${r.duration_ms}ms`);
        console.log(`   summary: ${r.playbook.this_week_summary}`);
        console.log(`   hooks:`);
        for (const h of r.playbook.dominant_hook_patterns || []) {
          console.log(`     - ${h.pattern}`);
          console.log(`       e.g. "${String(h.example).slice(0, 100)}"`);
        }
        const t = r.playbook.typical_length_seconds || {};
        console.log(`   length: median=${t.median}s  p25=${t.p25}s  p75=${t.p75}s`);
        console.log(`   pacing: ${String(r.playbook.pacing_notes).slice(0, 160)}`);
        console.log(`   CTAs: ${(r.playbook.cta_styles || []).join(' · ')}`);
        console.log(`   visuals: ${(r.playbook.visual_motifs || []).join(' · ')}`);
        console.log(`   AVOID: ${(r.playbook.avoid || []).join(' · ')}`);
      } catch (err) {
        console.error(`   runOnce(${p}) failed:`, err.message);
      }
    }

    console.log('\n--- done ---');
    process.exit(0);
  })();
}
