// Vertical-slice songs router.
//
// Three endpoints lifted directly off @casperaki/arrangement.orchestrate;
// no AI calls, no engine calls, no sample-library downloads. The
// `params` payload validates with Zod before the orchestrator sees it,
// and the storage layer holds the same canonical bytes the replay
// endpoint hashes against — see `apps/brain/src/store.ts`.

import { createHash } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { orchestrate, type GenerateParams } from '@casperaki/arrangement';
import {
  canonicalStringifySong,
  formatGenreTempoRange,
  GenreSchema,
  isBpmInGenreTempoRange,
  parseSong,
} from '@casperaki/song-schema';
import type { Song } from '@casperaki/song-schema';

import type { RenderService, RenderStatus } from '../render/renderService.js';
import type { ProjectRow, SongsStore } from '../store.js';
import { readRenderPeaks } from './renders.js';

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

// Display titles. Optional at generate time; the brain names untitled songs
// after their style and key.
const TitleSchema = z.string().trim().min(1).max(120);

const SaveBodySchema = z
  .object({
    song: z.unknown(),
    title: TitleSchema.optional(),
  })
  .strict();

const RenameBodySchema = z.object({ title: TitleSchema }).strict();

export interface SongsRouterDeps {
  readonly store: SongsStore;
  /** Per-song render jobs. Absent when the sample library is not configured;
   *  render endpoints then answer 503 render_not_configured. */
  readonly renders?: RenderService;
  /** Hook for tests to inject a deterministic timestamp. */
  readonly now?: () => string;
  /** Told about every newly generated song that got the placeholder title
   *  (no title given); the brain names it afterwards, outside this router. */
  readonly onPlaceholderTitle?: (song: { ownerId: string; songId: string; song: Song; placeholderTitle: string }) => void;
}

/** The id that owns projects. Every /api route sits behind the session gate
 *  when auth is configured; without auth (dev mode) everything belongs to
 *  one local owner. */
export const DEV_OWNER_ID = 'local-dev';
export function ownerOf(req: Request): string {
  return req.user?.id ?? DEV_OWNER_ID;
}

export function createSongsRouter({ store, renders, now, onPlaceholderTitle }: SongsRouterDeps): Router {
  const router = Router();
  const clock = now ?? (() => new Date().toISOString());

  router.get('/api/songs', (req, res) => {
    const owner = ownerOf(req);
    const projects = store.listProjects(owner).map((p) => projectJson(p, renders));
    res.json({ projects });
  });

  router.post('/api/songs/generate', (req, res) => {
    // `title` is project metadata, not a generator input: split it off
    // before the strict generator-params schema sees the body.
    const { title: rawTitle, ...generatorBody } = (req.body ?? {}) as Record<string, unknown>;
    const title = TitleSchema.optional().safeParse(rawTitle);
    const parsed = GenerateBodySchema.safeParse(generatorBody);
    if (!title.success || !parsed.success) {
      const issues = [
        ...(title.success ? [] : title.error.issues.map((i) => ({ path: 'title', message: i.message }))),
        ...(parsed.success ? [] : parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))),
      ];
      return res.status(400).json({ error: 'invalid_body', issues });
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
    const at = clock();
    store.put({ id, song, canonical, hash, createdAt: at });
    const owner = ownerOf(req);
    const existing = store.getProject(owner, id);
    const placeholder = title.data === undefined && !existing ? defaultTitle(params.genre, params.key) : undefined;
    store.upsertProject({
      ownerId: owner,
      songId: id,
      title: title.data ?? existing?.title ?? placeholder!,
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
    });
    if (placeholder !== undefined) onPlaceholderTitle?.({ ownerId: owner, songId: id, song, placeholderTitle: placeholder });
    return res.status(201).json({ id, song, hash, project: projectJson(store.getProject(owner, id)!, renders) });
  });

  router.get('/api/songs/:id', (req, res) => {
    const project = store.getProject(ownerOf(req), req.params.id);
    const stored = project ? store.get(req.params.id) : undefined;
    if (!project || !stored) return res.status(404).json({ error: 'not_found', id: req.params.id });
    return res.json({ id: stored.id, song: stored.song, hash: stored.hash, project: projectJson(project, renders) });
  });

  // Save an edited song. Songs are content-addressed, so the edit gets a new
  // id; the project moves to it (keeping its title and created date) and the
  // response carries the new id for the editor to navigate to.
  router.put('/api/songs/:id', (req, res) => {
    const owner = ownerOf(req);
    if (!store.getProject(owner, req.params.id)) {
      return res.status(404).json({ error: 'not_found', id: req.params.id });
    }
    const body = SaveBodySchema.safeParse(req.body);
    if (!body.success) {
      return res.status(400).json({
        error: 'invalid_body',
        issues: body.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    let song;
    try {
      song = parseSong(body.data.song);
    } catch (err) {
      return res.status(400).json({ error: 'invalid_song', message: err instanceof Error ? err.message : String(err) });
    }
    const canonical = canonicalStringifySong(song, 2);
    const hash = hashCanonical(canonical);
    const id = hash.slice(0, 16);
    const at = clock();
    store.put({ id, song, canonical, hash, createdAt: at });
    store.moveProject({ ownerId: owner, fromSongId: req.params.id, toSongId: id, updatedAt: at });
    if (body.data.title) store.renameProject({ ownerId: owner, songId: id, title: body.data.title, updatedAt: at });
    return res.json({ id, song, hash, project: projectJson(store.getProject(owner, id)!, renders) });
  });

  router.patch('/api/songs/:id', (req, res) => {
    const body = RenameBodySchema.safeParse(req.body);
    if (!body.success) {
      return res.status(400).json({
        error: 'invalid_body',
        issues: body.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const owner = ownerOf(req);
    const ok = store.renameProject({ ownerId: owner, songId: req.params.id, title: body.data.title, updatedAt: clock() });
    if (!ok) return res.status(404).json({ error: 'not_found', id: req.params.id });
    return res.json({ project: projectJson(store.getProject(owner, req.params.id)!, renders) });
  });

  router.delete('/api/songs/:id', (req, res) => {
    const ok = store.deleteProject(ownerOf(req), req.params.id);
    if (!ok) return res.status(404).json({ error: 'not_found', id: req.params.id });
    return res.status(204).end();
  });

  router.post('/api/songs/:id/replay', (req, res) => {
    const stored = store.getProject(ownerOf(req), req.params.id) ? store.get(req.params.id) : undefined;
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

  // --- Rendering ---------------------------------------------------------

  router.post('/api/songs/:id/render', (req, res) => {
    if (!renders) return renderNotConfigured(res);
    const stored = store.getProject(ownerOf(req), req.params.id) ? store.get(req.params.id) : undefined;
    if (!stored) return res.status(404).json({ error: 'not_found', id: req.params.id });
    renders.enqueue(stored.id, stored.canonical);
    return res.status(202).json(renderJson(stored.id, renders));
  });

  router.get('/api/songs/:id/render', (req, res) => {
    if (!renders) return renderNotConfigured(res);
    if (!store.getProject(ownerOf(req), req.params.id)) return res.status(404).json({ error: 'not_found', id: req.params.id });
    return res.json(renderJson(req.params.id, renders));
  });

  // render.{wav,mp3} = mastered; render-unmastered.{wav,mp3} = the raw mix.
  for (const version of ['mastered', 'unmastered'] as const)
  for (const format of ['wav', 'mp3'] as const) {
    const route = version === 'mastered' ? `render.${format}` : `render-unmastered.${format}`;
    router.get(`/api/songs/:id/${route}`, (req, res) => {
      if (!renders) return renderNotConfigured(res);
      const project = store.getProject(ownerOf(req), req.params.id);
      if (!project) return res.status(404).json({ error: 'not_found', id: req.params.id });
      if (renders.status(req.params.id)?.state !== 'done') {
        return res.status(404).json({ error: 'not_rendered', id: req.params.id });
      }
      if (version === 'unmastered' && !renders.hasVersion(req.params.id, 'unmastered')) {
        return res.status(404).json({ error: 'no_unmastered_render', id: req.params.id });
      }
      const file = format === 'wav' ? renders.wavPath(req.params.id, version) : renders.mp3Path(req.params.id, version);
      if (req.query.download === '1') {
        const suffix = version === 'unmastered' ? ' (unmastered)' : '';
        res.attachment(`${safeFileName(project.title)}${suffix}.${format}`);
      }
      res.setHeader('cache-control', 'private, max-age=31536000, immutable');
      return res.sendFile(file);
    });
  }

  router.get('/api/songs/:id/render/peaks', async (req, res) => {
    if (!renders) return renderNotConfigured(res);
    if (!store.getProject(ownerOf(req), req.params.id)) return res.status(404).json({ error: 'not_found', id: req.params.id });
    if (renders.status(req.params.id)?.state !== 'done') {
      return res.status(404).json({ error: 'not_rendered', id: req.params.id });
    }
    const bins = Math.min(4096, Math.max(16, Number(req.query.bins) || 512));
    return res.json(await readRenderPeaks(renders.wavPath(req.params.id), bins));
  });

  return router;
}

function defaultTitle(genre: string, key: string): string {
  const label = genre.replace(/([a-z])([A-Z])/g, '$1 $2');
  return `${label.charAt(0).toUpperCase()}${label.slice(1)} in ${key}`;
}

function safeFileName(title: string): string {
  return title.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'casperaki-song';
}

function renderNotConfigured(res: Response): Response {
  return res.status(503).json({
    error: 'render_not_configured',
    message: 'Server-side rendering is off: CASPERAKI_SAMPLE_LIBRARY_ROOT is not set on the brain.',
  });
}

export interface RenderJson {
  readonly state: 'none' | RenderStatus['state'];
  readonly step?: RenderStatus['step'];
  readonly queuePosition?: number;
  readonly error?: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly mp3Url?: string;
  readonly wavUrl?: string;
  readonly unmasteredMp3Url?: string;
  readonly unmasteredWavUrl?: string;
}

function renderJson(songId: string, renders: RenderService | undefined): RenderJson {
  if (!renders) return { state: 'none' };
  const st = renders.status(songId);
  if (!st) return { state: 'none' };
  const base = `/api/songs/${songId}/render`;
  return {
    state: st.state,
    ...(st.step && st.state === 'running' ? { step: st.step } : {}),
    ...(st.state === 'queued' ? { queuePosition: renders.queuePosition(songId) } : {}),
    ...(st.error ? { error: st.error } : {}),
    ...(st.startedAt ? { startedAt: st.startedAt } : {}),
    ...(st.finishedAt ? { finishedAt: st.finishedAt } : {}),
    ...(st.state === 'done' ? { mp3Url: `${base}.mp3`, wavUrl: `${base}.wav` } : {}),
    ...(st.state === 'done' && renders.hasVersion(songId, 'unmastered')
      ? { unmasteredMp3Url: `${base}-unmastered.mp3`, unmasteredWavUrl: `${base}-unmastered.wav` }
      : {}),
  };
}

function projectJson(p: ProjectRow, renders: RenderService | undefined) {
  return {
    id: p.songId,
    title: p.title,
    genre: p.genre,
    key: p.key,
    bpm: p.bpm,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    sections: p.sections,
    render: renderJson(p.songId, renders),
  };
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
