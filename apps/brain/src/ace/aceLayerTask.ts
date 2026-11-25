// The ACE layer task (docs/superpowers/specs/2026-11-25-ace-layer-design.md): render the song, have ACE-Step's lego
// task play one instrument part over the whole render (svc-ace), cut it into one clip per section it covers (with a
// selection: silence outside the selected bars), store the clips as <sha256>.ogg in the takes directory.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { AceLayerResultSchema, type AceLayerResult } from '@casperaki/arrangement';
import {
  ACE_INSTRUMENT_CAPTIONS,
  ACE_INSTRUMENT_LABELS,
  ACE_INSTRUMENTS,
  aceTrackName,
  vocalTakeFingerprint,
  type Song,
} from '@casperaki/song-schema';

import type { TaskJobs, TaskStep } from '../store.js';
import { CancelledError, followJob, wavSeconds, writeAtomic } from '../sing/singTask.js';
import type { VocalsClient } from '../sing/vocalsClient.js';

export const AceLayerOptionsSchema = z
  .object({
    instrument: z.enum(ACE_INSTRUMENTS),
    /** The user's style words, added to the instrument's description. */
    words: z.string().trim().max(200).optional(),
    /** A selection, in bars from the song's start (end exclusive); none = the whole song. */
    range: z
      .object({ startBar: z.number().min(0), endBar: z.number().positive() })
      .strict()
      .refine((r) => r.endBar > r.startBar, 'the selection must end after it starts')
      .optional(),
    seed: z.number().int().min(0),
  })
  .strict();
export type AceLayerOptions = z.infer<typeof AceLayerOptionsSchema>;

const BEATS_PER_BAR = 4;

export interface AceSection {
  readonly name: string;
  readonly startBar: number;
  readonly bars: number;
}

/** The song's sections in order, with the bar each starts on. */
export function sectionsOf(song: Song): AceSection[] {
  let bar = 0;
  return song.songStructure.map((s) => {
    const section = { name: s.name, startBar: bar, bars: s.bars.length };
    bar += s.bars.length;
    return section;
  });
}

/** The sections a layer covers: all of them, or those the selection touches (a TaskError-worthy Error for a
 *  selection outside the song). */
export function coveredSections(song: Song, range: AceLayerOptions['range']): AceSection[] {
  const all = sectionsOf(song);
  if (!range) return all;
  const covered = all.filter((s) => s.startBar < range.endBar && s.startBar + s.bars > range.startBar);
  if (covered.length === 0) throw new Error(`the selection (bars ${range.startBar + 1}–${range.endBar}) is outside the song`);
  return covered;
}

/** "C" → "C major", "F#m" → "F# minor" (ACE's key form). */
export function keyScale(key: string): string {
  const m = /^([A-G][#b]?)(m?)$/u.exec(key.trim());
  if (!m) throw new Error(`the song's key "${key}" is not a key ACE understands (want e.g. C, F#m)`);
  return `${m[1]} ${m[2] ? 'minor' : 'major'}`;
}

/** What ACE is asked to play: the instrument's description, the user's words, the tempo and the key. */
export function aceCaption(song: Song, options: AceLayerOptions): string {
  const words = options.words?.trim();
  return [ACE_INSTRUMENT_CAPTIONS[options.instrument], ...(words ? [words] : []), `${song.bpm} bpm`, keyScale(song.key)].join(', ');
}

/** Every track name the song uses (instrument tracks and audio-only tracks such as Ad-libs or earlier ACE layers). */
export function trackNames(song: Song): string[] {
  const names = song.instrumentDefinitions.map((d) => d.name);
  for (const a of song.aiArtifacts) if (a.attachedTo.scope === 'segment' && a.attachedTo.instrument) names.push(a.attachedTo.instrument);
  return [...new Set(names)];
}

export interface AceLayerContext {
  readonly taskId: string;
  /** The song as it was when the task started. */
  readonly input: Song;
  readonly options: AceLayerOptions;
  readonly client: VocalsClient;
  /** The task's own files folder (<BRAIN_TASK_FILES_DIR>/<task id>). */
  readonly filesDir: string;
  /** Where clips are stored as <sha256>.ogg (BRAIN_VOCAL_TAKES_DIR). */
  readonly takesDir: string;
  readonly ffmpegBin: string;
  readonly pollMs: number;
  readonly signal: AbortSignal;
  readonly jobs: TaskJobs | null;
  readonly setJobs: (jobs: TaskJobs) => void;
  readonly setSteps: (steps: TaskStep[]) => void;
  readonly now: () => string;
  /** Renders the song (its mix as the user hears it, unmastered): the WAV's path. */
  readonly renderWav: (song: Song) => Promise<string>;
}

type BrainStepId = 'render' | 'clips';
const LABELS: Record<BrainStepId, string> = { render: 'Render the song', clips: 'Cut the part into one clip per section and store them' };

class StepLog {
  private brain: Record<BrainStepId, TaskStep> = {
    render: { id: 'render', label: LABELS.render, state: 'waiting' },
    clips: { id: 'clips', label: LABELS.clips, state: 'waiting' },
  };
  private ace: TaskStep[] = [];
  private last = '';
  constructor(private readonly ctx: AceLayerContext) {}

  private publish(): void {
    const steps = [this.brain.render, ...this.ace, this.brain.clips];
    const key = JSON.stringify(steps);
    if (key === this.last) return;
    this.last = key;
    this.ctx.setSteps(steps);
  }

  service(steps: TaskStep[]): void {
    this.ace = steps;
    this.publish();
  }

  async run<T>(id: BrainStepId, fn: () => Promise<{ value: T; text: string; numbers?: Record<string, number> }>): Promise<T> {
    if (this.ctx.signal.aborted) throw new CancelledError();
    const startedAt = this.ctx.now();
    this.brain[id] = { id, label: LABELS[id], state: 'running', startedAt };
    this.publish();
    try {
      const { value, text, numbers } = await fn();
      this.brain[id] = { id, label: LABELS[id], state: 'done', startedAt, finishedAt: this.ctx.now(), text, ...(numbers ? { numbers } : {}) };
      this.publish();
      return value;
    } catch (err) {
      this.brain[id] = { id, label: LABELS[id], state: 'failed', startedAt, finishedAt: this.ctx.now(), text: err instanceof Error ? err.message : String(err) };
      this.publish();
      throw err;
    }
  }
}

/** Runs the ACE layer task: its result (the layer's clips, stored). */
export async function runAceLayer(ctx: AceLayerContext): Promise<AceLayerResult> {
  const { input, options } = ctx;
  const log = new StepLog(ctx);
  if (ctx.jobs === null) rmSync(ctx.filesDir, { recursive: true, force: true });
  mkdirSync(ctx.filesDir, { recursive: true });
  const covered = coveredSections(input, options.range);
  const track = aceTrackName(options.instrument, trackNames(input));
  const caption = aceCaption(input, options);
  const secPerBar = (BEATS_PER_BAR * 60) / input.bpm;

  const wav = await log.run('render', async () => {
    const path = await ctx.renderWav(input);
    if (ctx.signal.aborted) throw new CancelledError();
    const seconds = wavSeconds(readFileSync(path), 'the render');
    return { value: path, text: `${fmt(seconds)} rendered`, numbers: { seconds } };
  });

  let jobs: TaskJobs;
  if (ctx.jobs?.ace === undefined) {
    if (ctx.signal.aborted) throw new CancelledError();
    jobs = { ace: await ctx.client.submit({ src_wav: wav, track: options.instrument, caption, bpm: input.bpm, key_scale: keyScale(input.key), seed: options.seed }) };
    ctx.setJobs(jobs);
  } else jobs = ctx.jobs;
  const layer = await followJob(ctx, 'ace', jobs.ace!, (steps) => log.service(steps));
  const layerPath = join(ctx.filesDir, 'ace', 'layer.wav');
  writeAtomic(layerPath, layer);

  const takes = await log.run('clips', async () => {
    mkdirSync(ctx.takesDir, { recursive: true });
    const out: Array<{ segment: string; sha256: string; durationSeconds: number; fingerprint: string }> = [];
    for (const s of covered) {
      if (ctx.signal.aborted) throw new CancelledError();
      const start = s.startBar * secPerBar;
      const duration = s.bars * secPerBar;
      // A selection: the clip keeps the section's length (it plays from the section's start) and is silent outside.
      const r = options.range;
      const mute = r ? { from: Math.max(0, (r.startBar - s.startBar) * secPerBar), to: Math.min(duration, (r.endBar - s.startBar) * secPerBar) } : undefined;
      const tmp = join(ctx.takesDir, `.${ctx.taskId}-${s.name}.ogg`);
      await cutClip(ctx.ffmpegBin, layerPath, tmp, start, duration, mute);
      const sha256 = createHash('sha256').update(readFileSync(tmp)).digest('hex');
      const dest = join(ctx.takesDir, `${sha256}.ogg`);
      if (existsSync(dest)) unlinkSync(tmp);
      else renameSync(tmp, dest);
      out.push({ segment: s.name, sha256, durationSeconds: duration, fingerprint: vocalTakeFingerprint(input, s.name, track) });
    }
    return {
      value: out,
      text: `${ACE_INSTRUMENT_LABELS[options.instrument]} on ${track}: ${out.length} clips (${covered.map((s) => s.name).join(', ')})`,
      numbers: { clips: out.length },
    };
  });
  return AceLayerResultSchema.parse({ track, instrument: options.instrument, caption, seed: options.seed, takes });
}

const fmt = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;

/** One section's clip of the layer as Ogg Vorbis: `duration` seconds from `start`, silent outside `keep` when given. */
function cutClip(ffmpegBin: string, src: string, dest: string, start: number, duration: number, keep?: { from: number; to: number }): Promise<void> {
  const filters = [`apad=whole_dur=${duration.toFixed(6)}`];
  if (keep) filters.push(`volume=volume=0:enable='not(between(t,${keep.from.toFixed(6)},${keep.to.toFixed(6)}))'`);
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-ss', start.toFixed(6), '-t', duration.toFixed(6), '-i', src, '-af', filters.join(','), '-t', duration.toFixed(6), '-c:a', 'libvorbis', '-q:a', '6', '-f', 'ogg', dest];
  return new Promise((resolve, reject) => {
    execFile(ffmpegBin, args, (err, _out, stderr) => {
      if (err) reject(new Error(`ffmpeg could not cut the layer for ${dest}: ${stderr.trim() || err.message}`));
      else resolve();
    });
  });
}
