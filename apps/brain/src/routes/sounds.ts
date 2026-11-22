// The public sound catalog (Sounds page), for any signed-in user. Public names
// only: no library, preset, file path or other original names ever leave here.
//
//   GET  /api/sounds/families            families with counts, in display order
//   GET  /api/sounds?family&q&style&cursor&limit   a page of sounds
//   GET  /api/sounds/:id                 one sound
//   POST /api/sounds/:id/preview         any sound, through the playback engine: a
//                                        playback payload + { bpm, bars, genre, genres,
//                                        variant, kept, writer, loop } (see enginePreview.ts)
//   GET  /api/sounds/:id/details         what the engine does with it in a song:
//                                        volume, octave, loudness, bus + inserts, sends

import { createHash } from 'node:crypto';
import { Router, type Response } from 'express';
import { z } from 'zod';

import type { InstrumentFamily } from '@casperaki/arrangement';
import { canonicalStringifySong, GenreSchema, type Song } from '@casperaki/song-schema';

import type { PlaybackService } from '../render/playbackService.js';
import { diskPathOf, searchSounds, soundCatalog, soundFamilies, soundTransitions, SoundError, type SoundItem } from '../sounds/soundCatalog.js';
import { barsFor, DRUM_PREVIEW_BARS, drumPreviewSong, SAMPLE_PREVIEW_GENRE, samplePreviewSong } from '../sounds/enginePreview.js';
import { MixLookup, soundDetails, type DetailsKind } from '../sounds/soundDetails.js';
import { PREVIEW_BARS, previewSong } from '../sounds/previewSong.js';
import { playbackPayload } from './playback.js';

const ListQuery = z
  .object({
    family: z.string().min(1).optional(),
    /** Sounds that can go on a track of this kind (e.g. guitar: acoustic and electric). */
    useAs: z.string().min(1).optional(),
    /** Sounds a transition type can play (e.g. fxDownlifter). */
    transition: z.string().min(1).optional(),
    /** Only the sounds that suit a song in this style (the generator's rule). */
    suits: z.string().min(1).max(40).optional(),
    q: z.string().max(200).optional(),
    style: z.string().max(40).optional(),
    cursor: z.coerce.number().int().min(0).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

const DetailsQuery = z.object({ genre: GenreSchema.optional() }).strict();

/** The kind of part a borrowed preview plays, in words. */
const FAMILY_PART: Readonly<Record<InstrumentFamily, string>> = {
  drums: 'drum', bass: 'bass', keys: 'keys', pad: 'pad', guitar: 'guitar', synths: 'lead synth', pluckedSynths: 'plucked synth', popStrings: 'staccato string', popBrass: 'brass',
};

/** One mix lookup for the brain's mix config (loaded on first use). */
let mix: MixLookup | undefined;

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
    res.json({ families: soundFamilies(), transitions: soundTransitions() });
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
        ...(q.data.transition !== undefined ? { transition: q.data.transition } : {}),
        ...(q.data.suits !== undefined ? { suits: q.data.suits } : {}),
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
      const cat = soundCatalog();
      const body = PreviewBody.safeParse(req.body ?? {});
      if (!body.success) throw new SoundError(400, 'invalid_body', body.error.issues[0]?.message ?? 'invalid body');
      const { genre: want, prefer, keep } = body.data;
      const variant = body.data.variant ?? 0;
      const send = async (song: Song, extra: Record<string, unknown>) => {
        const canonical = canonicalStringifySong(song, 2);
        const id = createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 16);
        return res.json({ ...(await playbackPayload(playback, id, canonical)), ...extra });
      };
      const styleOrder = (genres: readonly string[]) => {
        if (want !== undefined && !genres.includes(want)) {
          throw new SoundError(400, 'unsupported_style', `No ${want} part can be written for ${item.name} (styles: ${genres.join(', ')}).`);
        }
        if (want !== undefined) return [want];
        return prefer && genres.includes(prefer) ? [prefer, ...genres.filter((g) => g !== prefer)] : [...genres];
      };

      // Tonal sounds: a part generated for them (or borrowed).
      const target = cat.patternOf.get(item.id);
      if (target) {
        const writer = keep ? cat.patternOf.get(keep.soundId) : undefined;
        const kept = Boolean(keep && writer && writer.family === target.family && target.genres.includes(keep.genre));
        const { song, bpm, genre } =
          kept && keep && writer
            ? previewSong(writer.donorId, target.family, [keep.genre], target.entry, keep.variant)
            : previewSong(target.donorId, target.family, styleOrder(target.genres), target.entry, variant);
        return await send(song, { bpm, bars: PREVIEW_BARS, genre, genres: target.genres, variant: kept && keep ? keep.variant : variant, kept, writer: kept && keep ? keep.soundId : item.id, loop: true });
      }

      // Drum hits: the style's groove with this hit in its kit positions. The groove
      // depends on style + pattern number only, so keeping it keeps the same groove.
      const drum = cat.drumOf.get(item.id);
      if (drum) {
        const kept = Boolean(keep && cat.drumOf.has(keep.soundId) && drum.genres.includes(keep.genre));
        const genre = kept && keep ? keep.genre : styleOrder(drum.genres)[0]!;
        const v = kept && keep ? keep.variant : variant;
        const { song, bpm } = drumPreviewSong(drum.entry, drum.roles, genre, v);
        return await send(song, { bpm, bars: DRUM_PREVIEW_BARS, genre, genres: drum.genres, variant: v, kept, writer: kept && keep ? keep.soundId : item.id, loop: true });
      }

      // Loops, breaks, effects, transition sounds, percussion hits: played on their own
      // through the engine. Styles, pattern numbers and keep do not apply (ignored).
      const sample = cat.sampleOf.get(item.id);
      if (sample) {
        const { plan, entry } = sample;
        let seconds: number;
        try {
          seconds = await playback.probeSeconds(diskPathOf(entry.matchedPath));
        } catch (err) {
          // The detail names the library file: log it, never send it.
          console.error(`[sounds] preview of ${item.id}: ${err instanceof Error ? err.message : String(err)}`);
          throw new SoundError(404, 'audio_missing', `The audio file for ${item.name} is missing from the library.`);
        }
        const bars = barsFor(seconds, plan.bpm, 1);
        const song = samplePreviewSong(entry, plan, bars, item.name);
        const loop = plan.kind === 'loop' ? true : plan.loop;
        return await send(song, { bpm: plan.bpm, bars, genre: SAMPLE_PREVIEW_GENRE, genres: [], variant: 0, kept: false, writer: item.id, loop });
      }

      throw new SoundError(409, 'no_preview', `${item.name} cannot be played: ${cat.noPreview.get(item.id) ?? 'no engine lane plays it'}.`);
    } catch (err) {
      return fail(res, err);
    }
  });

  // What the engine does with the sound in a song: GET /api/sounds/:id/details?genre=<style>.
  router.get('/api/sounds/:id/details', (req, res) => {
    if (!playback) return res.status(503).json(notConfigured);
    return run(res, () => {
      const item = soundOf(req.params.id);
      const q = DetailsQuery.safeParse(req.query);
      if (!q.success) throw new SoundError(400, 'invalid_query', q.error.issues[0]?.message ?? 'invalid query');
      const cat = soundCatalog();
      const entry = cat.validated.get(item.id);
      // The style the values are for: the one asked for (the song's), else the sound's own.
      const own = item.styles[0];
      const genre = q.data.genre ?? (own && (GenreSchema.options as readonly string[]).includes(own) ? own : null);
      mix ??= new MixLookup(playback.mixConfig);
      const pattern = cat.patternOf.get(item.id);
      const drum = cat.drumOf.get(item.id);
      const sample = cat.sampleOf.get(item.id);
      const kind: DetailsKind = pattern
        ? { kind: 'tonal', lane: pattern.donorId === item.id ? 'own' : FAMILY_PART[pattern.family] }
        : drum
          ? { kind: 'drum', roles: drum.roles }
          : sample
            ? { kind: 'sample', plan: sample.plan }
            : { kind: 'none', reason: cat.noPreview.get(item.id) ?? 'no engine lane plays it' };
      return soundDetails(mix, entry, kind, genre, { bpm: item.bpm, key: item.key });
    });
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
