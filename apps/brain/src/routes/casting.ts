// Casting videos (docs/superpowers/specs/2026-11-28-video-modes-casting-design.md), admins only while the speech model
// is non-commercial:
//   POST /api/songs/:id/casting/script  { avatarId, outcome: 'fourYes' | 'threeOne' | 'notThisTime' } → 202 { task }
//                                        (kind castingScript; 400 naming a missing precondition, 409 while one runs)
//   GET  /api/songs/:id/casting/script  → { script, taskId } (the latest finished one; 404 none)

import { Router, type Request, type Response } from 'express';

import type { SongsStore } from '../store.js';
import { TaskError, type BackgroundTasks } from '../tasks/tasks.js';
import { taskJson } from './tasks.js';

export interface CastingRouterDeps {
  readonly store: SongsStore;
  readonly tasks: Pick<BackgroundTasks, 'startCastingScript'>;
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

  router.get('/api/songs/:id/casting/script', (req, res) => {
    if (!admin(req, res)) return;
    const owner = deps.ownerOf(req);
    const latest = deps.store
      .listTasks(owner, '')
      .filter((t) => t.kind === 'castingScript' && t.songId === req.params.id && t.state === 'done')
      .sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''))[0];
    if (!latest) return res.status(404).json({ error: 'not_found', message: 'No casting script has been written for this song yet.' });
    return res.json({ script: latest.result, taskId: latest.id });
  });

  return router;
}
