// Music videos for a song (owner-only, like the song routes):
//   POST /api/songs/:id/video { orientation, quality?, artist }  → 202 + status (409 while one is being made)
//   GET  /api/songs/:id/video                          → { jobs: { landscape?, portrait? } }
//   GET  /api/songs/:id/video/<format>.mp4 (landscape, portrait, landscape-preview, portrait-preview)         → the video (?download=1: as an attachment)

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import type { SongsStore } from '../store.js';
import { MissingPlannerConfigError } from '../video/planner.js';
import { VideoInputError } from '../video/videoInput.js';
import { FORMATS, VideoBusyError, type VideoFormat, type VideoService, type VideoStatus } from '../video/videoService.js';

export interface VideoRouterDeps {
  readonly store: SongsStore;
  /** Absent when rendering is not configured (no sample library): 503. */
  readonly videos: VideoService | undefined;
  readonly ownerOf: (req: Request) => string;
  /** Whether the planner can run; a request without it fails at once with the reason. */
  readonly plannerConfigured: boolean;
}

const StartBody = z
  .object({
    orientation: z.enum(['landscape', 'portrait']),
    /** 'preview': half size, renders about 3x faster; kept beside the full video. */
    quality: z.enum(['full', 'preview']).optional(),
    artist: z.string().trim().min(1, 'the artist name is required').max(80),
  })
  .strict();

export function createVideoRouter({ store, videos, ownerOf, plannerConfigured }: VideoRouterDeps): Router {
  const router = Router();
  const notConfigured = (res: Response) =>
    res.status(503).json({ error: 'video_not_configured', message: 'Music videos need rendering: CASPERAKI_SAMPLE_LIBRARY_ROOT is not set on the brain.' });

  const statusJson = (s: VideoStatus) => ({
    state: s.state,
    ...(s.step ? { step: s.step } : {}),
    ...(s.progress !== undefined ? { progress: s.progress } : {}),
    ...(s.detail ? { detail: s.detail } : {}),
    ...(s.stepStartedAt ? { stepStartedAt: s.stepStartedAt } : {}),
    ...(s.startedAt ? { startedAt: s.startedAt } : {}),
    ...(s.error ? { error: s.error } : {}),
    ...(s.finishedAt ? { finishedAt: s.finishedAt } : {}),
    ...(s.state === 'done' ? { url: `/api/songs/${s.songId}/video/${s.format}.mp4` } : {}),
  });

  router.post('/api/songs/:id/video', (req, res) => {
    if (!videos) return notConfigured(res);
    const project = store.getProject(ownerOf(req), req.params.id);
    if (!project) return res.status(404).json({ error: 'not_found', id: req.params.id });
    const body = StartBody.safeParse(req.body);
    if (!body.success) {
      const issue = body.error.issues[0];
      return res.status(400).json({ error: 'invalid_body', message: issue ? `${issue.path.join('.')}: ${issue.message}` : 'invalid body' });
    }
    if (!plannerConfigured) return res.status(503).json({ error: 'planner_not_configured', message: new MissingPlannerConfigError().message });
    try {
      const format = (body.data.quality === 'preview' ? `${body.data.orientation}-preview` : body.data.orientation) as VideoFormat;
      const s = videos.start({ ownerId: ownerOf(req), songId: req.params.id, format, title: project.title, artist: body.data.artist });
      return res.status(202).json(statusJson(s));
    } catch (err) {
      if (err instanceof VideoBusyError) return res.status(409).json({ error: 'video_in_progress', message: err.message });
      if (err instanceof VideoInputError) return res.status(err.status).json({ error: err.code, message: err.message });
      throw err;
    }
  });

  router.get('/api/songs/:id/video', (req, res) => {
    if (!videos) return notConfigured(res);
    if (!store.getProject(ownerOf(req), req.params.id)) return res.status(404).json({ error: 'not_found', id: req.params.id });
    const jobs: Partial<Record<VideoFormat, ReturnType<typeof statusJson>>> = {};
    for (const o of FORMATS) {
      const s = videos.status(req.params.id, o);
      if (s) jobs[o] = statusJson(s);
    }
    return res.json({ jobs, plannerConfigured });
  });

  for (const format of FORMATS) {
    router.get(`/api/songs/:id/video/${format}.mp4`, (req, res) => {
      if (!videos) return notConfigured(res);
      const project = store.getProject(ownerOf(req), req.params.id);
      if (!project) return res.status(404).json({ error: 'not_found', id: req.params.id });
      if (videos.status(req.params.id, format)?.state !== 'done') return res.status(404).json({ error: 'no_video', id: req.params.id, format });
      if (req.query.download === '1') res.attachment(`${project.title.replace(/[\\/:*?"<>|]+/gu, '_')} (music video${format.endsWith('-preview') ? ', preview' : ''}).mp4`);
      res.type('video/mp4');
      return res.sendFile(videos.mp4Path(req.params.id, format));
    });
  }

  return router;
}
