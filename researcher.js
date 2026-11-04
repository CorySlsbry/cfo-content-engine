/**
 * researcher.js — The Researcher Agent for the CFO Content Engine.
 *
 * Pulls trending topics from free RSS feeds (no API keys required) and
 * inserts the top 3 per persona into the videos table as 'Idea' rows.
 *
 *  - Mode A 'BUILDER' : construction materials / home builders / financial
 *                       systems (QuickBooks, Procore)
 *  - Mode B 'SELLER'  : Shopify / Amazon FBA / e-commerce logistics
 *
 * Sources: Google News RSS (reliable, free, keyword-queryable) plus a few
 * branded feeds. Google News is the workhorse; the branded feeds add
 * signal when a company actually publishes fresh news.
 *
 * This module does NOT auto-start on require. Call `runOnce(mode)` for
 * a one-shot pull, or `start({ intervalMs })` to schedule periodic runs.
 *
 * Run directly (`node researcher.js`) to execute the self-test at the
 * bottom of this file — it pulls 3 ideas for each persona and prints the
 * resulting DB state so you can verify population visually.
 */

const https = require('node:https');
const http = require('node:http');
const { URL } = require('node:url');

const db = require('./db');

// -----------------------------------------------------------------------------
// Feed configuration
// -----------------------------------------------------------------------------
// Google News RSS endpoint: keyword search that returns a proper RSS 2.0
// document with <item><title>, <pubDate>, and <link> — no auth required.
const gnews = (q) =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;

const FEEDS = {
  BUILDER: [
    // NAHB is the primary source — their audience IS our audience (home
    // builders and contractors), so every post has a natural bridge into
    // a job-costing / margin-visibility script.
    //
    // Eye on Housing — NAHB's economics blog. Builder sentiment, permits,
    // construction costs, lumber duties — every post is a topical hook.
    'https://eyeonhousing.org/feed/',
    // NAHBNow — NAHB's industry/regulatory news blog (the old nahbnow.com
    // domain now 301s to this URL).
    'https://www.nahb.org/blog/feed/',
    // Construction Dive — broader industry news. Good variety, publishes
    // daily, quality tends to beat raw Google News aggregation.
    'https://www.constructiondive.com/feeds/news/',
  ],
  SELLER: [
    gnews('Shopify merchants OR "Shopify news"'),
    gnews('"Amazon FBA" sellers'),
    gnews('ecommerce logistics fulfillment'),
    // Branded Atom feed from Shopify.
    'https://www.shopify.com/blog.atom',
  ],
};

const PERSONAS = ['BUILDER', 'SELLER'];
const IDEAS_PER_RUN = 3;
const FETCH_TIMEOUT_MS = 10_000;

// -----------------------------------------------------------------------------
// HTTP helper
// -----------------------------------------------------------------------------
/**
 * Fetch a URL as a string. Follows up to 5 redirects. Times out after
 * FETCH_TIMEOUT_MS. Rejects on non-2xx so the caller can skip the source.
 */
function fetchText(urlStr, { redirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(urlStr); } catch (e) { return reject(e); }
    const client = url.protocol === 'http:' ? http : https;

    const req = client.get(
      url,
      {
        headers: {
          // Some feeds 403 a bare Node UA.
          'user-agent': 'CFO-Content-Engine/0.1 (+researcher)',
          'accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*;q=0.8',
        },
        timeout: FETCH_TIMEOUT_MS,
      },
      (res) => {
        const { statusCode, headers } = res;
        if (statusCode >= 300 && statusCode < 400 && headers.location && redirects > 0) {
          res.resume();
          const next = new URL(headers.location, url).toString();
          resolve(fetchText(next, { redirects: redirects - 1 }));
          return;
        }
        if (statusCode < 200 || statusCode >= 300) {
          res.resume();
          reject(new Error(`HTTP ${statusCode} from ${urlStr}`));
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve(body));
        res.on('error', reject);
      }
    );
    req.on('timeout', () => req.destroy(new Error(`timeout after ${FETCH_TIMEOUT_MS}ms: ${urlStr}`)));
    req.on('error', reject);
  });
}

// -----------------------------------------------------------------------------
// Minimal RSS / Atom parser
// -----------------------------------------------------------------------------
// We only need <title> and a date field per <item>/<entry>. Writing this by
// hand avoids an xml2js / fast-xml-parser dependency for a trivial need.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: ' ' };
function decodeEntities(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#?\w+);/g, (m, e) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e] ?? m;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? decodeEntities(m[1]) : null;
}

/**
 * Parse an RSS 2.0 or Atom feed, returning `[{ title, date }]` sorted
 * newest-first. Non-parseable feeds return an empty array — errors should
 * never take the pipeline down.
 */
function parseFeed(xml) {
  if (typeof xml !== 'string' || xml.length === 0) return [];

  // Grab either <item>...</item> (RSS) or <entry>...</entry> (Atom).
  const items = [
    ...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi),
    ...xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi),
  ].map((m) => m[1]);

  const out = [];
  for (const block of items) {
    const title = extractTag(block, 'title');
    if (!title) continue;
    const dateStr =
      extractTag(block, 'pubDate') ||
      extractTag(block, 'published') ||
      extractTag(block, 'updated') ||
      extractTag(block, 'dc:date');
    const date = dateStr ? new Date(dateStr) : null;
    out.push({ title, date: date && !Number.isNaN(+date) ? date : null });
  }
  out.sort((a, b) => (b.date?.getTime() || 0) - (a.date?.getTime() || 0));
  return out;
}

// -----------------------------------------------------------------------------
// Dedupe / normalize
// -----------------------------------------------------------------------------
function normalizeTitle(t) {
  return String(t)
    .toLowerCase()
    .replace(/\s*[-–—|].*$/, '')   // strip publisher suffix from Google News ("… - Reuters")
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function existingTopicSet() {
  const set = new Set();
  for (const row of await db.getAllVideos()) set.add(normalizeTitle(row.topic));
  return set;
}

// -----------------------------------------------------------------------------
// Core: pull 3 fresh ideas for a persona and insert
// -----------------------------------------------------------------------------

/**
 * @param {'BUILDER'|'SELLER'} mode
 * @param {{ force?: boolean, limit?: number }} [opts]
 *   - force: bypass the `generation_enabled` gate AND the `max_in_flight` cap.
 *           Used by the "Generate 1 Post" button so the operator can hand-test
 *           even when production mode is off or the pipeline is already full.
 *   - limit: cap how many ideas to insert on this run (default IDEAS_PER_RUN).
 *           Honored independently of the cap-aware budget below.
 * @returns {Promise<{ inserted: object[], skipped: number, errors: string[], gated?: string }>}
 */
async function runOnce(mode, opts = {}) {
  if (!PERSONAS.includes(mode)) {
    throw new TypeError(`runOnce: mode must be one of ${PERSONAS.join(', ')} (got ${mode})`);
  }
  const force = !!opts.force;
  const requestedLimit = Number.isFinite(opts.limit) && opts.limit > 0 ? Math.floor(opts.limit) : IDEAS_PER_RUN;

  // Production gate. The scheduled tick calls runOnce without `force`; when
  // the operator hasn't flipped the Production switch on the dashboard, we
  // bail early and let nothing through. The Generate-1 button passes force.
  if (!force && !(await db.isGenerationEnabled())) {
    return { inserted: [], skipped: 0, errors: [], gated: 'generation_disabled' };
  }

  // In-flight cap. Don't pile up more unapproved cards than the operator
  // asked for. `force` inserts are still bounded by `limit` below, but not
  // by the cap (the operator explicitly asked for one).
  let budget = requestedLimit;
  if (!force) {
    const max = await db.getMaxInFlight();
    const inFlight = await db.countInFlight();
    const remaining = max - inFlight;
    if (remaining <= 0) {
      return { inserted: [], skipped: 0, errors: [], gated: `in_flight_cap (${inFlight}/${max})` };
    }
    budget = Math.min(budget, remaining);
  }

  const urls = FEEDS[mode];
  const errors = [];

  // Fetch all RSS feeds in parallel; a failure in one is not fatal.
  const results = await Promise.allSettled(urls.map((u) => fetchText(u)));

  // RSS candidates — ranked by recency.
  const rssCandidates = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      rssCandidates.push(...parseFeed(r.value).map((it) => ({
        source: 'rss',
        title: it.title,
        url: null,
        // Recency becomes a 0..1ish score so it can compete with signals.
        score: recencyScore(it.date),
        raw: { pubDate: it.date },
      })));
    } else {
      errors.push(`${urls[i]}: ${r.reason?.message || r.reason}`);
    }
  });

  // Competitor signals for this persona — Reddit / YouTube, scored by
  // engagement. Limit to the top N so one hot sub doesn't dominate.
  const compSignals = (await db.getRecentSignals(mode, { days: 14, limit: 30 })).map((s) => ({
    source: s.source,
    title: s.title,
    url: s.url,
    score: Number(s.score) || 0,
    raw: safeParse(s.raw_json),
  }));

  // Blend: normalize scores within each source so RSS recency (0..1) and
  // Reddit log-scores (2..9) compete fairly, then sort together.
  //
  // RSS gets a weight multiplier because the feeds we curated (NAHB
  // Eye-on-Housing, NAHB Now, Construction Dive for BUILDER; Shopify blog
  // for SELLER) are editorially tied to the product audience, while Reddit
  // threads often drift into off-topic consumer chatter. The boost makes
  // sure a fresh NAHB post beats a mildly-upvoted Reddit thread.
  const RSS_WEIGHT = 2.0;
  const candidates = [
    ...normalize(rssCandidates).map((c) => ({ ...c, score: c.score * RSS_WEIGHT })),
    ...normalize(compSignals),
  ].sort((a, b) => b.score - a.score);

  const already = await existingTopicSet();
  const dismissed = await db.getDismissedTopicSet(mode); // topics the operator killed — never suggest again
  const seen = new Set();
  const picks = [];
  for (const c of candidates) {
    const norm = normalizeTitle(c.title);
    if (!norm || seen.has(norm) || already.has(norm) || dismissed.has(norm)) continue;
    seen.add(norm);
    picks.push(c);
    if (picks.length >= budget) break;
  }

  const inserted = [];
  for (const p of picks) {
    try {
      const cleanTopic =
        p.source === 'rss'
          ? (p.title.replace(/\s*[-–—|]\s*[^-–—|]+$/, '').trim() || p.title)
          : p.title;
      inserted.push(await db.insertIdea({
        target_persona: mode,
        topic: cleanTopic,
        source_signals: { source: p.source, url: p.url, score: p.score, raw: p.raw },
      }));
    } catch (err) {
      errors.push(`insert failed for "${p.title}": ${err.message}`);
    }
  }

  return { inserted, skipped: candidates.length - inserted.length, errors };
}

function recencyScore(date) {
  if (!date) return 0;
  const hours = (Date.now() - date.getTime()) / 3_600_000;
  if (hours < 0) return 1;
  // half-life ~48h
  return Math.exp(-hours / 48);
}

function normalize(items) {
  if (items.length === 0) return items;
  const max = Math.max(...items.map((i) => i.score || 0), 0);
  if (max <= 0) return items;
  return items.map((i) => ({ ...i, score: (i.score || 0) / max }));
}

function safeParse(s) { try { return s ? JSON.parse(s) : null; } catch { return null; } }

// -----------------------------------------------------------------------------
// Scheduler
// -----------------------------------------------------------------------------
let _timers = [];

/**
 * Run `runOnce` for BOTH personas on a repeating interval. Returns a stop()
 * function. The first run fires immediately so the DB gets seeded on boot;
 * subsequent runs fire on `intervalMs` (default 6h).
 */
function start({ intervalMs = 6 * 60 * 60 * 1000 } = {}) {
  stop();
  const tick = async () => {
    for (const mode of PERSONAS) {
      try {
        const r = await runOnce(mode);
        // eslint-disable-next-line no-console
        console.log(`[researcher] ${mode}: inserted ${r.inserted.length}, errors ${r.errors.length}`);
        for (const e of r.errors) console.warn(`[researcher] ${mode}: ${e}`);
      } catch (err) {
        console.error(`[researcher] ${mode} run failed:`, err.message);
      }
    }
  };
  tick(); // fire once on start
  _timers.push(setInterval(tick, intervalMs));
  return stop;
}

function stop() {
  for (const t of _timers) clearInterval(t);
  _timers = [];
}

module.exports = { runOnce, start, stop, FEEDS, PERSONAS };

// -----------------------------------------------------------------------------
// Self-test — `node researcher.js`
// -----------------------------------------------------------------------------
if (require.main === module) {
  (async () => {
    console.log('--- Researcher self-test ---');
    console.log('DB before:', await db.getCounts());

    for (const mode of PERSONAS) {
      console.log(`\n>>> Running mode: ${mode}`);
      try {
        const res = await runOnce(mode);
        console.log(`   inserted ${res.inserted.length} rows:`);
        for (const row of res.inserted) {
          console.log(`     #${row.id} [${row.target_persona}] ${row.topic}`);
        }
        if (res.errors.length) {
          console.log(`   ${res.errors.length} non-fatal errors:`);
          for (const e of res.errors) console.log('     -', e);
        }
      } catch (err) {
        console.error(`   runOnce(${mode}) failed:`, err.message);
      }
    }

    console.log('\nDB after:', await db.getCounts());
    console.log('\nAll rows currently in the pipeline:');
    for (const row of await db.getAllVideos()) {
      console.log(`  #${row.id} [${row.status}] [${row.target_persona}] ${row.topic}`);
    }
    console.log('\n--- done ---');
  })();
}
