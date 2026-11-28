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

import { wordlessMelodyAsPiano } from '@casperaki/arrangement';

import { masteringReferenceData } from '../render/playbackService.js';
import { STUB_SAMPLES, type PlaybackService } from '../render/playbackService.js';
import { songVersionKey } from '../render/songVersion.js';
import type { SongsStore } from '../store.js';

export interface PlaybackRouterDeps {
  readonly store: SongsStore;
  readonly playback: PlaybackService | undefined;
  /** The caller's owner id (signed-in user, or the dev owner with auth off). */
  readonly ownerOf: (req: Request) => string;
}

// mixOverrides: the editor's Pro-mode mix for a song not saved yet (a saved song's comes from its project).
const PlayBodySchema = z.object({ song: z.unknown(), mixOverrides: MixOverridesSchema.optional() }).strict();

/** Lower a song and list its samples: the body of every playback response. `played`: what the engine plays when it
 *  is not the song itself (a melody without lyrics on the piano); the version key is always the song's. */
export async function playbackPayload(service: PlaybackService, songId: string, canonical: string, mixOverrides?: MixOverrides | null, played: string = canonical) {
  const env = await service.envelope(songId, played);
  const mixConfig = mixOverrides ? applyMixOverrides(service.mixConfig, mixOverrides) : service.mixConfig;
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
    mixConfig,
    /** The version these levels and sounds belong to (render/songVersion.ts). */
    versionKey: songVersionKey(canonical, mixConfig),
    /** The standard mix's FX bus chains (the editor's Pro mode marks and resets changes against them). */
    standardRackChains: (JSON.parse(service.mixConfig) as { rackChains?: unknown }).rackChains ?? [],
    /** A genre recipe's mastering reference (Casperaki Pop): the browser engine masters towards it. */
    ...(() => {
      const reference = masteringReferenceData(canonical, service.masteringReferencesDir);
      return reference === undefined ? {} : { masteringReference: reference };
    })(),
  };
}

export function createPlaybackRouter({ store, playback, ownerOf }: PlaybackRouterDeps): Router {
  /** The engine's input for a song; the playback id is that input's hash. */
  const forEngine = (song: Song) => {
    const canonical = canonicalStringifySong(song, 2);
    return { id: createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 16), canonical };
  };
  const router = Router();

  const notConfigured = (res: Response) =>
    res.status(503).json({
      error: 'playback_not_configured',
      message: 'In-browser playback is off: CASPERAKI_SAMPLE_LIBRARY_ROOT is not set on the brain.',
    });

  // A melody without lyrics plays on the preview piano with the rest of the song (owner 2026-11-28); in-browser
  // playback only: exports and renders play the song as it is.
  const respond = async (res: Response, service: PlaybackService, songId: string, canonical: string, mixOverrides?: MixOverrides | null) => {
    const song = parseSong(JSON.parse(canonical));
    const played = wordlessMelodyAsPiano(song);
    res.json(await playbackPayload(service, songId, canonical, mixOverrides, played === song ? canonical : canonicalStringifySong(played, 2)));
  };

  router.get('/api/songs/:id/playback', async (req, res) => {
    if (!playback) return notConfigured(res);
    const id = req.params.id;
    const project = store.getProject(ownerOf(req), id);
    if (!project) return res.status(404).json({ error: 'not_found', id });
    const stored = store.get(id);
    if (!stored) return res.status(404).json({ error: 'not_found', id });
    try {
      await respond(res, playback, id, stored.canonical, project.mixOverrides);
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
