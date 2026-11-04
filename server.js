/**
 * server.js — Express + Socket.IO dashboard for the CFO Content Engine.
 *
 * Serves the real-time UI (public/index.html) and exposes a small REST/WS
 * surface over the db.js module so the operator can watch the pipeline move
 * rows from Idea -> Published, seed ideas manually, and trigger status
 * transitions while building out the automated workers.
 */

const path = require('path');
const http = require('http');
const express = require('express');
const { Server: IOServer } = require('socket.io');

const db = require('./db');
const researcher = require('./researcher');
const viral      = require('./viral');
const creative   = require('./creative');
const render     = require('./render');
const imagen     = require('./imagen');
const packager   = require('./packager');
const crm        = require('./crm');
const storage    = require('./storage');
const heygen     = require('./heygen');

const PORT = Number(process.env.PORT) || 3000;
// How often the Researcher Agent polls RSS for fresh ideas.
// Override with RESEARCHER_INTERVAL_MS (e.g. 900000 for 15 min during dev).
const RESEARCHER_INTERVAL_MS =
  Number(process.env.RESEARCHER_INTERVAL_MS) || 6 * 60 * 60 * 1000;

const app = express();
// Capture raw body on webhook paths so HMAC signature checks see the exact
// bytes HeyGen signed. `express.json` still parses + populates req.body for
// the handler. This adds ~30 bytes of memory per webhook request — fine.
app.use(express.json({
  limit: '2mb',
  verify: (req, _res, buf) => {
    if (req.originalUrl && req.originalUrl.startsWith('/api/webhooks/')) {
      req.rawBody = buf.toString('utf8');
    }
  },
}));
app.use(express.static(path.join(__dirname, 'public')));
// Expose rendered artifacts for dashboard previews + delivery emails.
// Keys: /media/video/<id>.mp4, /media/audio/<id>.mp3, /media/images/<id>/NN.png
//
// Three-stage resolution:
//   1. gcs mode + service-account key available -> 302 to signed URL (fastest)
//   2. gcs mode + user-ADC (local dev)          -> download + pipe bytes
//   3. local mode                                -> static file serve
const localStatic = express.static(path.join(__dirname, 'output'));
app.use('/media', async (req, res) => {
  const key = req.url.replace(/^\/+/, '').split('?')[0];
  if (!key) return res.status(404).end();

  if (storage.backend === 'gcs') {
    // Try signed URL first. On Cloud Run this succeeds immediately; on local
    // dev with a user ADC it fails with "Cannot sign data without client_email",
    // so we fall back to downloading the bytes and piping them back.
    try {
      const url = await storage.urlFor(key, { expiresSec: 3600 });
      return res.redirect(302, url);
    } catch (signErr) {
      try {
        const local = await storage.ensureLocal(key);
        return res.sendFile(local);
      } catch (dlErr) {
        return res.status(404).json({
          error: 'media not found',
          sign_error: signErr.message,
          download_error: dlErr.message,
        });
      }
    }
  }
  return localStatic(req, res, () => res.status(404).end());
});

// --- REST surface (also usable from curl / future workers) ---

app.get('/api/videos', async (req, res) => {
  try {
    res.json({ videos: await db.getAllVideos(), counts: await db.getCounts() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/videos', async (req, res) => {
  try {
    const row = await db.insertIdea({
      target_persona: req.body?.target_persona,
      topic: req.body?.topic,
    });
    res.status(201).json(row);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/videos/:id/status', async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const row = await db.updateStatus(id, req.body?.status, {
      script_json: req.body?.script_json,
      audio_path:  req.body?.audio_path,
      video_path:  req.body?.video_path,
    });
    res.json(row);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/next/:status', async (req, res) => {
  try {
    const row = await db.fetchOldestByStatus(req.params.status);
    if (!row) return res.status(204).end();
    res.json(row);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Approval / rejection ---
app.post('/api/videos/:id/approve', async (req, res) => {
  try {
    res.json(await db.approveVideo(Number.parseInt(req.params.id, 10), {
      reason: req.body?.reason,
      note:   req.body?.note,
    }));
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.post('/api/videos/:id/reject', async (req, res) => {
  try {
    res.json(await db.rejectVideo(Number.parseInt(req.params.id, 10), {
      reason: req.body?.reason,
      note:   req.body?.note,
    }));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Expose both taxonomies so the dashboard stays in sync with what the DB
// accepts without hardcoding the lists in two places.
app.get('/api/rejection-reasons', (req, res) => {
  res.json({ reasons: db.REJECTION_REASONS });
});
app.get('/api/approval-reasons', (req, res) => {
  res.json({ reasons: db.APPROVAL_REASONS });
});

// --- Manual stage advance ---
// Runs the actual stage work (script gen, TTS, image gen, render, package)
// for ONE specific row right now, regardless of the orchestrator's queue.
// This lets an operator push a stuck or deprioritized row forward from the
// dashboard without waiting for the next tick. Content-producing statuses
// (Idea, Scripted, Audio_Generated, Images_Generated, Rendered) dispatch to
// the matching stage module. Pending_Approval has its own approve/reject
// endpoints and is NOT advanced by this route. Terminal statuses error.
//
// In-flight locks prevent a double-click from running the stage twice
// concurrently against the same row (TTS + image gen can take 10-60s).
const _advanceLocks = new Set();

const STAGE_RUNNERS = {
  Idea:             (row) => creative.processIdeaRow(row),
  Scripted:         (row) => render.processScriptedRow(row),
  Audio_Generated:  (row) => imagen.processAudioRow(row),
  Images_Generated: (row) => render.processImagedRow(row),
  Rendered:         (row) => packager.packageRow(row),
};

app.post('/api/videos/:id/advance', async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'invalid id' });
  }
  if (_advanceLocks.has(id)) {
    return res.status(409).json({ error: 'stage is already running for this row' });
  }

  let row;
  try { row = await db.getVideoById(id); }
  catch (err) { return res.status(400).json({ error: err.message }); }
  if (!row) return res.status(404).json({ error: `row #${id} not found` });

  const runner = STAGE_RUNNERS[row.status];
  if (!runner) {
    return res.status(400).json({
      error: `row #${id} is in status "${row.status}" which has no manual advance ` +
             `(Pending_Approval uses /approve, Published/Rejected are terminal)`,
    });
  }

  _advanceLocks.add(id);
  try {
    const updated = await runner(row);
    res.json({ from: row.status, to: updated?.status, row: updated });
  } catch (err) {
    // Transient errors (503 "high demand", 429 rate limit, timeouts, network
    // blips) don't count toward auto-reject — we set a cooldown and let the
    // orchestrator retry on schedule. The dashboard shows this as a toast,
    // not a blocking alert, so the operator knows it's handled.
    const { isTransientHttpError } = require('./retry');
    if (isTransientHttpError(err)) {
      // Set the cooldown so subsequent tick/click skips this row.
      const prev = (row.transient_fail_count || 0) + 1;
      const cooldownSec = Math.min(60 * Math.pow(2, prev - 1), 1800);
      try { await db.markTransientFailure(id, err.message, cooldownSec); }
      catch (_) { /* soft-fail logging; don't mask the primary error */ }
      return res.status(202).json({
        transient: true,
        from: row.status,
        cooldown_seconds: cooldownSec,
        cooldown_until: new Date(Date.now() + cooldownSec * 1000).toISOString(),
        error: err.message,
        message: `Upstream briefly overloaded. Row #${id} will auto-retry in ~${Math.round(cooldownSec / 60 * 10) / 10}m.`,
      });
    }
    res.status(500).json({ from: row.status, error: err.message });
  } finally {
    _advanceLocks.delete(id);
  }
});

// --- CRM: landing URL (operator pastes this as the first/pinned comment) ---
app.get('/api/videos/:id/landing', async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const row = await db.getVideoById(id);
    if (!row) return res.status(404).json({ error: `row #${id} not found` });
    const url = crm.landingUrlForRow(row);
    if (!url) return res.status(404).json({ error: 'row has no landing_slug yet' });
    res.json({ landing_url: url });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Recovery: pull a row back into the pipeline from Rejected or any stage ---
// Useful when the outer MAX_FAILS guard auto-rejected a row for a transient
// reason (e.g. a Gemini 503 spike) but the artifacts on disk are still good.
// The body specifies the target status; if not provided we infer it from which
// artifacts exist:
//   video_path present  -> Rendered
//   images_dir present  -> Images_Generated
//   audio_path present  -> Audio_Generated
//   script_json present -> Scripted
//   otherwise           -> Idea
// Also resets fail_count so the MAX_FAILS guard gives the row a fresh budget.
app.post('/api/videos/:id/requeue', async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const row = await db.getVideoById(id);
    if (!row) return res.status(404).json({ error: `row #${id} not found` });

    let target = String(req.body?.status || '').trim();
    if (!target) {
      const fs = require('node:fs');
      const path = require('node:path');
      const imagesDir = path.join(__dirname, 'output', 'images', String(id));
      if (row.video_path && fs.existsSync(row.video_path))        target = 'Rendered';
      else if (fs.existsSync(imagesDir) && fs.readdirSync(imagesDir).length >= 3)
                                                                  target = 'Images_Generated';
      else if (row.audio_path && fs.existsSync(row.audio_path))   target = 'Audio_Generated';
      else if (row.script_json)                                    target = 'Scripted';
      else                                                         target = 'Idea';
    }

    // requeueRow also resets fail_count + last_error so the MAX_FAILS guard
    // gives the row a fresh budget. updateStatus preserves those on purpose
    // for the normal happy-path transitions.
    const updated = await db.requeueRow(id, target);
    res.json({ from: row.status, to: updated.status, row: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- CRM: manual re-push to Salisbury (if the automatic Publish hook missed) ---
app.post('/api/videos/:id/crm-push', async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const row = await db.getVideoById(id);
    if (!row) return res.status(404).json({ error: `row #${id} not found` });
    const r = await crm.pushPublishedRow(row);
    if (!r.ok) return res.status(502).json({ error: r.error });
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// HeyGen Avatar IV webhook — dormant until HEYGEN_ENABLED=true.
//
// Meta flow: when the engine submits a video to HeyGen, it stores the
// returned HeyGen video_id in engine_videos.metadata.heygen_video_id plus
// the internal row id as the callback_id. When HeyGen finishes rendering
// it POSTs avatar_video.success / avatar_video.fail here; we correlate via
// callback_id, stream the mp4 into our GCS bucket at video/{id}.mp4, and
// flip the row to Rendered.
//
// Signature verification lives in heygen.parseWebhook(). In dev (no
// HEYGEN_WEBHOOK_SECRET) signatures are skipped — do NOT run like that in
// production.
// ---------------------------------------------------------------------------
app.post('/api/webhooks/heygen', async (req, res) => {
  const rawBody = req.rawBody || JSON.stringify(req.body || {});
  const parsed = heygen.parseWebhook({ rawBody, headers: req.headers });
  if (!parsed.ok) {
    console.warn('[heygen-webhook] rejected:', parsed.error);
    return res.status(401).json({ ok: false, error: parsed.error });
  }
  const { event, data } = parsed;
  const rowId = Number.parseInt(data?.callback_id, 10);
  console.log(`[heygen-webhook] ${event}  video_id=${data?.video_id}  callback_id=${data?.callback_id}`);

  // Dormant mode: acknowledge the event but don't advance any row. The
  // caller (HeyGen) just needs a 200. When we enable the render path we
  // flip this branch to do the actual work.
  if (!heygen.enabled) {
    return res.status(200).json({ ok: true, note: 'heygen disabled — event acknowledged, no-op' });
  }

  try {
    if (event === 'avatar_video.success' && Number.isInteger(rowId) && data?.url) {
      const render = require('./render');
      // Delegate the "download + put in GCS + advance row to Rendered" work
      // to the render module where the ffmpeg path also lives. The function
      // below is a sibling of processImagedRow for the HeyGen path.
      await render.finalizeHeygenRow(rowId, { videoId: data.video_id, downloadUrl: data.url });
    } else if (event === 'avatar_video.fail' && Number.isInteger(rowId)) {
      await db.markTransientFailure(rowId, `HeyGen render failed: ${data?.msg || 'no reason'}`, 300);
    }
  } catch (err) {
    console.error('[heygen-webhook] handler error:', err.message);
    // Still 200 — HeyGen will retry on 5xx but the event is valid; we'll
    // reconcile via status polling.
  }
  res.status(200).json({ ok: true });
});

// --- Delete (+ learn) ---
app.delete('/api/videos/:id', async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const reason = req.body?.reason || null;
    const result = await db.deleteVideo(id, reason);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/dismissed', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 200, 1000);
    res.json({ dismissed: await db.getDismissedTopics(limit) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Viral Playbook — current "what's winning this week" per persona ---
// GET returns the latest saved playbook for each persona (or null). POST
// triggers an on-demand refresh — useful for the dashboard's "Refresh" button
// so the operator can re-run teardown without waiting for the weekly tick.
app.get('/api/viral-playbook', async (req, res) => {
  try {
    const personas = ['BUILDER', 'SELLER'];
    const results = await Promise.all(personas.map((p) => db.getLatestPlaybook(p, { maxAgeDays: 30 })));
    const out = {};
    personas.forEach((p, i) => { out[p] = results[i]; });
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Posting schedule — 3-slot-a-day queue of approved videos ---
// GET returns { scheduled: [...], upcoming_slots: [...], settings: {...} }.
// `scheduled` is rows already booked; `upcoming_slots` is the next ~9 slots
// (booked + open) so the dashboard can render a queue view.
app.get('/api/schedule', async (req, res) => {
  try {
    const scheduler = require('./scheduler');
    const [scheduled, slotTimes, tz, enabled] = await Promise.all([
      db.getUpcomingScheduled({ limit: 50 }),
      db.getPostingSlotTimes(),
      db.getPostingTimezone(),
      db.isSchedulingEnabled(),
    ]);
    const slots = scheduler.parseSlotTimes(slotTimes);
    const takenMap = new Map();
    for (const r of scheduled) {
      if (r.scheduled_publish_at) {
        takenMap.set(new Date(r.scheduled_publish_at).toISOString(), r);
      }
    }
    const upcoming = scheduler.upcomingSlots(new Date(), slots, tz, takenMap, 9);
    res.json({
      scheduled,
      upcoming_slots: upcoming,
      settings: {
        enabled,
        slot_times: JSON.parse(slotTimes),
        timezone: tz,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/viral-playbook/refresh', async (req, res) => {
  try {
    const persona = req.body?.persona;
    if (persona && !['BUILDER', 'SELLER'].includes(persona)) {
      return res.status(400).json({ error: 'persona must be BUILDER or SELLER' });
    }
    // Respond immediately so the dashboard doesn't hang on the 15-20s
    // Reddit fetch + Claude call; the client re-fetches GET after a short
    // delay to pick up the new row.
    const personas = persona ? [persona] : ['BUILDER', 'SELLER'];
    res.json({ started: personas });
    for (const p of personas) {
      viral.runOnce(p).catch((err) => console.error(`[server] viral refresh ${p} failed:`, err.message));
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Settings (Full Auto toggle, Production gate, in-flight cap) ---

// Build the settings payload shape once so every response uses it.
async function settingsSnapshot() {
  return {
    ...(await db.getAllSettings()),
    approval_required:   await db.isApprovalRequired(),
    generation_enabled:  await db.isGenerationEnabled(),
    max_in_flight:       await db.getMaxInFlight(),
    in_flight:           await db.countInFlight(),
  };
}

app.get('/api/settings', async (req, res) => {
  res.json(await settingsSnapshot());
});

app.patch('/api/settings', async (req, res) => {
  try {
    const body = req.body || {};
    if (Object.prototype.hasOwnProperty.call(body, 'approval_required')) {
      await db.setApprovalRequired(!!body.approval_required);
    }
    if (Object.prototype.hasOwnProperty.call(body, 'generation_enabled')) {
      await db.setGenerationEnabled(!!body.generation_enabled);
    }
    if (Object.prototype.hasOwnProperty.call(body, 'max_in_flight')) {
      await db.setMaxInFlight(Number(body.max_in_flight));
    }
    for (const [k, v] of Object.entries(body)) {
      if (['approval_required', 'generation_enabled', 'max_in_flight'].includes(k)) continue;
      await db.setSetting(k, v);
    }
    res.json(await settingsSnapshot());
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Generate one post (test button) ---
// Bypasses the generation_enabled gate AND the in-flight cap. Runs the
// researcher's blended RSS+signals pick for the chosen persona and inserts
// exactly one Idea row so the operator can watch it flow through.
app.post('/api/generate-one', async (req, res) => {
  try {
    const persona = (req.body?.target_persona || req.query?.persona || 'BUILDER').toString().toUpperCase();
    if (!db.PERSONAS.includes(persona)) {
      return res.status(400).json({ error: `target_persona must be one of ${db.PERSONAS.join(', ')}` });
    }
    const r = await researcher.runOnce(persona, { force: true, limit: 1 });
    if (r.inserted.length === 0) {
      return res.status(502).json({
        error: 'researcher found no fresh topic',
        details: r.errors.length ? r.errors : 'all candidates already seen or dismissed',
      });
    }
    res.status(201).json({ inserted: r.inserted[0], errors: r.errors });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Socket.IO: push every db change to connected dashboards ---

const server = http.createServer(app);
const io = new IOServer(server, { cors: { origin: '*' } });

const activity = []; // rolling in-memory log for newly-connected clients
const ACTIVITY_CAP = 200;

function pushActivity(entry) {
  activity.unshift(entry);
  if (activity.length > ACTIVITY_CAP) activity.length = ACTIVITY_CAP;
}

db.events.on('change', async (evt) => {
  const entry = {
    kind: evt.kind,          // 'insert' | 'update'
    row: evt.row,
    at: new Date().toISOString(),
  };
  pushActivity(entry);
  io.emit('change', entry);
  io.emit('counts', await db.getCounts());
  // in_flight is derived from counts — push settings too so the
  // "Production (N/max)" counter on the dashboard stays in sync.
  io.emit('settings', await settingsSnapshot());

  // CRM bridge: when a row transitions to Published, fire-and-forget
  // push to salisburybookkeeping.com so its /go/[slug] landing page
  // comes online immediately. Failure is logged but non-blocking.
  if (evt.kind === 'update' && evt.row?.status === 'Published') {
    crm.pushPublishedRow(evt.row)
      .then((r) => {
        if (r.ok) {
          console.log(`[crm] pushed #${evt.row.id} -> ${r.landing_url}`);
          io.emit('activity', {
            kind: 'crm_pushed',
            row: evt.row,
            landing_url: r.landing_url,
            at: new Date().toISOString(),
          });
        } else {
          console.warn(`[crm] push failed for #${evt.row.id}: ${r.error}`);
        }
      })
      .catch((err) => console.error(`[crm] push threw for #${evt.row.id}:`, err.message));
  }
});

db.events.on('settings', async () => {
  io.emit('settings', await settingsSnapshot());
});

io.on('connection', async (socket) => {
  socket.emit('snapshot', {
    videos: await db.getAllVideos(),
    counts: await db.getCounts(),
    activity,
    settings: await settingsSnapshot(),
  });
});

// --- Health probe (Cloud Run uses this to confirm the container is alive) ---
app.get('/healthz', (req, res) => {
  res.json({
    ok: true,
    backend: db._backend,
    storage: storage.backend,
    uptime_s: Math.floor(process.uptime()),
  });
});

server.listen(PORT, async () => {
  /* eslint-disable no-console */
  console.log(`CFO Content Engine dashboard listening on http://localhost:${PORT}`);
  console.log(`Supabase: ${db._dbPath}`);
  console.log(`Storage:  ${storage.backend}${storage.backend === 'gcs' ? ` (gs://${storage.bucket})` : ''}`);

  // Seed default settings once (only writes if absent).
  try { await db.ensureDefaults(); }
  catch (err) { console.error('ensureDefaults failed:', err.message); }

  // Start the Researcher Agent in-process so its inserts fire Socket.IO
  // events and cards flash into the dashboard live.
  researcher.start({ intervalMs: RESEARCHER_INTERVAL_MS });
  console.log(
    `Researcher Agent scheduled every ${Math.round(RESEARCHER_INTERVAL_MS / 60000)} min` +
    ` (first run firing now)`
  );

  // Orchestrator tick — pulls rows through the pipeline every TICK_INTERVAL_MS.
  // Running in-process means socket.io is still connected to the live DB
  // events; running as a separate PM2 process was a local-dev artifact, not
  // an architectural requirement. Single-process is what Cloud Run wants.
  const orchestrator = require('./main');
  orchestrator.start();
  console.log('Orchestrator started (in-process).');
});

// Clean scheduler shutdown on Ctrl-C / SIGTERM.
function shutdown() {
  try { require('./main').stop?.(); } catch { /* noop */ }
  researcher.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);
