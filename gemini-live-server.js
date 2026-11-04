/**
 * gemini-live-server.js — Secure WebSocket bridge to the Gemini Live API.
 *
 * Architecture:
 *
 *   [Browser Mic]                                        [Gemini Live API]
 *        │  PCM 16kHz base64                                     │
 *        ▼                                                       ▼
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │              THIS SERVER  (ws://localhost:3001)              │
 *   │                                                              │
 *   │  Frontend WS ◄──────── relay ────────► Gemini WS            │
 *   │  /ws/live              (both ways)     wss://google API     │
 *   └──────────────────────────────────────────────────────────────┘
 *        │                                                       │
 *        ▼  PCM 24kHz base64                                     ▼
 *   [Browser Speaker]                                    [Gemini response]
 *
 * The API key NEVER reaches the browser — it stays server-side in .env.
 *
 * Protocol (frontend ↔ this server):
 *   → { type: "config", ...overrides }     Optional: voice, model, etc.
 *   → { type: "audio",  data: "<b64>" }    Mic audio chunk (PCM 16-bit 16kHz mono)
 *   → { type: "text",   text: "..." }      Optional: typed text instead of voice
 *   → { type: "end" }                      Signal end-of-turn
 *   ← { type: "audio",  data: "<b64>" }    Gemini audio chunk (PCM 16-bit 24kHz mono)
 *   ← { type: "text",   text: "..." }      Gemini text (if responseModalities includes TEXT)
 *   ← { type: "turn_complete" }            Gemini finished speaking
 *   ← { type: "setup_complete" }           Session is ready for audio
 *   ← { type: "error",  message: "..." }   Something went wrong
 *
 * Run:
 *   node gemini-live-server.js
 *   # or via PM2:
 *   pm2 start ecosystem.config.js
 */

const path    = require('path');
const http    = require('http');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');

// ---------------------------------------------------------------------------
// Load environment
// ---------------------------------------------------------------------------
try { require('dotenv').config({ path: path.join(__dirname, '.env') }); } catch { /* optional */ }

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const LIVE_PORT     = Number(process.env.LIVE_PORT) || 3001;

// Gemini Live (Multimodal Live) WebSocket endpoint.
// Model must support BidiGenerateContent — gemini-2.0-flash-live-001 is the
// current production model for real-time audio.
const DEFAULT_MODEL = 'gemini-2.0-flash-live-001';
const GEMINI_WS_URL = (model, key) =>
  `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(key)}`;

// ---------------------------------------------------------------------------
// Express — serves the test frontend and health check
// ---------------------------------------------------------------------------
const app = express();
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    gemini_key_set: !!GEMINI_API_KEY,
    model: DEFAULT_MODEL,
    uptime: process.uptime(),
  });
});

const server = http.createServer(app);

// ---------------------------------------------------------------------------
// WebSocket server — accepts frontend connections on /ws/live
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ server, path: '/ws/live' });

/**
 * For each frontend connection we:
 *   1. Wait for an optional "config" message (or use defaults).
 *   2. Open a WebSocket to Gemini's BidiGenerateContent endpoint.
 *   3. Send the setup message (model, voice, modalities).
 *   4. Wait for Gemini's { setupComplete } acknowledgment.
 *   5. Relay audio/text frames in both directions until either side closes.
 */
wss.on('connection', (frontendWs, req) => {
  console.log(`[live] frontend connected from ${req.socket.remoteAddress}`);

  // ---- Per-session state ----
  let geminiWs    = null;   // WebSocket to Gemini
  let setupDone   = false;  // true after Gemini acknowledges setup
  let pendingAudio = [];    // audio frames that arrive before setup completes

  // Configurable per session; defaults below.
  let sessionConfig = {
    model: DEFAULT_MODEL,
    voice: 'Aoede',                      // Aoede, Charon, Fenrir, Kore, Puck
    responseModalities: ['AUDIO'],       // or ['AUDIO','TEXT'] for both
    systemInstruction: null,             // optional system prompt
  };

  // ------------------------------------------------------------------
  // Helper: send a typed JSON message to the frontend
  // ------------------------------------------------------------------
  function sendToFrontend(obj) {
    if (frontendWs.readyState === WebSocket.OPEN) {
      frontendWs.send(JSON.stringify(obj));
    }
  }

  // ------------------------------------------------------------------
  // Step 1 — Build Gemini setup payload from session config
  // ------------------------------------------------------------------
  function buildSetupMessage() {
    const setup = {
      model: `models/${sessionConfig.model}`,
      generationConfig: {
        responseModalities: sessionConfig.responseModalities,
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: sessionConfig.voice,
            },
          },
        },
      },
    };
    // Optional system instruction (e.g. "You are a helpful CFO assistant")
    if (sessionConfig.systemInstruction) {
      setup.systemInstruction = {
        parts: [{ text: sessionConfig.systemInstruction }],
      };
    }
    return { setup };
  }

  // ------------------------------------------------------------------
  // Step 2 — Open WebSocket to Gemini and wire up event handlers
  // ------------------------------------------------------------------
  function connectToGemini() {
    if (!GEMINI_API_KEY) {
      sendToFrontend({ type: 'error', message: 'GEMINI_API_KEY is not set on the server.' });
      frontendWs.close(4001, 'Missing API key');
      return;
    }

    const url = GEMINI_WS_URL(sessionConfig.model, GEMINI_API_KEY);
    geminiWs = new WebSocket(url);

    // ---- Gemini connection opened: send the setup message ----
    geminiWs.on('open', () => {
      console.log(`[live] connected to Gemini (${sessionConfig.model})`);
      const setupMsg = buildSetupMessage();
      geminiWs.send(JSON.stringify(setupMsg));
    });

    // ---- Gemini sends us data ----
    geminiWs.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); }
      catch (err) {
        console.error('[live] failed to parse Gemini message:', err.message);
        return;
      }

      // --- Setup acknowledgment ---
      if (msg.setupComplete !== undefined) {
        console.log('[live] Gemini setup complete — session is live');
        setupDone = true;
        sendToFrontend({ type: 'setup_complete' });

        // Flush any audio that arrived while we were setting up.
        for (const queued of pendingAudio) {
          geminiWs.send(JSON.stringify(queued));
        }
        pendingAudio = [];
        return;
      }

      // --- Server content (audio and/or text from Gemini) ---
      if (msg.serverContent) {
        const sc = msg.serverContent;

        // Turn complete signal — Gemini finished its response.
        if (sc.turnComplete) {
          sendToFrontend({ type: 'turn_complete' });
          return;
        }

        // Model turn — may contain audio parts and/or text parts.
        if (sc.modelTurn && sc.modelTurn.parts) {
          for (const part of sc.modelTurn.parts) {
            // Audio part — base64-encoded PCM 24kHz
            if (part.inlineData) {
              sendToFrontend({
                type: 'audio',
                mimeType: part.inlineData.mimeType,
                data: part.inlineData.data,
              });
            }
            // Text part — transcript or text-mode response
            if (part.text) {
              sendToFrontend({ type: 'text', text: part.text });
            }
          }
        }
        return;
      }

      // --- Tool calls, grounding, or other extensions ---
      // Forward anything else as-is so the frontend can handle it if needed.
      if (msg.toolCall || msg.toolCallCancellation) {
        sendToFrontend({ type: 'tool', payload: msg });
        return;
      }
    });

    // ---- Gemini errors ----
    geminiWs.on('error', (err) => {
      console.error('[live] Gemini WS error:', err.message);
      sendToFrontend({ type: 'error', message: `Gemini connection error: ${err.message}` });
    });

    // ---- Gemini closes ----
    geminiWs.on('close', (code, reason) => {
      console.log(`[live] Gemini WS closed: ${code} ${reason}`);
      setupDone = false;
      // Tell the frontend the session ended; they can reconnect to start over.
      sendToFrontend({ type: 'error', message: `Gemini session ended (${code})` });
      if (frontendWs.readyState === WebSocket.OPEN) {
        frontendWs.close(1000, 'Gemini session ended');
      }
    });
  }

  // ------------------------------------------------------------------
  // Step 3 — Handle messages from the frontend
  // ------------------------------------------------------------------
  frontendWs.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch {
      sendToFrontend({ type: 'error', message: 'Invalid JSON from client' });
      return;
    }

    switch (msg.type) {
      // ---- Optional per-session config (must arrive before first audio) ----
      case 'config': {
        if (geminiWs) {
          sendToFrontend({ type: 'error', message: 'Config must be sent before audio; reconnect to reconfigure.' });
          return;
        }
        if (msg.voice) sessionConfig.voice = msg.voice;
        if (msg.model) sessionConfig.model = msg.model;
        if (msg.systemInstruction) sessionConfig.systemInstruction = msg.systemInstruction;
        if (Array.isArray(msg.responseModalities)) sessionConfig.responseModalities = msg.responseModalities;
        console.log('[live] session config:', sessionConfig);
        // Don't connect yet — wait for the first audio frame or explicit "start".
        break;
      }

      // ---- Start the Gemini session explicitly (optional; auto-starts on first audio) ----
      case 'start': {
        if (!geminiWs) connectToGemini();
        break;
      }

      // ---- Audio chunk from the microphone ----
      case 'audio': {
        // Auto-connect on first audio if not already connected.
        if (!geminiWs) connectToGemini();

        // Build the Gemini realtime input frame.
        const frame = {
          realtimeInput: {
            mediaChunks: [{
              mimeType: msg.mimeType || 'audio/pcm;rate=16000',
              data: msg.data,  // base64-encoded PCM
            }],
          },
        };

        if (setupDone && geminiWs.readyState === WebSocket.OPEN) {
          geminiWs.send(JSON.stringify(frame));
        } else {
          // Queue until setup completes — prevents dropped audio on slow connects.
          pendingAudio.push(frame);
        }
        break;
      }

      // ---- Typed text input (alternative to voice) ----
      case 'text': {
        if (!geminiWs) connectToGemini();

        const frame = {
          clientContent: {
            turns: [{
              role: 'user',
              parts: [{ text: msg.text }],
            }],
            turnComplete: true,
          },
        };

        if (setupDone && geminiWs.readyState === WebSocket.OPEN) {
          geminiWs.send(JSON.stringify(frame));
        } else {
          pendingAudio.push(frame);
        }
        break;
      }

      // ---- End of user turn signal ----
      case 'end': {
        if (setupDone && geminiWs && geminiWs.readyState === WebSocket.OPEN) {
          geminiWs.send(JSON.stringify({
            clientContent: { turnComplete: true },
          }));
        }
        break;
      }

      default:
        sendToFrontend({ type: 'error', message: `Unknown message type: ${msg.type}` });
    }
  });

  // ------------------------------------------------------------------
  // Step 4 — Cleanup when the frontend disconnects
  // ------------------------------------------------------------------
  frontendWs.on('close', () => {
    console.log('[live] frontend disconnected');
    if (geminiWs && geminiWs.readyState === WebSocket.OPEN) {
      geminiWs.close(1000, 'Frontend disconnected');
    }
    geminiWs = null;
    pendingAudio = [];
  });

  frontendWs.on('error', (err) => {
    console.error('[live] frontend WS error:', err.message);
  });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
server.listen(LIVE_PORT, () => {
  console.log(`Gemini Live bridge listening on http://localhost:${LIVE_PORT}`);
  console.log(`  WebSocket endpoint:  ws://localhost:${LIVE_PORT}/ws/live`);
  console.log(`  Test UI:             http://localhost:${LIVE_PORT}/live.html`);
  console.log(`  Health check:        http://localhost:${LIVE_PORT}/health`);
  console.log(`  Gemini key set:      ${GEMINI_API_KEY ? 'yes' : 'NO — set GEMINI_API_KEY in .env'}`);
});
