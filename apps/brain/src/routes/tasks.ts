// Background tasks on the owner's songs (src/tasks/tasks.ts).
//
//   GET  /api/tasks                -> { tasks: TaskJson[] }  unfinished tasks and those finished in the last day
//   POST /api/tasks { kind, songId, song } -> 201 { task }   song = the editor's working copy
//   POST /api/tasks/:id/apply      -> { task, songId, result } a ready result saved into the song (its new id);
//                                     result: what the task made (writeLyrics: section → lines)
//   POST /api/tasks/:id/retry      -> { task }                a failed task started again
//
// TaskJson: { id, kind, songId, title, state, message?, startedAt, finishedAt? }.

import { Router, type Response } from 'express';
import { z } from 'zod';

import { parseSong } from '@casperaki/song-schema';

import type { TaskRow } from '../store.js';
import type { SongsStore } from '../store.js';
import { TaskError, type BackgroundTasks } from '../tasks/tasks.js';
import { ownerOf } from './songs.js';

const KEEP_MS = 24 * 3600_000;

const StartBody = z.object({ kind: z.literal('writeLyrics'), songId: z.string().min(1), song: z.unknown() }).strict();

export function taskJson(t: TaskRow, title: string) {
  return {
    id: t.id,
    kind: t.kind,
    songId: t.songId,
    title,
    state: t.state,
    ...(t.message !== null ? { message: t.message } : {}),
    startedAt: t.startedAt,
    ...(t.finishedAt !== null ? { finishedAt: t.finishedAt } : {}),
  };
}

export function createTasksRouter({ store, tasks, now }: { store: SongsStore; tasks: BackgroundTasks; now: () => Date }): Router {
  const router = Router();
  const titled = (owner: string, t: TaskRow) => taskJson(t, store.getProject(owner, t.songId)?.title ?? '');

  router.get('/api/tasks', (req, res) => {
    const owner = ownerOf(req);
    const since = new Date(now().getTime() - KEEP_MS).toISOString();
    res.json({ tasks: store.listTasks(owner, since).map((t) => taskJson(t, t.title)) });
  });

  router.post('/api/tasks', (req, res) => {
    const body = StartBody.safeParse(req.body);
    if (!body.success) {
      const issue = body.error.issues[0];
      return res.status(400).json({ error: 'invalid_body', message: issue ? `${issue.path.join('.')}: ${issue.message}` : 'invalid body' });
    }
    let song;
    try {
      song = parseSong(body.data.song);
    } catch (err) {
      return res.status(400).json({ error: 'invalid_song', message: err instanceof Error ? err.message : String(err) });
    }
    const owner = ownerOf(req);
    return answer(res, () => res.status(201).json({ task: titled(owner, tasks.start(owner, body.data.songId, body.data.kind, song)) }));
  });

  router.post('/api/tasks/:id/apply', (req, res) => {
    const owner = ownerOf(req);
    return answer(res, () => {
      const { task, songId } = tasks.apply(owner, req.params.id);
      return res.json({ task: titled(owner, task), songId, result: task.result });
    });
  });

  router.post('/api/tasks/:id/retry', (req, res) => {
    const owner = ownerOf(req);
    return answer(res, () => res.json({ task: titled(owner, tasks.retry(owner, req.params.id)) }));
  });

  return router;
}

/** Runs a handler, answering a TaskError with its status (anything else is a bug and is thrown). */
function answer(res: Response, handler: () => unknown) {
  try {
    return handler();
  } catch (err) {
    if (err instanceof TaskError) return res.status(err.status).json({ error: err.code, message: err.message });
    throw err;
  }
}
