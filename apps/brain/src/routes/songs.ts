// Vertical-slice songs router.
//
// Three endpoints lifted directly off @casperaki/arrangement.orchestrate;
// no AI calls, no engine calls, no sample-library downloads. The
// `params` payload validates with Zod before the orchestrator sees it,
// and the storage layer holds the same canonical bytes the replay
// endpoint hashes against — see `apps/brain/src/store.ts`.

import { createHash } from 'node:crypto';
import { Router, type Response } from 'express';
import { z } from 'zod';

import { orchestrate, type GenerateParams } from '@casperaki/arrangement';
import {
  canonicalStringifySong,
  formatGenreTempoRange,
  GenreSchema,
  isBpmInGenreTempoRange,
} from '@casperaki/song-schema';

import type { SongsStore } from '../store.js';

// `genre` is validated against the canonical brain vocabulary (8 styles,
// see GenreSchema). Legacy strings — notably the Phase-3-slice placeholder
// `'pop'` — are rejected at this boundary. There is NO compatibility alias:
// callers must send a canonical style key. See docs/53o-step4-per-style-
// structures.md for the rationale.
const GenerateBodySchema = z
  .object({
    genre: GenreSchema,
    key: z.string().min(1),
    bpm: z.number().int().positive(),
    seed: z.union([z.string().min(1), z.number().int()]),
    params: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (isBpmInGenreTempoRange(body.genre, body.bpm)) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['bpm'],
      message: `bpm must be in the legacy ${body.genre} tempo range (${formatGenreTempoRange(body.genre)})`,
    });
  });

export interface SongsRouterDeps {
  readonly store: SongsStore;
  /** Hook for tests to inject a deterministic timestamp. */
  readonly now?: () => string;
}

export function createSongsRouter({ store, now }: SongsRouterDeps): Router {
  const router = Router();
  const clock = now ?? (() => new Date().toISOString());

  router.post('/api/songs/generate', (req, res) => {
    const parsed = GenerateBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'invalid_body',
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const params: GenerateParams = parsed.data;
    let song;
    try {
      song = orchestrate(params);
    } catch (err) {
      return generateError(res, err);
    }
    const canonical = canonicalStringifySong(song, 2);
    const hash = hashCanonical(canonical);
    const id = hash.slice(0, 16);
    store.put({ id, song, canonical, hash, createdAt: clock() });
    return res.status(201).json({ id, song, hash });
  });

  router.get('/api/songs/:id', (req, res) => {
    const stored = store.get(req.params.id);
    if (!stored) return res.status(404).json({ error: 'not_found', id: req.params.id });
    return res.json({ id: stored.id, song: stored.song, hash: stored.hash });
  });

  router.post('/api/songs/:id/replay', (req, res) => {
    const stored = store.get(req.params.id);
    if (!stored) return res.status(404).json({ error: 'not_found', id: req.params.id });
    const params = paramsFromStored(stored.song);
    if (!params) {
      return res.status(409).json({
        error: 'replay_missing_params',
        message: 'stored song has no generator block — cannot replay',
        id: req.params.id,
      });
    }
    let replaySong;
    try {
      replaySong = orchestrate(params);
    } catch (err) {
      return generateError(res, err);
    }
    const replayCanonical = canonicalStringifySong(replaySong, 2);
    const replayHash = hashCanonical(replayCanonical);
    return res.json({
      id: stored.id,
      ok: replayHash === stored.hash,
      hash: stored.hash,
      replayHash,
    });
  });

  return router;
}

function paramsFromStored(song: unknown): GenerateParams | undefined {
  const generator = (song as { generator?: { seed?: unknown; params?: unknown } }).generator;
  if (!generator || !generator.params) return undefined;
  const block = generator.params as Record<string, unknown>;
  if (typeof block.genre !== 'string' || typeof block.key !== 'string' || typeof block.bpm !== 'number')
    return undefined;
  const seedRaw = generator.seed;
  // Replay must not silently substitute an empty seed — return undefined
  // so the route surfaces the documented 409 `replay_missing_params`.
  if (typeof seedRaw !== 'string' && typeof seedRaw !== 'number') return undefined;
  return {
    genre: block.genre,
    key: block.key,
    bpm: block.bpm,
    seed: seedRaw,
    ...(typeof block.params === 'object' && block.params !== null
      ? { params: block.params as Record<string, unknown> }
      : {}),
  };
}

function hashCanonical(canonical: string): string {
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function generateError(res: Response, err: unknown): Response {
  const message = err instanceof Error ? err.message : String(err);
  // Generator-level rejections (unsupported genre, missing precedent
  // entry, chord-vocab miss) surface here; treat them as 400s (bad input)
  // rather than 500s. The Zod body schema already catches non-canonical
  // genres at the API boundary — these messages cover the secondary
  // gates inside the chord / selection / vocals generators.
  if (/unsupported genre|only "brightPop"|unknown roman numeral|cannot parse/iu.test(message)) {
    return res.status(400).json({ error: 'orchestrate_failed', message });
  }
  return res.status(500).json({ error: 'orchestrate_failed', message });
}

// Exposed for tests that want to introspect parsed bodies without
// duplicating the schema.
export { GenerateBodySchema };
