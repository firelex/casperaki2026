// Transcribe melody (docs/superpowers/specs/2026-11-25-sing-and-transcribe-design.md): a recording the user brings of
// one section, sung or hummed along from the section's first beat at the song's tempo, written back into that
// section's Vocal lane. The result is a Sing result for that section only ({ melody: { [section]: notes }, takes: [] },
// applied with `partial`, so the song's other sections keep their sung melody and takes).
//
// Steps:
//   recording   the brain decodes the upload (any format ffmpeg reads) to WAV.
//   With written lyrics for the section: the vocals service's transcribe stage (pipeline/transcribe.py run) finds the
//     section's Vocal-lane note count (held "-" positions included) as the strongest note starts, as Sing's lead stage
//     transcribes YuE2's takes; its steps are recorded and their files kept under <task files>/transcribe/.
//   Without written lyrics: the hum service's pitch-only notes (POST /transcribe in click mode at the song's tempo,
//     the first beat at 0 s). A recording with music behind the voice (`hasBacking`) first goes through the vocals
//     service's stage for the voice alone (BS-RoFormer); a clean recording is read as it is.
//   words       with lyrics: the found notes take the lane's words and phonemes in order (one per note); without:
//     the lane's words (the phrase bank's) are attached as the generator attaches them (laneWordsOn).
// Notes come back in the lane's register: the transcription (at sung pitch; pitch-only notes snapped to the song's key,
// as the vocals stage snaps its own) moved by the whole octaves (-24..+24) that put its median nearest the median of
// the section's Vocal-lane notes (`laneOctaveShift`; a tie goes to the higher), so anyone's voice lands where the
// lane is.

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { generatorParams, laneWordsOn, type SungNote } from '@casperaki/arrangement';
import { parseKey, scalePitchClasses } from '@casperaki/music-theory';
import type { Song } from '@casperaki/song-schema';

import type { TaskJobs, TaskStep } from '../store.js';
import { CancelledError, followJob, laneNotes, wavSeconds, writeAtomic, type SingResult } from './singTask.js';
import { JobLostError, type VocalsClient } from './vocalsClient.js';

/** Whole-octave shifts a transcription may take to land in the lane's register, lowest first. */
const OCTAVE_SHIFTS = [-24, -12, 0, 12, 24] as const;

const median = (xs: readonly number[]): number => {
  if (xs.length === 0) throw new Error('median of no notes');
  const v = [...xs].sort((a, b) => a - b);
  const mid = v.length / 2;
  return v.length % 2 ? v[Math.floor(mid)]! : (v[mid - 1]! + v[mid]!) / 2;
};

/** The whole-octave shift (-24..+24) putting the median of `notes` nearest the median of `lane` (a tie: the higher). */
export function laneOctaveShift(notes: readonly number[], lane: readonly number[]): number {
  const target = median(lane);
  const m = median(notes);
  let best: number = OCTAVE_SHIFTS[0];
  for (const d of OCTAVE_SHIFTS) if (Math.abs(m + d - target) <= Math.abs(m + best - target)) best = d;
  return best;
}

/** The nearest note of the key's scale (a chromatic note goes to the closer neighbour, down on a tie), as the vocals
 *  service's transcription snaps. */
export function snapToKey(midi: number, key: string): number {
  const pcs = scalePitchClasses(parseKey(key));
  const inKey = (m: number) => pcs.includes(((m % 12) + 12) % 12);
  if (inKey(midi)) return midi;
  if (inKey(midi - 1)) return midi - 1;
  if (inKey(midi + 1)) return midi + 1;
  throw new Error(`snapToKey: ${midi} has no note of ${key} a semitone away`);
}

/** The largest recording accepted (decoded bytes): one section, not a whole song. */
export const MAX_RECORDING_BYTES = 10 * 1024 * 1024;

/** The message a Transcribe melody task fails with when its section changed before its result went in. */
export const TRANSCRIBE_CHANGED = 'The song changed while the recording was being transcribed: transcribe again';

const LEAD_TRACK = 'Vocal';
const BEATS_PER_BAR = 4;

/** What a transcribe task needs besides the song (kept on the task: its `options`). */
export const TranscribeOptionsSchema = z
  .object({
    /** The section the recording is of (generator name). */
    segment: z.string().min(1),
    /** The uploaded file's name in <task files>/input/. */
    recording: z.string().min(1),
    /** The recording has music behind the voice: the voice is separated first. */
    hasBacking: z.boolean(),
  })
  .strict();
export type TranscribeOptions = z.infer<typeof TranscribeOptionsSchema>;

/** Whether the song has written lyrics for the section (generator params `lyrics`). */
export function sectionHasLyrics(song: Song, segment: string): boolean {
  const lyrics = (generatorParams(song).params?.['lyrics'] ?? {}) as Readonly<Record<string, readonly unknown[] | undefined>>;
  return (lyrics[segment]?.length ?? 0) > 0;
}

/** The services a transcription needs: the vocals service with lyrics or backing, the hum service without lyrics. */
export function transcribeNeeds(song: Song, options: Pick<TranscribeOptions, 'segment' | 'hasBacking'>): { vocals: boolean; hum: boolean } {
  const lyrics = sectionHasLyrics(song, options.segment);
  return { vocals: lyrics || options.hasBacking, hum: !lyrics };
}

const StageResultSchema = z
  .object({
    section: z.string(),
    voice: z.string().min(1),
    notes: z.array(z.object({ start: z.number().min(0), duration: z.number().positive(), midi: z.number().int() })).nullable(),
  })
  .strict();

const HumAnswerSchema = z.object({ notes: z.array(z.object({ onsetSec: z.number(), offsetSec: z.number(), midi: z.number() })) });

export interface TranscribeContext {
  readonly taskId: string;
  /** The song as it was when the task started. */
  readonly input: Song;
  readonly options: TranscribeOptions;
  /** The vocals service (needed with lyrics or backing). */
  readonly client: VocalsClient | undefined;
  /** The hum service's base URL (needed without lyrics). */
  readonly humServiceUrl: string | undefined;
  /** The task's own files folder (<BRAIN_TASK_FILES_DIR>/<task id>). */
  readonly filesDir: string;
  readonly ffmpegBin: string;
  readonly pollMs: number;
  readonly signal: AbortSignal;
  /** The service job recorded before a restart (resumed), or null for a fresh start. */
  readonly jobs: TaskJobs | null;
  readonly setJobs: (jobs: TaskJobs) => void;
  readonly setSteps: (steps: TaskStep[]) => void;
  readonly now: () => string;
}

type BrainStepId = 'recording' | 'hum' | 'words';
const LABELS: Record<BrainStepId, string> = {
  recording: 'Read the recording',
  hum: 'Write down the hummed melody (hum service)',
  words: 'Put the words on the notes',
};

/** The task's steps: the brain's around the service stage's, in the order they run. */
class Steps {
  private readonly brain = new Map<BrainStepId, TaskStep>();
  private service: TaskStep[] = [];
  private last = '';

  constructor(
    private readonly ctx: TranscribeContext,
    private readonly hum: boolean,
  ) {
    for (const id of ['recording', ...(hum ? (['hum'] as const) : []), 'words'] as BrainStepId[]) this.brain.set(id, { id, label: LABELS[id], state: 'waiting' });
  }

  private publish(): void {
    const b = (id: BrainStepId) => (this.brain.has(id) ? [this.brain.get(id)!] : []);
    const steps = [...b('recording'), ...this.service, ...b('hum'), ...b('words')];
    const key = JSON.stringify(steps);
    if (key === this.last) return;
    this.last = key;
    this.ctx.setSteps(steps);
  }

  services(steps: TaskStep[]): void {
    this.service = steps;
    this.publish();
  }

  async run<T>(id: BrainStepId, fn: () => Promise<{ value: T; text: string; numbers?: Record<string, number> }>): Promise<T> {
    if (this.ctx.signal.aborted) throw new CancelledError();
    const startedAt = this.ctx.now();
    this.brain.set(id, { id, label: LABELS[id], state: 'running', startedAt });
    this.publish();
    try {
      const { value, text, numbers } = await fn();
      this.brain.set(id, { id, label: LABELS[id], state: 'done', startedAt, finishedAt: this.ctx.now(), text, ...(numbers ? { numbers } : {}) });
      this.publish();
      return value;
    } catch (err) {
      this.brain.set(id, { id, label: LABELS[id], state: 'failed', startedAt, finishedAt: this.ctx.now(), text: err instanceof Error ? err.message : String(err) });
      this.publish();
      throw err;
    }
  }
}

/** Decodes any recording ffmpeg reads to 44.1 kHz mono 16-bit WAV. */
function decodeToWav(ffmpegBin: string, src: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(ffmpegBin, ['-y', '-hide_banner', '-loglevel', 'error', '-i', src, '-ac', '1', '-ar', '44100', '-c:a', 'pcm_s16le', '-f', 'wav', dest], (err, _out, stderr) => {
      if (err) reject(new Error(`The recording could not be read (ffmpeg: ${stderr.trim() || err.message})`));
      else resolve();
    });
  });
}

function sectionBeats(song: Song, segment: string): number {
  const s = song.songStructure.find((x) => x.name === segment);
  if (!s) throw new Error(`the song has no section "${segment}"`);
  return s.bars.length * BEATS_PER_BAR;
}

/**
 * The hum service's notes (seconds from the section's first beat, sung pitch) on our 16th grid, snapped to `key`
 * (still at sung pitch): starts and ends rounded to 16ths (at least a 16th long); two notes starting on one 16th keep the
 * longer (as hum to song does); notes starting outside the section are left out; each lasts at most until
 * the next note and the section's end.
 */
export function humNotesOnGrid(
  notes: readonly { onsetSec: number; offsetSec: number; midi: number }[],
  bpm: number,
  beats: number,
  key: string,
  segment: string,
): { start: number; duration: number; midi: number }[] {
  const q = (sec: number) => Math.round((sec * bpm * 4) / 60) / 4;
  const on = notes
    .map((n) => ({ start: q(n.onsetSec), end: q(n.offsetSec), midi: snapToKey(Math.round(n.midi), key) }))
    .map((n) => ({ ...n, duration: Math.max(0.25, n.end - n.start) }))
    .filter((n) => n.start >= 0 && n.start < beats)
    .sort((a, b) => a.start - b.start);
  const kept: { start: number; duration: number; midi: number }[] = [];
  for (const n of on) {
    const prev = kept[kept.length - 1];
    if (prev && prev.start === n.start) {
      if (n.duration > prev.duration) kept[kept.length - 1] = { start: n.start, duration: n.duration, midi: n.midi };
      continue;
    }
    kept.push({ start: n.start, duration: n.duration, midi: n.midi });
  }
  if (kept.length === 0) throw new Error(`No notes were heard in the recording of ${segment}.`);
  return kept.map((n, i) => {
    const limit = (kept[i + 1]?.start ?? beats) - n.start;
    return { ...n, duration: Math.min(n.duration, limit) };
  });
}

/** Runs the Transcribe melody task: its result (a Sing result for the one section, no takes). */
export async function runTranscribe(ctx: TranscribeContext): Promise<SingResult> {
  const { input, options } = ctx;
  const segment = options.segment;
  const needs = transcribeNeeds(input, options);
  const log = new Steps(ctx, needs.hum);
  const inputDir = join(ctx.filesDir, 'input');
  if (ctx.jobs === null) rmSync(join(ctx.filesDir, 'transcribe'), { recursive: true, force: true });
  const beats = sectionBeats(input, segment);
  const lane = laneNotes(input, segment, LEAD_TRACK);
  if (lane.length === 0) throw new Error(`${segment} has no notes in the Vocal lane`);

  const wav = await log.run('recording', async () => {
    const src = join(inputDir, options.recording);
    if (!existsSync(src)) throw new Error(`the task's recording ${options.recording} is missing from its files`);
    const dest = join(inputDir, 'recording.wav');
    await decodeToWav(ctx.ffmpegBin, src, dest);
    const data = readFileSync(dest);
    const seconds = wavSeconds(data, 'the recording');
    return { value: { path: dest, data }, text: `${seconds.toFixed(1)} s`, numbers: { seconds: Math.round(seconds * 100) / 100 } };
  });

  let stage: z.infer<typeof StageResultSchema> | undefined;
  if (needs.vocals) {
    const client = ctx.client;
    if (!client) throw new Error('Transcribe melody needs the vocals service (VOCALS_SERVICE_URL) for this recording');
    let job = ctx.jobs?.transcribe;
    if (job === undefined) {
      if (ctx.signal.aborted) throw new CancelledError();
      job = await client.submit({
        stage: 'transcribe',
        section: segment,
        bpm: input.bpm,
        key: input.key,
        octave: 0, // notes come back at sung pitch; the brain moves them to the lane's octave
        section_beats: beats,
        count: needs.hum ? null : lane.length,
        has_backing: options.hasBacking,
        audio: wav.data.toString('base64'),
      });
      ctx.setJobs({ transcribe: job });
    }
    let file: Buffer;
    try {
      file = await followJob({ client, filesDir: ctx.filesDir, pollMs: ctx.pollMs, signal: ctx.signal }, 'transcribe', job, (steps) => log.services(steps));
    } catch (err) {
      if (err instanceof JobLostError) throw new Error('the vocal service lost the job: transcribe again');
      throw err;
    }
    writeAtomic(join(ctx.filesDir, 'transcribe', 'transcribe.json'), file);
    stage = StageResultSchema.parse(JSON.parse(file.toString('utf8')));
    if (stage.section !== segment) throw new Error(`the vocal service transcribed ${stage.section}, not ${segment}`);
  }

  let pitchOnly: { start: number; duration: number; midi: number }[] | undefined;
  if (needs.hum) {
    const url = ctx.humServiceUrl;
    if (!url) throw new Error('Transcribe melody needs the hum service (HUM_SERVICE_URL) for a section without written lyrics');
    const voice = stage ? join(ctx.filesDir, 'transcribe', stage.voice) : wav.path;
    pitchOnly = await log.run('hum', async () => {
      if (!existsSync(voice)) throw new Error(`the voice to transcribe (${voice}) is missing`);
      const form = new FormData();
      form.append('audio', new Blob([readFileSync(voice)], { type: 'audio/wav' }), 'voice.wav');
      form.append('mode', 'click');
      form.append('bpm', String(input.bpm));
      form.append('firstBeatSec', '0');
      const res = await fetch(`${url.replace(/\/+$/u, '')}/transcribe`, { method: 'POST', body: form, signal: ctx.signal });
      if (!res.ok) throw new Error(`the hum service answered ${res.status}: ${await res.text()}`);
      const answer = HumAnswerSchema.parse(await res.json());
      const value = humNotesOnGrid(answer.notes, input.bpm, beats, input.key, segment);
      return { value, text: `${value.length} notes (${answer.notes.length} heard)`, numbers: { notes: value.length, heard: answer.notes.length } };
    });
  }

  const melody = await log.run('words', async () => {
    const sung = pitchOnly ?? stage?.notes;
    if (!sung) throw new Error(`the vocal service sent no notes for ${segment}`);
    const shift = laneOctaveShift(
      sung.map((n) => n.midi),
      lane.map((n) => n.midi),
    );
    const notes = sung.map((n) => {
      const midi = n.midi + shift;
      if (midi < 0 || midi > 127) throw new Error(`${segment}: a note at beat ${n.start} lands outside MIDI 0-127 (${midi})`);
      return { start: n.start, duration: n.duration, midi };
    });
    let value: SungNote[];
    if (pitchOnly) {
      const bars = input.arrangement[segment]?.overrides?.[LEAD_TRACK]?.bars;
      if (!bars) throw new Error(`${segment} has no Vocal lane`);
      value = laneWordsOn(segment, bars, notes);
    } else {
      if (notes.length !== lane.length) throw new Error(`${segment}: the vocal service found ${notes.length} notes for the lane's ${lane.length}`);
      value = notes.map((n, i) => ({ ...n, word: lane[i]!.word, phonemes: [...lane[i]!.phonemes] }));
    }
    const moved = shift === 0 ? 'as sung' : `moved ${shift > 0 ? 'up' : 'down'} ${Math.abs(shift) / 12} octave${Math.abs(shift) === 12 ? '' : 's'} to the lane`;
    return { value, text: `${value.length} notes with the ${pitchOnly ? "lane's" : 'written'} words, ${moved}`, numbers: { notes: value.length, octaveShift: shift } };
  });
  return { melody: { [segment]: melody }, takes: [] };
}

/** Keeps an uploaded recording in the task's files (<task files>/input/upload; ffmpeg tells its format from its
 *  content): its file name. */
export function keepRecording(taskFilesDir: string, data: Buffer): string {
  const name = 'upload';
  const dir = join(taskFilesDir, 'input');
  mkdirSync(dir, { recursive: true });
  writeAtomic(join(dir, name), data);
  return name;
}
