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
// applied only while the sung sections are as they were sung), transcribe (src/sing/transcribeTask.ts: a recording of
// one section back into its Vocal lane; the same steps, cancel and apply check, for that section only), aceLayer
// (src/ace/aceLayerTask.ts), addSinger (src/singers/addSingerTask.ts: a new singer from an uploaded recording; on no
// song, so it has nothing to apply: it is done when the singer is stored).

import { randomInt, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { z } from 'zod';

import { AceLayerResultSchema, applyAceLayer, applyLyricsFirst, applySungVocals, applyWrittenLyrics, generatorParams, lyricsFirstParts, sungSections, vocalMelodyShown, WrittenLyricsSchema } from '@casperaki/arrangement';
import { canonicalStringifySong, parseSong, type MixOverrides, type Song } from '@casperaki/song-schema';

import { AceLayerOptionsSchema, coveredSections, keyScale, runAceLayer, type AceLayerOptions } from '../ace/aceLayerTask.js';
import type { EventHub } from '../events.js';
import type { ChatModel } from '../llm/chatModel.js';
import { drawInspiration } from '../lyrics/inspiration.js';
import { LyricsFirstResultSchema, recentOpenings, TYPE_LABELS, writeLyricsFirst } from '../lyrics/lyricsFirst.js';
import { defaultTitle } from '../routes/songs.js';
import { checkSectionsGenerated, planSinging, SingError } from '../sing/plan.js';
import { checkUnchanged, isPlainFileName, runSing, SingResultSchema, SONG_CHANGED, SongChangedError, TASK_FILE_STAGES } from '../sing/singTask.js';
import type { VocalLevel } from '../sing/vocalLevel.js';
import { keepRecording, runTranscribe, TRANSCRIBE_CHANGED, transcribeNeeds, TranscribeOptionsSchema, type TranscribeOptions } from '../sing/transcribeTask.js';
import type { VocalsClient } from '../sing/vocalsClient.js';
import { AddSingerOptionsSchema, MAX_RECORDING_SECONDS, recordingSeconds, runAddSinger, type AddSingerOptions } from '../singers/addSingerTask.js';
import { newSingerId, type ReferenceChoice, type UserSingers } from '../singers/userSingers.js';
import type { SongsStore, TaskKind, TaskRow, TaskStep } from '../store.js';

/** The user-facing refusal while a song is being sung. */
export const ALREADY_SINGING = 'Already singing';
/** The user-facing refusal while a recording is being transcribed for the song (Sing and Transcribe exclude each other). */
export const ALREADY_TRANSCRIBING = 'Already transcribing';
/** The user-facing refusal of Sing while the song's lyrics are being written (running or waiting their turn): new
 *  words would drop the sung melody of their sections. */
export const ALREADY_WRITING_LYRICS = 'Already writing lyrics';
/** Why a Sing (or Transcribe) that failed because the song changed is not started again: it would redo the old song. */
export const RETRY_SONG_CHANGED = 'The song changed since this sing started, so it cannot be started again: Sing again instead.';
export const RETRY_TRANSCRIBE_CHANGED = 'The song changed since this transcription started, so it cannot be started again: Transcribe melody again instead.';

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
  /** Transcribe melody: the task files folder, the vocals service and the hum service (each needed for some
   *  recordings), ffmpeg and the poll interval. */
  readonly transcribe?: TranscribeDeps;
  /** ACE layer: the ace service, the task files folder, the takes folder, ffmpeg, the poll interval and a way to
   *  render the owner's song; without it, ACE layer tasks cannot start. */
  readonly ace?: AceDeps;
  /** Add a singer: the vocals service, the task files folder, the users' singers (BRAIN_SINGERS_DATA_DIR), ffmpeg and
   *  the poll interval; without it, Add a singer answers 503. */
  readonly addSinger?: AddSingerDeps;
}

export interface AddSingerDeps {
  readonly client: VocalsClient;
  readonly filesDir: string;
  readonly singers: UserSingers;
  readonly ffmpegBin: string;
  readonly pollMs: number;
}

/** What Add a singer starts with: the upload and the user's choices (checked by startAddSinger). */
export interface AddSingerStart {
  readonly recording: Buffer;
  /** The upload's file name extension (lowercase letters and digits), kept on the stored file. */
  readonly extension: string;
  readonly name: string;
  readonly description: string;
  readonly rightToUse: boolean;
  readonly separate: boolean;
  readonly reference: ReferenceChoice;
}

/** The user-facing refusals of Add a singer. */
export const NO_CONSENT = 'Tick "I have the right to use this voice" to add a singer: only voices you may use can become singers.';
export const ADD_SINGER_NOT_SET_UP = 'Adding singers is not set up: the brain needs VOCALS_SERVICE_URL, BRAIN_TASK_FILES_DIR and BRAIN_SINGERS_DATA_DIR.';

/** "4 min 5 s" */
function minutes(seconds: number): string {
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  return m > 0 ? (s % 60 > 0 ? `${m} min ${s % 60} s` : `${m} min`) : `${s} s`;
}

export interface AceDeps {
  readonly client: VocalsClient;
  readonly filesDir: string;
  readonly takesDir: string;
  readonly ffmpegBin: string;
  readonly pollMs: number;
  /** Renders the song with the project's mix (unmastered) into the task's files folder: the WAV's path. */
  readonly renderWav: (ownerId: string, songId: string, song: Song, taskId: string) => Promise<string>;
}

export interface TranscribeDeps {
  /** BRAIN_TASK_FILES_DIR (required to transcribe: the recording is kept there). */
  readonly filesDir: string | undefined;
  readonly client: VocalsClient | undefined;
  /** HUM_SERVICE_URL. */
  readonly humServiceUrl: string | undefined;
  readonly ffmpegBin: string;
  readonly pollMs: number;
}

/** A transcribe task's start: the section, the recording and whether music plays behind the voice. */
export interface TranscribeStart {
  readonly segment: string;
  readonly recording: Buffer;
  readonly hasBacking: boolean;
}

/** Sing's options: the singer it sings with. */
export const SingOptionsSchema = z.object({ singerId: z.string().min(1) }).strict();
export type SingOptions = z.infer<typeof SingOptionsSchema>;

/** The singer of a sing task (one started before singers could be chosen has none: an error saying to sing again). */
function singOptionsOf(task: TaskRow): string {
  const parsed = SingOptionsSchema.safeParse(task.options);
  if (!parsed.success) throw new Error('this sing was started before a singer could be chosen: sing again');
  return parsed.data.singerId;
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
  /** The sung song's vocal level (renders it twice: src/sing/vocalLevel.ts), for the owner's project. */
  readonly levelVocals: (ownerId: string, songId: string, song: Song, taskId: string) => Promise<VocalLevel>;
  /** A singer's voice, among the built-in singers and the owner's own (src/routes/singers.ts): an Error for an
   *  unknown singer. */
  readonly singerVoice: (ownerId: string, singerId: string) => { audio: string; meta: string };
  /** The song's mix overrides with its vocals fader at `faderDb` (relative to the standard mix). */
  readonly withVocalFader: (overrides: MixOverrides | null, faderDb: number) => MixOverrides;
}

export class BackgroundTasks {
  /** Per kind, the end of its queue. */
  private readonly queues = new Map<TaskKind, Promise<void>>();
  private readonly running = new Set<Promise<void>>();
  /** Per running task, the signal that cancels it. */
  private readonly aborts = new Map<string, AbortController>();

  constructor(private readonly deps: BackgroundTasksDeps) {}

  /** Starts a task on the owner's project `songId` from the posted working song (transcribe: with its recording). */
  start(ownerId: string, songId: string, kind: TaskKind, song: Song, transcribe?: TranscribeStart): TaskRow {
    const { store } = this.deps;
    if (kind === 'sing') throw new Error('start: Sing needs its singer (startSing)');
    if ((kind === 'transcribe') !== (transcribe !== undefined)) throw new Error(`start: a ${kind} task ${transcribe ? 'takes no' : 'needs a'} recording`);
    const options: TranscribeOptions | undefined = transcribe ? { segment: transcribe.segment, recording: 'upload', hasBacking: transcribe.hasBacking } : undefined;
    this.checkCanStart(ownerId, songId, kind, song, options);
    const id = randomUUID();
    if (transcribe) {
      // checkCanStart made sure the folder is set
      const name = keepRecording(join(resolve(this.deps.transcribe!.filesDir!), id), transcribe.recording);
      if (name !== options!.recording) throw new Error(`start: the recording was kept as ${name}, not ${options!.recording}`);
    }
    store.insertTask({ id, ownerId, songId, kind, input: canonicalStringifySong(song, 2), startedAt: this.deps.clock(), ...(options ? { options } : {}) });
    this.deps.events.publish(ownerId, { type: 'task', taskId: id, songId, state: 'running' });
    this.enqueue(ownerId, id, kind);
    return store.getTask(ownerId, id)!;
  }

  /** Starts Sing on the owner's project `songId` from the posted working song, with the chosen singer. */
  startSing(ownerId: string, songId: string, song: Song, singerId: string): TaskRow {
    const { store } = this.deps;
    if (!this.deps.sing) throw new TaskError(503, 'no_vocal_service', 'Sing is not set up: the brain needs VOCALS_SERVICE_URL, BRAIN_TASK_FILES_DIR and BRAIN_VOCAL_TAKES_DIR.');
    try {
      this.deps.sing.singerVoice(ownerId, singerId);
    } catch (err) {
      throw new TaskError(400, 'unknown_singer', err instanceof Error ? err.message : String(err));
    }
    const options: SingOptions = { singerId };
    this.checkCanStart(ownerId, songId, 'sing', song);
    const id = randomUUID();
    store.insertTask({ id, ownerId, songId, kind: 'sing', input: canonicalStringifySong(song, 2), startedAt: this.deps.clock(), options });
    this.deps.events.publish(ownerId, { type: 'task', taskId: id, songId, state: 'running' });
    this.enqueue(ownerId, id, 'sing');
    return store.getTask(ownerId, id)!;
  }

  /** Starts an ACE layer task on the owner's project `songId` from the posted working song. */
  startAceLayer(ownerId: string, songId: string, song: Song, request: Omit<AceLayerOptions, 'seed'>): TaskRow {
    const parsed = AceLayerOptionsSchema.safeParse({ ...request, seed: randomInt(0, 2 ** 31 - 1) });
    if (!parsed.success) throw new TaskError(400, 'invalid_options', parsed.error.issues[0]?.message ?? 'invalid options');
    const options = parsed.data;
    this.checkCanStart(ownerId, songId, 'aceLayer', song, undefined, options);
    const id = randomUUID();
    const { store } = this.deps;
    store.insertTask({ id, ownerId, songId, kind: 'aceLayer', input: canonicalStringifySong(song, 2), startedAt: this.deps.clock(), options });
    this.deps.events.publish(ownerId, { type: 'task', taskId: id, songId, state: 'running' });
    this.enqueue(ownerId, id, 'aceLayer');
    return store.getTask(ownerId, id)!;
  }

  /** Starts Add a singer for the owner: the recording is checked (the consent box, a name and description, readable
   *  audio of at most MAX_RECORDING_SECONDS) and kept in the new singer's folder before the task is queued. */
  async startAddSinger(ownerId: string, start: AddSingerStart): Promise<TaskRow> {
    const a = this.deps.addSinger;
    if (!a) throw new TaskError(503, 'no_singer_service', ADD_SINGER_NOT_SET_UP);
    if (!start.rightToUse) throw new TaskError(400, 'no_consent', NO_CONSENT);
    if (start.recording.length === 0) throw new TaskError(400, 'no_recording', 'The recording is empty.');
    const singerId = newSingerId();
    const options: AddSingerOptions = (() => {
      const parsed = AddSingerOptionsSchema.safeParse({ singerId, name: start.name.trim(), description: start.description.trim(), separate: start.separate, reference: start.reference, upload: `original.${start.extension}` });
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const field = issue?.path.join('.') ?? 'the form';
        throw new TaskError(400, 'invalid_singer', field === 'name' ? 'Give the singer a name (at most 60 characters).' : field === 'description' ? 'Describe the voice (at most 300 characters).' : `${field}: ${issue?.message ?? 'invalid'}`);
      }
      return parsed.data;
    })();
    a.singers.keepUpload(ownerId, singerId, start.recording, start.extension);
    const upload = join(a.singers.dir(ownerId, singerId), options.upload);
    let seconds: number;
    try {
      seconds = await recordingSeconds(a.ffmpegBin, upload);
    } catch (err) {
      a.singers.discard(ownerId, singerId);
      throw new TaskError(400, 'not_audio', err instanceof Error ? err.message : String(err));
    }
    if (seconds > MAX_RECORDING_SECONDS) {
      a.singers.discard(ownerId, singerId);
      throw new TaskError(400, 'recording_too_long', `The recording is ${minutes(seconds)} long: a singer's recording can be at most ${minutes(MAX_RECORDING_SECONDS)}.`);
    }
    const id = randomUUID();
    this.deps.store.insertTask({ id, ownerId, songId: null, kind: 'addSinger', input: '', startedAt: this.deps.clock(), options });
    this.deps.events.publish(ownerId, { type: 'task', taskId: id, songId: null, state: 'running' });
    this.enqueue(ownerId, id, 'addSinger');
    return this.deps.store.getTask(ownerId, id)!;
  }

  /** Why a task of this kind cannot start on the owner's song now (a TaskError), checked on start and on retry. */
  private checkCanStart(ownerId: string, songId: string, kind: TaskKind, song: Song, options?: TranscribeOptions, ace?: AceLayerOptions): void {
    const { store } = this.deps;
    if (!store.getProject(ownerId, songId)) throw new TaskError(404, 'not_found', 'There is no such song.');
    if (kind === 'aceLayer') {
      if (!ace) throw new Error('checkCanStart: an ACE layer task without its options');
      if (!this.deps.ace) {
        throw new TaskError(503, 'no_ace_service', 'ACE layers are not set up: the brain needs ACE_SERVICE_URL, BRAIN_TASK_FILES_DIR and BRAIN_VOCAL_TAKES_DIR.');
      }
      if (store.activeTask(ownerId, songId, kind)) throw new TaskError(409, 'already_layering', 'An ACE layer is already being made for this song.');
      try {
        coveredSections(song, ace.range, ace.sectionKinds, ace.sections);
        keyScale(song.key);
      } catch (err) {
        throw new TaskError(422, 'cannot_layer', err instanceof Error ? err.message : String(err));
      }
    }
    if (kind === 'writeLyrics') {
      if (this.isSinging(ownerId, songId)) throw new TaskError(409, 'already_singing', ALREADY_SINGING);
      if (store.activeTask(ownerId, songId, kind)) throw new TaskError(409, 'already_running', 'The lyrics of this song are already being written.');
      if (!this.deps.lyricModel) throw new TaskError(503, 'no_lyric_model', 'Lyrics cannot be written: the brain has no language model (ASSISTANT_LLM_URL).');
      if (!vocalMelodyShown(song)) throw new TaskError(422, 'no_melody', 'Write a melody first.');
    }
    if (kind === 'sing') {
      if (store.activeTask(ownerId, songId, kind)) throw new TaskError(409, 'already_singing', ALREADY_SINGING);
      if (store.runningTask(ownerId, songId, 'transcribe')) throw new TaskError(409, 'already_transcribing', ALREADY_TRANSCRIBING);
      if (store.runningTask(ownerId, songId, 'writeLyrics')) throw new TaskError(409, 'already_writing_lyrics', ALREADY_WRITING_LYRICS);
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
    if (kind === 'transcribe') {
      if (!options) throw new Error('checkCanStart: a transcribe task without its options');
      if (this.isSinging(ownerId, songId)) throw new TaskError(409, 'already_singing', ALREADY_SINGING);
      if (store.activeTask(ownerId, songId, kind)) throw new TaskError(409, 'already_transcribing', ALREADY_TRANSCRIBING);
      const t = this.deps.transcribe;
      if (!t?.filesDir) throw new TaskError(503, 'no_task_files', 'Transcribe melody is not set up: the brain needs BRAIN_TASK_FILES_DIR.');
      if (!vocalMelodyShown(song)) throw new TaskError(422, 'no_melody', 'Write a melody first.');
      if (!sungSections(song).some((s) => s.name === options.segment)) {
        throw new TaskError(400, 'unknown_section', `The song has no sung section "${options.segment}".`);
      }
      try {
        checkSectionsGenerated(song, [options.segment]);
      } catch (err) {
        if (err instanceof SingError) throw new TaskError(422, 'section_not_generated', err.message);
        throw err;
      }
      const needs = transcribeNeeds(song, options);
      if (needs.vocals && !t.client) {
        throw new TaskError(503, 'no_vocals_service', 'Transcribing this recording needs the vocals service: the brain needs VOCALS_SERVICE_URL.');
      }
      if (needs.hum && !t.humServiceUrl) {
        throw new TaskError(503, 'no_hum_service', 'Transcribing a section without written lyrics needs the hum service: the brain needs HUM_SERVICE_URL.');
      }
    }
  }

  /** Starts a failed task again, from the same song (with the same checks as a start). */
  retry(ownerId: string, id: string): TaskRow {
    const { store } = this.deps;
    const task = store.getTask(ownerId, id);
    if (!task) throw new TaskError(404, 'not_found', 'There is no such task.');
    if (task.state !== 'failed') throw new TaskError(409, 'not_failed', 'Only a failed task can be started again.');
    if (task.kind === 'sing' && task.message === SONG_CHANGED) throw new TaskError(409, 'song_changed', RETRY_SONG_CHANGED);
    if (task.kind === 'transcribe' && task.message === TRANSCRIBE_CHANGED) throw new TaskError(409, 'song_changed', RETRY_TRANSCRIBE_CHANGED);
    if (task.kind === 'addSinger') {
      const a = this.deps.addSinger;
      if (!a) throw new TaskError(503, 'no_singer_service', ADD_SINGER_NOT_SET_UP);
      const o = AddSingerOptionsSchema.parse(task.options);
      if (!existsSync(join(a.singers.dir(ownerId, o.singerId), o.upload))) throw new TaskError(409, 'upload_gone', 'The uploaded recording is gone: add the singer again.');
    } else this.checkCanStart(
      ownerId,
      songIdOf(task),
      task.kind,
      parseSong(JSON.parse(task.input)),
      task.kind === 'transcribe' ? TranscribeOptionsSchema.parse(task.options) : undefined,
      task.kind === 'aceLayer' ? AceLayerOptionsSchema.parse(task.options) : undefined,
    );
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
    const songId = songIdOf(task);
    const current = store.get(songId);
    if (!current || !store.getProject(ownerId, songId)) {
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
    store.moveProject({ ownerId, fromSongId: songId, toSongId: newId, updatedAt: at });
    // A sung song's vocal level follows its backing: its vocals fader goes into the song's own mix.
    if (task.kind === 'sing') {
      const level = SingResultSchema.parse(task.result).vocalLevel;
      if (level) {
        if (!this.deps.sing) throw new Error('applying a sing result: the brain is not set up for Sing');
        const project = store.getProject(ownerId, newId)!;
        store.setProjectMix({ ownerId, songId: newId, mixOverrides: this.deps.sing.withVocalFader(project.mixOverrides, level.faderDb), updatedAt: at });
      }
    }
    store.setTaskState(id, { state: 'done', result: task.result, message: null, finishedAt: at });
    if (newId !== songId) this.deps.onSongReplaced?.(songId);
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
  stepFile(ownerId: string, id: string, stage: string, name: string): string {
    if (!(TASK_FILE_STAGES as readonly string[]).includes(stage)) throw new TaskError(400, 'bad_stage', `"${stage}" is not a stage (${TASK_FILE_STAGES.join(', ')}).`);
    if (!isPlainFileName(name)) throw new TaskError(400, 'bad_name', `"${name}" is not a file name.`);
    const task = this.deps.store.getTask(ownerId, id);
    if (!task) throw new TaskError(404, 'not_found', 'There is no such task.');
    const filesDir =
      task.kind === 'transcribe' ? this.deps.transcribe?.filesDir : task.kind === 'aceLayer' ? this.deps.ace?.filesDir : task.kind === 'addSinger' ? this.deps.addSinger?.filesDir : this.deps.sing?.filesDir;
    if (filesDir === undefined) throw new TaskError(404, 'no_file', `The task has no file "${name}".`);
    const path = join(resolve(filesDir), id, stage, name);
    if (!existsSync(path)) throw new TaskError(404, 'no_file', `The task has no file "${stage}/${name}".`);
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
      // A task on no song (Add a singer) has nothing to apply: it is done.
      if (now.songId === null) {
        store.setTaskState(id, { state: 'done', result, message: null, finishedAt: clock() });
        events.publish(ownerId, { type: 'task', taskId: id, songId: null, state: 'done' });
        return;
      }
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
      // Lyrics first (docs/superpowers/specs/2026-11-27-lyrics-first-singing-design.md): the words come before the
      // notes; applying them bends a rhythm to them (applyLyricsFirst). Per part (each verse, every other sung
      // type once: lyricsFirstParts), one line per two bars of the melody the generator chose, in song order.
      const params = generatorParams(input);
      const parts = lyricsFirstParts(params);
      const types = parts.map(({ part, type, lines }) => {
        const label = TYPE_LABELS[type];
        if (!label) throw new Error(`lyrics first: no name for the section type "${type}" to give the lyric writer`);
        // Every verse its own words: "Verse 1", "Verse 2" (a song with one verse: "Verse").
        const own = parts.filter((p) => p.type === type).length > 1;
        return { type: part, label: own ? `${label} ${parts.filter((p) => p.type === type).findIndex((p) => p.part === part) + 1}` : label, lines };
      });
      if (types.length === 0) throw new Error('the song has no sung section to write lyrics for');
      const songId = songIdOf(task);
      const project = this.deps.store.getProject(task.ownerId, songId);
      if (!project) throw new Error(`the owner has no project for song ${songId}`);
      const lyrics = await writeLyricsFirst(model, {
        types,
        title: project.title,
        genre: params.genre,
        recentOpenings: recentOpenings(this.deps.store, task.ownerId, songId),
        inspiration: drawInspiration(Math.random),
      });
      return { lyricsFirst: lyrics };
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
        levelVocals: (song) => sing.levelVocals(task.ownerId, songIdOf(task), song, task.id),
        voice: sing.singerVoice(task.ownerId, singOptionsOf(task)),
      });
    }
    if (task.kind === 'transcribe') {
      const t = this.deps.transcribe;
      if (!t?.filesDir) throw new Error('the brain is not set up to transcribe (BRAIN_TASK_FILES_DIR)');
      const { store, events, clock } = this.deps;
      return await runTranscribe({
        taskId: task.id,
        input: parseSong(JSON.parse(task.input)),
        options: TranscribeOptionsSchema.parse(task.options),
        client: t.client,
        humServiceUrl: t.humServiceUrl,
        filesDir: join(resolve(t.filesDir), task.id),
        ffmpegBin: t.ffmpegBin,
        pollMs: t.pollMs,
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
    if (task.kind === 'aceLayer') {
      const ace = this.deps.ace;
      if (!ace) throw new Error('the brain is not set up for ACE layers (ACE_SERVICE_URL, BRAIN_TASK_FILES_DIR, BRAIN_VOCAL_TAKES_DIR)');
      const { store, events, clock } = this.deps;
      return await runAceLayer({
        taskId: task.id,
        input: parseSong(JSON.parse(task.input)),
        options: AceLayerOptionsSchema.parse(task.options),
        client: ace.client,
        filesDir: join(resolve(ace.filesDir), task.id),
        takesDir: resolve(ace.takesDir),
        ffmpegBin: ace.ffmpegBin,
        pollMs: ace.pollMs,
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
        renderWav: (song) => ace.renderWav(task.ownerId, songIdOf(task), song, task.id),
      });
    }
    if (task.kind === 'addSinger') {
      const a = this.deps.addSinger;
      if (!a) throw new Error(ADD_SINGER_NOT_SET_UP);
      const { store, events, clock } = this.deps;
      return await runAddSinger({
        taskId: task.id,
        ownerId: task.ownerId,
        options: AddSingerOptionsSchema.parse(task.options),
        singers: a.singers,
        client: a.client,
        filesDir: join(resolve(a.filesDir), task.id),
        pollMs: a.pollMs,
        signal,
        jobs: task.jobs,
        setJobs: (jobs) => store.setTaskJobs(task.id, jobs),
        setSteps: (steps) => {
          const now = store.getTask(task.ownerId, task.id);
          if (!now || now.state !== 'running') return;
          store.setTaskSteps(task.id, steps);
          events.publish(task.ownerId, { type: 'task', taskId: task.id, songId: null, state: 'running' });
        },
        now: clock,
      });
    }
    throw new Error(`unknown task kind ${String(task.kind)}`);
  }
}

/** The song a task is on (an error for a task on no song: a bug). */
function songIdOf(task: TaskRow): string {
  if (task.songId === null) throw new Error(`task ${task.id} (${task.kind}) is on no song`);
  return task.songId;
}

/** The song with the task's result in it. */
function resultInto(task: TaskRow, song: Song): Song {
  if (task.kind === 'writeLyrics') {
    // Lyrics first ({ lyricsFirst }), or words written to a melody (section → lines: tasks before 2026-11-27).
    const first = LyricsFirstResultSchema.safeParse(task.result);
    return first.success ? applyLyricsFirst(song, first.data.lyricsFirst) : applyWrittenLyrics(song, WrittenLyricsSchema.parse(task.result));
  }
  if (task.kind === 'sing') {
    const result = SingResultSchema.parse(task.result);
    checkUnchanged(parseSong(JSON.parse(task.input)), song, result);
    return applySungVocals(song, result);
  }
  if (task.kind === 'transcribe') {
    const result = SingResultSchema.parse(task.result);
    const { segment } = TranscribeOptionsSchema.parse(task.options);
    if (Object.keys(result.melody).join() !== segment || result.takes.length > 0) throw new Error(`a transcribe result must hold ${segment} only and no takes`);
    try {
      checkUnchanged(parseSong(JSON.parse(task.input)), song, result);
    } catch (err) {
      if (err instanceof SongChangedError) throw new SongChangedError(err.detail, TRANSCRIBE_CHANGED);
      throw err;
    }
    return applySungVocals(song, result, { partial: true });
  }
  if (task.kind === 'aceLayer') return applyAceLayer(song, AceLayerResultSchema.parse(task.result));
  throw new Error(`unknown task kind ${String(task.kind)}`);
}
