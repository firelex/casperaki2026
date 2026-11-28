// Avatars (docs/superpowers/specs/2026-11-27-avatars-design.md): the part packs they are dressed from and the
// user's own avatars, each a recipe with an optional voice (one of the user's singers).
//
//   GET    /api/avatar-packs                -> { packs: [{ name, title, thumbnailUrl, manifest }] }
//   GET    /api/avatar-packs/:pack/<path>   -> a pack file (VRM, PNG)
//   GET    /api/avatars                     -> { avatars: AvatarJson[] }
//   POST   /api/avatars                     body { name, recipe, singerId: string | null, portrait: PNG data URL }
//                                           -> 201 { avatar }   (400 for a bad recipe, unknown singer or portrait)
//   PUT    /api/avatars/:id                 same body -> { avatar }
//   DELETE /api/avatars/:id                 -> { deleted: id }
//   GET    /api/avatars/:id/portrait        -> the portrait (PNG)
//   GET    /api/avatars/:id/vrm             -> a realistic avatar's built person (VRM)
//
// Realistic avatars (docs/superpowers/specs/2026-11-28-realistic-avatars-design.md; admins only, 403 admin_only):
//   GET    /api/avatars/realistic/library             -> { library } (the curated assets, no file paths)
//   POST   /api/avatars/realistic/builds              body { design } -> 202 { task } (kind avatarBuild)
//   GET    /api/avatars/realistic/builds/:taskId/vrm  -> the built person of a finished build
//   POST   /api/avatars/realistic                     body { name, singerId, buildTaskId, portrait } -> 201 { avatar }
//   PUT    /api/avatars/realistic/:id                 same body -> { avatar }
//
// AvatarJson: { id, style, name, recipe | design, singerId, portraitUrl, vrmUrl (realistic), createdAt, updatedAt }.
// Without BRAIN_AVATAR_PACKS_DIR or BRAIN_SINGERS_DATA_DIR every route answers 503 naming the setting; realistic
// routes also need the avatar builder (AVATAR_BUILDER_URL, AVATAR_LIBRARY_FILE).

import { existsSync } from 'node:fs';

import { Router, type Request, type Response } from 'express';

import { AvatarRecipeSchema, checkRecipe } from '@casperaki/video/avatar';
import { z } from 'zod';

import type { AvatarPacks } from '../avatars/avatarPacks.js';
import { builtVrm, type AvatarBuildResult } from '../avatars/avatarBuildTask.js';
import { publicLibrary, type RealisticDesign, type RealisticLibrary } from '../avatars/realisticDesign.js';
import { AVATAR_BUILD_NOT_SET_UP, TaskError, type BackgroundTasks } from '../tasks/tasks.js';
import type { TaskRow } from '../store.js';
import { taskJson } from './tasks.js';
import { MAX_PORTRAIT_BYTES, type UserAvatar, type UserAvatars } from '../avatars/userAvatars.js';
import { ownerOf } from './songs.js';

export interface AvatarsRouterDeps {
  readonly packs?: AvatarPacks;
  readonly avatars?: UserAvatars;
  /** Throws for a singer the owner cannot sing with (routes/singers.ts singerVoice). */
  readonly checkSinger: (ownerId: string, singerId: string) => void;
  readonly now?: () => string;
  /** Whether the request is an admin's (realistic avatars are admins only for now). */
  readonly isAdminRequest: (req: Request) => boolean;
  /** Realistic avatars: the curated library, the tasks that build them and where builds keep their files. */
  readonly realistic?: {
    readonly library: RealisticLibrary;
    readonly tasks: { startAvatarBuild: BackgroundTasks['startAvatarBuild']; get: (ownerId: string, id: string) => TaskRow | undefined };
    readonly buildsDir: string;
  };
}

const RealisticBodySchema = z
  .object({
    name: z.string().trim().min(1, 'give the avatar a name').max(60),
    singerId: z.string().min(1).nullable(),
    buildTaskId: z.string().uuid('buildTaskId is a build task id'),
    portrait: z.string().regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/u, 'the portrait must be a PNG data URL'),
  })
  .strict();

const BodySchema = z
  .object({
    name: z.string().trim().min(1, 'give the avatar a name').max(60),
    recipe: z.unknown(),
    singerId: z.string().min(1).nullable(),
    portrait: z.string().regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/u, 'the portrait must be a PNG data URL'),
  })
  .strict();

function avatarJson(a: UserAvatar) {
  const v = encodeURIComponent(a.updatedAt);
  return { ...a, portraitUrl: `/api/avatars/${a.id}/portrait?v=${v}`, ...(a.style === 'realistic' ? { vrmUrl: `/api/avatars/${a.id}/vrm?v=${v}` } : {}) };
}

export function createAvatarsRouter(deps: AvatarsRouterDeps): Router {
  const router = Router();
  const now = deps.now ?? (() => new Date().toISOString());

  const notSetUp = (res: Response) => {
    const missing = [!deps.packs && 'BRAIN_AVATAR_PACKS_DIR', !deps.avatars && 'BRAIN_SINGERS_DATA_DIR'].filter(Boolean).join(' and ');
    if (!missing) return false;
    res.status(503).json({ error: 'not_configured', message: `Avatars are not set up: ${missing} is not set.` });
    return true;
  };

  router.get('/api/avatar-packs', (_req, res) => {
    if (notSetUp(res)) return;
    res.json({ packs: deps.packs!.list().map((p) => ({ name: p.name, title: p.title, thumbnailUrl: `/api/avatar-packs/${p.name}/${p.thumbnail}`, manifest: p.raw })) });
  });

  router.get(/^\/api\/avatar-packs\/([a-z0-9_-]+)\/(.+)$/u, (req, res) => {
    if (notSetUp(res)) return;
    const params = req.params as unknown as Record<string, string>;
    // Express has already decoded the path.
    const file = deps.packs!.file(params[0]!, params[1]!);
    if (!file) return res.status(404).json({ error: 'not_found', message: `There is no file ${params[1]} in the avatar pack "${params[0]}".` });
    res.setHeader('cache-control', 'private, max-age=86400');
    return res.sendFile(file);
  });

  router.get('/api/avatars', (req, res) => {
    if (notSetUp(res)) return;
    res.json({ avatars: deps.avatars!.list(ownerOf(req)).map(avatarJson) });
  });

  const save = (req: Request, res: Response, id?: string) => {
    if (notSetUp(res)) return;
    const owner = ownerOf(req);
    const body = BodySchema.safeParse(req.body);
    if (!body.success) {
      const i = body.error.issues[0]!;
      return res.status(400).json({ error: 'invalid_body', message: `${i.path.join('.') || 'body'}: ${i.message}` });
    }
    const { name, singerId, portrait } = body.data;
    // The video engine's schema (its own zod version).
    const parsedRecipe = AvatarRecipeSchema.safeParse(body.data.recipe);
    if (!parsedRecipe.success) {
      const i = parsedRecipe.error.issues[0]!;
      return res.status(400).json({ error: 'invalid_recipe', message: `recipe.${i.path.join('.')}: ${i.message}` });
    }
    const recipe = parsedRecipe.data;
    const pack = deps.packs!.get(recipe.pack);
    if (!pack) return res.status(400).json({ error: 'invalid_recipe', message: `There is no avatar pack "${recipe.pack}".` });
    try {
      checkRecipe(recipe, pack.manifest);
    } catch (err) {
      return res.status(400).json({ error: 'invalid_recipe', message: (err as Error).message });
    }
    if (singerId !== null) {
      try {
        deps.checkSinger(owner, singerId);
      } catch (err) {
        return res.status(400).json({ error: 'unknown_singer', message: (err as Error).message });
      }
    }
    const png = Buffer.from(portrait.slice(portrait.indexOf(',') + 1), 'base64');
    if (png.length > MAX_PORTRAIT_BYTES) return res.status(400).json({ error: 'invalid_portrait', message: 'The portrait is larger than 2 MB.' });
    if (id && !deps.avatars!.get(owner, id)) return res.status(404).json({ error: 'not_found', message: `You have no avatar "${id}".` });
    let avatar: UserAvatar;
    try {
      if (id && deps.avatars!.get(owner, id)?.style !== 'anime') return res.status(400).json({ error: 'wrong_style', message: 'That avatar is realistic: change it in the realistic dressing room.' });
      avatar = deps.avatars!.save(owner, { style: 'anime', name, recipe, singerId }, png, now(), id);
    } catch (err) {
      if ((err as Error).message.startsWith('avatars: the portrait')) return res.status(400).json({ error: 'invalid_portrait', message: 'The portrait is not a PNG.' });
      throw err;
    }
    return res.status(id ? 200 : 201).json({ avatar: avatarJson(avatar) });
  };

  // ---- realistic avatars (admins only)
  const realisticReady = (req: Request, res: Response) => {
    if (!deps.isAdminRequest(req)) {
      res.status(403).json({ error: 'admin_only', message: 'Realistic avatars are limited to admins for now.' });
      return false;
    }
    if (notSetUp(res)) return false;
    if (!deps.realistic) {
      res.status(503).json({ error: 'not_configured', message: AVATAR_BUILD_NOT_SET_UP });
      return false;
    }
    return true;
  };
  const taskAnswer = (res: Response, err: unknown) => {
    if (err instanceof TaskError) return res.status(err.status).json({ error: err.code, message: err.message });
    throw err;
  };
  /** The built person of the owner's finished build task, or an answer saying why there is none. */
  const finishedBuild = (owner: string, taskId: string, res: Response): string | undefined => {
    const task = deps.realistic!.tasks.get(owner, taskId);
    if (!task || task.kind !== 'avatarBuild') {
      res.status(404).json({ error: 'not_found', message: `You have no avatar build "${taskId}".` });
      return undefined;
    }
    if (task.state !== 'done') {
      res.status(400).json({ error: 'build_not_done', message: `The build has not finished (it is ${task.state}).` });
      return undefined;
    }
    const file = builtVrm(deps.realistic!.buildsDir, taskId);
    if (!existsSync(file)) {
      res.status(410).json({ error: 'build_gone', message: 'The build is gone (builds are kept for a day): press Update again.' });
      return undefined;
    }
    return file;
  };

  router.get('/api/avatars/realistic/library', (req, res) => {
    if (!realisticReady(req, res)) return;
    res.json({ library: publicLibrary(deps.realistic!.library) });
  });

  router.post('/api/avatars/realistic/builds', (req, res) => {
    if (!realisticReady(req, res)) return;
    const design = (req.body as { design?: unknown } | undefined)?.design;
    try {
      const task = deps.realistic!.tasks.startAvatarBuild(ownerOf(req), design);
      return res.status(202).json({ task: taskJson(task, '') });
    } catch (err) {
      return taskAnswer(res, err);
    }
  });

  router.get('/api/avatars/realistic/builds/:taskId/vrm', (req, res) => {
    if (!realisticReady(req, res)) return;
    const file = finishedBuild(ownerOf(req), req.params.taskId, res);
    if (!file) return;
    res.setHeader('cache-control', 'private, max-age=3600');
    return res.sendFile(file);
  });

  const saveRealistic = (req: Request, res: Response, id?: string) => {
    if (!realisticReady(req, res)) return;
    const owner = ownerOf(req);
    const body = RealisticBodySchema.safeParse(req.body);
    if (!body.success) {
      const i = body.error.issues[0]!;
      return res.status(400).json({ error: 'invalid_body', message: `${i.path.join('.') || 'body'}: ${i.message}` });
    }
    const { name, singerId, buildTaskId, portrait } = body.data;
    if (id && deps.avatars!.get(owner, id)?.style !== 'realistic') return res.status(404).json({ error: 'not_found', message: `You have no realistic avatar "${id}".` });
    const file = finishedBuild(owner, buildTaskId, res);
    if (!file) return;
    if (singerId !== null) {
      try {
        deps.checkSinger(owner, singerId);
      } catch (err) {
        return res.status(400).json({ error: 'unknown_singer', message: (err as Error).message });
      }
    }
    const built = deps.realistic!.tasks.get(owner, buildTaskId)!;
    const design = (built.options as { design: RealisticDesign }).design;
    const credits = (built.result as AvatarBuildResult).credits.filter((c) => c.licence === 'CC-BY');
    const png = Buffer.from(portrait.slice(portrait.indexOf(',') + 1), 'base64');
    if (png.length > MAX_PORTRAIT_BYTES) return res.status(400).json({ error: 'invalid_portrait', message: 'The portrait is larger than 2 MB.' });
    let avatar: UserAvatar;
    try {
      avatar = deps.avatars!.saveRealistic(owner, { name, design, credits, singerId }, file, png, now(), id);
    } catch (err) {
      if ((err as Error).message.startsWith('avatars: the portrait')) return res.status(400).json({ error: 'invalid_portrait', message: 'The portrait is not a PNG.' });
      throw err;
    }
    return res.status(id ? 200 : 201).json({ avatar: avatarJson(avatar) });
  };
  router.post('/api/avatars/realistic', (req, res) => saveRealistic(req, res));
  router.put('/api/avatars/realistic/:id', (req, res) => saveRealistic(req, res, String(req.params.id)));

  router.get('/api/avatars/:id/vrm', (req, res) => {
    if (notSetUp(res)) return;
    const owner = ownerOf(req);
    const a = /^a-[0-9a-f]{12}$/u.test(req.params.id) ? deps.avatars!.get(owner, req.params.id) : undefined;
    if (!a || a.style !== 'realistic') return res.status(404).json({ error: 'not_found', message: `You have no realistic avatar "${req.params.id}".` });
    res.setHeader('cache-control', 'private, max-age=86400');
    return res.sendFile(deps.avatars!.vrmPath(owner, a.id));
  });

  // Bodies are parsed by the app's JSON parser (bootstrap.ts, 16 MB).
  router.post('/api/avatars', (req, res) => save(req, res));
  router.put('/api/avatars/:id', (req, res) => save(req, res, String(req.params.id)));

  router.delete('/api/avatars/:id', (req, res) => {
    if (notSetUp(res)) return;
    if (!/^a-[0-9a-f]{12}$/u.test(req.params.id) || !deps.avatars!.remove(ownerOf(req), req.params.id)) {
      return res.status(404).json({ error: 'not_found', message: `You have no avatar "${req.params.id}".` });
    }
    return res.json({ deleted: req.params.id });
  });

  router.get('/api/avatars/:id/portrait', (req, res) => {
    if (notSetUp(res)) return;
    const owner = ownerOf(req);
    if (!/^a-[0-9a-f]{12}$/u.test(req.params.id) || !deps.avatars!.get(owner, req.params.id)) {
      return res.status(404).json({ error: 'not_found', message: `You have no avatar "${req.params.id}".` });
    }
    res.setHeader('cache-control', 'private, max-age=86400');
    return res.sendFile(deps.avatars!.portraitPath(owner, req.params.id));
  });

  return router;
}
