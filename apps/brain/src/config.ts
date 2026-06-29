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
  authDbPath: z.string().default('./data/auth.sqlite'),
  webOrigin: z.string().default('http://localhost:5173'),
  oidcIssuerUrl: z.string().optional(),
  oidcClientId: z.string().optional(),
  oidcClientSecret: z.string().optional(),
  oidcRedirectUri: z.string().default('http://localhost:16500/api/auth/callback'),
  oidcResource: z.string().default('http://localhost:16500'),
});

export type BrainConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BrainConfig {
  if (env.NODE_ENV === 'production' && !env.SESSION_SECRET) {
    throw new Error('SESSION_SECRET is required in production');
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
  });
}

/** OIDC is "configured" only when issuer + client id/secret are all present. */
export function oidcConfigured(c: BrainConfig): boolean {
  return Boolean(c.oidcIssuerUrl && c.oidcClientId && c.oidcClientSecret);
}
