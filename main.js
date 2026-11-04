/**
 * main.js — The Orchestrator. The brain of the CFO Content Engine.
 *
 * Every TICK_INTERVAL_MS we look at the pipeline end-to-beginning and
 * move exactly one piece of work forward, prioritizing rows closest to
 * 'Published' so things don't pile up at the tail.
 *
 *     Rendered         -> publish           -> Published   (mock for now)
 *     Audio_Generated  -> Render Agent      -> Rendered
 *     Scripted         -> Audio Agent (TTS) -> Audio_Generated
 *     Idea             -> Creative Agent    -> Scripted
 *     (database empty) -> Researcher Agent  -> Idea rows
 *
 * Rationale for end-to-beginning: if we processed beginning-to-end,
 * every tick would grow the Idea backlog while Rendered rows starved.
 * Tail-first keeps the pipeline draining.
 *
 * Stylized terminal output so operators can watch the flow without the
 * dashboard open. All output uses ANSI escapes — no chalk dependency.
 *
 * Failure isolation: one broken agent never kills the loop. The row
 * stays at its current status (credit-safe state machine), the error is
 * logged, the next tick re-evaluates.
 */

const db = require('./db');
const researcher = require('./researcher');
const competitor = require('./competitor');
const viral = require('./viral');
const creative = require('./creative');
const imagen = require('./imagen');
const render = require('./render');
const packager = require('./packager');

// -----------------------------------------------------------------------------
// Config
// -----------------------------------------------------------------------------
const TICK_INTERVAL_MS = Number(process.env.TICK_INTERVAL_MS) || 15_000;
const SHOW_IDLE = (process.env.ORCHESTRATOR_SHOW_IDLE ?? '1') !== '0';
// How many times a single row is allowed to fail its current stage before
// the orchestrator kicks it to 'Rejected' so it stops blocking the pipeline.
const MAX_FAILS = Number(process.env.MAX_ROW_FAILS) || 3;

// -----------------------------------------------------------------------------
// Styling (ANSI — no deps)
// -----------------------------------------------------------------------------
const C = {
  reset:   '\x1b[0m',
  dim:     '\x1b[2m',
  bold:    '\x1b[1m',
  red:     '\x1b[31m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  blue:    '\x1b[34m',
  magenta: '\x1b[35m',
  cyan:    '\x1b[36m',
  white:   '\x1b[37m',
  gray:    '\x1b[90m',
  bgBlue:  '\x1b[44m',
};

// Per-stage color + glyph vocabulary. Consistent across the whole log so
// the eye learns to skim.
const STAGE = {
  PUBLISH:  { color: C.green,   glyph: '✔',  label: 'PUBLISH ' },
  APPROVE:  { color: C.green,   glyph: '✓',  label: 'APPROVE ' },
  PACKAGE:  { color: C.cyan,    glyph: '◈',  label: 'PACKAGE ' },
  RENDER:   { color: C.blue,    glyph: '▶',  label: 'RENDER  ' },
  IMAGE:    { color: C.magenta, glyph: '◐',  label: 'IMAGE   ' },
  AUDIO:    { color: C.magenta, glyph: '♪',  label: 'AUDIO   ' },
  CREATIVE: { color: C.yellow,  glyph: '✎',  label: 'CREATIVE' },
  RESEARCH: { color: C.cyan,    glyph: '⚡', label: 'RESEARCH' },
  SCOUT:    { color: C.blue,    glyph: '◎',  label: 'SCOUT   ' },
  IDLE:     { color: C.gray,    glyph: '·',  label: 'IDLE    ' },
  ERROR:    { color: C.red,     glyph: '✗',  label: 'ERROR   ' },
  SYSTEM:   { color: C.white,   glyph: 'ℹ',  label: 'SYSTEM  ' },
};

function ts() {
  // HH:MM:SS local time. Good enough for a live terminal; the dashboard
  // has the ISO timestamps.
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function line(stageKey, msg) {
  const s = STAGE[stageKey] || STAGE.SYSTEM;
  process.stdout.write(
    `${C.dim}[${ts()}]${C.reset} ` +
    `${s.color}${s.glyph} ${C.bold}${s.label}${C.reset} ` +
    `${msg}\n`
  );
}

function banner() {
  const title = ' CFO CONTENT ENGINE · ORCHESTRATOR ';
  const bar = '─'.repeat(title.length);
  const nl = '\n';
  process.stdout.write(
    C.cyan + C.bold +
    '┌' + bar + '┐' + nl +
    '│' + title + '│' + nl +
    '└' + bar + '┘' + C.reset + nl
  );
  line('SYSTEM', `tick interval: ${C.bold}${TICK_INTERVAL_MS}ms${C.reset}  ${C.dim}(auto-reject after ${MAX_FAILS} fails)${C.reset}`);
  line('SYSTEM', `database:      ${C.dim}${db._dbPath}${C.reset}`);
  line('SYSTEM', `bg video:      ${C.dim}${render.BG_VIDEO_PATH}${C.reset}`);
  line('SYSTEM', `keys present:  ` +
    `GEMINI=${process.env.GEMINI_API_KEY ? C.green + 'yes' : C.red + 'no'}${C.reset}  ` +
    `OPENAI=${process.env.OPENAI_API_KEY ? C.green + 'yes' : C.red + 'no'}${C.reset}  ` +
    `ELEVEN=${process.env.ELEVENLABS_API_KEY ? C.green + 'yes' : C.dim + 'no'}${C.reset}`);
}

function pipelineBar(counts) {
  const segs = [
    { k: 'Idea',             color: C.yellow,  short: 'Idea' },
    { k: 'Scripted',         color: C.magenta, short: 'Scripted' },
    { k: 'Audio_Generated',  color: C.blue,    short: 'Audio' },
    { k: 'Images_Generated', color: C.magenta, short: 'Images' },
    { k: 'Rendered',         color: C.green,   short: 'Rendered' },
    { k: 'Pending_Approval', color: C.cyan,    short: 'Pending' },
    { k: 'Published',        color: C.green,   short: 'Published' },
  ];
  return segs.map((s) =>
    `${s.color}${s.short}:${C.bold}${counts[s.k] ?? 0}${C.reset}`
  ).join(`${C.dim} → ${C.reset}`);
}

// -----------------------------------------------------------------------------
// Stage handlers — each returns true if it did work, false if its queue was empty.
//
// Per-row failure isolation: we used to rely on the tick loop's blanket
// try/catch, but that leaves a broken row at its current status forever and
// — because priority is end-to-beginning — a single poisoned Scripted/Audio/
// Rendered row blocks every Idea behind it. withRetryGuard bumps a fail_count
// on the row, and once it hits MAX_FAILS we move the row to 'Rejected' so the
// pipeline keeps draining.
// -----------------------------------------------------------------------------

const { isTransientHttpError } = require('./retry');

/**
 * Exponential cooldown schedule for transient failures. We back off further
 * each time so repeated Gemini "high demand" responses don't hammer the
 * service during an outage — but the row is never auto-rejected for
 * transient reasons, so topics are never lost.
 */
const TRANSIENT_COOLDOWN_SEC = [60, 120, 240, 480, 900, 1800]; // 1m -> 30m cap
function cooldownFor(transientCount) {
  const idx = Math.max(0, Math.min(transientCount - 1, TRANSIENT_COOLDOWN_SEC.length - 1));
  return TRANSIENT_COOLDOWN_SEC[idx];
}

/**
 * Wrap a per-row stage's work in a try/catch with TWO failure paths:
 *
 *   Transient errors (5xx, 429, timeouts, network, JSON-parse mid-stream,
 *   "high demand" bodies) -> markTransientFailure. Row stays at its current
 *   status, cooldown_until is set, orchestrator skips it until cooldown
 *   passes. NEVER counts toward MAX_FAILS auto-reject. Topics are preserved
 *   through outages of any length.
 *
 *   Permanent errors (validation, schema mismatch, auth, missing required
 *   fields) -> markFailed. Counts toward MAX_FAILS=3 -> auto-reject, same
 *   as before. These will never succeed on retry so reject is correct.
 *
 * Returns { advanced, wasError, transient }: advanced=true when the stage
 * produced a new status, so the chain can continue.
 */
async function withRetryGuard(row, stageKey, work) {
  try {
    await work();
    return { advanced: true, wasError: false, transient: false };
  } catch (err) {
    const tag = `#${row.id} [${row.target_persona}]`;

    if (isTransientHttpError(err)) {
      const count = await db.markTransientFailure(
        row.id,
        err.message,
        cooldownFor(((row.transient_fail_count || 0) + 1)),
      );
      const cooldown = cooldownFor(count);
      line(
        'WAIT',
        `${tag} ${stageKey} transient — ${err.message.slice(0, 90)} — ` +
        `cooldown ${cooldown}s (attempt ${count}, no reject)`
      );
      return { advanced: false, wasError: true, transient: true };
    }

    const count = await db.markFailed(row.id, err.message);
    if (count >= MAX_FAILS) {
      line('ERROR', `${tag} ${stageKey} permanent-failed ${count}× — rejecting: ${err.message}`);
      try { await db.updateStatus(row.id, 'Rejected'); }
      catch (rejErr) { line('ERROR', `${tag} reject transition also failed: ${rejErr.message}`); }
    } else {
      line('ERROR', `${tag} ${stageKey} permanent fail ${count}/${MAX_FAILS}: ${err.message}`);
    }
    return { advanced: false, wasError: true, transient: false };
  }
}

async function autoApproveOne() {
  const row = await db.fetchOldestByStatus('Pending_Approval');
  if (!row) return false;
  return withRetryGuard(row, 'APPROVE', async () => {
    line('APPROVE', `#${row.id} [${row.target_persona}] auto-approved (Full Auto is ON)`);
    const platforms = safeArray(row.platforms);
    console.log(`${C.dim}           ↳ platforms: ${platforms.join(', ') || '(none)'}${C.reset}`);
    await db.approveVideo(row.id);
    await mockPublish(row);
  });
}

async function packageOne() {
  const row = await db.fetchOldestByStatus('Rendered');
  if (!row) return false;
  return withRetryGuard(row, 'PACKAGE', async () => {
    line('PACKAGE', `#${row.id} [${row.target_persona}] writing per-platform captions…`);
    const t0 = Date.now();
    await packager.packageOne();
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    const after = await db.getVideoById(row.id);
    const platforms = safeArray(after?.platforms);
    console.log(`${C.dim}           ↳ ${dt}s · ${platforms.join(', ')} · now Pending_Approval${C.reset}`);
  });
}

async function mockPublish(row) {
  const posts = safeObject(row.platform_posts);
  const published_at = new Date().toISOString();
  console.log(`${C.dim}           ↳ mock publish · video=${row.video_path} · at=${published_at}${C.reset}`);
  for (const [plat, post] of Object.entries(posts)) {
    const caption = String(post?.caption || '').slice(0, 70);
    const tagCount = Array.isArray(post?.hashtags) ? post.hashtags.length : 0;
    console.log(`${C.dim}           ↳ ${plat.padEnd(16)} "${caption}…" · ${tagCount} tags${C.reset}`);
  }
}

async function renderOne() {
  const row = await db.fetchOldestByStatus('Images_Generated');
  if (!row) return false;
  return withRetryGuard(row, 'RENDER', async () => {
    line('RENDER', `#${row.id} [${row.target_persona}] compositing Ken-Burns reel…`);
    const t0 = Date.now();
    await render.processOneImaged();
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    const after = await db.getVideoById(row.id);
    console.log(`${C.dim}           ↳ ${dt}s · ${after?.video_path || '(no path)'}${C.reset}`);
  });
}

async function imageOne() {
  const row = await db.fetchOldestByStatus('Audio_Generated');
  if (!row) return false;
  return withRetryGuard(row, 'IMAGE', async () => {
    line('IMAGE', `#${row.id} [${row.target_persona}] generating b-roll stills…`);
    const t0 = Date.now();
    await imagen.processOneAudio();
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    const count = imagen.imagesForRow(row.id).length;
    console.log(`${C.dim}           ↳ ${dt}s · ${count} images on disk${C.reset}`);
  });
}

async function audioOne() {
  const row = await db.fetchOldestByStatus('Scripted');
  if (!row) return false;
  return withRetryGuard(row, 'AUDIO', async () => {
    line('AUDIO', `#${row.id} [${row.target_persona}] TTS synthesizing…`);
    const t0 = Date.now();
    await render.processOneScripted();
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    const after = await db.getVideoById(row.id);
    console.log(`${C.dim}           ↳ ${dt}s · ${after?.audio_path || '(no path)'}${C.reset}`);
  });
}

async function creativeOne() {
  const row = await db.fetchOldestByStatus('Idea');
  if (!row) return false;
  return withRetryGuard(row, 'CREATIVE', async () => {
    line('CREATIVE', `#${row.id} [${row.target_persona}] "${truncate(row.topic, 64)}"`);
    const t0 = Date.now();
    const script = await creative.generateScript({
      topic: row.topic,
      target_persona: row.target_persona,
    });
    await db.updateStatus(row.id, 'Scripted', { script_json: script });
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`${C.dim}           ↳ ${dt}s · hook: "${truncate(script.hook, 72)}"${C.reset}`);
  });
}

/**
 * Publisher tick — flip any Scheduled rows whose scheduled_publish_at has
 * arrived to Published. Multi-row on purpose: if the orchestrator was down
 * for a few minutes and three slots passed, all three should publish on the
 * next tick rather than lagging one-per-tick.
 */
async function publisherTick() {
  try {
    const due = await db.getDueScheduled({ limit: 10 });
    for (const row of due) {
      const updated = await db.publishScheduled(row.id);
      if (updated) {
        line('PUBLISH', `#${row.id} [${row.target_persona}] "${truncate(row.topic, 56)}" — slot ${row.scheduled_publish_at}`);
      }
    }
  } catch (err) {
    line('ERROR', `publisher: ${err.message}`);
  }
}

async function researchAll() {
  // First: refresh competitive signals (what's working for others) so
  // the researcher's next pick is informed.
  line('SCOUT', `collecting competitive signals (Reddit${process.env.YT_API_KEY || process.env.YOUTUBE_API_KEY ? ' + YouTube' : ''})…`);
  for (const mode of ['BUILDER', 'SELLER']) {
    try {
      const t0 = Date.now();
      const s = await competitor.runOnce(mode);
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`${C.dim}           ↳ ${mode.padEnd(7)} ${dt}s · saved ${s.saved} signals (reddit ${s.reddit_count}, yt ${s.youtube_count})${C.reset}`);
    } catch (err) {
      line('ERROR', `competitor ${mode}: ${err.message}`);
    }
  }

  line('RESEARCH', `pulling fresh ideas blended from RSS + signals`);
  for (const mode of ['BUILDER', 'SELLER']) {
    const t0 = Date.now();
    const r = await researcher.runOnce(mode);
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    const gated = r.gated ? ` · ${C.yellow}gated:${r.gated}${C.reset}` : '';
    console.log(
      `${C.dim}           ↳ ${mode.padEnd(7)} ${dt}s · ` +
      `inserted ${r.inserted.length}${r.errors.length ? `, ${r.errors.length} errors` : ''}${gated}${C.dim}${C.reset}`
    );
  }
  return true;
}

function truncate(s, n) {
  const str = String(s ?? '');
  return str.length <= n ? str : str.slice(0, n - 1) + '…';
}

function safeArray(v) { try { const x = typeof v === 'string' ? JSON.parse(v) : v; return Array.isArray(x) ? x : []; } catch { return []; } }
function safeObject(v) { try { const x = typeof v === 'string' ? JSON.parse(v) : v; return x && typeof x === 'object' ? x : {}; } catch { return {}; } }

// -----------------------------------------------------------------------------
// Tick loop
// -----------------------------------------------------------------------------
let tickNumber = 0;
let inFlight   = false;

async function tick() {
  // Re-entry guard: slow work (ffmpeg render can take 30s+) must not overlap
  // with the next scheduled tick, or we'd fire duplicate work on the same row.
  if (inFlight) return;
  inFlight = true;

  tickNumber += 1;
  const counts = await db.getCounts();
  // Rejected rows exist in the DB but don't count toward "pipeline empty" —
  // they're dead, not pending.
  const liveTotal =
    counts.Idea + counts.Scripted + counts.Audio_Generated + counts.Images_Generated +
    counts.Rendered + counts.Pending_Approval + counts.Published;
  const approvalRequired = await db.isApprovalRequired();

  console.log(
    `${C.dim}[${ts()}]${C.reset} ${C.bold}${C.cyan}─► tick #${tickNumber}${C.reset}  ` +
    pipelineBar(counts) +
    `  ${C.dim}mode=${C.reset}${approvalRequired ? C.yellow + 'approval' : C.green + 'AUTO'}${C.reset}`
  );

  try {
    // Priority 0: publisher — any Scheduled rows whose time has come get
    // flipped to Published NOW. Runs every tick (15s cadence) so we hit slot
    // times within a minute even without dedicated cron. Cheap query: a
    // partial index on status='Scheduled' + time bound is index-only.
    await publisherTick();

    // Priority 1: auto-approve runs OUTSIDE the chain — it acts on whatever
    // row has been waiting longest, and should happen before any new work.
    if (!approvalRequired && counts.Pending_Approval > 0) {
      await autoApproveOne();
    }

    // Priority 2: pick ONE row and chain it through every stage it can
    // legally reach in this tick. A fresh Idea row can walk all the way
    // to Pending_Approval in a single tick when Gemini is cooperating —
    // no more "wait 15s per stage" dead time.
    //
    // End-first means we finish rows already in-flight before starting
    // new ones; that prevents the Pending_Approval column from starving
    // when there's a backlog of Ideas.
    const chained = await runChainedStage(counts);

    if (!chained) {
      // Nothing advanceable. Researcher fires on a genuinely empty pipeline.
      if (liveTotal === 0) {
        await researchAll();
      } else if (SHOW_IDLE) {
        const pend = counts.Pending_Approval > 0
          ? `${counts.Pending_Approval} waiting for approval`
          : 'nothing ready (check cooldowns in dashboard)';
        line('IDLE', pend);
      }
    }
  } catch (err) {
    line('ERROR', `${err.message}`);
    if (process.env.DEBUG) console.error(err.stack);
  } finally {
    inFlight = false;
  }
}

/**
 * Pick the furthest-along ready row and push it through as many stages as
 * it can take this tick. Stops on: successful advance to a human-gate
 * status (Pending_Approval), transient error (cooldown set), permanent
 * error (fail_count bumped, maybe rejected), or exhaustion (no more work).
 *
 * Returns true if any work was attempted (so the caller knows not to fire
 * the researcher for an empty-pipeline tick).
 */
const CHAIN_RUNNERS = [
  { status: 'Rendered',         label: 'PACKAGE',  fn: packageOne  },
  { status: 'Images_Generated', label: 'RENDER',   fn: renderOne   },
  { status: 'Audio_Generated',  label: 'IMAGE',    fn: imageOne    },
  { status: 'Scripted',         label: 'AUDIO',    fn: audioOne    },
  { status: 'Idea',             label: 'CREATIVE', fn: creativeOne },
];

async function runChainedStage(initialCounts) {
  // Pick the FIRST stage (end-first) that has work ready.
  let startingIdx = -1;
  for (let i = 0; i < CHAIN_RUNNERS.length; i += 1) {
    if (initialCounts[CHAIN_RUNNERS[i].status] > 0) { startingIdx = i; break; }
  }
  if (startingIdx === -1) return false;

  // Each *One fetches the oldest ready row internally. We let it advance,
  // then loop: if the pipeline now has work ready at the NEXT stage (which
  // by design is exactly the status that row just moved into), run that
  // too. We cap at CHAIN_RUNNERS.length to keep a single tick bounded.
  let didSomething = false;
  for (let step = 0; step < CHAIN_RUNNERS.length; step += 1) {
    const countsNow = await db.getCounts();
    let ranThisStep = false;
    // End-first again — the row we just advanced is now at a later stage,
    // so the end-first scan naturally picks it up on the next iteration.
    for (const { status, fn } of CHAIN_RUNNERS) {
      if (countsNow[status] > 0) {
        const before = await db.fetchOldestByStatus(status);
        if (!before) continue;
        await fn();
        const after = await db.getVideoById(before.id);
        ranThisStep = true;
        didSomething = true;
        // If status is unchanged, the stage failed (transient or permanent)
        // and we shouldn't keep chaining this same row this tick.
        if (!after || after.status === before.status) {
          return didSomething;
        }
        break;
      }
    }
    if (!ranThisStep) break; // no readable work anywhere in the pipeline
  }
  return didSomething;
}

// -----------------------------------------------------------------------------
// Boot
// -----------------------------------------------------------------------------
let interval = null;
let stopViral = null;

// Weekly viral teardown runs on its own cadence, independent of the 15s
// pipeline tick. Longer interval = smaller YouTube API bill + playbook that
// actually reflects "this week." Env-overridable for dev / backfill.
const VIRAL_INTERVAL_MS = Number(process.env.VIRAL_INTERVAL_MS) || 7 * 24 * 60 * 60 * 1000;

function start() {
  banner();
  line('SYSTEM', `${C.green}orchestrator started${C.reset}`);

  // Fire immediately so the operator sees activity on boot.
  tick();
  interval = setInterval(tick, TICK_INTERVAL_MS);

  // Viral teardown — background, weekly. First run fires immediately so a
  // fresh boot doesn't generate a week of scripts without playbook guidance.
  // Runs on free Reddit signals by default; YouTube Data API and Apify
  // plug in as additional sources inside viral.collectSamples when enabled.
  line('SYSTEM', `viral teardown scheduled every ${Math.round(VIRAL_INTERVAL_MS / 3_600_000)}h`);
  stopViral = viral.start({ intervalMs: VIRAL_INTERVAL_MS, immediate: true });
}

function stop() {
  if (interval) { clearInterval(interval); interval = null; }
  if (stopViral) { stopViral(); stopViral = null; }
  line('SYSTEM', `${C.yellow}orchestrator stopped${C.reset}`);
}

function shutdown(code = 0) {
  stop();
  process.exit(code);
}

process.on('SIGINT',  () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('uncaughtException',  (err) => { line('ERROR', `uncaughtException: ${err.message}`); });
process.on('unhandledRejection', (err) => { line('ERROR', `unhandledRejection: ${err?.message || err}`); });

module.exports = { start, tick, stop, shutdown };

if (require.main === module) start();
