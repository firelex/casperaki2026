// Music videos for a song (owner-only, like the song routes):
//   POST /api/songs/:id/video { style?, orientation, quality?, artist, console? }  → 202 + status (409 while one is being made)
//        style 'cartoon' (default): planned by a language model. style 'console': a 3D mixing desk; `console` carries
//        the tracks the browser measured and the song version they belong to (409 song_changed for another version).
//        style 'avatars': the user's avatars on a 3D dance floor; `console` as for the console style (the lead vocal's
//        level drives the lead's lip sync) and `avatars: { avatarIds }` (1 to 5 of the user's avatars).
//   GET  /api/songs/:id/video                          → { jobs: { cartoon: {...}, console: {...}, avatars: {...} } }
//   GET  /api/songs/:id/video/<job>.mp4 (cartoon: landscape, portrait, landscape-preview, portrait-preview;
//        console: console-<format>; avatars: avatars-<format>) → the video (?download=1: as an attachment)

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import type { SongsStore } from '../store.js';
import { MissingPlannerConfigError } from '../video/planner.js';
import { parseConsoleBody, VideoInputError } from '../video/videoInput.js';
import { FORMATS, jobId, STYLES, VideoBusyError, type VideoFormat, type VideoService, type VideoStatus } from '../video/videoService.js';

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
    style: z.enum(['cartoon', 'console', 'avatars']).optional(),
    /** Console and avatars styles: the measured tracks, checked with the engine's schema (parseConsoleBody). */
    console: z.unknown().optional(),
    /** Avatars style only: which of the user's avatars dance, in order. */
    avatars: z.object({ avatarIds: z.array(z.string().min(1)) }).strict().optional(),
  })
  .strict()
  .refine((b) => (b.style === 'console' || b.style === 'avatars') === (b.console !== undefined), {
    message: 'measured tracks (console) go with the styles "console" and "avatars", and only with them',
    path: ['console'],
  })
  .refine((b) => (b.style === 'avatars') === (b.avatars !== undefined), {
    message: 'avatars go with style "avatars", and only with it',
    path: ['avatars'],
  });

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
    ...(s.state === 'done' ? { url: `/api/songs/${s.songId}/video/${jobId(s.style, s.format)}.mp4` } : {}),
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
    const style = body.data.style ?? 'cartoon';
    if (style === 'cartoon' && !plannerConfigured) return res.status(503).json({ error: 'planner_not_configured', message: new MissingPlannerConfigError().message });
    try {
      const format = (body.data.quality === 'preview' ? `${body.data.orientation}-preview` : body.data.orientation) as VideoFormat;
      const common = { ownerId: ownerOf(req), songId: req.params.id, format, title: project.title, artist: body.data.artist };
      const s =
        style === 'console'
          ? videos.start({ ...common, style, console: parseConsoleBody(body.data.console) })
          : style === 'avatars'
            ? videos.start({ ...common, style, console: parseConsoleBody(body.data.console), avatarIds: body.data.avatars!.avatarIds })
            : videos.start({ ...common, style });
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
    const jobs = { cartoon: {}, console: {}, avatars: {} } as Record<(typeof STYLES)[number], Partial<Record<VideoFormat, ReturnType<typeof statusJson>>>>;
    for (const style of STYLES)
      for (const o of FORMATS) {
        const s = videos.status(req.params.id, style, o);
        if (s) jobs[style][o] = statusJson(s);
      }
    return res.json({ jobs, plannerConfigured });
  });

  for (const style of STYLES)
    for (const format of FORMATS) {
      const job = jobId(style, format);
      router.get(`/api/songs/:id/video/${job}.mp4`, (req, res) => {
        if (!videos) return notConfigured(res);
        const project = store.getProject(ownerOf(req), req.params.id);
        if (!project) return res.status(404).json({ error: 'not_found', id: req.params.id });
        if (videos.status(req.params.id, style, format)?.state !== 'done') return res.status(404).json({ error: 'no_video', id: req.params.id, format: job });
        const kind = style === 'console' ? 'console video' : style === 'avatars' ? 'dance floor video' : 'music video';
        if (req.query.download === '1') res.attachment(`${project.title.replace(/[\\/:*?"<>|]+/gu, '_')} (${kind}${format.endsWith('-preview') ? ', preview' : ''}).mp4`);
        res.type('video/mp4');
        return res.sendFile(videos.mp4Path(req.params.id, style, format));
      });
    }

  return router;
}
