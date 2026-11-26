// The singers Sing can sing with: the built-in ones (the vocals service's voices:
// apps/models/services/vocals/voices/singers.json, each a voice reference SoulX-Singer sings in, with the description
// of what is sung in it), seen by everyone, and the ones a user added from their own recording
// (src/singers/userSingers.ts), seen only by that user.
//
//   GET    /api/singers               -> { singers: SingerJson[] }  the built-in singers, then the user's own
//   GET    /api/singers/:id/preview   -> the singer's voice reference (audio)
//   GET    /api/singers/:id/test-line -> the test line sung in an added singer's voice (audio)
//   POST   /api/singers?name=&description=&rightToUse=1&fullSong=0|1&reference=beginning|best&extension=
//          body: the recording (any format ffmpeg reads, at most 5 minutes)
//                                     -> 201 { task }  Add a singer (an addSinger task, src/singers/addSingerTask.ts);
//                                        400 without the consent box ticked, for a recording over 5 minutes or one
//                                        that is not audio; 503 when adding singers is not set up
//   DELETE /api/singers/:id           -> { deleted: id }  one of the user's own singers (a built-in one: 403)
//
// SingerJson: { id, name, description, source, previewUrl, own, testLineUrl?, reference?: { choice, startSeconds,
// endSeconds, recordingStartSeconds, recordingEndSeconds, seconds }, transcription? } (the last three for own singers).

import express, { Router, type Response } from 'express';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { z } from 'zod';

import { MAX_UPLOAD_BYTES } from '../singers/addSingerTask.js';
import { REFERENCE_CHOICES, type UserSinger, type UserSingers } from '../singers/userSingers.js';
import { TaskError, type BackgroundTasks } from '../tasks/tasks.js';
import { taskJson } from './tasks.js';
import { ownerOf } from './songs.js';

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
    if (s.id.startsWith('u-')) throw new Error(`singers: ${s.name} (${s.id}): ids starting "u-" are kept for the singers users add`);
  }
  if (new Set(singers.map((s) => s.id)).size !== singers.length) throw new Error('singers: two singers share an id');
  return singers;
}

/** A singer's voice reference and its description, as absolute paths: a built-in singer (`dir`) or one of the
 *  owner's own (`users`, when adding singers is set up). An Error for an unknown singer. */
export function singerVoice(dir: string, users: UserSingers | undefined, ownerId: string, id: string): { audio: string; meta: string } {
  const builtIn = readSingers(dir).find((s) => s.id === id);
  if (builtIn) return { audio: join(resolve(dir), builtIn.audio), meta: join(resolve(dir), builtIn.meta) };
  const own = users?.get(ownerId, id);
  if (own) return { audio: join(users!.dir(ownerId, id), own.audio), meta: join(users!.dir(ownerId, id), own.meta) };
  throw new Error(`There is no singer "${id}".`);
}

function ownJson(s: UserSinger) {
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    source: s.source,
    previewUrl: `/api/singers/${s.id}/preview`,
    own: true,
    testLineUrl: `/api/singers/${s.id}/test-line`,
    reference: s.reference,
    transcription: s.transcription,
  };
}

const StartQuery = z
  .object({
    name: z.string(),
    description: z.string(),
    rightToUse: z.enum(['0', '1']),
    fullSong: z.enum(['0', '1']),
    reference: z.enum(REFERENCE_CHOICES),
    extension: z.string().regex(/^[a-z0-9]{1,8}$/u),
  })
  .strict();

export interface SingersRouterDeps {
  /** The built-in singers' folder (BRAIN_SINGERS_DIR). */
  readonly dir: string;
  /** The users' singers (BRAIN_SINGERS_DATA_DIR), when adding singers is set up. */
  readonly users?: UserSingers;
  readonly tasks: BackgroundTasks;
}

export function createSingersRouter(deps: SingersRouterDeps): Router {
  const router = Router();
  const own = (owner: string) => deps.users?.list(owner) ?? [];

  router.get('/api/singers', (req, res) => {
    const builtIn = readSingers(deps.dir).map((s) => ({ id: s.id, name: s.name, description: s.description, source: s.source, previewUrl: `/api/singers/${s.id}/preview`, own: false }));
    res.json({ singers: [...builtIn, ...own(ownerOf(req)).map(ownJson)] });
  });

  router.get('/api/singers/:id/preview', (req, res) => {
    const owner = ownerOf(req);
    const builtIn = readSingers(deps.dir).find((s) => s.id === req.params.id);
    res.setHeader('cache-control', 'private, max-age=3600');
    if (builtIn) return res.sendFile(join(resolve(deps.dir), builtIn.audio));
    const mine = own(owner).find((s) => s.id === req.params.id);
    if (!mine) return res.status(404).json({ error: 'not_found', message: `There is no singer "${req.params.id}".` });
    return res.sendFile(join(deps.users!.dir(owner, mine.id), mine.audio));
  });

  router.get('/api/singers/:id/test-line', (req, res) => {
    const owner = ownerOf(req);
    const mine = own(owner).find((s) => s.id === req.params.id);
    if (!mine) return res.status(404).json({ error: 'not_found', message: `You have no added singer "${req.params.id}".` });
    res.setHeader('cache-control', 'private, max-age=3600');
    return res.sendFile(join(deps.users!.dir(owner, mine.id), mine.testLine));
  });

  router.post('/api/singers', express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES }), async (req, res) => {
    const q = StartQuery.safeParse(req.query);
    if (!q.success) {
      const issue = q.error.issues[0];
      return res.status(400).json({ error: 'invalid_query', message: issue ? `${issue.path.join('.')}: ${issue.message}` : 'invalid query' });
    }
    const recording = req.body as unknown;
    if (!Buffer.isBuffer(recording)) return res.status(400).json({ error: 'no_recording', message: 'Send the recording as the request body.' });
    return answer(res, async () => {
      const task = await deps.tasks.startAddSinger(ownerOf(req), {
        recording,
        extension: q.data.extension,
        name: q.data.name,
        description: q.data.description,
        rightToUse: q.data.rightToUse === '1',
        separate: q.data.fullSong === '1',
        reference: q.data.reference,
      });
      return res.status(201).json({ task: taskJson(task, '') });
    });
  });

  router.delete('/api/singers/:id', (req, res) => {
    const owner = ownerOf(req);
    if (readSingers(deps.dir).some((s) => s.id === req.params.id)) {
      return res.status(403).json({ error: 'built_in', message: 'The built-in singers cannot be deleted.' });
    }
    if (!deps.users?.remove(owner, req.params.id)) return res.status(404).json({ error: 'not_found', message: `You have no added singer "${req.params.id}".` });
    return res.json({ deleted: req.params.id });
  });

  return router;
}

/** Runs a handler, answering a TaskError with its status (anything else is a bug and is thrown). */
async function answer(res: Response, handler: () => Promise<unknown>) {
  try {
    return await handler();
  } catch (err) {
    if (err instanceof TaskError) return res.status(err.status).json({ error: err.code, message: err.message });
    throw err;
  }
}
