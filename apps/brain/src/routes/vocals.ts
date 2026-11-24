// Sung vocals (docs/superpowers/specs/2026-11-24-sung-vocals-design.md):
//
//   GET  /api/vocals/voices                  -> {voices}            the singing service's voices
//   POST /api/vocals/status {song}           -> {sections: [{segment, state: none|sung|unsung}]}
//   POST /api/vocals/sing   {song, segment}  -> {section}           sings one section (nothing to do if its take is stored)
//
// The song is sent whole (the editor's working copy). Takes are found by fingerprint when a song is loaded
// (createVocalsHooks().withTakes); nothing is recorded on the song.
// Not configured (SOULX_SERVICE_URL or BRAIN_VOCAL_TAKES_DIR unset) -> 503 naming what is missing.

import { Router, type Response } from 'express';
import { z } from 'zod';

import { parseSong, SongSchema, type Song } from '@casperaki/song-schema';

import type { BrainConfig } from '../config.js';
import type { SongsStore } from '../store.js';
import { deleteUnusedTakes, songTakeFingerprints, VocalTakes, VocalsError, withStoredTakes } from '../vocals/takes.js';

export interface VocalsRouterDeps {
  /** Undefined when not configured; `missing` names the environment variables to set. */
  readonly takes: VocalTakes | undefined;
  readonly missing: readonly string[];
}

const StatusBody = z.object({ song: z.unknown() }).strict();
const SingBody = z.object({ song: z.unknown(), segment: z.string().min(1).max(100) }).strict();

export function createVocalsRouter(deps: VocalsRouterDeps): Router {
  const router = Router();

  const takes = (res: Response): VocalTakes | undefined => {
    if (!deps.takes) {
      res.status(503).json({ error: 'vocals_not_configured', message: `Sung vocals are not set up: set ${deps.missing.join(' and ')} in brain.env.` });
    }
    return deps.takes;
  };
  const fail = (res: Response, err: unknown) => {
    if (err instanceof VocalsError) return void res.status(err.status).json({ error: err.code, message: err.message });
    const message = err instanceof Error ? err.message : String(err);
    // A song the score builder cannot read (a note without phonemes, ...) is the request's fault.
    if (message.startsWith('sectionScore:')) return void res.status(422).json({ error: 'invalid_song', message });
    console.error('[vocals]', err);
    res.status(500).json({ error: 'internal', message });
  };
  const parseSong = (res: Response, raw: unknown) => {
    const r = SongSchema.safeParse(raw);
    if (!r.success) res.status(400).json({ error: 'invalid_song', message: r.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    return r.success ? r.data : undefined;
  };

  router.get('/api/vocals/voices', async (_req, res) => {
    const t = takes(res);
    if (!t) return;
    try {
      res.json({ voices: await t.voices() });
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/api/vocals/status', (req, res) => {
    const t = takes(res);
    if (!t) return;
    const body = StatusBody.safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: 'invalid_body', message: 'Send {song}.' });
    const song = parseSong(res, body.data.song);
    if (!song) return;
    try {
      res.json({ sections: t.status(song) });
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/api/vocals/sing', async (req, res) => {
    const t = takes(res);
    if (!t) return;
    const body = SingBody.safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: 'invalid_body', message: 'Send {song, segment}.' });
    const song = parseSong(res, body.data.song);
    if (!song) return;
    try {
      res.json({ section: await t.sing(song, body.data.segment) });
    } catch (err) {
      fail(res, err);
    }
  });

  return router;
}

/** The router as configured: both SOULX_SERVICE_URL and BRAIN_VOCAL_TAKES_DIR, or 503 naming the missing ones. */
export function createVocalsRouterFor(config: Pick<BrainConfig, 'singingServiceUrl' | 'vocalTakesDir' | 'ffmpegBin'>, fetchImpl?: typeof fetch): Router {
  const missing = [...(config.singingServiceUrl ? [] : ['SOULX_SERVICE_URL']), ...(config.vocalTakesDir ? [] : ['BRAIN_VOCAL_TAKES_DIR'])];
  const takes =
    missing.length === 0
      ? new VocalTakes({ takesDir: config.vocalTakesDir!, serviceUrl: config.singingServiceUrl!, ffmpegBin: config.ffmpegBin, ...(fetchImpl ? { fetchImpl } : {}) })
      : undefined;
  return createVocalsRouter({ takes, missing });
}

/**
 * What the rest of the brain needs from sung vocals:
 *   - withTakes(song): the song as the engine gets it, its sections' stored takes added (play, export, render);
 *   - onSongReplaced(songId): a saved song was saved again or deleted: the takes its old version used that no saved
 *     song uses any more are deleted (no grace period: the owner wants the space back).
 * Without BRAIN_VOCAL_TAKES_DIR there are no takes: songs are lowered as they are and nothing is cleaned.
 */
export interface VocalsHooks {
  readonly withTakes: (song: Song) => Song;
  /** The fingerprints of the takes on a song from withTakes (for the render cache key). */
  readonly takesOf: (song: Song) => string;
  readonly onSongReplaced: (oldSongId: string) => void;
}

const takesOf = (song: Song) =>
  song.aiArtifacts.filter((a) => a.kind === 'soulx-vocal').map((a) => a.conditioning?.hashes?.[0] ?? '').join(',');

export function createVocalsHooks(config: Pick<BrainConfig, 'vocalTakesDir'>, store: SongsStore): VocalsHooks {
  const dir = config.vocalTakesDir;
  if (!dir) return { withTakes: (song) => song, takesOf, onSongReplaced: () => undefined };
  const fingerprintsOf = (canonical: string): Set<string> =>
    canonical.includes('"vocals"') ? songTakeFingerprints(parseSong(JSON.parse(canonical))) : new Set();
  return {
    withTakes: (song) => withStoredTakes(song, dir),
    takesOf,
    onSongReplaced: (oldSongId) => {
      const old = store.get(oldSongId);
      if (!old) return;
      const candidates = fingerprintsOf(old.canonical);
      if (candidates.size === 0) return;
      const used = new Set<string>();
      for (const id of store.listProjectSongIds()) {
        const s = store.get(id);
        if (s) for (const fp of fingerprintsOf(s.canonical)) used.add(fp);
      }
      const deleted = deleteUnusedTakes(dir, candidates, used);
      if (deleted.length) console.log(`[vocals] deleted ${deleted.length} take(s) no saved song uses any more (song ${oldSongId} replaced)`);
    },
  };
}
