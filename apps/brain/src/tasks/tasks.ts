// Background tasks on a song (docs/superpowers/specs/2026-11-25-vocal-tasks-design.md). A task starts from the song as
// the user's editor has it (its melody may not be saved yet), runs in the background, and keeps its result until a
// page of its owner applies it: pages apply results only while nothing is playing, so a song never changes under
// playback. Applying puts the result into the project's song as it is then (saves may have moved it) and saves that as a
// new version. Tasks are kept in the database: a brain restart resumes the running ones.
//
// One task of a kind runs at a time (the language model drops connections under parallel load; singing will share one
// graphics card); the others wait their turn. The brain only sends requests and waits, so renders and playback are not
// slowed down.
//
// Kinds: writeLyrics (src/lyrics/lyricist.ts), sing (src/sing/singTask.ts: steps recorded on the task, cancellable,
// applied only while the sung sections are as they were sung).

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { applySungVocals, applyWrittenLyrics, generatorParams, orchestrate, sungSections, vocalMelodyShown, WrittenLyricsSchema } from '@casperaki/arrangement';
import { canonicalStringifySong, parseSong, type Song } from '@casperaki/song-schema';

import type { EventHub } from '../events.js';
import type { ChatModel } from '../llm/chatModel.js';
import { writeLyrics } from '../lyrics/lyricist.js';
import { defaultTitle } from '../routes/songs.js';
import { planSinging, SingError } from '../sing/plan.js';
import { checkUnchanged, isPlainFileName, runSing, SingResultSchema, SongChangedError } from '../sing/singTask.js';
import type { VocalsClient } from '../sing/vocalsClient.js';
import type { SongsStore, TaskKind, TaskRow, TaskStep } from '../store.js';

/** The user-facing refusal while a song is being sung. */
export const ALREADY_SINGING = 'Already singing';

/** Why a task cannot start or be applied: an HTTP status, a code and a message for the user. */
export class TaskError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface BackgroundTasksDeps {
  readonly store: SongsStore;
  readonly events: EventHub;
  /** The language model that writes lyrics; without it, writeLyrics tasks cannot start. */
  readonly lyricModel?: ChatModel;
  readonly hash: (canonical: string) => string;
  readonly clock: () => string;
  /** A saved song was replaced by a new version. */
  readonly onSongReplaced?: (oldSongId: string) => void;
  /** Sing: the vocals service, the task files folder, the takes folder, ffmpeg and the poll interval; without it,
   *  sing tasks cannot start. */
  readonly sing?: SingDeps;
}

export interface SingDeps {
  readonly client: VocalsClient;
  /** BRAIN_TASK_FILES_DIR: each task's step files in <dir>/<task id>/. */
  readonly filesDir: string;
  /** BRAIN_VOCAL_TAKES_DIR: takes as <sha256>.ogg. */
  readonly takesDir: string;
  readonly ffmpegBin: string;
  /** How often a running service job is polled (ms). */
  readonly pollMs: number;
}

export class BackgroundTasks {
  /** Per kind, the end of its queue. */
  private readonly queues = new Map<TaskKind, Promise<void>>();
  private readonly running = new Set<Promise<void>>();
  /** Per running task, the signal that cancels it. */
  private readonly aborts = new Map<string, AbortController>();

  constructor(private readonly deps: BackgroundTasksDeps) {}

  /** Starts a task on the owner's project `songId` from the posted working song. */
  start(ownerId: string, songId: string, kind: TaskKind, song: Song): TaskRow {
    const { store } = this.deps;
    if (!store.getProject(ownerId, songId)) throw new TaskError(404, 'not_found', 'There is no such song.');
    if (kind === 'writeLyrics') {
      if (this.isSinging(ownerId, songId)) throw new TaskError(409, 'already_singing', ALREADY_SINGING);
      if (store.activeTask(ownerId, songId, kind)) throw new TaskError(409, 'already_running', 'The lyrics of this song are already being written.');
      if (!this.deps.lyricModel) throw new TaskError(503, 'no_lyric_model', 'Lyrics cannot be written: the brain has no language model (ASSISTANT_LLM_URL).');
      if (!vocalMelodyShown(song)) throw new TaskError(422, 'no_melody', 'Write a melody first.');
    }
    if (kind === 'sing') {
      if (store.activeTask(ownerId, songId, kind)) throw new TaskError(409, 'already_singing', ALREADY_SINGING);
      if (!this.deps.sing) {
        throw new TaskError(503, 'no_vocals_service', 'Sing is not set up: the brain needs VOCALS_SERVICE_URL, BRAIN_TASK_FILES_DIR and BRAIN_VOCAL_TAKES_DIR.');
      }
      try {
        planSinging(song);
      } catch (err) {
        if (err instanceof SingError) throw new TaskError(422, 'cannot_sing', err.message);
        throw err;
      }
    }
    const id = randomUUID();
    store.insertTask({ id, ownerId, songId, kind, input: canonicalStringifySong(song, 2), startedAt: this.deps.clock() });
    this.deps.events.publish(ownerId, { type: 'task', taskId: id, songId, state: 'running' });
    this.enqueue(ownerId, id, kind);
    return store.getTask(ownerId, id)!;
  }

  /** Starts a failed task again, from the same song. */
  retry(ownerId: string, id: string): TaskRow {
    const { store } = this.deps;
    const task = store.getTask(ownerId, id);
    if (!task) throw new TaskError(404, 'not_found', 'There is no such task.');
    if (task.state !== 'failed') throw new TaskError(409, 'not_failed', 'Only a failed task can be started again.');
    store.setTaskSteps(id, []);
    store.setTaskJobs(id, null);
    store.setTaskState(id, { state: 'running', result: null, message: null, finishedAt: null, startedAt: this.deps.clock() });
    this.deps.events.publish(ownerId, { type: 'task', taskId: id, songId: task.songId, state: 'running' });
    this.enqueue(ownerId, id, task.kind);
    return store.getTask(ownerId, id)!;
  }

  /** Puts a ready result into the project's song and saves it as a new version: the saved song's id. */
  apply(ownerId: string, id: string): { task: TaskRow; songId: string } {
    const { store, hash, clock } = this.deps;
    const task = store.getTask(ownerId, id);
    if (!task) throw new TaskError(404, 'not_found', 'There is no such task.');
    if (task.state !== 'ready') throw new TaskError(409, 'not_ready', `The task is ${task.state}, not ready.`);
    const current = store.get(task.songId);
    if (!current || !store.getProject(ownerId, task.songId)) {
      store.deleteTask(id);
      throw new TaskError(404, 'song_deleted', 'The song was deleted.');
    }
    let song: Song;
    try {
      song = resultInto(task, current.song);
    } catch (err) {
      if (!(err instanceof SongChangedError)) throw err;
      store.setTaskState(id, { state: 'failed', result: null, message: err.message, finishedAt: clock() });
      this.deps.events.publish(ownerId, { type: 'task', taskId: id, songId: task.songId, state: 'failed' });
      throw new TaskError(409, 'song_changed', err.message);
    }
    const canonical = canonicalStringifySong(song, 2);
    const songHash = hash(canonical);
    const newId = songHash.slice(0, 16);
    const at = clock();
    store.put({ id: newId, song, canonical, hash: songHash, createdAt: at });
    store.moveProject({ ownerId, fromSongId: task.songId, toSongId: newId, updatedAt: at });
    store.setTaskState(id, { state: 'done', result: task.result, message: null, finishedAt: at });
    if (newId !== task.songId) this.deps.onSongReplaced?.(task.songId);
    this.deps.events.publish(ownerId, { type: 'task', taskId: id, songId: newId, state: 'done' });
    return { task: store.getTask(ownerId, id)!, songId: newId };
  }

  /** Cancels a running task (queued or under way): it fails with "Cancelled", and a service job it runs is cancelled. */
  cancel(ownerId: string, id: string): TaskRow {
    const { store, clock } = this.deps;
    const task = store.getTask(ownerId, id);
    if (!task) throw new TaskError(404, 'not_found', 'There is no such task.');
    if (task.state !== 'running') throw new TaskError(409, 'not_running', `The task is ${task.state}, not running.`);
    const at = clock();
    const steps: TaskStep[] = task.steps.map((s) => (s.state === 'running' ? { ...s, state: 'failed', finishedAt: at, text: 'Cancelled' } : s));
    store.setTaskSteps(id, steps);
    store.setTaskState(id, { state: 'failed', result: null, message: 'Cancelled', finishedAt: at });
    this.aborts.get(id)?.abort();
    this.deps.events.publish(ownerId, { type: 'task', taskId: id, songId: task.songId, state: 'failed' });
    return store.getTask(ownerId, id)!;
  }

  /** Whether a sing task runs on the owner's song (Write melody and Write lyrics wait for it). */
  isSinging(ownerId: string, songId: string): boolean {
    return this.deps.store.runningTask(ownerId, songId, 'sing') !== undefined;
  }

  /** The path of a file a step of the owner's task made (a TaskError when there is none). */
  stepFile(ownerId: string, id: string, name: string): string {
    if (!isPlainFileName(name)) throw new TaskError(400, 'bad_name', `"${name}" is not a file name.`);
    const task = this.deps.store.getTask(ownerId, id);
    if (!task) throw new TaskError(404, 'not_found', 'There is no such task.');
    if (!this.deps.sing) throw new TaskError(404, 'no_file', `The task has no file "${name}".`);
    const path = join(resolve(this.deps.sing.filesDir), id, name);
    if (!existsSync(path)) throw new TaskError(404, 'no_file', `The task has no file "${name}".`);
    return path;
  }

  /** Resumes every task the database says is running (at start-up: a restart ended them). */
  resumeAll(): void {
    for (const t of this.deps.store.listRunningTasks()) this.enqueue(t.ownerId, t.id, t.kind);
  }

  /** Resolves when every queued and running task has finished (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.all([...this.running]);
  }

  private enqueue(ownerId: string, id: string, kind: TaskKind): void {
    const before = this.queues.get(kind) ?? Promise.resolve();
    const run = before.then(() => this.run(ownerId, id));
    this.queues.set(kind, run);
    this.running.add(run);
    void run.finally(() => this.running.delete(run));
  }

  private async run(ownerId: string, id: string): Promise<void> {
    const { store, events, clock } = this.deps;
    const task = store.getTask(ownerId, id);
    if (!task || task.state !== 'running') return;
    const abort = new AbortController();
    this.aborts.set(id, abort);
    try {
      const result = await this.work(task, abort.signal);
      const now = store.getTask(ownerId, id);
      // Gone, or cancelled meanwhile.
      if (!now || now.state !== 'running') return;
      // The song was deleted meanwhile: the task goes with it.
      if (!store.getProject(ownerId, now.songId)) {
        store.deleteTask(id);
        return;
      }
      store.setTaskState(id, { state: 'ready', result, message: null, finishedAt: clock() });
      events.publish(ownerId, { type: 'task', taskId: id, songId: now.songId, state: 'ready' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[tasks] ${task.kind} ${id} failed: ${message}`);
      const now = store.getTask(ownerId, id);
      if (!now || now.state !== 'running') return;
      store.setTaskState(id, { state: 'failed', result: null, message, finishedAt: clock() });
      events.publish(ownerId, { type: 'task', taskId: id, songId: now.songId, state: 'failed' });
    } finally {
      this.aborts.delete(id);
    }
  }

  /** The task's result. */
  private async work(task: TaskRow, signal: AbortSignal): Promise<unknown> {
    if (task.kind === 'writeLyrics') {
      const model = this.deps.lyricModel;
      if (!model) throw new Error('the brain has no language model to write lyrics with (ASSISTANT_LLM_URL)');
      const input = parseSong(JSON.parse(task.input));
      // The words fit the melody the generator writes for the song (applying them regenerates the vocal tracks).
      const generated = orchestrate(generatorParams(input));
      const sections = sungSections(generated).map((s) => s.name);
      // A real title gives the lyrics their theme; the placeholder ("Bright Pop in C") does not.
      const project = this.deps.store.getProject(task.ownerId, task.songId);
      const title = project && project.title !== defaultTitle(input.genre ?? '', input.key) ? project.title : undefined;
      return await writeLyrics(generated, model, { sections, ...(title ? { title } : {}) });
    }
    if (task.kind === 'sing') {
      const sing = this.deps.sing;
      if (!sing) throw new Error('the brain is not set up to sing (VOCALS_SERVICE_URL, BRAIN_TASK_FILES_DIR, BRAIN_VOCAL_TAKES_DIR)');
      const { store, events, clock } = this.deps;
      return await runSing({
        taskId: task.id,
        input: parseSong(JSON.parse(task.input)),
        client: sing.client,
        filesDir: join(resolve(sing.filesDir), task.id),
        takesDir: resolve(sing.takesDir),
        ffmpegBin: sing.ffmpegBin,
        pollMs: sing.pollMs,
        signal,
        jobs: task.jobs,
        setJobs: (jobs) => store.setTaskJobs(task.id, jobs),
        setSteps: (steps) => {
          const now = store.getTask(task.ownerId, task.id);
          if (!now || now.state !== 'running') return;
          store.setTaskSteps(task.id, steps);
          events.publish(task.ownerId, { type: 'task', taskId: task.id, songId: now.songId, state: 'running' });
        },
        now: clock,
      });
    }
    throw new Error(`unknown task kind ${String(task.kind)}`);
  }
}

/** The song with the task's result in it. */
function resultInto(task: TaskRow, song: Song): Song {
  if (task.kind === 'writeLyrics') return applyWrittenLyrics(song, WrittenLyricsSchema.parse(task.result));
  if (task.kind === 'sing') {
    const result = SingResultSchema.parse(task.result);
    checkUnchanged(parseSong(JSON.parse(task.input)), song, result);
    return applySungVocals(song, result);
  }
  throw new Error(`unknown task kind ${String(task.kind)}`);
}
