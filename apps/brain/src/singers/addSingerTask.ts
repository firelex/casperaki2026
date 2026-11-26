// Add a singer: a recording the user uploads made into a singer for Sing, by the vocals service's add_singer stage
// (apps/models/services/vocals/pipeline/add_singer.py: separation when it is a full song, compression, Resemble
// Enhance, the silences cut, a voice reference of about 10 s chosen at a pause, transcribed into SoulX-Singer's
// description, and a test line sung in the new voice). The brain keeps the upload in the singer's folder
// (src/singers/userSingers.ts), runs the stage as a background task with every step recorded, then stores the
// singer's files and adds it to the owner's list.

import { execFile } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { CancelledError, followJob, writeAtomic } from '../sing/singTask.js';
import type { VocalsClient } from '../sing/vocalsClient.js';
import type { TaskJobs, TaskStep } from '../store.js';
import { REFERENCE_CHOICES, type UserSingers } from './userSingers.js';

/** The longest recording a singer can be made from (seconds). */
export const MAX_RECORDING_SECONDS = 300;
/** The largest upload accepted (bytes): 5 minutes of 48 kHz 24-bit stereo WAV is about 86 MB. */
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
/** The vocals service's stage, and the subfolder of the task's files folder its step files are kept in. */
export const ADD_SINGER_STAGE = 'add_singer';
export const SINGER_FILES_STAGE = 'singer';

/** What an Add a singer task was started with (kept on the task: Retry runs it again from the kept upload). */
export const AddSingerOptionsSchema = z
  .object({
    singerId: z.string().regex(/^u-[0-9a-f]{12}$/u),
    name: z.string().min(1).max(60),
    description: z.string().min(1).max(300),
    /** The recording is a full song: its lead vocal is separated first. */
    separate: z.boolean(),
    reference: z.enum(REFERENCE_CHOICES),
    /** The upload's file name in the singer's folder. */
    upload: z.string().regex(/^original\.[a-z0-9]{1,8}$/u),
  })
  .strict();
export type AddSingerOptions = z.infer<typeof AddSingerOptionsSchema>;

/** The stage's add_singer.json. */
const AddSingerJsonSchema = z.object({
  audio: z.literal('voice.wav'),
  meta: z.literal('voice.json'),
  testLine: z.literal('test_line.wav'),
  reference: z
    .object({
      choice: z.enum(REFERENCE_CHOICES),
      startSeconds: z.number(),
      endSeconds: z.number(),
      recordingStartSeconds: z.number(),
      recordingEndSeconds: z.number(),
      seconds: z.number().positive(),
    })
    .strict(),
  transcription: z.enum(['words', 'la']),
  heard: z.string(),
  testLinePitch: z.object({ notes: z.number(), within: z.number(), medianErrorSemitones: z.number() }).strict(),
});

/** The task's result: the new singer's id. */
export const AddSingerResultSchema = z.object({ singerId: z.string() }).strict();

/** Where the voice came from, as the Singers page shows it. */
export function sourceOf(options: AddSingerOptions, transcription: 'words' | 'la', heard: string): string {
  const from = options.separate ? 'the vocals separated from an uploaded song' : 'an uploaded recording';
  const sung = transcription === 'la' ? 'sung as "la la la"' : `with the words "${heard}"`;
  return `Made from ${from} (the uploader confirmed the right to use this voice); its voice reference is ${sung}.`;
}

/** The length of an audio file (seconds), decoded by ffmpeg; an Error saying the file is not audio when ffmpeg cannot
 *  read it. */
export function recordingSeconds(ffmpegBin: string, path: string): Promise<number> {
  const rate = 8000;
  return new Promise((resolve, reject) => {
    execFile(ffmpegBin, ['-v', 'error', '-i', path, '-vn', '-ac', '1', '-ar', String(rate), '-f', 's16le', '-'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }, (err, out, stderr) => {
      if (err) reject(new Error(`The file could not be read as audio: ${stderr.toString().trim().slice(-300) || err.message}`));
      else if (out.length === 0) reject(new Error('The file holds no audio.'));
      else resolve(out.length / 2 / rate);
    });
  });
}

export interface AddSingerContext {
  readonly taskId: string;
  readonly ownerId: string;
  readonly options: AddSingerOptions;
  readonly singers: UserSingers;
  readonly client: VocalsClient;
  /** The task's own files folder (<BRAIN_TASK_FILES_DIR>/<task id>). */
  readonly filesDir: string;
  readonly pollMs: number;
  readonly signal: AbortSignal;
  readonly jobs: TaskJobs | null;
  readonly setJobs: (jobs: TaskJobs) => void;
  readonly setSteps: (steps: TaskStep[]) => void;
  readonly now: () => string;
}

const KEEP = { id: 'keep', label: 'Keep the singer' } as const;

/** Runs the task: the stage's job, then the singer's files stored and the singer listed. */
export async function runAddSinger(ctx: AddSingerContext): Promise<{ singerId: string }> {
  const { options, singers } = ctx;
  const dir = singers.dir(ctx.ownerId, options.singerId);
  const upload = join(dir, options.upload);
  if (!existsSync(upload)) throw new Error(`the uploaded recording ${upload} is gone: add the singer again`);
  let service: TaskStep[] = [];
  let keep: TaskStep = { ...KEEP, state: 'waiting' };
  const publish = () => ctx.setSteps([...service, keep]);
  publish();

  let job: string;
  if (ctx.jobs?.addSinger !== undefined) job = ctx.jobs.addSinger;
  else {
    if (ctx.signal.aborted) throw new CancelledError();
    job = await ctx.client.submit({ stage: ADD_SINGER_STAGE, upload, separate: options.separate, reference: options.reference });
    ctx.setJobs({ addSinger: job });
  }
  const file = await followJob(ctx, SINGER_FILES_STAGE, job, (steps) => {
    service = steps;
    publish();
  });
  const stageDir = join(ctx.filesDir, SINGER_FILES_STAGE);
  writeAtomic(join(stageDir, 'add_singer.json'), file);
  const made = AddSingerJsonSchema.parse(JSON.parse(file.toString('utf8')));

  const startedAt = ctx.now();
  keep = { ...KEEP, state: 'running', startedAt };
  publish();
  try {
    if (ctx.signal.aborted) throw new CancelledError();
    for (const name of [made.audio, made.meta, made.testLine]) {
      const src = join(stageDir, name);
      if (!existsSync(src)) throw new Error(`${name} was not among the files the vocal service's steps made`);
      copyFileSync(src, join(dir, name));
    }
    singers.add(ctx.ownerId, {
      id: options.singerId,
      name: options.name,
      description: options.description,
      source: sourceOf(options, made.transcription, made.heard),
      audio: made.audio,
      meta: made.meta,
      testLine: made.testLine,
      original: options.upload,
      reference: made.reference,
      transcription: made.transcription,
      heard: made.heard,
      createdAt: ctx.now(),
    });
    keep = { ...KEEP, state: 'done', startedAt, finishedAt: ctx.now(), text: `${options.name} is ready to sing` };
    publish();
  } catch (err) {
    keep = { ...KEEP, state: 'failed', startedAt, finishedAt: ctx.now(), text: err instanceof Error ? err.message : String(err) };
    publish();
    throw err;
  }
  return { singerId: options.singerId };
}
