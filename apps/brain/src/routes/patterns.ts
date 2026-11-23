// Pattern lab (admins only): review Casperaki-written pattern proposals.
//
//   GET  /api/patterns                 proposals + review decision + whether exported
//   POST /api/patterns/:id/review      { status: 'approved' | 'rejected' | 'pending', note? }
//   GET  /api/patterns/:id/sounds?genre=  the sounds the proposal's instrument can use in
//                                      that genre (the instrument picker; none for drums)
//   POST /api/patterns/:id/preview     { genre, seed?, variant: 'proposal' | 'current', take?, soundId? }
//     -> a playback payload (see routes/playback.ts) for a full song in that
//        genre, with the proposal forced in ('proposal') or the library as is
//        ('current', same seed) so the two can be compared. Both songs get a
//        lane of the proposal's family when the seed's roster has none.
//        soundId: play the proposal's instrument with that library sound (the
//        editor's Change sound on each of its tracks; not for drums, whose kit
//        is fixed per genre). The answer lists the sounds the instrument can
//        use in that genre (`sounds`) and the one playing (`soundId`).
//
// Proposals are files in packages/arrangement/data/patterns/proposals/;
// approved ones reach the library via scripts/export-approved-patterns.ts.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Router, type Request } from 'express';
import { z } from 'zod';

import {
  authoredStyleName,
  authoredStyleNames,
  BASS_BANK_DIR,
  DRUM_BANK_DIR,
  editTrack,
  familySoundPool,
  laneFamilyOf,
  loadPublicNames,
  loadValidatedCatalog,
  publicNameOf,
  userSoundFamily,
  TrackEditError,
  loadPatternProposals,
  orchestrate,
  previewParamsFor,
  sectionEnergy,
  type PatternProposal,
} from '@casperaki/arrangement';
import type { Song } from '@casperaki/song-schema';
import { canonicalStringifySong, DEFAULT_BPM_BY_GENRE, GenreSchema } from '@casperaki/song-schema';

import type { PlaybackService } from '../render/playbackService.js';
import type { SongsStore } from '../store.js';
import { playbackPayload } from './playback.js';

export interface PatternsRouterDeps {
  readonly store: SongsStore;
  readonly playback: PlaybackService | undefined;
  /** Whether the request comes from an admin (everyone, with auth off). */
  readonly isAdminRequest: (req: Request) => boolean;
  /** Who the reviewer is, for the record. */
  readonly reviewerOf: (req: Request) => string;
}

const ReviewBody = z
  .object({ status: z.enum(['approved', 'rejected', 'pending']), note: z.string().max(2000).optional() })
  .strict();
const PreviewBody = z
  .object({
    genre: GenreSchema,
    seed: z.union([z.string().min(1), z.number().int()]).optional(),
    variant: z.enum(['proposal', 'current']),
    /** Play only this pattern (0-based) of the proposal; omitted = the song picks among all of them. */
    take: z.number().int().min(0).optional(),
    /** Play the proposal's instrument with this library sound (not drums). */
    soundId: z.string().regex(/^[0-9a-f]{16}$/u).optional(),
  })
  .strict();

function exportedStyles(): Set<string> {
  const drums = JSON.parse(readFileSync(join(DRUM_BANK_DIR, 'bank-index.json'), 'utf8')) as { styles: Record<string, unknown> };
  const bass = JSON.parse(readFileSync(join(BASS_BANK_DIR, 'bank-index.json'), 'utf8')) as { authored?: Record<string, unknown> };
  return new Set([...Object.keys(drums.styles), ...Object.keys(bass.authored ?? {}), ...authoredStyleNames()]);
}

/**
 * The preview song with the proposal's family playing throughout: unless a
 * lane of that family already plays in at least half of the sections, the
 * song gets one more in every section (the sequencer's "add track"). Both
 * variants get the same lane, so the proposal and the current library are
 * heard on the same parts.
 */
function withProposalLane(song: Song, proposal: PatternProposal): Song {
  if (proposal.family === 'drums' || proposal.family === 'bass') return song;
  const sections = song.songStructure.map((s) => s.name);
  const lanes = song.instrumentDefinitions.map((d) => d.name).filter((n) => laneFamilyOf(n) === proposal.family);
  const coverage = Math.max(0, ...lanes.map((lane) => sections.filter((s) => song.arrangement[s]?.instruments[lane] === true).length));
  if (coverage * 2 >= sections.length) return song;
  return editTrack(song, { kind: 'addTrack', family: proposal.family, segments: sections }).song;
}

/**
 * Every sound a proposal's instrument can play (what Change sound accepts), by
 * public name: first the genre's own pool (`inStyle`, what generated songs pick
 * from), then the instrument's other library sounds (e.g. trumpet, saxophones
 * and trombone for brass, whose generated tracks use the brass sections). None
 * for drums: the kit is fixed per genre.
 */
function soundsFor(proposal: PatternProposal, genre: Parameters<typeof familySoundPool>[1]): { id: string; name: string; inStyle: boolean }[] {
  if (proposal.family === 'drums') return [];
  const names = loadPublicNames();
  const pool = familySoundPool(proposal.family, genre);
  const inPool = new Set(pool.map((e) => e.id));
  // (A Virtual Guitarist guitar's chords and effects recordings are parts of its notes row, not sounds.)
  const guitarPart = (e: { preset?: string | null }) => e.preset === 'Default Chords' || e.preset === 'Default FX';
  const others = loadValidatedCatalog().entries.filter((e) => !inPool.has(e.id) && userSoundFamily(e) === proposal.family && !guitarPart(e));
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  return [
    ...pool.map((e) => ({ id: e.id, name: publicNameOf(e, names), inStyle: true })).sort(byName),
    ...others.map((e) => ({ id: e.id, name: publicNameOf(e, names), inStyle: false })).sort(byName),
  ];
}

export function createPatternsRouter({ store, playback, isAdminRequest, reviewerOf }: PatternsRouterDeps): Router {
  const router = Router();
  router.use('/api/patterns', (req, res, next) => {
    if (!isAdminRequest(req)) {
      res.status(403).json({ error: 'admin_only', message: 'The pattern lab is limited to admins.' });
      return;
    }
    next();
  });

  router.get('/api/patterns', (_req, res) => {
    const reviews = new Map(store.listPatternReviews().map((r) => [r.proposalId, r]));
    const exported = exportedStyles();
    res.json({
      proposals: loadPatternProposals().map((p) => ({
        ...p,
        review: reviews.get(p.id) ?? null,
        inLibrary: exported.has(authoredStyleName(p.id)),
      })),
    });
  });

  router.post('/api/patterns/:id/review', (req, res) => {
    const body = ReviewBody.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'invalid_body' });
    const id = req.params.id;
    if (!loadPatternProposals().some((p) => p.id === id)) return res.status(404).json({ error: 'not_found', id });
    if (body.data.status === 'pending') store.clearPatternReview(id);
    else
      store.setPatternReview({
        proposalId: id,
        status: body.data.status,
        note: body.data.note ?? '',
        reviewer: reviewerOf(req),
        decidedAt: new Date().toISOString(),
      });
    const review = store.listPatternReviews().find((r) => r.proposalId === id) ?? null;
    return res.json({ review });
  });

  router.get('/api/patterns/:id/sounds', (req, res) => {
    const proposal = loadPatternProposals().find((p) => p.id === req.params.id);
    if (!proposal) return res.status(404).json({ error: 'not_found', id: req.params.id });
    const genre = GenreSchema.safeParse(req.query.genre);
    if (!genre.success) return res.status(400).json({ error: 'invalid_genre', message: 'genre must be one of the canonical genres' });
    return res.json({ sounds: soundsFor(proposal, genre.data) });
  });

  router.post('/api/patterns/:id/preview', async (req, res) => {
    if (!playback) {
      return res.status(503).json({ error: 'playback_not_configured', message: 'CASPERAKI_SAMPLE_LIBRARY_ROOT is not set on the brain.' });
    }
    const body = PreviewBody.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'invalid_body', message: body.error.issues[0]?.message });
    const proposal = loadPatternProposals().find((p) => p.id === req.params.id);
    if (!proposal) return res.status(404).json({ error: 'not_found', id: req.params.id });
    const { genre, variant } = body.data;
    const seed = body.data.seed ?? `pattern-lab-${proposal.id}-${genre}`;
    let params: Record<string, unknown> | undefined;
    try {
      params = variant === 'proposal' ? previewParamsFor(proposal, body.data.take) : undefined;
    } catch (err) {
      return res.status(400).json({ error: 'invalid_take', message: err instanceof Error ? err.message : String(err) });
    }
    try {
      let song = withProposalLane(
        orchestrate({
          genre,
          key: 'C',
          bpm: DEFAULT_BPM_BY_GENRE[genre],
          seed,
          ...(params ? { params } : {}),
        }),
        proposal,
      );
      const familyLanes = () => song.instrumentDefinitions.map((d) => d.name).filter((n) => laneFamilyOf(n) === proposal.family);
      const { soundId } = body.data;
      if (soundId) {
        if (proposal.family === 'drums') return res.status(400).json({ error: 'drum_kit_fixed', message: 'The drum kit is fixed per genre; drum proposals cannot change sound.' });
        for (const lane of familyLanes()) {
          try {
            song = editTrack(song, { kind: 'changeSound', track: lane, soundId }).song;
          } catch (err) {
            if (err instanceof TrackEditError) return res.status(err.status).json({ error: err.code, message: err.message });
            throw err;
          }
        }
      }
      const canonical = canonicalStringifySong(song, 2);
      const id = createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 16);
      // The tracks that play the proposal's instrument (the lab's "Play solo" solos them).
      const lanes = familyLanes();
      // The instrument picker: the sounds this family can use in the genre, and the one playing.
      const sounds = soundsFor(proposal, genre);
      const playing = song.instrumentDefinitions.find((d) => d.name === lanes[0])?.id;
      // Where each section plays (the lab starts a verse or chorus pattern at its section).
      const secPerBar = (4 * 60) / song.bpm;
      let bar = 0;
      const sections = song.songStructure.map((seg) => {
        const bars = seg.lengthInBars ?? seg.bars.length;
        const s = { name: seg.name, energy: sectionEnergy(seg.name) ?? null, start: bar * secPerBar, end: (bar + bars) * secPerBar };
        bar += bars;
        return s;
      });
      return res.json({ ...(await playbackPayload(playback, id, canonical)), seed, lanes, sections, sounds, soundId: typeof playing === 'string' ? playing : null });
    } catch (err) {
      return res.status(500).json({ error: 'preview_failed', message: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
