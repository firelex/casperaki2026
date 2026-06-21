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
});

export type BrainConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BrainConfig {
  return ConfigSchema.parse({
    port: env.BRAIN_PORT,
    host: env.BRAIN_HOST,
    logLevel: env.BRAIN_LOG_LEVEL,
    catalogPath: env.BRAIN_CATALOG_PATH,
    songsDbPath: env.BRAIN_SONGS_DB_PATH,
    renderArtifactPath: env.BRAIN_RENDER_ARTIFACT_PATH,
  });
}
