// Background tasks on the owner's songs (src/tasks/tasks.ts).
//
//   GET  /api/tasks                -> { tasks: TaskJson[] }  unfinished tasks and those finished in the last day
//   POST /api/tasks { kind, songId, song } -> 201 { task }   song = the editor's working copy
//   POST /api/tasks { kind: 'transcribe', songId, song, segment, recording: { name, type, data }, hasBacking }
//                                  -> 201 { task }   Transcribe melody: a recording of one section (data: base64 of the
//                                     file, any format ffmpeg reads, at most 10 MB decoded; 413 when larger), sung or
//                                     hummed along from the section's first beat; hasBacking: music plays behind the voice
//   POST /api/tasks { kind: 'aceLayer', songId, song, instrument, words?, range?: { startBar, endBar }, sectionKinds?: [kind],
//                                     sections?: [name], lyrics?, voice? }  (instrument 'adlibs': lyrics and voice required)
//                                  -> 201 { task }   Add ACE layer: one instrument part played over the song by ACE-Step,
//                                     for the whole song or the selected bars (src/ace/aceLayerTask.ts)
//   POST /api/tasks { kind: 'sing', songId, song, singerId } -> 201 { task }   Sing with a singer (GET /api/singers)
//   POST /api/tasks/:id/apply      -> { task, songId, result } a ready result saved into the song (its new id);
//                                     result: what the task made (writeLyrics: section → lines)
//   POST /api/tasks/:id/retry      -> { task }                a failed task started again
//   POST /api/tasks/:id/cancel     -> { task }                a running task cancelled (fails with "Cancelled")
//   GET  /api/tasks/:id/files/:stage/:name -> a file a step of the task made (step.files lists "<stage>/<name>")
//
// TaskJson: { id, kind, songId, title, state, message?, startedAt, finishedAt?, steps: TaskStep[] }
// (TaskStep: src/store.ts; kinds: writeLyrics, sing, transcribe, aceLayer).

import { Router, type Response } from 'express';
import { z } from 'zod';

import { parseSong } from '@casperaki/song-schema';

import type { TaskRow } from '../store.js';
import type { SongsStore } from '../store.js';
import { MAX_RECORDING_BYTES } from '../sing/transcribeTask.js';
import { TaskError, type BackgroundTasks } from '../tasks/tasks.js';
import { ownerOf } from './songs.js';

const KEEP_MS = 24 * 3600_000;

const StartBody = z.union([
  z.object({ kind: z.literal('writeLyrics'), songId: z.string().min(1), song: z.unknown() }).strict(),
  z.object({ kind: z.literal('sing'), songId: z.string().min(1), song: z.unknown(), singerId: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal('transcribe'),
      songId: z.string().min(1),
      song: z.unknown(),
      segment: z.string().min(1),
      recording: z.object({ name: z.string(), type: z.string(), data: z.string().min(1) }).strict(),
      hasBacking: z.boolean(),
    })
    .strict(),
  // The ACE layer's own options (instrument, words, range) are checked by the task (AceLayerOptionsSchema).
  z.object({ kind: z.literal('aceLayer'), songId: z.string().min(1), song: z.unknown(), instrument: z.string(), words: z.string().optional(), range: z.unknown().optional(), sectionKinds: z.unknown().optional(), sections: z.unknown().optional(), lyrics: z.unknown().optional(), voice: z.unknown().optional() }).strict(),
]);

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
    steps: t.steps,
    // The singer a Sing sang with (its dialog preselects it for Sing again).
    ...(t.kind === 'sing' && t.options && typeof (t.options as { singerId?: unknown }).singerId === 'string' ? { singerId: (t.options as { singerId: string }).singerId } : {}),
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
    const b = body.data;
    if (b.kind === 'transcribe') {
      const recording = Buffer.from(b.recording.data, 'base64');
      if (recording.length === 0) return res.status(400).json({ error: 'no_recording', message: 'The recording is empty.' });
      if (recording.length > MAX_RECORDING_BYTES) {
        return res.status(413).json({ error: 'recording_too_large', message: `The recording is larger than ${MAX_RECORDING_BYTES / 1024 / 1024} MB: bring one section, not the whole song.` });
      }
      return answer(res, () =>
        res.status(201).json({ task: titled(owner, tasks.start(owner, b.songId, b.kind, song, { segment: b.segment, recording, hasBacking: b.hasBacking })) }),
      );
    }
    if (b.kind === 'aceLayer') {
      const { instrument, words, range, sectionKinds, sections, lyrics, voice } = b;
      return answer(res, () =>
        res.status(201).json({ task: titled(owner, tasks.startAceLayer(owner, b.songId, song, { instrument, ...(words !== undefined ? { words } : {}), ...(range !== undefined ? { range } : {}), ...(sectionKinds !== undefined ? { sectionKinds } : {}), ...(sections !== undefined ? { sections } : {}), ...(lyrics !== undefined ? { lyrics } : {}), ...(voice !== undefined ? { voice } : {}) } as Parameters<BackgroundTasks['startAceLayer']>[3])) }),
      );
    }
    if (b.kind === 'sing') return answer(res, () => res.status(201).json({ task: titled(owner, tasks.startSing(owner, b.songId, song, b.singerId)) }));
    return answer(res, () => res.status(201).json({ task: titled(owner, tasks.start(owner, b.songId, b.kind, song)) }));
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

  router.post('/api/tasks/:id/cancel', (req, res) => {
    const owner = ownerOf(req);
    return answer(res, () => res.json({ task: titled(owner, tasks.cancel(owner, req.params.id)) }));
  });

  router.get('/api/tasks/:id/files/:stage/:name', (req, res) => {
    const owner = ownerOf(req);
    return answer(res, () => res.sendFile(tasks.stepFile(owner, req.params.id, req.params.stage, req.params.name)));
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
