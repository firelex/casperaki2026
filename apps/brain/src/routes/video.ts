// Music videos for a song (owner-only, like the song routes): the 3D avatar video (the console and the 2D cartoon
// were removed, 2026-11-28).
//   POST /api/songs/:id/video { orientation, quality?, artist, levels, avatars: { avatarIds, storyboard? }, style? }
//        → 202 + status (409 while one is being made). `levels`: what the browser measured and the song version it
//        belongs to (409 song_changed for another version); `avatars`: 1 to 5 of the user's avatars, and the
//        storyboard per section { scene, avatarIds, camera } (docs/superpowers/specs/2026-11-27-avatar-scenes-storyboard-design.md).
//        `style`, when an old page sends it, must be 'avatars' (400 otherwise).
//   GET  /api/songs/:id/video                          → { jobs: { avatars: { <format>: status } } }
//   GET  /api/songs/:id/video/avatars-<format>.mp4     → the video (?download=1: as an attachment)

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import type { SongsStore } from '../store.js';
import { parseMeasuredLevels, VideoInputError } from '../video/videoInput.js';
import { FORMATS, jobId, VideoBusyError, type VideoFormat, type VideoService, type VideoStatus } from '../video/videoService.js';

export interface VideoRouterDeps {
  readonly store: SongsStore;
  /** Absent when rendering is not configured (no sample library): 503. */
  readonly videos: VideoService | undefined;
  readonly ownerOf: (req: Request) => string;
}

export const ONLY_AVATARS = 'Only the 3D avatar video is made now.';

const StartBody = z
  .object({
    orientation: z.enum(['landscape', 'portrait']),
    /** 'preview': half size, renders about 3x faster; kept beside the full video. */
    quality: z.enum(['full', 'preview']).optional(),
    artist: z.string().trim().min(1, 'the artist name is required').max(80),
    style: z.string().optional(),
    /** The measured levels, checked by parseMeasuredLevels. */
    levels: z.unknown(),
    /** Which of the user's avatars dance, in order. */
    avatars: z
      .object({
        avatarIds: z.array(z.string().min(1)),
        /** One entry per section of the saved song: scene, which of the avatars, camera (checked by the service). */
        storyboard: z.array(z.object({ scene: z.string().min(1), avatarIds: z.array(z.string().min(1)), camera: z.string().min(1) }).strict()).optional(),
      })
      .strict(),
  })
  .strict();

export function createVideoRouter({ store, videos, ownerOf }: VideoRouterDeps): Router {
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
    ...(s.state === 'done' ? { url: `/api/songs/${s.songId}/video/${jobId(s.format)}.mp4` } : {}),
  });

  router.post('/api/songs/:id/video', (req, res) => {
    if (!videos) return notConfigured(res);
    const project = store.getProject(ownerOf(req), req.params.id);
    if (!project) return res.status(404).json({ error: 'not_found', id: req.params.id });
    const style = (req.body as { style?: unknown } | undefined)?.style;
    if (style !== undefined && style !== 'avatars') return res.status(400).json({ error: 'invalid_body', message: ONLY_AVATARS });
    const body = StartBody.safeParse(req.body);
    if (!body.success) {
      const issue = body.error.issues[0];
      return res.status(400).json({ error: 'invalid_body', message: issue ? `${issue.path.join('.')}: ${issue.message}` : 'invalid body' });
    }
    try {
      const format = (body.data.quality === 'preview' ? `${body.data.orientation}-preview` : body.data.orientation) as VideoFormat;
      const s = videos.start({
        ownerId: ownerOf(req),
        songId: req.params.id,
        format,
        title: project.title,
        artist: body.data.artist,
        levels: parseMeasuredLevels(body.data.levels),
        avatarIds: body.data.avatars.avatarIds,
        ...(body.data.avatars.storyboard ? { storyboard: body.data.avatars.storyboard } : {}),
      });
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
    const avatars: Partial<Record<VideoFormat, ReturnType<typeof statusJson>>> = {};
    for (const f of FORMATS) {
      const s = videos.status(req.params.id, f);
      if (s) avatars[f] = statusJson(s);
    }
    return res.json({ jobs: { avatars } });
  });

  for (const format of FORMATS) {
    const job = jobId(format);
    router.get(`/api/songs/:id/video/${job}.mp4`, (req, res) => {
      if (!videos) return notConfigured(res);
      const project = store.getProject(ownerOf(req), req.params.id);
      if (!project) return res.status(404).json({ error: 'not_found', id: req.params.id });
      if (videos.status(req.params.id, format)?.state !== 'done') return res.status(404).json({ error: 'no_video', id: req.params.id, format: job });
      if (req.query.download === '1') res.attachment(`${project.title.replace(/[\\/:*?"<>|]+/gu, '_')} (music video${format.endsWith('-preview') ? ', preview' : ''}).mp4`);
      res.type('video/mp4');
      return res.sendFile(videos.mp4Path(req.params.id, format));
    });
  }

  return router;
}
