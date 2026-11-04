/**
 * competitor.js — Competitive signal agent.
 *
 * Pulls "what's working for other people" from free sources, scores it
 * per-persona, and writes rows into the `signals` table. The Researcher
 * blends these signals with RSS headlines to bias idea generation toward
 * topics with actual audience demand.
 *
 * Sources:
 *   reddit   — hot threads in persona-relevant subs (free, no auth)
 *   youtube  — recent high-view videos for persona queries (OPTIONAL;
 *              only runs when YT_API_KEY / YOUTUBE_API_KEY is set)
 *
 * Score normalization: each source emits a 0..∞ float. The Researcher
 * treats higher = hotter; cross-source comparability is approximate, not
 * exact. We log-compress the raw counts so a 10k-upvote monster doesn't
 * drown out every mid-engagement thread.
 */

const db = require('./db');

// ---------------------------------------------------------------------------
// Source config
// ---------------------------------------------------------------------------
const SUBREDDITS = {
  BUILDER: [
    // Contractor- and business-side subs only. Dropped r/HomeImprovement and
    // r/Tools because those are homeowners doing DIY projects, not contractors
    // running a business — their threads (e.g. "Drill time", "What nickname do
    // you have for these?") produced ideas that had nothing to do with
    // BuilderCFO's audience (contractors tracking job margins).
    'HomeBuilding',
    'Construction',
    'Contractor',
    'GeneralContractor',
    'ConstructionManagers',
    'QuickBooks',
    'smallbusiness',
  ],
  SELLER: [
    'shopify',
    'Entrepreneur',
    'ecommerce',
    'FulfillmentByAmazon',
    'AmazonSeller',
    'dropship',
    'smallbusiness',
  ],
};

const YT_QUERIES = {
  BUILDER: [
    'custom home builder business',
    'construction job costing',
    'Procore Buildertrend tips',
    'contractor margins profit',
  ],
  SELLER: [
    'Shopify growth tips',
    'Amazon FBA profit',
    'ecommerce P&L margin',
    'ecom logistics 3PL',
  ],
};

const YT_API_KEY = process.env.YT_API_KEY || process.env.YOUTUBE_API_KEY || '';
const USER_AGENT = 'CFO-Content-Engine/0.2 (+competitor)';
const FETCH_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function fetchJson(url, init = {}) {
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...init,
      headers: { 'user-agent': USER_AGENT, accept: 'application/json', ...(init.headers || {}) },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    return await res.json();
  } finally {
    clearTimeout(to);
  }
}

// Log-compress raw counts so one viral post can't dominate ranking.
function logScore(n) {
  const x = Math.max(0, Number(n) || 0);
  return Math.log10(1 + x);
}

// ---------------------------------------------------------------------------
// Reddit
// ---------------------------------------------------------------------------

async function fetchRedditHot(subreddit, { timeframe = 'week', limit = 15 } = {}) {
  const url =
    `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/top.json` +
    `?t=${encodeURIComponent(timeframe)}&limit=${limit}`;
  const data = await fetchJson(url);
  const children = data?.data?.children || [];
  return children.map((c) => c.data).filter(Boolean).map((p) => ({
    title: p.title || '',
    url: p.permalink ? `https://reddit.com${p.permalink}` : (p.url || ''),
    ups: Number(p.ups || p.score || 0),
    num_comments: Number(p.num_comments || 0),
    subreddit: p.subreddit || subreddit,
    created_utc: p.created_utc ? new Date(p.created_utc * 1000).toISOString() : null,
    over_18: !!p.over_18,
    stickied: !!p.stickied,
    is_self: !!p.is_self,
  })).filter((p) => p.title && !p.over_18 && !p.stickied);
}

async function collectReddit(persona) {
  const subs = SUBREDDITS[persona] || [];
  const results = await Promise.allSettled(subs.map((s) => fetchRedditHot(s)));
  const errors = [];
  const all = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') all.push(...r.value);
    else errors.push(`r/${subs[i]}: ${r.reason?.message || r.reason}`);
  });
  // Score: weight comments harder than upvotes — discussion volume is a
  // stronger pain-point signal than passive agreement.
  const signals = all.map((p) => ({
    source: 'reddit',
    persona,
    title: p.title,
    url: p.url,
    score: logScore(p.ups) + 1.5 * logScore(p.num_comments),
    raw_json: p,
  }));
  signals.sort((a, b) => b.score - a.score);
  return { signals, errors };
}

// ---------------------------------------------------------------------------
// YouTube (optional)
// ---------------------------------------------------------------------------

async function searchYouTube(query, { maxResults = 10, publishedAfterDays = 30 } = {}) {
  if (!YT_API_KEY) return [];
  const publishedAfter = new Date(Date.now() - publishedAfterDays * 86_400_000).toISOString();
  const searchUrl = new URL('https://www.googleapis.com/youtube/v3/search');
  searchUrl.searchParams.set('key', YT_API_KEY);
  searchUrl.searchParams.set('part', 'snippet');
  searchUrl.searchParams.set('type', 'video');
  searchUrl.searchParams.set('q', query);
  searchUrl.searchParams.set('maxResults', String(maxResults));
  searchUrl.searchParams.set('publishedAfter', publishedAfter);
  searchUrl.searchParams.set('order', 'viewCount');

  const s = await fetchJson(searchUrl.toString());
  const items = s?.items || [];
  const ids = items.map((it) => it.id?.videoId).filter(Boolean);
  if (ids.length === 0) return [];

  // Second call fetches statistics (viewCount etc.) for the IDs.
  const statsUrl = new URL('https://www.googleapis.com/youtube/v3/videos');
  statsUrl.searchParams.set('key', YT_API_KEY);
  statsUrl.searchParams.set('part', 'snippet,statistics');
  statsUrl.searchParams.set('id', ids.join(','));
  const v = await fetchJson(statsUrl.toString());
  return (v?.items || []).map((it) => ({
    title: it.snippet?.title || '',
    url: `https://www.youtube.com/watch?v=${it.id}`,
    channel: it.snippet?.channelTitle || '',
    publishedAt: it.snippet?.publishedAt || null,
    viewCount:    Number(it.statistics?.viewCount    || 0),
    likeCount:    Number(it.statistics?.likeCount    || 0),
    commentCount: Number(it.statistics?.commentCount || 0),
  })).filter((v) => v.title);
}

async function collectYouTube(persona) {
  if (!YT_API_KEY) return { signals: [], errors: [] };
  const queries = YT_QUERIES[persona] || [];
  const results = await Promise.allSettled(queries.map((q) => searchYouTube(q)));
  const errors = [];
  const all = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') all.push(...r.value);
    else errors.push(`yt "${queries[i]}": ${r.reason?.message || r.reason}`);
  });
  // Score: views are the dominant signal; comments add a small boost
  // because they indicate resonance beyond an algorithmic push.
  const signals = all.map((v) => ({
    source: 'youtube',
    persona,
    title: v.title,
    url: v.url,
    score: logScore(v.viewCount) + 0.5 * logScore(v.commentCount),
    raw_json: v,
  }));
  signals.sort((a, b) => b.score - a.score);
  return { signals, errors };
}

// ---------------------------------------------------------------------------
// Top-level: collect, persist, return
// ---------------------------------------------------------------------------

/**
 * Pull fresh signals for one persona across all enabled sources and
 * persist them to the `signals` table. Returns a summary.
 */
async function runOnce(persona, { topPerSource = 20 } = {}) {
  if (!db.PERSONAS.includes(persona)) {
    throw new TypeError(`runOnce: persona must be one of ${db.PERSONAS.join(', ')} (got ${persona})`);
  }
  const [reddit, yt] = await Promise.all([collectReddit(persona), collectYouTube(persona)]);

  const all = [...reddit.signals.slice(0, topPerSource), ...yt.signals.slice(0, topPerSource)];
  let saved = 0;
  for (const s of all) {
    try { await db.insertSignal(s); saved += 1; }
    catch (err) { reddit.errors.push(`insert: ${err.message}`); }
  }

  return {
    persona,
    saved,
    reddit_count: reddit.signals.length,
    youtube_count: yt.signals.length,
    errors: [...reddit.errors, ...yt.errors],
  };
}

async function runAllPersonas(opts) {
  const out = [];
  for (const p of db.PERSONAS) out.push(await runOnce(p, opts));
  return out;
}

module.exports = {
  runOnce,
  runAllPersonas,
  collectReddit,
  collectYouTube,
  SUBREDDITS,
  YT_QUERIES,
};

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------
if (require.main === module) {
  (async () => {
    console.log('--- Competitor Agent self-test ---');
    console.log('YouTube API key present:', !!YT_API_KEY);
    for (const p of db.PERSONAS) {
      const t0 = Date.now();
      const r = await runOnce(p);
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`\n${p}: saved=${r.saved} reddit=${r.reddit_count} yt=${r.youtube_count} (${dt}s)`);
      for (const e of r.errors.slice(0, 5)) console.log('   !', e);
      const top = await db.getRecentSignals(p, { days: 1, limit: 5 });
      console.log(`   top signals for ${p}:`);
      for (const s of top) console.log(`     · [${s.source}] ${s.score.toFixed(2)}  ${s.title.slice(0, 90)}`);
    }
  })();
}
