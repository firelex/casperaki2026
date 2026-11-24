// Vertical-slice songs router.
//
// Endpoints lifted directly off @casperaki/arrangement.orchestrate; the one
// model call is the lyricist (generation writes the song's words, see
// src/lyrics), no engine calls, no sample-library downloads. The
// `params` payload validates with Zod before the orchestrator sees it,
// and the storage layer holds the same canonical bytes the replay
// endpoint hashes against — see `apps/brain/src/store.ts`.

import { createHash } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { orchestrate, sungSections, writtenLyricsOf, type GenerateParams } from '@casperaki/arrangement';
import {
  canonicalStringifySong,
  formatGenreTempoRange,
  GenreSchema,
  isBpmInGenreTempoRange,
  applyMixOverrides,
  isEmptyMixOverrides,
  MixOverridesSchema,
  parseSong,
  pruneMixOverrides,
} from '@casperaki/song-schema';
import type { Song } from '@casperaki/song-schema';

import type { RenderService, RenderStatus } from '../render/renderService.js';
import type { ProjectRow, SongsStore } from '../store.js';
import type { ArtworkTasks } from '../artwork/tasks.js';
import type { LyricsTasks } from '../lyrics/tasks.js';
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

const MixBodySchema = z.object({ mixOverrides: MixOverridesSchema.nullable() }).strict();

/** The song's mixer lanes: its instruments, plus the shared transitions lane. */
function songLaneNames(song: Song): string[] {
  return [...song.instrumentDefinitions.map((d) => d.name), 'Sample Transitions FX'];
}

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
  /** The standard mix config (mix-config.json text), to check and apply Pro-mode
   *  mixes. Absent without in-browser playback; saving a mix then answers 503. */
  readonly mixConfig?: () => string;
  /** Hook for tests to inject a deterministic timestamp. */
  readonly now?: () => string;
  /** Told about every newly generated song that got the placeholder title
   *  (no title given); the brain names it afterwards, outside this router. */
  readonly onPlaceholderTitle?: (song: { ownerId: string; songId: string; song: Song; placeholderTitle: string }) => Promise<void> | void;
  /** The song as the engine gets it, its stored vocal takes added (see routes/vocals.ts). */
  readonly withTakes?: (song: Song) => Song;
  /** The vocal takes a song for the engine plays (their fingerprints, for the render cache key). */
  readonly takesOf?: (song: Song) => string;
  /** A saved song was saved again (new version) or deleted: clean up what only its old version used. */
  readonly onSongReplaced?: (oldSongId: string, how: 'saved' | 'deleted') => void;
  /** Writes the words of new songs in the background (the language model). Absent: generating answers 503
   *  lyrics_not_configured. */
  readonly lyrics?: LyricsTasks;
  /** Draws new songs' artwork in the background, after their title. Absent: songs get no artwork. */
  readonly artwork?: ArtworkTasks;
}

/** Generating needs the lyricist and it is not set up. */
export class LyricsNotConfiguredError extends Error {
  constructor() {
    super('Songs cannot be generated: the lyrics model is not configured (set ASSISTANT_LLM_URL and ASSISTANT_LLM_MODEL).');
    this.name = 'LyricsNotConfiguredError';
  }
}

/** The id that owns projects. Every /api route sits behind the session gate
 *  when auth is configured; without auth (dev mode) everything belongs to
 *  one local owner. */
export const DEV_OWNER_ID = 'local-dev';
export function ownerOf(req: Request): string {
  return req.user?.id ?? DEV_OWNER_ID;
}

export interface GeneratedProject {
  readonly id: string;
  readonly song: Song;
  readonly hash: string;
}

/**
 * Generate a song and keep it as one of the owner's projects (POST /api/songs/generate; hum to song uses it too).
 * The song comes back at once with its melody; the words of every sung section that has none recorded are written
 * in the background (lyrics/tasks.ts), and the project's lyrics state says so until they are in.
 * Untitled songs get the style-and-key placeholder and are named afterwards. Generator errors are thrown.
 */
export async function generateProject(
  deps: { readonly store: SongsStore; readonly clock: () => string; readonly onPlaceholderTitle?: SongsRouterDeps['onPlaceholderTitle']; readonly lyrics?: LyricsTasks; readonly artwork?: ArtworkTasks },
  owner: string,
  params: GenerateParams,
  title: string | undefined,
): Promise<GeneratedProject> {
  const { store, clock, onPlaceholderTitle, lyrics, artwork } = deps;
  if (!lyrics) throw new LyricsNotConfiguredError();
  const song = orchestrate(params);
  const recorded = writtenLyricsOf(params.params);
  const unwritten = sungSections(song).some((s) => !recorded[s.name]);
  const canonical = canonicalStringifySong(song, 2);
  const hash = hashCanonical(canonical);
  const id = hash.slice(0, 16);
  const at = clock();
  store.put({ id, song, canonical, hash, createdAt: at });
  const existing = store.getProject(owner, id);
  const placeholder = title === undefined && !existing ? defaultTitle(params.genre, params.key) : undefined;
  store.upsertProject({
    ownerId: owner,
    songId: id,
    title: title ?? existing?.title ?? placeholder!,
    createdAt: existing?.createdAt ?? at,
    updatedAt: at,
  });
  if (unwritten) lyrics.start(owner, id);
  const naming = placeholder !== undefined ? onPlaceholderTitle?.({ ownerId: owner, songId: id, song, placeholderTitle: placeholder }) : undefined;
  // The artwork is drawn for the song's title, so it starts once naming is over.
  artwork?.start(owner, id, naming ?? Promise.resolve());
  return { id, song, hash };
}

export function createSongsRouter({ store, renders, mixConfig, now, onPlaceholderTitle, withTakes, takesOf, onSongReplaced, lyrics, artwork }: SongsRouterDeps): Router {
  const router = Router();
  const clock = now ?? (() => new Date().toISOString());

  router.get('/api/songs', (req, res) => {
    const owner = ownerOf(req);
    const projects = store.listProjects(owner).map((p) => projectJson(p, renders));
    res.json({ projects });
  });

  router.post('/api/songs/generate', async (req, res) => {
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
    let made: GeneratedProject;
    try {
      made = await generateProject({ store, clock, onPlaceholderTitle, ...(lyrics ? { lyrics } : {}), ...(artwork ? { artwork } : {}) }, ownerOf(req), parsed.data, title.data);
    } catch (err) {
      return generateError(res, err);
    }
    const { id, song, hash } = made;
    const owner = ownerOf(req);
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
    if (req.params.id !== id) onSongReplaced?.(req.params.id, 'saved');
    // A Pro-mode change for a track the edit removed no longer applies.
    const moved = store.getProject(owner, id)!;
    if (moved.mixOverrides) {
      const pruned = pruneMixOverrides(moved.mixOverrides, songLaneNames(song));
      store.setProjectMix({ ownerId: owner, songId: id, mixOverrides: isEmptyMixOverrides(pruned) ? null : pruned, updatedAt: moved.mixUpdatedAt ?? at });
    }
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

  // The song's artwork (a PNG), once drawn.
  router.get('/api/songs/:id/artwork', (req, res) => {
    const project = store.getProject(ownerOf(req), req.params.id);
    if (!project) return res.status(404).json({ error: 'not_found', id: req.params.id });
    if (project.artwork?.state !== 'done' || !artwork) return res.status(404).json({ error: 'no_artwork', message: 'This song has no artwork (yet).' });
    res.setHeader('cache-control', 'private, max-age=31536000, immutable');
    return res.sendFile(artwork.fileOf(project.artwork.file));
  });

  router.delete('/api/songs/:id', (req, res) => {
    const gone = store.getProject(ownerOf(req), req.params.id);
    const ok = store.deleteProject(ownerOf(req), req.params.id);
    if (ok && gone?.artwork?.state === 'done') artwork?.removeFile(gone.artwork.file);
    if (!ok) return res.status(404).json({ error: 'not_found', id: req.params.id });
    onSongReplaced?.(req.params.id, 'deleted');
    return res.status(204).end();
  });

  // Write the song's lyrics again after writing them failed (they are written in the background, as for a new song).
  router.post('/api/songs/:id/lyrics', (req, res) => {
    const owner = ownerOf(req);
    const project = store.getProject(owner, req.params.id);
    if (!project) return res.status(404).json({ error: 'not_found', id: req.params.id });
    if (!lyrics) return generateError(res, new LyricsNotConfiguredError());
    if (project.lyrics?.state === 'writing') return res.status(409).json({ error: 'lyrics_writing', message: 'The lyrics are already being written.' });
    lyrics.start(owner, project.songId);
    return res.status(202).json({ project: projectJson(store.getProject(owner, project.songId)!, renders) });
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

  // Pro mode: save the owner's mix changes for this song (null or an empty mix = the standard mix).
  router.put('/api/songs/:id/mix', (req, res) => {
    const owner = ownerOf(req);
    const project = store.getProject(owner, req.params.id);
    const stored = project ? store.get(req.params.id) : undefined;
    if (!project || !stored) return res.status(404).json({ error: 'not_found', id: req.params.id });
    const body = MixBodySchema.safeParse(req.body);
    if (!body.success) {
      return res.status(400).json({ error: 'invalid_body', issues: body.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    }
    const mix = body.data.mixOverrides;
    if (mix && !isEmptyMixOverrides(mix)) {
      if (!mixConfig) return res.status(503).json({ error: 'mix_not_configured', message: 'The brain has no mix config (CASPERAKI_MIX_CONFIG).' });
      const lanes = new Set(songLaneNames(stored.song));
      const unknown = Object.keys(mix.lanes).filter((l) => !lanes.has(l));
      if (unknown.length) return res.status(400).json({ error: 'unknown_lanes', message: `This song has no track ${unknown.map((l) => `"${l}"`).join(', ')}.` });
      try {
        applyMixOverrides(mixConfig(), mix);
      } catch (err) {
        return res.status(400).json({ error: 'invalid_mix', message: err instanceof Error ? err.message : String(err) });
      }
    }
    store.setProjectMix({ ownerId: owner, songId: req.params.id, mixOverrides: mix && !isEmptyMixOverrides(mix) ? mix : null, updatedAt: clock() });
    return res.json({ project: projectJson(store.getProject(owner, req.params.id)!, renders) });
  });

  router.post('/api/songs/:id/render', (req, res) => {
    if (!renders) return renderNotConfigured(res);
    const stored = store.getProject(ownerOf(req), req.params.id) ? store.get(req.params.id) : undefined;
    if (!stored) return res.status(404).json({ error: 'not_found', id: req.params.id });
    const project = store.getProject(ownerOf(req), req.params.id)!;
    let songMix: string | undefined;
    if (project.mixOverrides) {
      if (!mixConfig) return res.status(503).json({ error: 'mix_not_configured', message: 'This song has a Pro-mode mix, but the brain has no mix config (CASPERAKI_MIX_CONFIG).' });
      songMix = applyMixOverrides(mixConfig(), project.mixOverrides);
    }
    try {
      const forEngine = withTakes ? withTakes(parseSong(JSON.parse(stored.canonical))) : undefined;
      renders.enqueue(stored.id, forEngine ? canonicalStringifySong(forEngine, 2) : stored.canonical, songMix, forEngine && takesOf ? takesOf(forEngine) : undefined);
    } catch (err) {
      return res.status(409).json({ error: 'render_busy', message: err instanceof Error ? err.message : String(err) });
    }
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
    mixOverrides: p.mixOverrides,
    mixUpdatedAt: p.mixUpdatedAt,
    lyrics: p.lyrics === null ? null : p.lyrics.state === 'failed' ? { state: 'failed', message: p.lyrics.message } : { state: 'writing' },
    artwork:
      p.artwork === null
        ? null
        : p.artwork.state === 'done'
          ? { state: 'done', url: `/api/songs/${p.songId}/artwork?v=${p.artwork.task}` }
          : p.artwork.state === 'failed'
            ? { state: 'failed', message: p.artwork.message }
            : { state: 'drawing' },
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

export function hashCanonical(canonical: string): string {
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function generateError(res: Response, err: unknown): Response {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof LyricsNotConfiguredError) return res.status(503).json({ error: 'lyrics_not_configured', message });
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
