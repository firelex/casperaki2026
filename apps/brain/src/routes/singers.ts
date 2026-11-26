// The singers Sing can sing with (the vocals service's voices: apps/models/services/vocals/voices/singers.json, each
// a voice reference SoulX-Singer sings in, with the description of what is sung in it).
//
//   GET /api/singers                -> { singers: [{ id, name, description, source, previewUrl }] }
//   GET /api/singers/:id/preview    -> the singer's voice reference (audio)

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { Router } from 'express';
import { z } from 'zod';

const SingerSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9_-]+$/u),
    name: z.string().min(1),
    description: z.string().min(1),
    source: z.string().min(1),
    audio: z.string().regex(/^[\w.-]+$/u),
    meta: z.string().regex(/^[\w.-]+$/u),
  })
  .strict();
export type Singer = z.infer<typeof SingerSchema>;

/** The singers in `dir`/singers.json, every voice file present (an error naming what is missing). */
export function readSingers(dir: string): Singer[] {
  const file = join(resolve(dir), 'singers.json');
  if (!existsSync(file)) throw new Error(`singers: no list at ${file}`);
  const singers = z.array(SingerSchema).min(1).parse(JSON.parse(readFileSync(file, 'utf8')));
  for (const s of singers) {
    for (const f of [s.audio, s.meta]) {
      if (!existsSync(join(resolve(dir), f))) throw new Error(`singers: ${s.name} (${s.id}) names ${f}, which is not in ${dir}`);
    }
  }
  if (new Set(singers.map((s) => s.id)).size !== singers.length) throw new Error('singers: two singers share an id');
  return singers;
}

export function createSingersRouter(deps: { dir: string }): Router {
  const router = Router();
  router.get('/api/singers', (_req, res) => {
    const singers = readSingers(deps.dir);
    res.json({ singers: singers.map((s) => ({ id: s.id, name: s.name, description: s.description, source: s.source, previewUrl: `/api/singers/${s.id}/preview` })) });
  });
  router.get('/api/singers/:id/preview', (req, res) => {
    const singer = readSingers(deps.dir).find((s) => s.id === req.params.id);
    if (!singer) return res.status(404).json({ error: 'not_found', message: `There is no singer "${req.params.id}".` });
    res.setHeader('cache-control', 'private, max-age=3600');
    return res.sendFile(join(resolve(deps.dir), singer.audio));
  });
  return router;
}
