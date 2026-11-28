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
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { z } from 'zod';

import { AceLayerResultSchema, applyAceLayer, applyLyricsFirst, applyRapLyrics, applySungVocals, applyWrittenLyrics, generatorParams, lyricsFirstParts, sungSections, vocalMelodyShown, WrittenLyricsSchema } from '@casperaki/arrangement';
import { canonicalStringifySong, parseSong, rapLineCount, type MixOverrides, type Song } from '@casperaki/song-schema';

import { RAP_DENSITY, writeRapWords } from '../ace/rapWords.js';
import { AceLayerOptionsSchema, coveredSections, keyScale, runAceLayer, sectionLabel, songWordsOf, type AceLayerOptions } from '../ace/aceLayerTask.js';
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
import { buildAvatar, type AvatarBuildDeps } from '../avatars/avatarBuildTask.js';
import type { UserAvatars } from '../avatars/userAvatars.js';
import { songSinger } from '../avatars/videoAvatars.js';
import { castNames, verdictVotes } from '../casting/cast.js';
import { castingFacts, isChorus } from '../casting/facts.js';
import { SCENES, writeScript, type CastingScript, type SceneId } from '../casting/writer.js';
import { layOut } from '../casting/timeline.js';
import { lineVoices, speakLines } from '../casting/voices.js';
import { APPLAUSE_LUFS, audibleSeconds, BED_LUFS, gainTo, mixSoundtrack, pickFor, speakerGains } from '../casting/mix.js';
import { wavLevels } from '../routes/renders.js';
import { songTiming } from '../video/videoInput.js';
import { checkDesign, RealisticDesignSchema, type RealisticDesign } from '../avatars/realisticDesign.js';
import { makeSpeakingVoice, SpeakingVoiceOptionsSchema, type SpeakingSinger, type SpeakingVoiceDeps } from '../singers/speakingVoiceTask.js';
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
  /** Singers' speaking voices: the speech service, the voices' folder, the language model, and how to find a singer
   *  of the owner's (an Error for an unknown one); without it, making speaking voices answers 503. */
  readonly speakingVoice?: SpeakingVoiceDeps & { readonly findSinger: (ownerId: string, singerId: string) => SpeakingSinger };
  /** Realistic avatars' builds: the avatar builder, the curated library and the builds' files folder; without it,
   *  building answers 503. */
  readonly avatarBuild?: AvatarBuildDeps;
  /** Casting scripts: the language model, the users' avatars and how to find a singer of the owner's (its name and
   *  what was written about the voice); without it, casting scripts answer 503. */
  readonly casting?: CastingDeps;
  /** Casting soundtracks: the speech service, the music and the song export; without it, they answer 503. */
  readonly castingSoundtrack?: CastingSoundtrackDeps;
}

export interface CastingDeps {
  readonly chat: ChatModel;
  readonly avatars: UserAvatars;
  readonly findSinger: (ownerId: string, singerId: string) => { name: string; description: string | null };
}

export interface CastingSoundtrackDeps {
  /** The speech service. */
  readonly client: VocalsClient;
  /** Where soundtrack tasks keep their files (BRAIN_TASK_FILES_DIR). */
  readonly filesDir: string;
  readonly pollMs: number;
  readonly ffmpegBin: string;
  /** BRAIN_CASTING_MUSIC_DIR: "Poised and Ready.mp3" and "The Grand Entrance.mp3". */
  readonly musicDir: string;
  readonly avatars: UserAvatars;
  /** The singer's speaking voice (description and seed), or undefined when it has none yet. */
  readonly singerVoice: (ownerId: string, singerId: string) => { description: string; seed: number; line?: string } | undefined;
  /** The owner's song exported with its mix, and its length. */
  readonly exportSong: (ownerId: string, songId: string) => Promise<{ path: string; seconds: number }>;
}
export const CASTING_MUSIC = { poised: 'Poised and Ready.mp3', entrance: 'The Grand Entrance.mp3' } as const;
/** Folders in the music folder: applause clips after the song, music beds under the verdicts (one of each per video). */
export const CASTING_APPLAUSE_DIR = 'applause';
export const CASTING_BEDS_DIR = 'verdict-beds';
function wavsIn(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.wav')) : [];
}
/** Every voice's loudness in the soundtrack (LUFS), the narrator then sitting 3 dB lower. */
export const CASTING_VOICE_LUFS = -16;
/** The mouth levels' bin length (seconds). */
export const CASTING_BIN_SECONDS = 0.05;
export const CASTING_SOUNDTRACK_NOT_SET_UP = 'Casting soundtracks are not set up: the brain needs SPEECH_SERVICE_URL, BRAIN_CASTING_MUSIC_DIR, BRAIN_TASK_FILES_DIR, BRAIN_SINGERS_DATA_DIR and rendering.';
const CastingSoundtrackOptionsSchema = z
  .object({ scriptTaskId: z.string().min(1), singerVoice: z.object({ description: z.string().min(1), seed: z.number().int(), referenceText: z.string().min(1) }).strict() })
  .strict();

const CastingOptionsSchema = z
  .object({
    avatarId: z.string().min(1),
    outcome: z.enum(['fourYes', 'threeOne', 'notThisTime']),
    title: z.string().min(1),
    singerName: z.string().min(1),
    singerDescription: z.string().nullable(),
    avatarName: z.string().min(1),
    /** The singer's back story as the user wrote it; absent: the narrator makes one up. */
    backstory: z.string().min(1).max(1200).optional(),
  })
  .strict();
export const CASTING_NOT_SET_UP = "Casting scripts are not set up: the brain needs the assistant's language model (ASSISTANT_LLM_URL) and BRAIN_SINGERS_DATA_DIR.";
/** Kinds on a song whose result goes into nothing: done when written, not ready to apply. */
const NOTHING_TO_APPLY: ReadonlySet<TaskKind> = new Set(['castingScript', 'castingSoundtrack']);

export interface AddSingerDeps {
  readonly client: VocalsClient;
  readonly filesDir: string;
  readonly singers: UserSingers;
  readonly ffmpegBin: string;
  readonly pollMs: number;
  /** Set when speaking voices are set up: a new singer's speaking voice is made last. */
  readonly speaking?: SpeakingVoiceDeps;
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
export const SPEAKING_NOT_SET_UP = "Speaking voices are not set up: the brain needs SPEECH_SERVICE_URL, the assistant's language model (ASSISTANT_LLM_URL), BRAIN_TASK_FILES_DIR and BRAIN_SINGERS_DATA_DIR.";
export const AVATAR_BUILD_NOT_SET_UP = "Realistic avatars are not set up: the brain needs AVATAR_BUILDER_URL, AVATAR_LIBRARY_FILE, BRAIN_TASK_FILES_DIR and BRAIN_SINGERS_DATA_DIR.";
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

/** Sing's options: the singer it sings with, and the sections it sings (none: every section with a melody; a sing
 *  started before sections could be chosen). */
export const SingOptionsSchema = z.object({ singerId: z.string().min(1), sections: z.array(z.string().min(1)).min(1).optional() }).strict();
export type SingOptions = z.infer<typeof SingOptionsSchema>;

/** The singer of a sing task (one started before singers could be chosen has none: an error saying to sing again). */
function singOptionsOf(task: TaskRow): SingOptions {
  const parsed = SingOptionsSchema.safeParse(task.options);
  if (!parsed.success) throw new Error('this sing was started before a singer could be chosen: sing again');
  return parsed.data;
}

/** Write rap lyrics' options (docs/superpowers/specs/2026-11-28-rap-like-singing-design.md): the rap's style and the
 *  sections to write words for. */
export const WriteRapLyricsOptionsSchema = z
  .object({ style: z.string().trim().min(1).max(200), sections: z.array(z.string().min(1)).min(1) })
  .strict()
  .refine((o) => new Set(o.sections).size === o.sections.length, 'each section once');
export type WriteRapLyricsOptions = z.infer<typeof WriteRapLyricsOptionsSchema>;
export const WriteRapLyricsResultSchema = z.object({ rapLyrics: z.record(z.string(), z.array(z.string().min(1)).min(1)) }).strict();

/** The checks of a start or retry that depend on the task's options. */
interface StartOptions {
  readonly transcribe?: TranscribeOptions;
  readonly ace?: AceLayerOptions;
  readonly sing?: SingOptions;
  readonly rapLyrics?: WriteRapLyricsOptions;
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
    this.checkCanStart(ownerId, songId, kind, song, options ? { transcribe: options } : {});
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
  startSing(ownerId: string, songId: string, song: Song, singerId: string, sections?: readonly string[]): TaskRow {
    const { store } = this.deps;
    if (!this.deps.sing) throw new TaskError(503, 'no_vocal_service', 'Sing is not set up: the brain needs VOCALS_SERVICE_URL, BRAIN_TASK_FILES_DIR and BRAIN_VOCAL_TAKES_DIR.');
    try {
      this.deps.sing.singerVoice(ownerId, singerId);
    } catch (err) {
      throw new TaskError(400, 'unknown_singer', err instanceof Error ? err.message : String(err));
    }
    const parsed = SingOptionsSchema.safeParse({ singerId, ...(sections ? { sections: [...sections] } : {}) });
    if (!parsed.success) throw new TaskError(400, 'invalid_options', parsed.error.issues[0]?.message ?? 'invalid options');
    const options = parsed.data;
    this.checkCanStart(ownerId, songId, 'sing', song, { sing: options });
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
    this.checkCanStart(ownerId, songId, 'aceLayer', song, { ace: options });
    const id = randomUUID();
    const { store } = this.deps;
    store.insertTask({ id, ownerId, songId, kind: 'aceLayer', input: canonicalStringifySong(song, 2), startedAt: this.deps.clock(), options });
    this.deps.events.publish(ownerId, { type: 'task', taskId: id, songId, state: 'running' });
    this.enqueue(ownerId, id, 'aceLayer');
    return store.getTask(ownerId, id)!;
  }

  /** Starts Write rap lyrics on the owner's project `songId` from the posted working song. */
  startWriteRapLyrics(ownerId: string, songId: string, song: Song, request: WriteRapLyricsOptions): TaskRow {
    const parsed = WriteRapLyricsOptionsSchema.safeParse(request);
    if (!parsed.success) throw new TaskError(400, 'invalid_options', parsed.error.issues[0]?.message ?? 'invalid options');
    const options = parsed.data;
    this.checkCanStart(ownerId, songId, 'writeRapLyrics', song, { rapLyrics: options });
    const id = randomUUID();
    const { store } = this.deps;
    store.insertTask({ id, ownerId, songId, kind: 'writeRapLyrics', input: canonicalStringifySong(song, 2), startedAt: this.deps.clock(), options });
    this.deps.events.publish(ownerId, { type: 'task', taskId: id, songId, state: 'running' });
    this.enqueue(ownerId, id, 'writeRapLyrics');
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

  /** Makes a speaking voice for one of the owner's singers: described from the singing and matched, or from the
   *  user's own description (used as is). 400 for a blank description, 404 for an unknown singer, 409 while one is
   *  being made for that singer. */
  startSpeakingVoice(ownerId: string, start: { singerId: string; description?: string }): TaskRow {
    const sv = this.deps.speakingVoice;
    if (start.description !== undefined && !start.description.trim()) throw new TaskError(400, 'no_description', 'Describe the voice.');
    if (!sv) throw new TaskError(503, 'no_speech_service', SPEAKING_NOT_SET_UP);
    let singer: SpeakingSinger;
    try {
      singer = sv.findSinger(ownerId, start.singerId);
    } catch (err) {
      throw new TaskError(404, 'not_found', err instanceof Error ? err.message : String(err));
    }
    this.checkNoSpeakingVoiceRunning(ownerId, singer.id);
    const description = start.description?.trim();
    const parsed = SpeakingVoiceOptionsSchema.safeParse({ singerId: singer.id, name: singer.name, ...(description ? { description } : {}) });
    if (!parsed.success) throw new TaskError(400, 'invalid_description', 'Describe the voice in at most 300 characters.');
    const id = randomUUID();
    this.deps.store.insertTask({ id, ownerId, songId: null, kind: 'speakingVoice', input: '', startedAt: this.deps.clock(), options: parsed.data });
    this.deps.events.publish(ownerId, { type: 'task', taskId: id, songId: null, state: 'running' });
    this.enqueue(ownerId, id, 'speakingVoice');
    return this.deps.store.getTask(ownerId, id)!;
  }

  /** Starts building a realistic avatar from `design` (checked against the library first: 400 naming the problem). */
  startAvatarBuild(ownerId: string, design: unknown): TaskRow {
    const ab = this.deps.avatarBuild;
    if (!ab) throw new TaskError(503, 'no_avatar_builder', AVATAR_BUILD_NOT_SET_UP);
    const parsed = RealisticDesignSchema.safeParse(design);
    if (!parsed.success) {
      const i = parsed.error.issues[0]!;
      throw new TaskError(400, 'invalid_design', `design.${i.path.join('.')}: ${i.message}`);
    }
    try {
      checkDesign(parsed.data, ab.library);
    } catch (err) {
      throw new TaskError(400, 'invalid_design', err instanceof Error ? err.message : String(err));
    }
    const id = randomUUID();
    this.deps.store.insertTask({ id, ownerId, songId: null, kind: 'avatarBuild', input: '', startedAt: this.deps.clock(), options: { design: parsed.data } });
    this.deps.events.publish(ownerId, { type: 'task', taskId: id, songId: null, state: 'running' });
    this.enqueue(ownerId, id, 'avatarBuild');
    return this.deps.store.getTask(ownerId, id)!;
  }

  /** Starts writing a casting script for the owner's song, performed by one of their avatars (its singer must have
   *  sung the song's latest finished Sing), with the outcome the user chose. */
  startCastingScript(ownerId: string, songId: string, start: { avatarId: unknown; outcome: unknown; backstory?: unknown }): TaskRow {
    const c = this.deps.casting;
    if (!c) throw new TaskError(503, 'no_casting', CASTING_NOT_SET_UP);
    const { store } = this.deps;
    const project = store.getProject(ownerId, songId);
    const stored = project ? store.get(songId) : undefined;
    if (!project || !stored) throw new TaskError(404, 'not_found', 'There is no such song.');
    const outcome = z.enum(['fourYes', 'threeOne', 'notThisTime']).safeParse(start.outcome);
    if (!outcome.success) throw new TaskError(400, 'invalid_outcome', 'Choose the outcome: fourYes, threeOne or notThisTime.');
    const avatar = typeof start.avatarId === 'string' ? c.avatars.get(ownerId, start.avatarId) : undefined;
    if (!avatar) throw new TaskError(400, 'unknown_avatar', `You have no avatar "${String(start.avatarId)}".`);
    const singerId = songSinger(store, ownerId, songId);
    if (singerId === undefined) throw new TaskError(400, 'not_sung', "Sing this song with one of your avatars' singers first.");
    if (avatar.singerId !== singerId) throw new TaskError(400, 'wrong_singer', `${avatar.name} does not have the voice that sang this song: choose the avatar whose singer sang it.`);
    const song = parseSong(JSON.parse(stored.canonical));
    if (!songTiming(song).sections.some((x) => isChorus(x.name))) throw new TaskError(400, 'no_chorus', 'The song has no chorus, which a casting performance ends with.');
    if (store.runningTask(ownerId, songId, 'castingScript')) throw new TaskError(409, 'already_running', 'A casting script for this song is already being written.');
    let singer: { name: string; description: string | null };
    try {
      singer = c.findSinger(ownerId, singerId);
    } catch (err) {
      throw new TaskError(400, 'unknown_singer', err instanceof Error ? err.message : String(err));
    }
    if (castNames().includes(singer.name.trim().toLowerCase())) {
      throw new TaskError(400, 'name_clash', `The singer is called "${singer.name}", like someone in the casting cast (the narrator and the judges Ice, Nicky, Love and Bob): rename the singer first.`);
    }
    if (start.backstory !== undefined && (typeof start.backstory !== 'string' || start.backstory.length > 1200)) {
      throw new TaskError(400, 'invalid_backstory', 'The back story must be text of at most 1200 characters.');
    }
    const backstory = typeof start.backstory === 'string' && start.backstory.trim() ? start.backstory.trim() : undefined;
    const options = CastingOptionsSchema.parse({ avatarId: avatar.id, outcome: outcome.data, title: project.title, singerName: singer.name, singerDescription: singer.description, avatarName: avatar.name, ...(backstory ? { backstory } : {}) });
    const id = randomUUID();
    store.insertTask({ id, ownerId, songId, kind: 'castingScript', input: stored.canonical, startedAt: this.deps.clock(), options });
    this.deps.events.publish(ownerId, { type: 'task', taskId: id, songId, state: 'running' });
    this.enqueue(ownerId, id, 'castingScript');
    return store.getTask(ownerId, id)!;
  }

  /** Starts making the casting soundtrack of the owner's song from its latest finished casting script. */
  startCastingSoundtrack(ownerId: string, songId: string): TaskRow {
    const c = this.deps.castingSoundtrack;
    if (!c) throw new TaskError(503, 'no_casting', CASTING_SOUNDTRACK_NOT_SET_UP);
    const { store } = this.deps;
    const stored = store.getProject(ownerId, songId) ? store.get(songId) : undefined;
    if (!stored) throw new TaskError(404, 'not_found', 'There is no such song.');
    const script = latestDone(store, ownerId, songId, 'castingScript');
    if (!script) throw new TaskError(400, 'no_script', 'Write the casting script first.');
    const o = CastingOptionsSchema.parse(script.options);
    const avatar = c.avatars.get(ownerId, o.avatarId);
    if (!avatar || avatar.singerId === null) throw new TaskError(400, 'avatar_gone', `The avatar the script was written for is gone or has no voice: write the script again.`);
    const voice = c.singerVoice(ownerId, avatar.singerId);
    if (!voice) throw new TaskError(400, 'no_speaking_voice', `Make ${o.singerName}'s speaking voice on the Singers page first.`);
    for (const f of Object.values(CASTING_MUSIC)) {
      if (!existsSync(join(c.musicDir, f))) throw new TaskError(503, 'music_missing', `The casting music "${f}" is missing from ${c.musicDir}.`);
    }
    // One applause clip; two music beds (one under the meeting, another under the verdicts).
    for (const [folder, needed] of [[CASTING_APPLAUSE_DIR, 1], [CASTING_BEDS_DIR, 2]] as const) {
      if (wavsIn(join(c.musicDir, folder)).length < needed) throw new TaskError(503, 'music_missing', `${join(c.musicDir, folder)} needs at least ${needed} WAV file${needed > 1 ? 's' : ''}.`);
    }
    if (store.runningTask(ownerId, songId, 'castingSoundtrack')) throw new TaskError(409, 'already_running', 'A casting soundtrack for this song is already being made.');
    // The singer's reference says the exact line their speaking voice was chosen with: it reproduces that voice.
    if (!voice.line) throw new TaskError(400, 'remake_speaking_voice', `${o.singerName}'s speaking voice was made before it kept its words: make it again on the Singers page.`);
    const options = CastingSoundtrackOptionsSchema.parse({ scriptTaskId: script.id, singerVoice: { description: voice.description, seed: voice.seed, referenceText: voice.line } });
    const id = randomUUID();
    store.insertTask({ id, ownerId, songId, kind: 'castingSoundtrack', input: stored.canonical, startedAt: this.deps.clock(), options });
    this.deps.events.publish(ownerId, { type: 'task', taskId: id, songId, state: 'running' });
    this.enqueue(ownerId, id, 'castingSoundtrack');
    return store.getTask(ownerId, id)!;
  }

  private checkNoSpeakingVoiceRunning(ownerId: string, singerId: string): void {
    // A speakingVoice task, or Add a singer (whose last steps make the new singer's voice), for this singer.
    const running = this.deps.store
      .listRunningTasks()
      .some(
        (t) =>
          t.ownerId === ownerId &&
          ((t.kind === 'speakingVoice' && SpeakingVoiceOptionsSchema.parse(t.options).singerId === singerId) ||
            (t.kind === 'addSinger' && AddSingerOptionsSchema.parse(t.options).singerId === singerId)),
      );
    if (running) throw new TaskError(409, 'already_running', 'A speaking voice is being made for this singer already.');
  }

  /** Why a task of this kind cannot start on the owner's song now (a TaskError), checked on start and on retry. */
  private checkCanStart(ownerId: string, songId: string, kind: TaskKind, song: Song, o: StartOptions): void {
    const { store } = this.deps;
    const { transcribe: options, ace } = o;
    if (!store.getProject(ownerId, songId)) throw new TaskError(404, 'not_found', 'There is no such song.');
    if (kind === 'aceLayer') {
      if (!ace) throw new Error('checkCanStart: an ACE layer task without its options');
      if (!this.deps.ace) {
        throw new TaskError(503, 'no_ace_service', 'AI tracks are not set up: the brain needs ACE_SERVICE_URL, BRAIN_TASK_FILES_DIR and BRAIN_VOCAL_TAKES_DIR.');
      }
      if (store.activeTask(ownerId, songId, kind)) throw new TaskError(409, 'already_layering', 'An AI track is already being made for this song.');
      try {
        coveredSections(song, ace.range, ace.sectionKinds, ace.sections);
        keyScale(song.key);
      } catch (err) {
        if (err instanceof TaskError) throw err;
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
        planSinging(song, o.sing?.sections);
      } catch (err) {
        if (err instanceof SingError) throw new TaskError(422, 'cannot_sing', err.message);
        throw err;
      }
    }
    if (kind === 'writeRapLyrics') {
      const r = o.rapLyrics;
      if (!r) throw new Error('checkCanStart: a write rap lyrics task without its options');
      if (store.activeTask(ownerId, songId, kind)) throw new TaskError(409, 'already_running', "The rap's lyrics of this song are already being written.");
      if (!this.deps.lyricModel) throw new TaskError(503, 'no_lyric_model', "The rap's lyrics cannot be written: the brain has no language model (ASSISTANT_LLM_URL).");
      const unknown = r.sections.filter((n) => !song.songStructure.some((s) => s.name === n));
      if (unknown.length) throw new TaskError(400, 'unknown_section', `The song has no section ${unknown.map((n) => `"${n}"`).join(', ')}.`);
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
    if (task.kind === 'speakingVoice') {
      const sv = this.deps.speakingVoice;
      if (!sv) throw new TaskError(503, 'no_speech_service', SPEAKING_NOT_SET_UP);
      const o = SpeakingVoiceOptionsSchema.parse(task.options);
      try {
        sv.findSinger(ownerId, o.singerId);
      } catch (err) {
        throw new TaskError(409, 'singer_gone', err instanceof Error ? err.message : String(err));
      }
      this.checkNoSpeakingVoiceRunning(ownerId, o.singerId);
    } else if (task.kind === 'castingSoundtrack') {
      if (!this.deps.castingSoundtrack) throw new TaskError(503, 'no_casting', CASTING_SOUNDTRACK_NOT_SET_UP);
    } else if (task.kind === 'castingScript') {
      if (!this.deps.casting) throw new TaskError(503, 'no_casting', CASTING_NOT_SET_UP);
    } else if (task.kind === 'avatarBuild') {
      if (!this.deps.avatarBuild) throw new TaskError(503, 'no_avatar_builder', AVATAR_BUILD_NOT_SET_UP);
    } else if (task.kind === 'addSinger') {
      const a = this.deps.addSinger;
      if (!a) throw new TaskError(503, 'no_singer_service', ADD_SINGER_NOT_SET_UP);
      const o = AddSingerOptionsSchema.parse(task.options);
      if (!existsSync(join(a.singers.dir(ownerId, o.singerId), o.upload))) throw new TaskError(409, 'upload_gone', 'The uploaded recording is gone: add the singer again.');
    } else this.checkCanStart(
      ownerId,
      songIdOf(task),
      task.kind,
      parseSong(JSON.parse(task.input)),
      {
        ...(task.kind === 'transcribe' ? { transcribe: TranscribeOptionsSchema.parse(task.options) } : {}),
        ...(task.kind === 'aceLayer' ? { ace: AceLayerOptionsSchema.parse(task.options) } : {}),
        ...(task.kind === 'sing' ? { sing: singOptionsOf(task) } : {}),
        ...(task.kind === 'writeRapLyrics' ? { rapLyrics: WriteRapLyricsOptionsSchema.parse(task.options) } : {}),
      },
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
      task.kind === 'transcribe'
        ? this.deps.transcribe?.filesDir
        : task.kind === 'aceLayer'
          ? this.deps.ace?.filesDir
          : task.kind === 'addSinger'
            ? this.deps.addSinger?.filesDir
            : task.kind === 'speakingVoice'
              ? this.deps.speakingVoice?.filesDir
              : task.kind === 'avatarBuild'
                ? this.deps.avatarBuild?.filesDir
                : task.kind === 'castingSoundtrack'
                  ? this.deps.castingSoundtrack?.filesDir
                  : this.deps.sing?.filesDir;
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
      // A task on no song (Add a singer), or of a kind whose result goes into nothing, is done.
      if (now.songId === null || NOTHING_TO_APPLY.has(now.kind)) {
        store.setTaskState(id, { state: 'done', result, message: null, finishedAt: clock() });
        events.publish(ownerId, { type: 'task', taskId: id, songId: now.songId, state: 'done' });
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
    if (task.kind === 'writeRapLyrics') {
      const model = this.deps.lyricModel;
      if (!model) throw new Error("the brain has no language model to write the rap's lyrics with (ASSISTANT_LLM_URL)");
      const input = parseSong(JSON.parse(task.input));
      const o = WriteRapLyricsOptionsSchema.parse(task.options);
      const project = this.deps.store.getProject(task.ownerId, songIdOf(task));
      if (!project) throw new Error(`the owner has no project for song ${songIdOf(task)}`);
      const sections = o.sections.map((name) => {
        const sec = input.songStructure.find((s) => s.name === name);
        if (!sec) throw new Error(`the song has no section "${name}"`);
        return { name, label: sectionLabel(name), lines: rapLineCount(sec.bars.length) };
      });
      const rapLyrics = await writeRapWords(model, { density: RAP_DENSITY, title: project.title, style: o.style, songWords: songWordsOf(input), sections });
      return { rapLyrics };
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
        voice: sing.singerVoice(task.ownerId, singOptionsOf(task).singerId),
        ...(singOptionsOf(task).sections ? { sections: singOptionsOf(task).sections! } : {}),
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
        ...(a.speaking ? { speaking: a.speaking } : {}),
      });
    }
    if (task.kind === 'speakingVoice') {
      const sv = this.deps.speakingVoice;
      if (!sv) throw new Error(SPEAKING_NOT_SET_UP);
      const { store, events, clock } = this.deps;
      const o = SpeakingVoiceOptionsSchema.parse(task.options);
      const voice = await makeSpeakingVoice({
        ownerId: task.ownerId,
        singer: sv.findSinger(task.ownerId, o.singerId),
        ...(o.description ? { description: o.description } : {}),
        deps: sv,
        filesDir: join(resolve(sv.filesDir), task.id),
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
      return { singerId: o.singerId, seed: voice.seed };
    }
    if (task.kind === 'castingSoundtrack') {
      const c = this.deps.castingSoundtrack;
      if (!c) throw new Error(CASTING_SOUNDTRACK_NOT_SET_UP);
      const { store, events, clock } = this.deps;
      const o = CastingSoundtrackOptionsSchema.parse(task.options);
      const scriptTask = store.getTask(task.ownerId, o.scriptTaskId);
      if (!scriptTask || scriptTask.state !== 'done') throw new Error('the casting script this soundtrack was made from is gone: write it again');
      const script = scriptTask.result as CastingScript;
      const filesDir = join(resolve(c.filesDir), task.id);
      let voiceSteps: TaskStep[] = [];
      const own: Record<'export' | 'mix', TaskStep> = {
        export: { id: 'export', label: 'Export the song', state: 'waiting' },
        mix: { id: 'mix', label: 'Mix the soundtrack', state: 'waiting' },
      };
      const publish = () => {
        const now = store.getTask(task.ownerId, task.id);
        if (!now || now.state !== 'running') return;
        store.setTaskSteps(task.id, [...voiceSteps, own.export, own.mix]);
        events.publish(task.ownerId, { type: 'task', taskId: task.id, songId: task.songId, state: 'running' });
      };
      const spoken = await speakLines(
        { client: c.client, filesDir, pollMs: c.pollMs, signal, jobs: task.jobs, setJobs: (jobs) => store.setTaskJobs(task.id, jobs), setSteps: (steps) => ((voiceSteps = steps), publish()) },
        lineVoices(script, o.singerVoice),
      );
      own.export = { ...own.export, state: 'running', startedAt: clock() };
      publish();
      const exported = await c.exportSong(task.ownerId, songIdOf(task));
      own.export = { ...own.export, state: 'done', finishedAt: clock(), text: `${exported.seconds.toFixed(0)} s` };
      own.mix = { ...own.mix, state: 'running', startedAt: clock() };
      publish();
      const song = parseSong(JSON.parse(task.input));
      const timeline = layOut({
        script,
        spoken: new Map([...spoken].map(([id, v]) => [id, { seconds: v.seconds, levels: wavLevels(v.file, CASTING_BIN_SECONDS) }])),
        sections: songTiming(song).sections,
        exportSeconds: exported.seconds,
        // The stage door lasts as long as its music is heard (the file ends with 1.5 s of silence).
        entranceSeconds: audibleSeconds(c.ffmpegBin, join(c.musicDir, CASTING_MUSIC.entrance)),
        binSeconds: CASTING_BIN_SECONDS,
        scriptTaskId: scriptTask.id,
      });
      const outDir = join(filesDir, 'soundtrack');
      mkdirSync(outDir, { recursive: true });
      // Every voice at one loudness: one gain per speaker from all their lines (each line still rising and falling).
      const bySpeaker = new Map<string, string[]>();
      for (const l of timeline.lines) bySpeaker.set(l.speaker, [...(bySpeaker.get(l.speaker) ?? []), spoken.get(l.id)!.file]);
      const perSpeaker = speakerGains(c.ffmpegBin, bySpeaker, CASTING_VOICE_LUFS);
      const gains = new Map(timeline.lines.map((l) => [l.id, perSpeaker.get(l.speaker)!]));
      const applause = pickFor(wavsIn(join(c.musicDir, CASTING_APPLAUSE_DIR)), scriptTask.id, 'applause');
      const verdictBed = pickFor(wavsIn(join(c.musicDir, CASTING_BEDS_DIR)), scriptTask.id, 'verdict music');
      const talkBed = pickFor(wavsIn(join(c.musicDir, CASTING_BEDS_DIR)).filter((f) => f !== verdictBed), scriptTask.id, 'meeting music');
      mixSoundtrack(
        timeline,
        {
          gains,
          applause: join(c.musicDir, CASTING_APPLAUSE_DIR, applause),
          applauseGain: gainTo(c.ffmpegBin, join(c.musicDir, CASTING_APPLAUSE_DIR, applause), APPLAUSE_LUFS),
          verdictBed: join(c.musicDir, CASTING_BEDS_DIR, verdictBed),
          bedGain: gainTo(c.ffmpegBin, join(c.musicDir, CASTING_BEDS_DIR, verdictBed), BED_LUFS),
          talkBed: join(c.musicDir, CASTING_BEDS_DIR, talkBed),
          talkBedGain: gainTo(c.ffmpegBin, join(c.musicDir, CASTING_BEDS_DIR, talkBed), BED_LUFS), lines: new Map([...spoken].map(([id, v]) => [id, v.file])), song: exported.path, poised: join(c.musicDir, CASTING_MUSIC.poised), entrance: join(c.musicDir, CASTING_MUSIC.entrance) },
        join(outDir, 'casting.wav'),
        c.ffmpegBin,
      );
      own.mix = { ...own.mix, state: 'done', finishedAt: clock(), text: `${timeline.durationSeconds.toFixed(0)} s`, files: ['soundtrack/casting.wav'] };
      publish();
      return { ...timeline, music: { applause, verdictBed, talkBed } };
    }
    if (task.kind === 'castingScript') {
      const c = this.deps.casting;
      if (!c) throw new Error(CASTING_NOT_SET_UP);
      const { store, events, clock } = this.deps;
      const o = CastingOptionsSchema.parse(task.options);
      const song = parseSong(JSON.parse(task.input));
      const facts = castingFacts(song, o.title, { name: o.singerName, description: o.singerDescription }, o.avatarName, o.backstory ?? null);
      const labels: Record<SceneId, string> = { backstage: 'Backstage (narrator)', banter: 'The judges meet the singer', verdicts: 'The verdicts' };
      const lines: Record<SceneId, number> = { backstage: 0, banter: 0, verdicts: 0 };
      let current: SceneId = 'backstage';
      const started: Partial<Record<SceneId, string>> = { backstage: clock() };
      const finished: Partial<Record<SceneId, string>> = {};
      const publish = () => {
        const steps: TaskStep[] = SCENES.map((sc) => ({
          id: sc,
          label: labels[sc],
          state: finished[sc] ? 'done' : sc === current ? 'running' : 'waiting',
          ...(started[sc] ? { startedAt: started[sc] } : {}),
          ...(finished[sc] ? { finishedAt: finished[sc] } : {}),
          ...(lines[sc] ? { text: `${lines[sc]} lines` } : {}),
        }));
        const now = store.getTask(task.ownerId, task.id);
        if (!now || now.state !== 'running') return;
        store.setTaskSteps(task.id, steps);
        events.publish(task.ownerId, { type: 'task', taskId: task.id, songId: task.songId, state: 'running' });
      };
      publish();
      const script = await writeScript(c.chat, facts, o.outcome, verdictVotes(o.outcome, songIdOf(task)), signal, (scene) => {
        if (scene !== current) {
          finished[current] = clock();
          current = scene;
          started[scene] = clock();
        }
        lines[scene] += 1;
        publish();
      });
      finished[current] = clock();
      publish();
      return script;
    }
    if (task.kind === 'avatarBuild') {
      const ab = this.deps.avatarBuild;
      if (!ab) throw new Error(AVATAR_BUILD_NOT_SET_UP);
      const { store, events } = this.deps;
      const o = z.object({ design: RealisticDesignSchema }).parse(task.options) as { design: RealisticDesign };
      return await buildAvatar({
        design: o.design,
        deps: ab,
        filesDir: join(resolve(ab.filesDir), task.id),
        signal,
        jobs: task.jobs,
        setJobs: (jobs) => store.setTaskJobs(task.id, jobs),
        setSteps: (steps) => {
          const now = store.getTask(task.ownerId, task.id);
          if (!now || now.state !== 'running') return;
          store.setTaskSteps(task.id, steps);
          events.publish(task.ownerId, { type: 'task', taskId: task.id, songId: null, state: 'running' });
        },
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
    // Sing covers the sections it sang: the other sections keep their takes.
    return applySungVocals(song, result, { partial: true });
  }
  if (task.kind === 'writeRapLyrics') return applyRapLyrics(song, WriteRapLyricsResultSchema.parse(task.result).rapLyrics);
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

/** The owner's latest finished task of a kind on a song, or undefined. */
function latestDone(store: SongsStore, ownerId: string, songId: string, kind: TaskKind): TaskRow | undefined {
  return store
    .listTasks(ownerId, '')
    .filter((t) => t.kind === kind && t.songId === songId && t.state === 'done')
    .sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''))[0];
}

