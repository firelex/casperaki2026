// Casting videos (docs/superpowers/specs/2026-11-28-video-modes-casting-design.md), admins only while the speech model
// is non-commercial:
//   POST /api/songs/:id/casting/script  { avatarId, outcome: 'fourYes' | 'threeOne' | 'notThisTime' } → 202 { task }
//                                        (kind castingScript; 400 naming a missing precondition, 409 while one runs)
//   GET  /api/songs/:id/casting/script  → { script, taskId } (the latest finished one; 404 none)
//   POST /api/songs/:id/casting/soundtrack → 202 { task } (kind castingSoundtrack, from the latest script)
//   GET  /api/songs/:id/casting/soundtrack.wav → the latest finished soundtrack (404 none)
//   GET  /api/songs/:id/casting/timeline → { timeline, taskId } (the latest finished soundtrack's)

import { Router, type Request, type Response } from 'express';

import type { SongsStore } from '../store.js';
import { TaskError, type BackgroundTasks } from '../tasks/tasks.js';
import { taskJson } from './tasks.js';

export interface CastingRouterDeps {
  readonly store: SongsStore;
  readonly tasks: Pick<BackgroundTasks, 'startCastingScript' | 'startCastingSoundtrack' | 'stepFile'>;
  readonly isAdminRequest: (req: Request) => boolean;
  readonly ownerOf: (req: Request) => string;
}

export function createCastingRouter(deps: CastingRouterDeps): Router {
  const router = Router();
  const admin = (req: Request, res: Response) => {
    if (deps.isAdminRequest(req)) return true;
    res.status(403).json({ error: 'admin_only', message: 'Casting videos are limited to admins for now.' });
    return false;
  };

  router.post('/api/songs/:id/casting/script', (req, res) => {
    if (!admin(req, res)) return;
    const body = (req.body ?? {}) as { avatarId?: unknown; outcome?: unknown };
    try {
      const task = deps.tasks.startCastingScript(deps.ownerOf(req), req.params.id, { avatarId: body.avatarId, outcome: body.outcome });
      return res.status(202).json({ task: taskJson(task, '') });
    } catch (err) {
      if (err instanceof TaskError) return res.status(err.status).json({ error: err.code, message: err.message });
      throw err;
    }
  });

  const latest = (owner: string, songId: string, kind: 'castingScript' | 'castingSoundtrack') =>
    deps.store
      .listTasks(owner, '')
      .filter((t) => t.kind === kind && t.songId === songId && t.state === 'done')
      .sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''))[0];

  router.post('/api/songs/:id/casting/soundtrack', (req, res) => {
    if (!admin(req, res)) return;
    try {
      const task = deps.tasks.startCastingSoundtrack(deps.ownerOf(req), req.params.id);
      return res.status(202).json({ task: taskJson(task, '') });
    } catch (err) {
      if (err instanceof TaskError) return res.status(err.status).json({ error: err.code, message: err.message });
      throw err;
    }
  });

  router.get('/api/songs/:id/casting/soundtrack.wav', (req, res) => {
    if (!admin(req, res)) return;
    const owner = deps.ownerOf(req);
    const t = latest(owner, req.params.id, 'castingSoundtrack');
    if (!t) return res.status(404).json({ error: 'not_found', message: 'No casting soundtrack has been made for this song yet.' });
    return res.sendFile(deps.tasks.stepFile(owner, t.id, 'soundtrack', 'casting.wav'));
  });

  router.get('/api/songs/:id/casting/timeline', (req, res) => {
    if (!admin(req, res)) return;
    const t = latest(deps.ownerOf(req), req.params.id, 'castingSoundtrack');
    if (!t) return res.status(404).json({ error: 'not_found', message: 'No casting soundtrack has been made for this song yet.' });
    return res.json({ timeline: t.result, taskId: t.id });
  });

  router.get('/api/songs/:id/casting/script', (req, res) => {
    if (!admin(req, res)) return;
    const done = latest(deps.ownerOf(req), req.params.id, 'castingScript');
    if (!done) return res.status(404).json({ error: 'not_found', message: 'No casting script has been written for this song yet.' });
    return res.json({ script: done.result, taskId: done.id });
  });

  return router;
}
