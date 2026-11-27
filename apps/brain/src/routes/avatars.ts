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
//
// AvatarJson: { id, name, recipe, singerId, portraitUrl, createdAt, updatedAt }. Without BRAIN_AVATAR_PACKS_DIR or
// BRAIN_SINGERS_DATA_DIR every route answers 503 naming the setting.

import { Router, type Request, type Response } from 'express';

import { AvatarRecipeSchema, checkRecipe } from '@casperaki/video/avatar';
import { z } from 'zod';

import type { AvatarPacks } from '../avatars/avatarPacks.js';
import { MAX_PORTRAIT_BYTES, type UserAvatar, type UserAvatars } from '../avatars/userAvatars.js';
import { ownerOf } from './songs.js';

export interface AvatarsRouterDeps {
  readonly packs?: AvatarPacks;
  readonly avatars?: UserAvatars;
  /** Throws for a singer the owner cannot sing with (routes/singers.ts singerVoice). */
  readonly checkSinger: (ownerId: string, singerId: string) => void;
  readonly now?: () => string;
}

const BodySchema = z
  .object({
    name: z.string().trim().min(1, 'give the avatar a name').max(60),
    recipe: z.unknown(),
    singerId: z.string().min(1).nullable(),
    portrait: z.string().regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/u, 'the portrait must be a PNG data URL'),
  })
  .strict();

function avatarJson(a: UserAvatar) {
  return { ...a, portraitUrl: `/api/avatars/${a.id}/portrait?v=${encodeURIComponent(a.updatedAt)}` };
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
    const file = deps.packs!.file(params[0]!, decodeURIComponent(params[1]!));
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
      avatar = deps.avatars!.save(owner, { name, recipe, singerId }, png, now(), id);
    } catch (err) {
      if ((err as Error).message.startsWith('avatars: the portrait')) return res.status(400).json({ error: 'invalid_portrait', message: 'The portrait is not a PNG.' });
      throw err;
    }
    return res.status(id ? 200 : 201).json({ avatar: avatarJson(avatar) });
  };

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
