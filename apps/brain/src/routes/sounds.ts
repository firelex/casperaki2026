// The public sound catalog (Sounds page), for any signed-in user. Public names
// only: no library, preset, file path or other original names ever leave here.
//
//   GET  /api/sounds/families            families with counts, in display order
//   GET  /api/sounds?family&q&style&cursor&limit   a page of sounds
//   GET  /api/sounds/:id                 one sound
//   POST /api/sounds/:id/preview         tonal sounds: a 4-bar pattern played by
//                                        the sound alone (a playback payload + bpm, bars)
//   GET  /api/sounds/:id/audio           drum hits, loops, breaks, fx: the sound's
//                                        audio as OGG (loops cut to the first 16 s)

import { createHash } from 'node:crypto';
import { Router, type Response } from 'express';
import { z } from 'zod';

import { canonicalStringifySong } from '@casperaki/song-schema';

import type { PlaybackService } from '../render/playbackService.js';
import { diskPathOf, searchSounds, soundCatalog, soundFamilies, SoundError, type SoundItem } from '../sounds/soundCatalog.js';
import { PREVIEW_BARS, previewSong } from '../sounds/previewSong.js';
import { playbackPayload } from './playback.js';

const ListQuery = z
  .object({
    family: z.string().min(1).optional(),
    /** Sounds that can go on a track of this kind (e.g. guitar: acoustic and electric). */
    useAs: z.string().min(1).optional(),
    q: z.string().max(200).optional(),
    style: z.string().max(40).optional(),
    cursor: z.coerce.number().int().min(0).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

/** Loops and breaks are cut to this many seconds for previews. */
const AUDIO_PREVIEW_SEC = 16;

/** Pattern preview options: a style (genre) and which generated pattern (0, 1, 2, …). */
// `prefer`: a style to start in when it can write this sound's part (e.g. the
// page's style filter); otherwise the sound's own style is used.
const PreviewBody = z
  .object({
    genre: z.string().min(1).optional(),
    prefer: z.string().min(1).optional(),
    variant: z.number().int().min(0).max(999).optional(),
    // Keep the pattern another sound is playing (to compare sounds on the same
    // notes): that sound writes the part, this one plays it. Kept only when
    // both are the same kind and the style suits both (`kept` in the reply).
    keep: z.object({ soundId: z.string().min(1), genre: z.string().min(1), variant: z.number().int().min(0).max(999) }).strict().optional(),
  })
  .strict();

export function createSoundsRouter(deps: { playback: PlaybackService | undefined }): Router {
  const { playback } = deps;
  const router = Router();
  const notConfigured = { error: 'playback_not_configured', message: 'CASPERAKI_SAMPLE_LIBRARY_ROOT is not set on the brain.' };

  router.get('/api/sounds/families', (_req, res) => {
    res.json({ families: soundFamilies() });
  });

  router.get('/api/sounds', (req, res) => {
    const q = ListQuery.safeParse(req.query);
    if (!q.success) {
      const issue = q.error.issues[0];
      return res.status(400).json({ error: 'invalid_query', message: issue ? `${issue.path.join('.') || 'query'}: ${issue.message}` : 'invalid query' });
    }
    return run(res, () =>
      searchSounds({
        ...(q.data.family !== undefined ? { family: q.data.family } : {}),
        ...(q.data.useAs !== undefined ? { useAs: q.data.useAs } : {}),
        ...(q.data.q !== undefined ? { q: q.data.q } : {}),
        ...(q.data.style !== undefined ? { style: q.data.style } : {}),
        cursor: q.data.cursor ?? 0,
        limit: q.data.limit ?? 60,
      }),
    );
  });

  router.get('/api/sounds/:id', (req, res) => run(res, () => soundOf(req.params.id)));

  router.post('/api/sounds/:id/preview', async (req, res) => {
    if (!playback) return res.status(503).json(notConfigured);
    try {
      const item = soundOf(req.params.id);
      const target = soundCatalog().patternOf.get(item.id);
      if (item.preview !== 'pattern' || !target) {
        throw new SoundError(409, 'no_pattern_preview', `${item.name} is previewed as ${item.preview === 'audio' ? 'audio' : 'nothing'}, not as a pattern.`);
      }
      const body = PreviewBody.safeParse(req.body ?? {});
      if (!body.success) throw new SoundError(400, 'invalid_body', body.error.issues[0]?.message ?? 'invalid body');
      const want = body.data.genre;
      if (want !== undefined && !target.genres.includes(want)) {
        throw new SoundError(400, 'unsupported_style', `No ${want} part can be written for ${item.name} (styles: ${target.genres.join(', ')}).`);
      }
      const variant = body.data.variant ?? 0;
      const prefer = body.data.prefer;
      const order = prefer && target.genres.includes(prefer) ? [prefer, ...target.genres.filter((g) => g !== prefer)] : target.genres;
      const keep = body.data.keep;
      const writer = keep ? soundCatalog().patternOf.get(keep.soundId) : undefined;
      if (keep && !writer) throw new SoundError(400, 'unknown_pattern', `Sound ${keep.soundId} has no pattern to keep.`);
      const kept = Boolean(keep && writer && writer.family === target.family && target.genres.includes(keep.genre));
      const { song, bpm, genre } =
        kept && keep && writer
          ? previewSong(writer.donorId, target.family, [keep.genre], target.entry, keep.variant)
          : previewSong(target.donorId, target.family, want ? [want] : order, target.entry, variant);
      const canonical = canonicalStringifySong(song, 2);
      const id = createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 16);
      return res.json({ ...(await playbackPayload(playback, id, canonical)), bpm, bars: PREVIEW_BARS, genre, genres: target.genres, variant: kept && keep ? keep.variant : variant, kept, writer: kept && keep ? keep.soundId : item.id });
    } catch (err) {
      return fail(res, err);
    }
  });

  router.get('/api/sounds/:id/audio', async (req, res) => {
    if (!playback) return res.status(503).json(notConfigured);
    try {
      const item = soundOf(req.params.id);
      const entry = soundCatalog().validated.get(item.id);
      if (item.preview !== 'audio' || !entry) {
        throw new SoundError(409, 'no_audio_preview', `${item.name} is previewed as ${item.preview === 'pattern' ? 'a pattern' : 'nothing'}, not as audio.`);
      }
      let sampleId: string;
      try {
        sampleId = playback.fileSample(diskPathOf(entry.matchedPath), item.family === 'percussionLoops' || item.family === 'percussionBreaks' ? AUDIO_PREVIEW_SEC : undefined);
      } catch (err) {
        // The detail names the library file: log it, never send it.
        console.error(`[sounds] audio for ${item.id}: ${err instanceof Error ? err.message : String(err)}`);
        throw new SoundError(404, 'audio_missing', `The audio file for ${item.name} is missing from the library.`);
      }
      const file = await playback.sampleFile(sampleId);
      res.setHeader('Content-Type', 'audio/ogg');
      res.setHeader('Cache-Control', 'private, max-age=86400');
      if (item.bpm !== null) res.setHeader('X-Sound-Bpm', String(item.bpm));
      return res.sendFile(file);
    } catch (err) {
      return fail(res, err);
    }
  });

  return router;
}

function soundOf(id: string): SoundItem {
  const item = soundCatalog().byId.get(id);
  if (!item) throw new SoundError(404, 'not_found', `No sound with id ${id}.`);
  return item;
}

function run(res: Response, fn: () => unknown) {
  try {
    return res.json(fn());
  } catch (err) {
    return fail(res, err);
  }
}

function fail(res: Response, err: unknown) {
  if (err instanceof SoundError) return res.status(err.status).json({ error: err.code, message: err.message });
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[sounds] ${message}`);
  return res.status(500).json({ error: 'sound_failed', message: 'The sound could not be prepared (see the brain log).' });
}
