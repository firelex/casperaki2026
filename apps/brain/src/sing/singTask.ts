// The Sing task (docs/superpowers/specs/2026-11-25-sing-and-transcribe-design.md, "Steps"): the brain plans who sings
// what (src/sing/plan.ts), the vocals service's sing stage sings it with SoulX-Singer (every section's lead from the
// Vocal lane, the backing vocals re-pitched from the lead, every take through the vocal chain), and the brain stores
// the takes. Every step, the brain's and the service's, is recorded on the task in the order it runs; each service
// step's files are copied into the task's files folder as the step finishes. The result ({ melody, takes }) goes into
// the song on apply, unless a sung section changed meanwhile (`checkUnchanged`). The melody is the Vocal lane's own
// notes: Sing keeps the melody exactly as written.
//
// The brain only sends requests and waits (the service does the model work); it polls the service every `pollMs`.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { SungMelodySchema, type SungMelody, type SungTake } from '@casperaki/arrangement';
import { SUNG_TAKE_KINDS, vocalTakeFingerprint, type Song } from '@casperaki/song-schema';

import type { TaskJobs, TaskStep } from '../store.js';
import { planSinging, type SingPlan } from './plan.js';
import type { ServiceStep, VocalsClient } from './vocalsClient.js';

/** The message a Sing task fails with when a sung section changed before its result went in. */
export const SONG_CHANGED = 'The song changed while it was being sung: sing again';

/** Backing vocals under their section's lead (dB, loudness of the singing parts): the owner's demo. */
export const BACKING_DB = -9;

/** Every take Sing makes is SoulX-Singer's. */
const TAKE_KIND = 'soulx-vocal' as const;
const MODEL = { modelId: 'Soul-AILab/SoulX-Singer', modelVersion: 'SoulX-Singer + SoulX-Singer-SVC' } as const;

/** The task was cancelled. */
export class CancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'CancelledError';
  }
}

/** A sung section changed between the task's start and its apply. */
export class SongChangedError extends Error {
  constructor(
    readonly detail: string,
    message: string = SONG_CHANGED,
  ) {
    super(message);
    this.name = 'SongChangedError';
  }
}

const SungTakeSchema = z
  .object({
    segment: z.string().min(1),
    track: z.string().min(1),
    kind: z.enum(SUNG_TAKE_KINDS),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    durationSeconds: z.number().positive(),
    modelId: z.string().min(1),
    modelVersion: z.string().min(1),
    seed: z.number().int().optional(),
  })
  .strict();

export const SingResultSchema = z.object({ melody: SungMelodySchema, takes: z.array(SungTakeSchema) }).strict();
export type SingResult = { melody: SungMelody; takes: SungTake[] };

/** The sing stage's sing.json. */
const SingJsonSchema = z.object({
  takes: z.array(
    z.object({
      segment: z.string().min(1),
      track: z.string().min(1),
      kind: z.literal(TAKE_KIND),
      file: z.string().min(1),
      durationSeconds: z.number(),
    }),
  ),
});

export interface SingContext {
  readonly taskId: string;
  /** The song as it was when the task started. */
  readonly input: Song;
  readonly client: VocalsClient;
  /** The task's own files folder (<BRAIN_TASK_FILES_DIR>/<task id>). */
  readonly filesDir: string;
  /** Where takes are stored as <sha256>.ogg (BRAIN_VOCAL_TAKES_DIR). */
  readonly takesDir: string;
  readonly ffmpegBin: string;
  readonly pollMs: number;
  readonly signal: AbortSignal;
  /** The service jobs recorded before a restart (resumed), or null for a fresh start. */
  readonly jobs: TaskJobs | null;
  readonly setJobs: (jobs: TaskJobs) => void;
  /** Records the steps on the task (and tells pages); does nothing once the task is no longer running. */
  readonly setSteps: (steps: TaskStep[]) => void;
  readonly now: () => string;
}

type BrainStepId = 'plan' | 'store-takes';
const BRAIN_LABELS: Record<BrainStepId, string> = {
  plan: 'Plan who sings what',
  'store-takes': 'Store the takes',
};

/** The task's steps: the brain's two around the sing stage's, in the order they run. */
class StepLog {
  private readonly brain: Record<BrainStepId, TaskStep> = {
    plan: { id: 'plan', label: BRAIN_LABELS.plan, state: 'waiting' },
    'store-takes': { id: 'store-takes', label: BRAIN_LABELS['store-takes'], state: 'waiting' },
  };
  private sing: TaskStep[] = [];
  private last = '';

  constructor(private readonly ctx: SingContext) {}

  private publish(): void {
    const steps = [this.brain.plan, ...this.sing, this.brain['store-takes']];
    const key = JSON.stringify(steps);
    if (key === this.last) return;
    this.last = key;
    this.ctx.setSteps(steps);
  }

  service(steps: TaskStep[]): void {
    this.sing = steps;
    this.publish();
  }

  /** Runs a brain step: running, then done with its text and numbers (or failed with the error). */
  async run<T>(id: BrainStepId, fn: () => Promise<{ value: T; text: string; numbers?: Record<string, number> }>): Promise<T> {
    if (this.ctx.signal.aborted) throw new CancelledError();
    const startedAt = this.ctx.now();
    this.brain[id] = { id, label: BRAIN_LABELS[id], state: 'running', startedAt };
    this.publish();
    try {
      const { value, text, numbers } = await fn();
      this.brain[id] = { id, label: BRAIN_LABELS[id], state: 'done', startedAt, finishedAt: this.ctx.now(), text, ...(numbers ? { numbers } : {}) };
      this.publish();
      return value;
    } catch (err) {
      this.brain[id] = { id, label: BRAIN_LABELS[id], state: 'failed', startedAt, finishedAt: this.ctx.now(), text: err instanceof Error ? err.message : String(err) };
      this.publish();
      throw err;
    }
  }
}

const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

/** Sing's service stage; its step files are kept in its own subfolder of the task's files folder. */
export const SING_STAGE = 'sing';
/** Every service stage a task runs (Sing's, Transcribe melody's, the ACE layer's): the subfolders step files are
 *  served from. "lead" and "repeats" are the folders of Sing tasks run before 2026-11-25 (YuE2), still served. */
export const TASK_FILE_STAGES = [SING_STAGE, 'transcribe', 'ace', 'lead', 'repeats'] as const;
export type TaskFileStage = (typeof TASK_FILE_STAGES)[number];

/** A step's files as the task lists them: "<stage>/<name>" (GET /api/tasks/:id/files/<stage>/<name>). */
function taskStep(stage: TaskFileStage, s: ServiceStep): TaskStep {
  return {
    id: s.id,
    label: s.label,
    state: s.state,
    startedAt: iso(s.started),
    ...(s.finished !== null ? { finishedAt: iso(s.finished) } : {}),
    ...(s.text ? { text: s.text } : {}),
    ...(Object.keys(s.numbers).length > 0 ? { numbers: { ...s.numbers } } : {}),
    ...(s.files.length > 0 ? { files: s.files.map((f) => `${stage}/${f}`) } : {}),
  };
}

/** A plain file name (no folders), as step files are. */
export function isPlainFileName(name: string): boolean {
  return /^[\w][\w.-]*$/u.test(name) && !name.includes('..');
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    timer.unref?.();
    signal.addEventListener('abort', done, { once: true });
  });
}

/** Writes a file whole or not at all: a temporary name in the same folder, then renamed (resume skips files that
 *  exist, so a half-written one must never carry the real name). */
export function writeAtomic(dest: string, data: Buffer): void {
  const tmp = `${dest}.part-${process.pid}`;
  writeFileSync(tmp, data);
  renameSync(tmp, dest);
}

/** What following a service job needs: the service, the task's files folder, the poll interval, the cancel signal. */
export interface JobFollowing {
  readonly client: VocalsClient;
  readonly filesDir: string;
  readonly pollMs: number;
  readonly signal: AbortSignal;
}

/** Polls a service job to its end, copying its steps (`onSteps`) and their files (into <filesDir>/<stage>/); the
 *  job's result file. Cancelled → the job is cancelled too and CancelledError thrown. */
export async function followJob(f: JobFollowing, stage: TaskFileStage, job: string, onSteps: (steps: TaskStep[]) => void): Promise<Buffer> {
  const { client } = f;
  const dir = join(f.filesDir, stage);
  mkdirSync(dir, { recursive: true });
  for (;;) {
    if (f.signal.aborted) {
      await client.cancel(job);
      throw new CancelledError();
    }
    const r = await client.result(job);
    // A name listed by several steps of one job is one file in the job's folder (e.g. a unit's score, listed by
    // each seed's take): fetched once.
    for (const s of r.steps) {
      if (s.state !== 'done') continue;
      for (const name of s.files) {
        if (!isPlainFileName(name)) throw new Error(`the vocal service's step ${s.id} listed a file "${name}" that is not a plain file name`);
        const dest = join(dir, name);
        if (!existsSync(dest)) writeAtomic(dest, await client.file(job, name));
      }
    }
    onSteps(r.steps.map((x) => taskStep(stage, x)));
    if (r.state === 'done') return await client.file(job);
    if (r.state === 'error') throw new Error(r.error ?? `the vocal service's ${stage} job failed without saying why`);
    await sleep(f.pollMs, f.signal);
  }
}

/** Runs the Sing task: its result. */
export async function runSing(ctx: SingContext): Promise<SingResult> {
  const { client, input } = ctx;
  const log = new StepLog(ctx);
  if (ctx.jobs === null) rmSync(ctx.filesDir, { recursive: true, force: true });
  mkdirSync(ctx.filesDir, { recursive: true });

  const plan = await log.run('plan', async () => {
    const value = planSinging(input);
    return { value, ...describePlan(value) };
  });

  let job: string;
  if (ctx.jobs === null) {
    if (ctx.signal.aborted) throw new CancelledError();
    job = await client.submit(singParams(input, plan));
    ctx.setJobs({ sing: job });
  } else {
    if (ctx.jobs.sing === undefined) {
      throw new Error('this sing was started by an earlier version of Sing (with YuE2), which cannot be resumed: sing again');
    }
    job = ctx.jobs.sing;
  }
  const file = await followJob(ctx, SING_STAGE, job, (steps) => log.service(steps));
  writeAtomic(join(ctx.filesDir, SING_STAGE, 'sing.json'), file);
  const sung = SingJsonSchema.parse(JSON.parse(file.toString('utf8')));

  const takes = await log.run('store-takes', async () => {
    const value = await storeTakes(ctx, plan, sung.takes);
    return { value, text: `${value.length} takes stored`, numbers: { takes: value.length } };
  });
  return { melody: melodyOf(plan), takes };
}

/** The sung melody recorded on apply: every sung section's Vocal lane notes, as written. */
export function melodyOf(plan: SingPlan): SungMelody {
  return Object.fromEntries(plan.sections.map((s) => [s.segment, s.notes.map((n) => ({ ...n, phonemes: [...n.phonemes] }))]));
}

function describePlan(plan: SingPlan): { text: string; numbers: Record<string, number> } {
  const lines = plan.backings.map((b) => `${b.track} in ${b.segment}${b.shift === 0 ? '' : ` ${b.shift > 0 ? '+' : ''}${b.shift}`}`);
  return {
    text: `SoulX sings ${plan.sections.map((s) => s.segment).join(', ')}; backing vocals: ${lines.length > 0 ? lines.join(', ') : 'none'}`,
    numbers: { sections: plan.sections.length, backingLines: plan.backings.length },
  };
}

/** The sing stage's params (pipeline/sing.py). */
export function singParams(song: Song, plan: SingPlan): Record<string, unknown> {
  return {
    stage: SING_STAGE,
    bpm: song.bpm,
    backing_db: BACKING_DB,
    sections: plan.sections.map((s) => ({ segment: s.segment, section_bars: s.sectionBars, notes: s.notes })),
    backings: plan.backings.map((b) => ({ track: b.track, segment: b.segment, notes: b.notes })),
  };
}

/** Length of a WAV file in seconds (from its fmt and data chunks). */
export function wavSeconds(buf: Buffer, name: string): number {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`${name} is not a WAV file`);
  let blockAlign: number | undefined;
  let rate: number | undefined;
  for (let at = 12; at + 8 <= buf.length; ) {
    const id = buf.toString('ascii', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    if (id === 'fmt ') {
      rate = buf.readUInt32LE(at + 12);
      blockAlign = buf.readUInt16LE(at + 20);
    } else if (id === 'data') {
      if (rate === undefined || blockAlign === undefined || blockAlign === 0) throw new Error(`${name}: its data comes before its format`);
      return size / blockAlign / rate;
    }
    at += 8 + size + (size % 2);
  }
  throw new Error(`${name} has no audio data`);
}

/**
 * The gain every stored vocal take gets (dB), applied once, here, where every take of the song passes (`storeTakes`):
 * the service levels the takes against the chorus take near full scale, and the vocal lanes play at unity on the vocals
 * bus with reverb and delay sends on top, so without it the unmastered render clips where the vocals peak. The takes
 * keep their levels relative to each other. Measured on the end-to-end song of 2026-11-25 (EDM, 128 bpm): samples at
 * or above -0.1 dBFS in the unmastered render 173 -> 26, in the vocals alone 12 -> 2; the vocals bus's compressor
 * (Logical4) makes up most of the lower input, so the rest is for the bus's output level (mix-config), not the takes.
 */
export const TAKE_GAIN_DB = -3;

/** A take's WAV encoded as Ogg Vorbis at TAKE_GAIN_DB. */
export function encodeTake(ffmpegBin: string, src: string, dest: string): Promise<void> {
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', src, '-af', `volume=${TAKE_GAIN_DB}dB`, '-c:a', 'libvorbis', '-q:a', '6', '-f', 'ogg', dest];
  return new Promise((resolve, reject) => {
    execFile(ffmpegBin, args, (err, _out, stderr) => {
      if (err) reject(new Error(`ffmpeg could not encode ${src}: ${stderr.trim() || err.message}`));
      else resolve();
    });
  });
}

/** Every take of the sing stage encoded and stored as <sha256>.ogg; every sung section must have its lead take and
 *  every backing line its take. */
async function storeTakes(ctx: SingContext, plan: SingPlan, sung: readonly { segment: string; track: string; file: string }[]): Promise<SungTake[]> {
  const wanted = [...plan.sections.map((s) => `${s.segment}/Vocal`), ...plan.backings.map((b) => `${b.segment}/${b.track}`)];
  const got = sung.map((t) => `${t.segment}/${t.track}`);
  const missing = wanted.filter((w) => !got.includes(w));
  if (missing.length > 0) throw new Error(`the vocal service's sing.json has no take for ${missing.join(', ')}`);
  const extra = got.filter((g) => !wanted.includes(g));
  if (extra.length > 0) throw new Error(`the vocal service's sing.json has takes nobody asked for: ${extra.join(', ')}`);

  mkdirSync(ctx.takesDir, { recursive: true });
  const takes: SungTake[] = [];
  for (const t of sung) {
    if (ctx.signal.aborted) throw new CancelledError();
    const src = join(ctx.filesDir, SING_STAGE, t.file);
    if (!existsSync(src)) throw new Error(`the take ${t.file} (${t.track} in ${t.segment}) was not among the files the vocal service's steps made`);
    const durationSeconds = wavSeconds(readFileSync(src), t.file);
    const tmp = join(ctx.takesDir, `.${ctx.taskId}-${SING_STAGE}-${t.file}.ogg`);
    await encodeTake(ctx.ffmpegBin, src, tmp);
    const sha256 = createHash('sha256').update(readFileSync(tmp)).digest('hex');
    const dest = join(ctx.takesDir, `${sha256}.ogg`);
    if (existsSync(dest)) unlinkSync(tmp);
    else renameSync(tmp, dest);
    takes.push({ segment: t.segment, track: t.track, kind: TAKE_KIND, sha256, durationSeconds, ...MODEL });
  }
  return takes;
}

/**
 * Throws SongChangedError when the song changed under a sung section between the task's start (`input`) and now
 * (`current`): the tempo, or any sung section's bars, chords or vocal lanes (the take fingerprint of every sung
 * section × vocal track), or a sung section gone.
 */
export function checkUnchanged(input: Song, current: Song, result: SingResult): void {
  if (input.bpm !== current.bpm) throw new SongChangedError(`the tempo changed from ${input.bpm} to ${current.bpm} bpm`);
  const segments = [...new Set([...Object.keys(result.melody), ...result.takes.map((t) => t.segment)])];
  const vocal = (song: Song) => song.instrumentDefinitions.filter((d) => d.instrumentGroup === 'Vocal').map((d) => d.name);
  const tracks = [...new Set([...vocal(input), ...vocal(current), ...result.takes.map((t) => t.track)])];
  for (const segment of segments) {
    if (!current.songStructure.some((s) => s.name === segment) || !current.arrangement[segment]) throw new SongChangedError(`the section ${segment} is gone`);
    for (const track of tracks) {
      if (vocalTakeFingerprint(input, segment, track) !== vocalTakeFingerprint(current, segment, track)) {
        throw new SongChangedError(`${track} in ${segment} changed`);
      }
    }
  }
}
