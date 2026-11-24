// Sung vocals (docs/superpowers/specs/2026-11-24-sung-vocals-design.md):
//
//   GET  /api/vocals/voices                  -> {voices}            the singing service's voices
//   POST /api/vocals/status {song}           -> {sections: [{segment, state: none|current|stale|missing}]}
//   POST /api/vocals/sing   {song, segment}  -> {artifact}          sings one section (or reuses its stored take)
//
// The song is sent whole (the editor's working copy); the caller records the returned artifact on its song.
// Not configured (SOULX_SERVICE_URL or BRAIN_VOCAL_TAKES_DIR unset) -> 503 naming what is missing.

import { Router, type Response } from 'express';
import { z } from 'zod';

import { SongSchema, type Song } from '@casperaki/song-schema';

import type { BrainConfig } from '../config.js';
import { sectionStates, VocalTakes, VocalsError } from '../vocals/takes.js';

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
      res.json({ artifact: await t.sing(song, body.data.segment) });
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

/** Why a song cannot be played (or rendered) yet: its vocals are on but a section's take is missing or stale, or
 *  sung vocals are not set up. Undefined when it can (vocals off, or every take current). */
export interface VocalsProblem {
  readonly status: number;
  readonly body: { readonly error: string; readonly message: string; readonly sections?: readonly string[] };
}
export type VocalsCheck = (song: Song, saved: boolean) => VocalsProblem | undefined;

export function createVocalsCheck(config: Pick<BrainConfig, 'vocalTakesDir'>): VocalsCheck {
  return (song, saved) => {
    if (!song.vocals?.enabled) return undefined;
    if (!config.vocalTakesDir) {
      return { status: 503, body: { error: 'vocals_not_configured', message: 'The song has Vocals on, but sung vocals are not set up: set BRAIN_VOCAL_TAKES_DIR in brain.env.' } };
    }
    const sections = sectionStates(song, config.vocalTakesDir).filter((s) => s.state !== 'none' && s.state !== 'current').map((s) => s.segment);
    if (sections.length === 0) return undefined;
    const what = `The vocals of ${sections.join(', ')} have not been sung for the song as it is now.`;
    return {
      status: 409,
      body: { error: 'vocals_need_singing', sections, message: saved ? `${what} Open the song and play it to sing its vocals.` : `${what} Sing them first.` },
    };
  };
}
