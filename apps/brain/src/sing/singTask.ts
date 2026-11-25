// The Sing task (docs/superpowers/specs/2026-11-25-sing-and-transcribe-design.md, "Steps"): the brain plans who sings
// what, the vocals service sings the lead (YuE2, checked against our chords, transcribed), the brain puts the sung lead
// into the song and reads the backing-vocal lines the generator makes from it, the service sings the repeats (SoulX
// copies, backing vocals, extensions, ad-libs), and the brain stores the takes. Every step, the brain's and the
// service's, is recorded on the task in the order it runs; each service step's files are copied into the task's
// files folder as the step finishes. The result ({ melody, takes }) goes into the song on apply, unless a sung
// section changed meanwhile (`checkUnchanged`).
//
// The brain only sends requests and waits (the service does the model work); it polls the service every `pollMs`.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { generatorParams, orchestrate, segmentType, SUNG_MELODY_PARAM, SungMelodySchema, SungNoteSchema, type SungMelody, type SungTake } from '@casperaki/arrangement';
import { SUNG_TAKE_KINDS, vocalTakeFingerprint, type Song } from '@casperaki/song-schema';

import type { TaskJobs, TaskStep } from '../store.js';
import { adlibGapBars, followSung, planSinging, SingError, type SingPlan, type SungNote } from './plan.js';
import type { ServiceStep, VocalsClient } from './vocalsClient.js';

/** The message a Sing task fails with when a sung section changed before its result went in. */
export const SONG_CHANGED = 'The song changed while it was being sung: sing again';

/** Seeds per YuE2 unit and the harmony threshold (share of a section's half-beats on our chord). */
export const SING_SEEDS = 3;
export const SING_THRESHOLD = 0.7;
/** Backing vocals and ad-libs under the lead (dB). */
const BACKING_DB = -6;
const ADLIB_DB = -4;

const LEAD_TRACK = 'Vocal';
const BACKING_TRACKS = ['Backing vocals 1', 'Backing vocals 2'] as const;
const BEATS_PER_BAR = 4;
/** Every sung note (lane + octave) must lie within F3..A5. */
const LOWEST_SUNG = 53;
const HIGHEST_SUNG = 81;

const MODELS = {
  'yue2-vocal': { modelId: 'm-a-p/YuE2-3B', modelVersion: 'yue2_infer 0.1.5' },
  'soulx-vocal': { modelId: 'Soul-AILab/SoulX-Singer', modelVersion: 'SoulX-Singer + SoulX-Singer-SVC' },
} as const;

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

const LeadJsonSchema = z.object({
  units: z.record(
    z.string(),
    z.object({ take: z.string().min(1), seed: z.number().int(), chords_match: z.number(), melody: z.array(SungNoteSchema).min(1) }),
  ),
});
type LeadJson = z.infer<typeof LeadJsonSchema>;

const RepeatsJsonSchema = z.object({
  takes: z.array(
    z.object({
      segment: z.string().min(1),
      track: z.string().min(1),
      kind: z.enum(SUNG_TAKE_KINDS),
      file: z.string().min(1),
      durationSeconds: z.number(),
      /** The YuE2 seed (the ad-lib takes). */
      seed: z.number().int().optional(),
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

type BrainStepId = 'plan' | 'backing-lines' | 'store-takes';
const BRAIN_LABELS: Record<BrainStepId, string> = {
  plan: 'Plan who sings what',
  'backing-lines': 'Put the sung lead into the song and write the backing vocal lines',
  'store-takes': 'Store the takes',
};

/** The task's steps: the brain's three around the two service stages', in the order they run. */
class StepLog {
  private readonly brain: Record<BrainStepId, TaskStep> = {
    plan: { id: 'plan', label: BRAIN_LABELS.plan, state: 'waiting' },
    'backing-lines': { id: 'backing-lines', label: BRAIN_LABELS['backing-lines'], state: 'waiting' },
    'store-takes': { id: 'store-takes', label: BRAIN_LABELS['store-takes'], state: 'waiting' },
  };
  private lead: TaskStep[] = [];
  private repeats: TaskStep[] = [];
  private last = '';

  constructor(private readonly ctx: SingContext) {}

  private publish(): void {
    const steps = [this.brain.plan, ...this.lead, this.brain['backing-lines'], ...this.repeats, this.brain['store-takes']];
    const key = JSON.stringify(steps);
    if (key === this.last) return;
    this.last = key;
    this.ctx.setSteps(steps);
  }

  service(stage: SingStage, steps: TaskStep[]): void {
    if (stage === 'lead') this.lead = steps;
    else this.repeats = steps;
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

/** The two service stages; each keeps its step files in its own subfolder of the task's files folder. */
export const SING_STAGES = ['lead', 'repeats'] as const;
export type SingStage = (typeof SING_STAGES)[number];
/** Every service stage a task runs (Sing's two, Transcribe melody's one): the subfolders step files are served from. */
export const TASK_FILE_STAGES = [...SING_STAGES, 'transcribe', 'ace'] as const;
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
  const follow = (stage: SingStage, job: string) => followJob(ctx, stage, job, (steps) => log.service(stage, steps));

  const plan = await log.run('plan', async () => {
    const value = planSinging(input);
    return { value, ...describePlan(value) };
  });

  let jobs: TaskJobs;
  if (ctx.jobs === null) {
    if (ctx.signal.aborted) throw new CancelledError();
    jobs = { lead: await client.submit(leadParams(input, plan)) };
    ctx.setJobs(jobs);
  } else jobs = ctx.jobs;
  const leadJob = jobs.lead;
  if (leadJob === undefined) throw new Error('the sing task recorded its jobs without the lead job');
  const leadFile = await follow('lead', leadJob);
  writeAtomic(join(ctx.filesDir, 'lead', 'lead.json'), leadFile);
  const lead = parseLead(leadFile, plan);

  const sung = await log.run('backing-lines', async () => {
    const value = backingLines(input, plan, lead, leadJob);
    const backings = value.params.backings as unknown[];
    return {
      value,
      text:
        `Sung melody in ${Object.keys(value.melody).length} sections; backing vocal lines: ` +
        (value.shifts.length > 0 ? value.shifts.join(', ') : 'none') +
        (value.adlibNote ? `; ${value.adlibNote}` : ''),
      numbers: { sections: Object.keys(value.melody).length, backingLines: backings.length },
    };
  });

  if (jobs.repeats === undefined) {
    if (ctx.signal.aborted) throw new CancelledError();
    jobs = { ...jobs, repeats: await client.submit(sung.params) };
    ctx.setJobs(jobs);
  }
  const repeatsFile = await follow('repeats', jobs.repeats!);
  writeAtomic(join(ctx.filesDir, 'repeats', 'repeats.json'), repeatsFile);
  const repeats = RepeatsJsonSchema.parse(JSON.parse(repeatsFile.toString('utf8')));

  const takes = await log.run('store-takes', async () => {
    const value = await storeTakes(ctx, plan, lead, repeats.takes);
    return { value, text: `${value.length} takes stored`, numbers: { takes: value.length } };
  });
  return { melody: sung.melody, takes };
}

function describePlan(plan: SingPlan): { text: string; numbers: Record<string, number> } {
  const parts = [`YuE2 sings ${plan.units.map((u) => u.id).join(', ')}`];
  if (plan.reuses.length > 0) parts.push(`the same take in ${plan.reuses.map((r) => r.segment).join(', ')}`);
  if (plan.copies.length > 0) parts.push(`SoulX sings ${plan.copies.map((c) => `${c.segment} (as ${c.from})`).join(', ')}`);
  if (plan.adlibChoruses.length > 0) parts.push(`ad-libs in ${plan.adlibChoruses.join(', ')}`);
  parts.push(`sung ${plan.octave > 0 ? '+' : ''}${plan.octave} semitones from the Vocal lane`);
  return {
    text: parts.join('; '),
    numbers: { units: plan.units.length, reuses: plan.reuses.length, copies: plan.copies.length, extensions: plan.extensions.length, octave: plan.octave },
  };
}

function leadParams(song: Song, plan: SingPlan): Record<string, unknown> {
  return { stage: 'lead', bpm: song.bpm, key: song.key, style: plan.style, octave: plan.octave, seeds: SING_SEEDS, threshold: SING_THRESHOLD, units: plan.units };
}

function parseLead(file: Buffer, plan: SingPlan): LeadJson {
  const lead = LeadJsonSchema.parse(JSON.parse(file.toString('utf8')));
  for (const u of plan.units) {
    if (!lead.units[u.id]) throw new Error(`the vocal service's lead.json has no unit "${u.id}"`);
  }
  return lead;
}

type LaneEvent = { type?: string; note: number; duration: number; fullWord?: string; vocaloidPhonemes?: string[] };

/** A lane's vocal notes in a section as SungNotes (beats from the section start). */
export function laneNotes(song: Song, segment: string, track: string): SungNote[] {
  const bars = (song.arrangement[segment]?.overrides?.[track]?.bars ?? []) as unknown as readonly { notes?: Record<string, readonly unknown[] | undefined> }[];
  const out: SungNote[] = [];
  bars.forEach((bar, barIndex) => {
    for (const [key, evs] of Object.entries(bar.notes ?? {})) {
      for (const e of (evs ?? []) as LaneEvent[]) {
        if (e.type !== 'vocalNote') continue;
        const where = `${track} in ${segment} bar ${barIndex + 1} beat ${key}`;
        if (!e.fullWord) throw new SingError(`${where}: a note without a word: write lyrics first`);
        if (!e.vocaloidPhonemes || e.vocaloidPhonemes.length === 0) throw new SingError(`${where}: a note without phonemes: write lyrics first`);
        out.push({ start: barIndex * BEATS_PER_BAR + Number.parseFloat(key), duration: e.duration, midi: e.note, word: e.fullWord, phonemes: [...e.vocaloidPhonemes] });
      }
    }
  });
  return out.sort((a, b) => a.start - b.start);
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteName = (midi: number) => `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;

function sectionBars(song: Song, segment: string): number {
  const s = song.songStructure.find((x) => x.name === segment);
  if (!s) throw new Error(`the song has no section "${segment}"`);
  return s.bars.length;
}

/**
 * The sung melody of every sung section (units and reuses as YuE2 sang them; copies following their unit's sung melody,
 * with an extension's own sung bars joined on), the song regenerated with it, and the repeats stage's params with the
 * backing-vocal lines the generator writes from it.
 */
export function backingLines(
  input: Song,
  plan: SingPlan,
  lead: LeadJson,
  leadJob: string,
): { melody: SungMelody; params: Record<string, unknown>; shifts: string[]; adlibNote?: string } {
  const extUnits = new Set(plan.extensions.map((e) => e.unit));
  const sungOf = (unit: string) => lead.units[unit]!.melody;
  const melody: SungMelody = {};
  for (const u of plan.units) if (!extUnits.has(u.id)) melody[u.id] = sungOf(u.id);
  for (const r of plan.reuses) melody[r.segment] = sungOf(r.from);
  const copies = plan.copies.map((c) => {
    const unit = plan.units.find((u) => u.id === c.from);
    if (!unit) throw new Error(`${c.segment} copies "${c.from}", which is not a unit of the plan`);
    const target = laneNotes(input, c.segment, LEAD_TRACK).filter((n) => n.start < c.sungBars * BEATS_PER_BAR);
    const notes = followSung(target, unit.notes, sungOf(c.from), c.segment);
    const ext = plan.extensions.find((e) => e.segment === c.segment);
    const extNotes = ext ? sungOf(ext.unit).map((n) => ({ ...n, start: n.start + ext.fromBar * BEATS_PER_BAR })) : [];
    melody[c.segment] = [...notes, ...extNotes].map((n) => ({ ...n, phonemes: [...n.phonemes] }));
    return { segment: c.segment, from: c.from, section_bars: sectionBars(input, c.segment), notes, voice: `${c.from}_section.wav` };
  });

  const chorus = plan.units.find((u) => segmentType(u.id) === 'chorus' && !extUnits.has(u.id));
  if (!chorus) throw new SingError('Sing needs a sung chorus: its take is the voice and the loudness the other parts are matched to');
  const voice = `${chorus.id}_section.wav`;

  const gp = generatorParams(input);
  const regenerated = orchestrate({ ...gp, params: { ...(gp.params ?? {}), [SUNG_MELODY_PARAM]: melody } });
  const order = input.songStructure.map((s) => s.name).filter((name) => melody[name] !== undefined);
  const backings: Record<string, unknown>[] = [];
  /** Each line with its own octave shift (semitones), for the step's text. */
  const shifts: string[] = [];
  for (const segment of order) {
    for (const track of BACKING_TRACKS) {
      const notes = laneNotes(regenerated, segment, track);
      if (notes.length === 0) continue;
      const delta = backingShift(
        notes.map((n) => n.midi),
        melody[segment]!.map((n) => n.midi),
        plan.octave,
        `${track} in ${segment}`,
      );
      const shifted = notes.map((n) => ({ ...n, midi: n.midi + delta }));
      shifts.push(`${track} in ${segment}${delta === 0 ? '' : ` ${delta > 0 ? '+' : ''}${delta}`}`);
      backings.push({ track, segment, section_bars: sectionBars(input, segment), notes: shifted, voice });
    }
  }

  let adlibs: Record<string, unknown> | null = null;
  let adlibNote: string | undefined;
  if (plan.adlibChoruses.length > 0) {
    const gaps = adlibGapBars(sungOf(chorus.id), sectionBars(input, chorus.id));
    if (gaps.length === 0) adlibNote = `no ad-libs: the sung ${chorus.id} leaves no gap of two beats`;
    else {
      adlibs = {
        chorus_unit: chorus.id,
        lead_in_chords: chorus.lead_in_chords,
        chords: chorus.chords,
        tail_chords: chorus.tail_chords,
        melody: sungOf(chorus.id),
        gaps_bars: gaps,
        segments: plan.adlibChoruses,
        seeds: SING_SEEDS,
        threshold: SING_THRESHOLD,
      };
    }
  }

  const params = {
    stage: 'repeats',
    lead_job: leadJob,
    bpm: input.bpm,
    octave: plan.octave,
    style: plan.style,
    copies,
    backings,
    extensions: plan.extensions.map((e) => ({ segment: e.segment, unit: e.unit, from_bar: e.fromBar, section_bars: sectionBars(input, e.segment) })),
    adlibs,
    levels: { reference: voice, backing_db: BACKING_DB, adlib_db: ADLIB_DB },
  };
  return { melody, params, shifts, ...(adlibNote ? { adlibNote } : {}) };
}

const median = (xs: readonly number[]): number => {
  const v = [...xs].sort((a, b) => a - b);
  const mid = v.length / 2;
  return v.length % 2 ? v[Math.floor(mid)]! : (v[mid - 1]! + v[mid]!) / 2;
};

/** Whole-octave shifts a backing line may take on top of the song's octave, lowest first (a tie goes to the lower). */
const BACKING_SHIFTS = [-24, -12, 0, 12, 24] as const;

/**
 * A backing line's own octave (semitones added to its lane notes before they go to the repeats stage, which sings
 * them at lane + the song's octave): the shift whose median sung note is nearest the lead's sung median in the same
 * section, among shifts that keep every note of the line within F3..A5; a tie goes to the lower shift. No shift fits →
 * SingError naming the line (`where`: "<track> in <section>") and its range as sung at the song's octave.
 */
export function backingShift(line: readonly number[], lead: readonly number[], octave: number, where: string): number {
  if (line.length === 0) throw new Error(`${where}: a backing line without notes`);
  if (lead.length === 0) throw new Error(`${where}: no sung lead in the section to place the backing line against`);
  const lo = Math.min(...line);
  const hi = Math.max(...line);
  const leadMedian = median(lead) + octave;
  const lineMedian = median(line) + octave;
  let best: number | undefined;
  for (const d of BACKING_SHIFTS) {
    if (lo + octave + d < LOWEST_SUNG || hi + octave + d > HIGHEST_SUNG) continue;
    if (best === undefined || Math.abs(lineMedian + d - leadMedian) < Math.abs(lineMedian + best - leadMedian)) best = d;
  }
  if (best === undefined) {
    throw new SingError(
      `${where} spans ${noteName(lo + octave)}-${noteName(hi + octave)}, which no octave shift puts within the singable range ${noteName(LOWEST_SUNG)}-${noteName(HIGHEST_SUNG)}`,
    );
  }
  return best;
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

/** Every take (the lead stage's units and reuses, the repeats stage's takes) encoded and stored as <sha256>.ogg. */
async function storeTakes(
  ctx: SingContext,
  plan: SingPlan,
  lead: LeadJson,
  repeatsTakes: readonly { segment: string; track: string; kind: (typeof SUNG_TAKE_KINDS)[number]; file: string; seed?: number }[],
): Promise<SungTake[]> {
  const extUnits = new Set(plan.extensions.map((e) => e.unit));
  const wanted: { segment: string; track: string; kind: (typeof SUNG_TAKE_KINDS)[number]; stage: SingStage; file: string; seed?: number }[] = [];
  for (const u of plan.units) {
    if (extUnits.has(u.id)) continue;
    wanted.push({ segment: u.id, track: LEAD_TRACK, kind: 'yue2-vocal', stage: 'lead', file: lead.units[u.id]!.take, seed: lead.units[u.id]!.seed });
  }
  for (const r of plan.reuses) wanted.push({ segment: r.segment, track: LEAD_TRACK, kind: 'yue2-vocal', stage: 'lead', file: lead.units[r.from]!.take, seed: lead.units[r.from]!.seed });
  for (const t of repeatsTakes) {
    wanted.push({ segment: t.segment, track: t.track, kind: t.kind, stage: 'repeats', file: t.file, ...(t.seed !== undefined ? { seed: t.seed } : {}) });
  }

  mkdirSync(ctx.takesDir, { recursive: true });
  const stored = new Map<string, { sha256: string; durationSeconds: number }>();
  const takes: SungTake[] = [];
  for (const w of wanted) {
    if (ctx.signal.aborted) throw new CancelledError();
    const key = `${w.stage}/${w.file}`;
    let s = stored.get(key);
    if (!s) {
      const src = join(ctx.filesDir, w.stage, w.file);
      if (!existsSync(src)) throw new Error(`the take ${w.file} (${w.track} in ${w.segment}) was not among the files the vocal service's steps made`);
      const durationSeconds = wavSeconds(readFileSync(src), w.file);
      const tmp = join(ctx.takesDir, `.${ctx.taskId}-${w.stage}-${w.file}.ogg`);
      await encodeTake(ctx.ffmpegBin, src, tmp);
      const sha256 = createHash('sha256').update(readFileSync(tmp)).digest('hex');
      const dest = join(ctx.takesDir, `${sha256}.ogg`);
      if (existsSync(dest)) unlinkSync(tmp);
      else renameSync(tmp, dest);
      s = { sha256, durationSeconds };
      stored.set(key, s);
    }
    takes.push({
      segment: w.segment,
      track: w.track,
      kind: w.kind,
      sha256: s.sha256,
      durationSeconds: s.durationSeconds,
      ...MODELS[w.kind],
      ...(w.seed !== undefined ? { seed: w.seed } : {}),
    });
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
