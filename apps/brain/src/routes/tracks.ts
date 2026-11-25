// Sequencer track editing (any signed-in user; the /api session gate applies).
//
//   POST /api/tracks/options  { song }      -> { tracks, families }
//     every track's family / sound / whether it can be regenerated, and per
//     instrument family the sounds the song's genre allows (public names).
//   POST /api/tracks/edit     { song, op }  -> { song, track }
//     op: { kind: 'changeSound', track, soundId }
//       | { kind: 'newPattern', track }
//       | { kind: 'addTrack', family, segments, soundId? }
//       | { kind: 'setDrumSound', role, soundId | null }   (null: genre default)
//       | { kind: 'newMelody', section }   a new melody (its chords and every part
//                                          under it, the phrase bank's words) for every section of that type
//       | { kind: 'writeMelody' }          the vocal tracks show the melody the generator chose (new songs start empty)
//       | { kind: 'applySung', result, sungOver, partial? }  a finished Sing (or, with partial, Transcribe melody) task's result put into the posted working copy (sungOver: the saved version, whose take fingerprints it keeps; partial: the result covers only its melody's sections)
//       | { kind: 'applyAceLayer', result }  a finished ACE layer task's clips on their "ACE <Instrument>" track
//       | { kind: 'applyLyrics', lyrics }  written lyrics (section → lines) on the vocal tracks (a finished Write
//                                          lyrics task merged into unsaved edits)
//     The edit is recorded in the song's generator block and only the edited
//     track changes in the posted (working) song (for a new melody: every track
//     of the sections of that type). Removing a track is a client-side edit.
//
//   POST /api/tracks/drum-kit { song }     -> { kit: [{ role, label, family,
//     soundId, name, overridden }] }: the drums the engine plays for the song,
//     in engine order (role = the engine's drum channel name, e.g. snareDrum1).
//
// See packages/arrangement/src/edits/track-edits.ts and drums/kit.ts.

import { Router, type Response } from 'express';
import { z } from 'zod';

import {
  addSection,
  setTransition,
  vocalAsPiano,
  finalChordRootForSegment,
  isSwappableTransition,
  loadValidatedCatalog,
  pickTransitionSound,
  resolveTransitionSound,
  TRANSITION_TYPES,
  DRUM_ROLE_LABELS,
  drumKit,
  editTrack,
  publicNameOf,
  songDrumSounds,
  TrackEditError,
  TrackEditRequestSchema,
  trackOptions,
} from '@casperaki/arrangement';
import { AceLayerResultSchema, applyAceLayer, applySungVocalsOver, applyWrittenLyrics, newMelody, segmentType, writeMelody, WrittenLyricsSchema } from '@casperaki/arrangement';
import { contentHash, parseSong, type Song } from '@casperaki/song-schema';

import { SingResultSchema } from '../sing/singTask.js';
import { ownerOf } from './songs.js';


const OptionsBody = z.object({ song: z.unknown() }).strict();
const VocalEditSchema = z.union([
  z.object({ kind: z.literal('newMelody'), section: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('writeMelody') }).strict(),
  z.object({ kind: z.literal('applyLyrics'), lyrics: WrittenLyricsSchema }).strict(),
  z.object({ kind: z.literal('applySung'), result: SingResultSchema, sungOver: z.unknown(), partial: z.boolean().optional() }).strict(),
  z.object({ kind: z.literal('applyAceLayer'), result: AceLayerResultSchema }).strict(),
]);
/** songId: the saved project the working song belongs to (a new melody waits while the project is being sung). */
const EditBody = z.object({ song: z.unknown(), songId: z.string().min(1).optional(), op: z.union([TrackEditRequestSchema, VocalEditSchema]) }).strict();

const VocalPianoBody = z.object({ song: z.unknown(), track: z.string().min(1) }).strict();

const SetTransitionBody = z
  .object({
    song: z.unknown(),
    segments: z.array(z.string().min(1)).min(1),
    type: z.string().min(1),
    placement: z.enum(['beginningOfSegment', 'midSegment', 'endOfSegment']),
    on: z.boolean(),
    /** The sound to play (library-sound transitions; a pack for tonal reverses / percussion fills). */
    soundId: z.string().min(1).optional(),
  })
  .strict();

const AddSectionBody = z
  .object({ song: z.unknown(), type: z.string().min(1), index: z.number().int().min(0), bars: z.number().int().min(1).max(64).optional() })
  .strict();

export interface TracksRouterDeps {
  /** Whether the owner's saved song is being sung (Write melody waits for it). */
  readonly isSinging: (ownerId: string, songId: string) => boolean;
}

export function createTracksRouter({ isSinging }: TracksRouterDeps): Router {
  const router = Router();

  router.post('/api/tracks/options', (req, res) => {
    const body = OptionsBody.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'invalid_body', message: body.error.issues[0]?.message });
    const song = songOf(body.data.song, res);
    if (!song) return;
    return run(res, () => trackOptions(song));
  });

  router.post('/api/tracks/edit', (req, res) => {
    const body = EditBody.safeParse(req.body);
    if (!body.success) {
      const issue = body.error.issues[0];
      return res.status(400).json({ error: 'invalid_body', message: issue ? `${issue.path.join('.')}: ${issue.message}` : 'invalid body' });
    }
    const song = songOf(body.data.song, res);
    if (!song) return;
    const op = body.data.op;
    const songId = body.data.songId;
    if ((op.kind === 'newMelody' || op.kind === 'writeMelody') && songId !== undefined && isSinging(ownerOf(req), songId)) {
      return res.status(409).json({ error: 'already_singing', message: 'Already singing' });
    }
    if (op.kind === 'newMelody') return run(res, () => ({ song: newMelody(song, segmentType(op.section)).song, track: 'Vocal' }));
    if (op.kind === 'writeMelody') return run(res, () => ({ song: writeMelody(song), track: 'Vocal' }));
    if (op.kind === 'applyAceLayer') return run(res, () => ({ song: applyAceLayer(song, op.result), track: op.result.track }));
    if (op.kind === 'applyLyrics') return run(res, () => ({ song: applyWrittenLyrics(song, op.lyrics), track: 'Vocal' }));
    if (op.kind === 'applySung') return run(res, () => ({ song: applySungVocalsOver(song, op.result, parseSong(op.sungOver), { partial: op.partial === true }), track: 'Vocal' }));
    return run(res, () => editTrack(song, op));
  });

  router.post('/api/tracks/drum-kit', (req, res) => {
    const body = OptionsBody.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'invalid_body', message: body.error.issues[0]?.message });
    const song = songOf(body.data.song, res);
    if (!song) return;
    return run(res, () => ({ kit: drumKitView(song) }));
  });

  // Add a section written by the generator: { song, type, index, bars? } -> { song, name }.
  router.post('/api/sections/add', (req, res) => {
    const body = AddSectionBody.safeParse(req.body);
    if (!body.success) {
      const issue = body.error.issues[0];
      return res.status(400).json({ error: 'invalid_body', message: issue ? `${issue.path.join('.')}: ${issue.message}` : 'invalid body' });
    }
    const song = songOf(body.data.song, res);
    if (!song) return;
    return run(res, () => addSection(song, body.data.type, body.data.index, body.data.bars));
  });

  // Every section's transitions with their sounds (public names only), and the types there are.
  router.post('/api/transitions/state', (req, res) => {
    const body = OptionsBody.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'invalid_body', message: body.error.issues[0]?.message });
    const song = songOf(body.data.song, res);
    if (!song) return;
    return run(res, () => transitionState(song));
  });

  // A sung part played on a piano (the engine does not sing yet), for the
  // preview window: { song (a preview song holding only that track), track } -> { song, pianoName }.
  router.post('/api/tracks/vocal-as-piano', (req, res) => {
    const body = VocalPianoBody.safeParse(req.body);
    if (!body.success) {
      const issue = body.error.issues[0];
      return res.status(400).json({ error: 'invalid_body', message: issue ? `${issue.path.join('.')}: ${issue.message}` : 'invalid body' });
    }
    const song = songOf(body.data.song, res);
    if (!song) return;
    return run(res, () => {
      const out = vocalAsPiano(song, body.data.track);
      return { song: out.song, pianoName: publicNameOf(out.piano) };
    });
  });

  // Switch a transition on or off in sections: { song, segments, type, placement, on } -> { song }.
  router.post('/api/transitions/set', (req, res) => {
    const body = SetTransitionBody.safeParse(req.body);
    if (!body.success) {
      const issue = body.error.issues[0];
      return res.status(400).json({ error: 'invalid_body', message: issue ? `${issue.path.join('.')}: ${issue.message}` : 'invalid body' });
    }
    const song = songOf(body.data.song, res);
    if (!song) return;
    const { song: _s, ...request } = body.data;
    return run(res, () => ({ song: setTransition(song, request) }));
  });

  return router;
}

function songOf(raw: unknown, res: Response): Song | undefined {
  try {
    return parseSong(raw);
  } catch (err) {
    res.status(400).json({ error: 'invalid_song', message: err instanceof Error ? err.message : String(err) });
    return undefined;
  }
}

function run(res: Response, fn: () => unknown) {
  try {
    return res.json(fn());
  } catch (err) {
    if (err instanceof TrackEditError) return res.status(err.status).json({ error: err.code, message: err.message });
    return res.status(500).json({ error: 'track_edit_failed', message: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * The song's transitions per section with the sound each plays. A stored
 * soundId names it (for packs the row played in that section is named); a
 * transition saved without one shows what lowering picks for it (the same
 * seeded pick, seed = the song's content hash).
 */
/** The song's drum kit: each drum part (role) with the public name of the sound it plays. */
export function drumKitView(song: Song) {
  if (!song.instrumentDefinitions.some((d) => d.name === 'Drums')) throw new TrackEditError(400, 'no_drums', 'The song has no drum track.');
  if (!song.genre) throw new TrackEditError(400, 'no_genre', 'The song has no genre, so its drum kit is unknown.');
  return drumKit(song.genre, songDrumSounds(song)).map((slot) => ({
    role: slot.role,
    label: DRUM_ROLE_LABELS[slot.role],
    family: slot.family,
    soundId: slot.entry?.id ?? null,
    name: slot.entry ? publicNameOf(slot.entry) : null,
    overridden: slot.overridden,
  }));
}

/** Every section's transitions with the sounds they play (public names only), and the types there are. */
export function transitionState(song: Song) {
  const catalog = loadValidatedCatalog();
  const hash = contentHash(song);
  const sections: Record<string, { type: string; placement: string; soundId: string | null; soundName: string | null }[]> = {};
  for (const seg of song.songStructure) {
    const entries = Object.entries((song.arrangement[seg.name]?.transitions ?? {}) as Record<string, { type?: string; placement?: string; soundId?: string }>);
    sections[seg.name] = entries.map(([tag, e]) => {
      if (typeof e.placement !== 'string') throw new Error(`${seg.name}/${tag}: transition has no placement`);
      if (!isSwappableTransition(tag)) return { type: tag, placement: e.placement, soundId: null, soundName: null };
      const ctx = { tempo: song.bpm, finalChordRoot: finalChordRootForSegment(seg.bars) };
      if (typeof e.soundId === 'string') {
        const played = resolveTransitionSound(catalog, tag, e.soundId, ctx);
        return { type: tag, placement: e.placement, soundId: e.soundId, soundName: publicNameOf(played) };
      }
      if (!song.genre) throw new Error('the song has no genre');
      const picked = pickTransitionSound(catalog, tag, { genre: song.genre, ...ctx }, hash, seg.name);
      return { type: tag, placement: e.placement, soundId: null, soundName: picked ? publicNameOf(picked.entry) : null };
    });
  }
  return {
    types: TRANSITION_TYPES.map((t) => ({ type: t.type, label: t.label, placements: t.placements, swappable: isSwappableTransition(t.type) })),
    sections,
  };
}
