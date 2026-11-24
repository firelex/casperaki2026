// apps/brain — typed config parsed from process.env.
//
// Single source of truth for environment-driven settings. `loadConfig`
// returns a fully-typed, validated object; callers never read
// process.env directly. Defaults are spelled out below; required values
// (none today) would throw via Zod.

import { z } from 'zod';

const ConfigSchema = z.object({
  port: z.coerce.number().int().positive().default(16500),
  host: z.string().default('127.0.0.1'),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  // SQLite catalog path; defaults to a per-app data dir under the cwd
  // until @teamsuzie/db-sqlite wiring lands.
  catalogPath: z.string().default('./data/catalog.sqlite'),
  // Slice songs store. `':memory:'` is a valid value (used by tests).
  songsDbPath: z.string().default('./data/songs.sqlite'),
  // Local dev render artifact path. The native engine-spike harness drops
  // a multi-segment Drums+Bass+Keys+Pad WAV here (see docs/53z / docs/54c).
  // The /api/renders/latest endpoint surfaces metadata + bytes from this
  // single file. Browser-triggered native rendering is intentionally NOT
  // wired through the brain yet — this is a dev/local bridge only.
  renderArtifactPath: z.string().default('../engine-spike/out/brain-roundtrip/out.wav'),
  // --- Auth (OIDC client) ---
  sessionSecret: z.string().default(''),
  /** Fake sign-in with one fixed demo account (src/auth/demoAuth.ts) instead of OIDC. */
  demoLogin: z.enum(['0', '1']).default('0').transform((v) => v === '1'),
  authDbPath: z.string().default('./data/auth.sqlite'),
  webOrigin: z.string().default('http://localhost:5173'),
  oidcIssuerUrl: z.string().optional(),
  oidcClientId: z.string().optional(),
  oidcClientSecret: z.string().optional(),
  oidcRedirectUri: z.string().default('http://localhost:16500/api/auth/callback'),
  oidcResource: z.string().default('http://localhost:16500'),
  // Where /login sends the user when no (valid, same-origin) return_to is
  // given. Falls back to `${webOrigin}/` in the route when unset.
  postLoginDefault: z.string().optional(),
  // --- Per-song server-side rendering (see src/render/renderService.ts) ---
  // Rendering is enabled only when the sample library root is set; every
  // other path has a repo-relative default (cwd = apps/brain).
  rendersDir: z.string().default('./data/renders'),
  renderEmitScript: z.string().default('../engine-spike/scripts/emit-brain-roundtrip.mjs'),
  renderBin: z.string().default('../web/wasm/engine/build/casperaki_render'),
  renderStubSamplesDir: z.string().default('../engine-spike/samples'),
  sampleLibraryRoot: z.string().optional(),
  renderMix: z.enum(['0', '1']).default('1').transform((v) => v === '1'),
  ffmpegBin: z.string().default('ffmpeg'),
  /** The engine's mastering CLI (casperaki_master, the JUCE-free port of the legacy
   *  mastering; docs/67 #1) that masters exports. */
  masteringBin: z.string().default('../web/wasm/engine/build/casperaki_master'),
  // --- In-browser playback (docs/60) ---
  playbackDir: z.string().default('./data/playback'),
  sampleCacheDir: z.string().default('./data/sample-cache'),
  /** Edits of the melody library's entries (Melodies page), a JSON file outside the repo; required in production. */
  melodyEditsPath: z.string().default('./data/melody-edits.json'),
  /** casperaki_engine/config/mix-config.json; required for in-browser playback. */
  mixConfigPath: z.string().optional(),
  // --- Music videos (src/video/) ---
  /** DeepSeek API key for the video scene planner; videos fail loudly without it. */
  /** The music-video scene planner: an OpenAI-compatible endpoint (the B200 DeepSeek via its tunnel) and model. */
  /** Python of the Beat This! environment (hum lab beat tracking). */
  beatThisPython: z.string().min(1).optional(),
  /** Where the hum lab keeps recordings sent with a meant tempo (test data for apps/models/hum-beats). */
  humLabDir: z.string().min(1).optional(),
  /** Hum to song: the transcription service ("hum": POST /transcribe) and the melody completion service ("amt":
   *  POST /complete), as base URLs. Unset → /api/hum answers 503 naming the setting. */
  humServiceUrl: z.string().url().optional(),
  amtServiceUrl: z.string().url().optional(),
  /** Sung vocals: the SoulX singing service (svc-soulx, POST /voices and /sing) and the directory the section takes
   *  are kept in. Either unset → /api/vocals answers 503 naming the setting. */
  singingServiceUrl: z.string().url().optional(),
  vocalTakesDir: z.string().min(1).optional(),
  /** Song artwork: the image service (svc-artwork, small-sd on the serving harness) and the directory the pictures
   *  are kept in. Both or neither (without them songs get no artwork). */
  artworkServiceUrl: z.string().url().optional(),
  artworkDir: z.string().min(1).optional(),
  videoPlannerUrl: z.string().url().optional(),
  videoPlannerModel: z.string().min(1).optional(),
  videoPlannerKey: z.string().min(1).optional(),
  /** The song assistant's model: an OpenAI-compatible endpoint with tool calling (both or neither). */
  assistantLlmUrl: z.string().url().optional(),
  assistantLlmModel: z.string().min(1).optional(),
  assistantLlmKey: z.string().min(1).optional(),
  /** Frames the video renderer draws in parallel (default: the engine's, 8). */
  videoRenderConcurrency: z.coerce.number().int().positive().optional(),
  // --- Production web serving ---
  // When set, the brain serves the built web app (apps/web/dist) at / with
  // an SPA fallback, so one origin carries both the UI and /api.
  webDistDir: z.string().optional(),
  // --- Admins ---
  // Comma-separated sign-in emails that may browse the sound catalog (it
  // shows the source library / preset names). Unset = nobody.
  adminEmails: z
    .string()
    .default('')
    .transform((v) => v.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean)),
});

export type BrainConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BrainConfig {
  if (env.NODE_ENV === 'production' && !env.SESSION_SECRET) {
    throw new Error('SESSION_SECRET is required in production');
  }
  if (env.NODE_ENV === 'production' && !env.BRAIN_MELODY_EDITS_PATH) {
    throw new Error('BRAIN_MELODY_EDITS_PATH is required in production (edits of the melody library)');
  }
  if (env.NODE_ENV === 'production' && !env.CASPERAKI_SAMPLE_LIBRARY_ROOT) {
    throw new Error('CASPERAKI_SAMPLE_LIBRARY_ROOT is required in production (per-song rendering)');
  }
  return ConfigSchema.parse({
    port: env.BRAIN_PORT,
    host: env.BRAIN_HOST,
    logLevel: env.BRAIN_LOG_LEVEL,
    catalogPath: env.BRAIN_CATALOG_PATH,
    songsDbPath: env.BRAIN_SONGS_DB_PATH,
    renderArtifactPath: env.BRAIN_RENDER_ARTIFACT_PATH,
    sessionSecret: env.SESSION_SECRET,
    authDbPath: env.BRAIN_AUTH_DB_PATH,
    webOrigin: env.WEB_ORIGIN,
    oidcIssuerUrl: env.OIDC_ISSUER_URL,
    oidcClientId: env.OIDC_CLIENT_ID,
    oidcClientSecret: env.OIDC_CLIENT_SECRET,
    oidcRedirectUri: env.OIDC_REDIRECT_URI,
    oidcResource: env.OIDC_RESOURCE,
    postLoginDefault: env.OIDC_POST_LOGIN_DEFAULT,
    rendersDir: env.BRAIN_RENDERS_DIR,
    renderEmitScript: env.BRAIN_RENDER_EMIT_SCRIPT,
    renderBin: env.BRAIN_RENDER_BIN,
    renderStubSamplesDir: env.BRAIN_RENDER_STUB_SAMPLES_DIR,
    sampleLibraryRoot: env.CASPERAKI_SAMPLE_LIBRARY_ROOT,
    renderMix: env.BRAIN_RENDER_MIX,
    ffmpegBin: env.FFMPEG_BIN,
    masteringBin: env.BRAIN_MASTERING_BIN,
    playbackDir: env.BRAIN_PLAYBACK_DIR,
    sampleCacheDir: env.BRAIN_SAMPLE_CACHE_DIR,
    melodyEditsPath: env.BRAIN_MELODY_EDITS_PATH,
    mixConfigPath: env.CASPERAKI_MIX_CONFIG,
    webDistDir: env.BRAIN_WEB_DIST_DIR,
    beatThisPython: env.BEAT_THIS_PYTHON || undefined,
    humLabDir: env.BRAIN_HUM_LAB_DIR || undefined,
    humServiceUrl: env.HUM_SERVICE_URL || undefined,
    amtServiceUrl: env.AMT_SERVICE_URL || undefined,
    singingServiceUrl: env.SOULX_SERVICE_URL || undefined,
    vocalTakesDir: env.BRAIN_VOCAL_TAKES_DIR || undefined,
    artworkServiceUrl: env.ARTWORK_SERVICE_URL || undefined,
    artworkDir: env.BRAIN_ARTWORK_DIR || undefined,
    videoPlannerUrl: env.VIDEO_PLANNER_URL || undefined,
    videoPlannerModel: env.VIDEO_PLANNER_MODEL || undefined,
    videoPlannerKey: env.VIDEO_PLANNER_KEY || undefined,
    assistantLlmUrl: env.ASSISTANT_LLM_URL || undefined,
    assistantLlmModel: env.ASSISTANT_LLM_MODEL || undefined,
    assistantLlmKey: env.ASSISTANT_LLM_KEY || undefined,
    videoRenderConcurrency: env.VIDEO_RENDER_CONCURRENCY || undefined,
    adminEmails: env.BRAIN_ADMIN_EMAILS,
    demoLogin: env.BRAIN_DEMO_LOGIN || undefined,
  });
}

/** OIDC is "configured" only when issuer + client id/secret are all present. */
export function oidcConfigured(c: BrainConfig): boolean {
  return Boolean(c.oidcIssuerUrl && c.oidcClientId && c.oidcClientSecret);
}
