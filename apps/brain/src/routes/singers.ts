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
//   GET    /api/singers/:id/speaking-sample -> the singer's speaking voice saying its test line (WAV)
//   GET    /api/singers/:id/speaking-candidates/:seed -> one of its candidate speaking voices (WAV)
//   POST   /api/singers/:id/speaking-voice {description?} -> 202 { task }  make the singer's speaking voice (a
//                                        speakingVoice task, src/singers/speakingVoiceTask.ts): described from the
//                                        singing and matched, or the user's description used as is; 400 blank
//                                        description, 404 unknown singer, 409 one is being made, 503 not set up
//   POST   /api/singers/:id/speaking-voice/choose {seed} -> { speaking }  another candidate as its voice
//   DELETE /api/singers/:id           -> { deleted: id }  one of the user's own singers, or a built-in one for this
//                                        user only (its files stay; 503 when adding singers is not set up)
//
// SingerJson: { id, name, description, source, previewUrl, own, speaking: SpeakingJson | null, testLineUrl?, reference?: { choice, startSeconds,
// endSeconds, recordingStartSeconds, recordingEndSeconds, seconds }, transcription? } (the last three for own singers).

import express, { Router, type Request, type Response } from 'express';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { z } from 'zod';

import { MAX_UPLOAD_BYTES } from '../singers/addSingerTask.js';
import type { SpeakingVoice, SpeakingVoices } from '../singers/speakingVoice.js';
import type { SpeakingSinger } from '../singers/speakingVoiceTask.js';
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

/** A singer of the owner's for making a speaking voice (src/singers/speakingVoiceTask.ts): a built-in one or the
 *  owner's own. An Error for an unknown singer. */
export function speakingSinger(dir: string, users: UserSingers | undefined, ownerId: string, id: string): SpeakingSinger {
  const builtIn = readSingers(dir).find((s) => s.id === id && !users?.hiddenBuiltIns(ownerId).has(id));
  // A built-in singer the owner renamed speaks under that name (casting); one never renamed keeps its own.
  if (builtIn) return { id, name: users?.builtInNames(ownerId)[id] ?? builtIn.name, description: builtIn.description, audio: join(resolve(dir), builtIn.audio), meta: join(resolve(dir), builtIn.meta), builtIn: true };
  const own = users?.get(ownerId, id);
  if (own) return { id, name: own.name, description: own.description, audio: join(users!.dir(ownerId, id), own.audio), meta: join(users!.dir(ownerId, id), own.meta), builtIn: false };
  throw new Error(`There is no singer "${id}".`);
}

/** A singer's voice reference and its description, as absolute paths: a built-in singer (`dir`) or one of the
 *  owner's own (`users`, when adding singers is set up). An Error for an unknown singer. */
export function singerVoice(dir: string, users: UserSingers | undefined, ownerId: string, id: string): { audio: string; meta: string } {
  const builtIn = readSingers(dir).find((s) => s.id === id && !users?.hiddenBuiltIns(ownerId).has(id));
  if (builtIn) return { audio: join(resolve(dir), builtIn.audio), meta: join(resolve(dir), builtIn.meta) };
  const own = users?.get(ownerId, id);
  if (own) return { audio: join(users!.dir(ownerId, id), own.audio), meta: join(users!.dir(ownerId, id), own.meta) };
  throw new Error(`There is no singer "${id}".`);
}

/** A singer's speaking voice as pages see it. */
function speakingJson(voice: SpeakingVoice | undefined, id: string) {
  if (!voice) return null;
  const v = encodeURIComponent(voice.createdAt + voice.seed);
  return {
    description: voice.description,
    madeBy: voice.madeBy,
    seed: voice.seed,
    sampleUrl: `/api/singers/${id}/speaking-sample?v=${v}`,
    candidates: voice.candidates.map((c) => ({ ...c, url: `/api/singers/${id}/speaking-candidates/${c.seed}?v=${v}` })),
  };
}

/** A file's address with its version (its last change): a file made again gets a new address, so a browser does not
 *  keep playing its copy of the old one (owner 2026-11-28: test lines sung again still sounded cut off). */
const versioned = (url: string, file: string) => `${url}?v=${Math.round(statSync(file).mtimeMs)}`;

function ownJson(s: UserSinger, dir: string) {
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    source: s.source,
    previewUrl: versioned(`/api/singers/${s.id}/preview`, join(dir, s.audio)),
    own: true,
    testLineUrl: versioned(`/api/singers/${s.id}/test-line`, join(dir, s.testLine)),
    reference: s.reference,
    transcription: s.transcription,
  };
}

const RenameBody = z.object({ name: z.string().trim().min(1).max(60) }).strict();

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
  /** The singers' speaking voices (kept in BRAIN_SINGERS_DATA_DIR), when that is set. */
  readonly voices?: SpeakingVoices;
}

export function createSingersRouter(deps: SingersRouterDeps): Router {
  const router = Router();
  const own = (owner: string) => deps.users?.list(owner) ?? [];
  /** The built-in singers the owner has not deleted, under the names the owner gave them. */
  const builtIns = (owner: string) => {
    const hidden = deps.users?.hiddenBuiltIns(owner) ?? new Set<string>();
    const names = deps.users?.builtInNames(owner) ?? {};
    return readSingers(deps.dir)
      .filter((s) => !hidden.has(s.id))
      .map((s) => (names[s.id] ? { ...s, name: names[s.id]! } : s));
  };

  router.get('/api/singers', (req, res) => {
    const owner = ownerOf(req);
    const speaking = (id: string, builtIn: boolean) => speakingJson(deps.voices?.get(owner, id, builtIn), id);
    const builtIn = builtIns(owner).map((s) => ({ id: s.id, name: s.name, description: s.description, source: s.source, previewUrl: `/api/singers/${s.id}/preview`, own: false, speaking: speaking(s.id, true) }));
    res.json({ singers: [...builtIn, ...own(owner).map((s) => ({ ...ownJson(s, deps.users!.dir(owner, s.id)), speaking: speaking(s.id, false) }))] });
  });

  router.get('/api/singers/:id/preview', (req, res) => {
    const owner = ownerOf(req);
    const builtIn = builtIns(owner).find((s) => s.id === req.params.id);
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

  /** The owner's singer (built-in or own) for its speaking voice, or a 404 answered. */
  const speakingOf = (req: Request, res: Response): { owner: string; builtIn: boolean } | undefined => {
    const owner = ownerOf(req);
    if (builtIns(owner).some((s) => s.id === req.params.id)) return { owner, builtIn: true };
    if (own(owner).some((s) => s.id === req.params.id)) return { owner, builtIn: false };
    res.status(404).json({ error: 'not_found', message: `There is no singer "${req.params.id}".` });
    return undefined;
  };

  router.get('/api/singers/:id/speaking-sample', (req, res) => {
    const s = speakingOf(req, res);
    if (!s) return;
    if (!deps.voices?.get(s.owner, req.params.id, s.builtIn)) return res.status(404).json({ error: 'not_found', message: 'The singer has no speaking voice yet.' });
    res.setHeader('cache-control', 'private, max-age=3600');
    return res.sendFile(deps.voices.samplePath(s.owner, req.params.id, s.builtIn));
  });

  router.get('/api/singers/:id/speaking-candidates/:seed', (req, res) => {
    const s = speakingOf(req, res);
    if (!s) return;
    const voice = deps.voices?.get(s.owner, req.params.id, s.builtIn);
    const seed = Number(req.params.seed);
    if (!voice || !voice.candidates.some((c) => c.seed === seed)) return res.status(404).json({ error: 'not_found', message: `The singer has no candidate voice ${req.params.seed}.` });
    res.setHeader('cache-control', 'private, max-age=3600');
    return res.sendFile(join(deps.voices!.dir(s.owner, req.params.id, s.builtIn), 'candidates', `candidate-${seed}.wav`));
  });

  router.post('/api/singers/:id/speaking-voice', (req, res) => {
    const body = z.object({ description: z.string().optional() }).strict().safeParse(req.body ?? {});
    if (!body.success) return res.status(400).json({ error: 'invalid_body', message: 'Send { description? }.' });
    return answer(res, async () => {
      const task = deps.tasks.startSpeakingVoice(ownerOf(req), { singerId: req.params.id, ...(body.data.description !== undefined ? { description: body.data.description } : {}) });
      return res.status(202).json({ task: taskJson(task, '') });
    });
  });

  router.post('/api/singers/:id/speaking-voice/choose', (req, res) => {
    const s = speakingOf(req, res);
    if (!s) return;
    const body = z.object({ seed: z.number().int() }).strict().safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'invalid_body', message: 'Send { seed }.' });
    const voice = deps.voices?.get(s.owner, req.params.id, s.builtIn);
    if (!voice) return res.status(404).json({ error: 'not_found', message: 'The singer has no speaking voice yet.' });
    if (!voice.candidates.some((c) => c.seed === body.data.seed)) return res.status(400).json({ error: 'not_a_candidate', message: `${body.data.seed} is not one of the singer's candidate voices.` });
    return res.json({ speaking: speakingJson(deps.voices!.choose(s.owner, req.params.id, s.builtIn, body.data.seed), req.params.id) });
  });

  // Rename (owner 2026-11-28): an added singer in its list; a built-in one for this owner only.
  router.put('/api/singers/:id/name', express.json(), (req, res) => {
    const owner = ownerOf(req);
    const body = RenameBody.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'invalid_name', message: 'A singer needs a name of 1 to 60 characters.' });
    const name = body.data.name;
    if (builtIns(owner).some((s) => s.id === req.params.id)) {
      if (!deps.users) return res.status(503).json({ error: 'not_configured', message: 'Renaming a built-in singer needs BRAIN_SINGERS_DATA_DIR (where each user\'s singers are kept).' });
      deps.users.nameBuiltIn(owner, req.params.id, name);
      return res.json({ id: req.params.id, name });
    }
    if (!deps.users?.rename(owner, req.params.id, name)) return res.status(404).json({ error: 'not_found', message: `There is no singer "${req.params.id}".` });
    return res.json({ id: req.params.id, name });
  });

  router.delete('/api/singers/:id', (req, res) => {
    const owner = ownerOf(req);
    if (builtIns(owner).some((s) => s.id === req.params.id)) {
      if (!deps.users) return res.status(503).json({ error: 'not_configured', message: 'Deleting a built-in singer needs BRAIN_SINGERS_DATA_DIR (where each user\'s singers are kept).' });
      deps.users.hideBuiltIn(owner, req.params.id);
      return res.json({ deleted: req.params.id });
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
