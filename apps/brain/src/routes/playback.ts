// In-browser playback endpoints (docs/60). The browser's WASM engine plays the
// song in real time; these hand it the lowered song and the sample slices.
//
//   GET  /api/songs/:id/playback          a saved song the caller owns
//   POST /api/playback  { song }          any song (e.g. the editor's unsaved edits)
//     -> { songId, song, insts[], samples[{key, kind, url, index?, count?}], stubs[] }
//   GET  /api/playback/samples/:id.ogg    one sample slice (immutable)
//   GET  /api/playback/stubs/:name        the engine's five fallback samples

import { createHash } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { applyMixOverrides, canonicalStringifySong, MixOverridesSchema, parseSong, type MixOverrides, type Song } from '@casperaki/song-schema';

import { STUB_SAMPLES, type PlaybackService } from '../render/playbackService.js';
import type { SongsStore } from '../store.js';

export interface PlaybackRouterDeps {
  readonly store: SongsStore;
  readonly playback: PlaybackService | undefined;
  /** The caller's owner id (signed-in user, or the dev owner with auth off). */
  readonly ownerOf: (req: Request) => string;
  /** The song as the engine gets it, its stored vocal takes added (see routes/vocals.ts). */
  readonly withTakes?: (song: Song) => Song;
}

// mixOverrides: the editor's Pro-mode mix for a song not saved yet (a saved song's comes from its project).
const PlayBodySchema = z.object({ song: z.unknown(), mixOverrides: MixOverridesSchema.optional() }).strict();

/** Lower a song and list its samples: the body of every playback response. */
export async function playbackPayload(service: PlaybackService, songId: string, canonical: string, mixOverrides?: MixOverrides | null) {
  const env = await service.envelope(songId, canonical);
  const samples = service.plan(songId).map((e) => ({
    key: e.key,
    kind: e.kind,
    url: `/api/playback/samples/${e.sampleId}.ogg`,
    ...(e.index !== undefined ? { index: e.index, count: e.count } : {}),
  }));
  return {
    songId,
    song: env.song,
    insts: env.insts,
    samples,
    stubs: STUB_SAMPLES.map((n) => `/api/playback/stubs/${n}`),
    // The song's Pro-mode mix applied to the standard config (the same rule the export and renders use).
    mixConfig: mixOverrides ? applyMixOverrides(service.mixConfig, mixOverrides) : service.mixConfig,
    /** The standard mix's FX bus chains (the editor's Pro mode marks and resets changes against them). */
    standardRackChains: (JSON.parse(service.mixConfig) as { rackChains?: unknown }).rackChains ?? [],
  };
}

export function createPlaybackRouter({ store, playback, ownerOf, withTakes }: PlaybackRouterDeps): Router {
  /** The engine's input for a song: its stored vocal takes added; the playback id is that input's hash (so a take
   *  sung later gives a new id, and a new lowering). */
  const forEngine = (song: Song) => {
    const canonical = canonicalStringifySong(withTakes ? withTakes(song) : song, 2);
    return { id: createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 16), canonical };
  };
  const router = Router();

  const notConfigured = (res: Response) =>
    res.status(503).json({
      error: 'playback_not_configured',
      message: 'In-browser playback is off: CASPERAKI_SAMPLE_LIBRARY_ROOT is not set on the brain.',
    });

  const respond = async (res: Response, service: PlaybackService, songId: string, canonical: string, mixOverrides?: MixOverrides | null) => {
    res.json(await playbackPayload(service, songId, canonical, mixOverrides));
  };

  router.get('/api/songs/:id/playback', async (req, res) => {
    if (!playback) return notConfigured(res);
    const id = req.params.id;
    const project = store.getProject(ownerOf(req), id);
    if (!project) return res.status(404).json({ error: 'not_found', id });
    const stored = store.get(id);
    if (!stored) return res.status(404).json({ error: 'not_found', id });
    const engine = withTakes ? forEngine(parseSong(JSON.parse(stored.canonical))) : { id, canonical: stored.canonical };
    try {
      await respond(res, playback, engine.id, engine.canonical, project.mixOverrides);
    } catch (err) {
      res.status(500).json({ error: 'playback_failed', message: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/api/playback', async (req, res) => {
    if (!playback) return notConfigured(res);
    const body = PlayBodySchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'invalid_body' });
    let canonical: string;
    let id: string;
    try {
      ({ id, canonical } = forEngine(parseSong(body.data.song)));
    } catch (err) {
      return res.status(400).json({ error: 'invalid_song', message: err instanceof Error ? err.message : String(err) });
    }
    try {
      await respond(res, playback, id, canonical, body.data.mixOverrides);
    } catch (err) {
      res.status(500).json({ error: 'playback_failed', message: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/api/playback/samples/:file', async (req, res) => {
    if (!playback) return notConfigured(res);
    const m = /^([0-9a-f]{24})\.ogg$/u.exec(req.params.file);
    if (!m || !playback.knowsSample(m[1]!)) return res.status(404).json({ error: 'not_found' });
    try {
      const path = await playback.sampleFile(m[1]!);
      res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
      res.type('audio/ogg').sendFile(path);
    } catch (err) {
      res.status(500).json({ error: 'sample_failed', message: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/api/playback/stubs/:name', (req, res) => {
    if (!playback) return notConfigured(res);
    if (!(STUB_SAMPLES as readonly string[]).includes(req.params.name)) return res.status(404).json({ error: 'not_found' });
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.type('audio/ogg').sendFile(playback.stubFile(req.params.name));
  });

  return router;
}
