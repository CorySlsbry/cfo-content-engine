/**
 * PM2 process manifest for the CFO Content Engine.
 *
 * Two long-lived processes:
 *   cfo-server       — Express + Socket.IO dashboard (server.js)
 *   cfo-orchestrator — pipeline tick loop that moves rows forward (main.js)
 *
 * Usage:
 *   pm2 start ecosystem.config.js
 *   pm2 save
 *   pm2-startup install   # survive reboots
 */

const path = require('path');

// Load .env into process.env so PM2 children inherit API keys even when
// launched by the Windows service (no shell env to pull from).
try { require('dotenv').config({ path: path.join(__dirname, '.env') }); } catch { /* dotenv optional */ }

const sharedEnv = {
  NODE_ENV:           'production',
  GEMINI_API_KEY:     process.env.GEMINI_API_KEY     || '',
  SUPABASE_URL:                  process.env.SUPABASE_URL                  || '',
  SUPABASE_SERVICE_ROLE_KEY:     process.env.SUPABASE_SERVICE_ROLE_KEY     || '',
  STORAGE_BACKEND:               process.env.STORAGE_BACKEND               || 'local',
  GCS_BUCKET:                    process.env.GCS_BUCKET                    || '',
  GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS || '',
  OPENAI_API_KEY:     process.env.OPENAI_API_KEY     || '',
  ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY || '',
  YT_API_KEY:         process.env.YT_API_KEY         || process.env.YOUTUBE_API_KEY || '',
  PORT:               process.env.PORT               || '3000',
  LIVE_PORT:          process.env.LIVE_PORT           || '3001',
  TICK_INTERVAL_MS:   process.env.TICK_INTERVAL_MS   || '15000',

  // TTS provider selection + per-persona ElevenLabs voice config.
  TTS_PROVIDER:                    process.env.TTS_PROVIDER                    || 'openai',
  ELEVENLABS_MODEL_ID:             process.env.ELEVENLABS_MODEL_ID             || '',
  ELEVENLABS_VOICE_BUILDER:        process.env.ELEVENLABS_VOICE_BUILDER        || '',
  ELEVENLABS_VOICE_SELLER:         process.env.ELEVENLABS_VOICE_SELLER         || '',
  ELEVENLABS_STABILITY_BUILDER:    process.env.ELEVENLABS_STABILITY_BUILDER    || '',
  ELEVENLABS_SIMILARITY_BUILDER:   process.env.ELEVENLABS_SIMILARITY_BUILDER   || '',
  ELEVENLABS_STYLE_BUILDER:        process.env.ELEVENLABS_STYLE_BUILDER        || '',
  ELEVENLABS_STABILITY_SELLER:     process.env.ELEVENLABS_STABILITY_SELLER     || '',
  ELEVENLABS_SIMILARITY_SELLER:    process.env.ELEVENLABS_SIMILARITY_SELLER    || '',
  ELEVENLABS_STYLE_SELLER:         process.env.ELEVENLABS_STYLE_SELLER         || '',

  // CRM bridge — where to push published videos + which secret to use.
  SALISBURY_API_URL:               process.env.SALISBURY_API_URL               || '',
  CONTENT_ENGINE_SECRET:           process.env.CONTENT_ENGINE_SECRET           || '',

  // HeyGen Avatar IV — dormant until HEYGEN_ENABLED=true + all 3 secrets set.
  HEYGEN_ENABLED:                  process.env.HEYGEN_ENABLED                  || 'false',
  HEYGEN_API_KEY:                  process.env.HEYGEN_API_KEY                  || '',
  HEYGEN_TALKING_PHOTO_ID:         process.env.HEYGEN_TALKING_PHOTO_ID         || '',
  HEYGEN_WEBHOOK_SECRET:           process.env.HEYGEN_WEBHOOK_SECRET           || '',
  HEYGEN_WIDTH:                    process.env.HEYGEN_WIDTH                    || '1080',
  HEYGEN_HEIGHT:                   process.env.HEYGEN_HEIGHT                   || '1920',
};

module.exports = {
  apps: [
    {
      name: 'cfo-server',
      script: 'server.js',
      cwd: __dirname,
      node_args: '--disable-warning=ExperimentalWarning',
      env: sharedEnv,
      max_memory_restart: '500M',
      out_file:   path.join(__dirname, 'logs', 'server.out.log'),
      error_file: path.join(__dirname, 'logs', 'server.err.log'),
      time: true,
    },
    {
      name: 'cfo-orchestrator',
      script: 'main.js',
      cwd: __dirname,
      node_args: '--disable-warning=ExperimentalWarning',
      env: sharedEnv,
      max_memory_restart: '1G', // ffmpeg can spike during render
      out_file:   path.join(__dirname, 'logs', 'orchestrator.out.log'),
      error_file: path.join(__dirname, 'logs', 'orchestrator.err.log'),
      time: true,
    },
    {
      name: 'cfo-live',
      script: 'gemini-live-server.js',
      cwd: __dirname,
      node_args: '--disable-warning=ExperimentalWarning',
      env: sharedEnv,
      max_memory_restart: '300M',
      out_file:   path.join(__dirname, 'logs', 'live.out.log'),
      error_file: path.join(__dirname, 'logs', 'live.err.log'),
      time: true,
    },
    {
      // Cloudflare quick tunnel — exposes http://localhost:PORT to a
      // public *.trycloudflare.com URL. URL changes each restart;
      // find it via `pm2 logs cfo-tunnel` (look for "trycloudflare.com").
      //
      // For a STABLE URL on your own domain, replace the args with
      // `tunnel run <your-tunnel-name>` after running `cloudflared tunnel login`
      // once and creating a named tunnel.
      name: 'cfo-tunnel',
      script: 'cloudflared',
      args: `tunnel --url http://localhost:${process.env.PORT || '3000'}`,
      interpreter: 'none',           // cloudflared is a native binary, not a Node script
      cwd: __dirname,
      max_restarts: 20,
      restart_delay: 5000,           // back off if Cloudflare is throttling
      out_file:   path.join(__dirname, 'logs', 'tunnel.out.log'),
      error_file: path.join(__dirname, 'logs', 'tunnel.err.log'),
      time: true,
    },
  ],
};
