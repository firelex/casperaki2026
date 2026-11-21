// Pattern lab (admins only): review Casperaki-written pattern proposals.
//
//   GET  /api/patterns                 proposals + review decision + whether exported
//   POST /api/patterns/:id/review      { status: 'approved' | 'rejected' | 'pending', note? }
//   POST /api/patterns/:id/preview     { genre, seed?, variant: 'proposal' | 'current' }
//     -> a playback payload (see routes/playback.ts) for a full song in that
//        genre, with the proposal forced in ('proposal') or the library as is
//        ('current', same seed) so the two can be compared.
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
  DRUM_BANK_DIR,
  loadPatternProposals,
  orchestrate,
  previewParamsFor,
} from '@casperaki/arrangement';
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
  })
  .strict();

function exportedStyles(): Set<string> {
  const index = JSON.parse(readFileSync(join(DRUM_BANK_DIR, 'bank-index.json'), 'utf8')) as { styles: Record<string, unknown> };
  return new Set(Object.keys(index.styles));
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
    try {
      const song = orchestrate({
        genre,
        key: 'C',
        bpm: DEFAULT_BPM_BY_GENRE[genre],
        seed,
        ...(variant === 'proposal' ? { params: previewParamsFor(proposal) } : {}),
      });
      const canonical = canonicalStringifySong(song, 2);
      const id = createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 16);
      return res.json({ ...(await playbackPayload(playback, id, canonical)), seed });
    } catch (err) {
      return res.status(500).json({ error: 'preview_failed', message: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
