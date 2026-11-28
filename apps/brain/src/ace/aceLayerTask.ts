// The ACE layer task (docs/superpowers/specs/2026-11-25-ace-layer-design.md): render the song, have ACE-Step's lego
// task play one instrument part over the whole render (svc-ace), cut it into one clip per section it covers (with a
// selection: silence outside the selected bars), store the clips as <sha256>.ogg in the takes directory.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { AceLayerResultSchema, writtenLyricsOf, type AceLayerResult } from '@casperaki/arrangement';
import {
  ACE_INSTRUMENT_CAPTIONS,
  ACE_INSTRUMENT_LABELS,
  ACE_ADLIB_VOICES,
  ACE_INSTRUMENTS,
  aceTrackName,
  aceTrackOf,
  RAP_TRACK,
  rapLineCount,
  vocalTakeFingerprint,
  type Song,
} from '@casperaki/song-schema';

import type { TaskJobs, TaskStep } from '../store.js';
import { integratedLoudnessOf } from '../audio/loudness.js';
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
    /** The kinds of section the layer plays in ("verse", "chorus", …, as sectionKind names them); none = all. ACE still
     *  plays over the whole song; sections of other kinds get no clip. */
    sectionKinds: z.array(z.string().min(1)).min(1).optional(),
    /** The sections the layer plays in, by name (ad-libs: the final chorus(es)); none = all. */
    sections: z.array(z.string().min(1)).min(1).optional(),
    /** Ad-libs only: the words ACE sings (under every chorus), and the voice (ACE's backing_vocals or vocals track). */
    lyrics: z.string().trim().min(1).max(1000).optional(),
    voice: z.enum(ACE_ADLIB_VOICES).optional(),
    /** Rap only: every section's words (section name → its lines, one per line of text), as the Rap dialog has them
     *  (written by Write rap lyrics, edited by the user). */
    rapWords: z.record(z.string().min(1), z.string().trim().min(1).max(1000)).optional(),
    seed: z.number().int().min(0),
  })
  .strict()
  .refine((o) => o.instrument !== 'rap' || o.sections !== undefined, 'rap needs the sections it goes in')
  .refine((o) => o.instrument !== 'rap' || (o.range === undefined && o.sectionKinds === undefined), 'rap is chosen by section, not by a selection or section kinds')
  .refine((o) => (o.rapWords === undefined) || o.instrument === 'rap', 'only rap takes rap words')
  .refine((o) => o.instrument !== 'rap' || (o.sections ?? []).every((n) => o.rapWords?.[n] !== undefined), 'rap needs the words of every section it goes in (write rap lyrics first)')
  .refine((o) => o.instrument !== 'rap' || (o.words?.trim() ?? '') !== '', "rap needs its style (the rapper's voice and flow)")
  .refine((o) => !o.rapWords || Object.keys(o.rapWords).every((n) => o.sections?.includes(n)), 'rap words are only for the sections the rap goes in')
  .refine((o) => (o.instrument === 'adlibs') === (o.lyrics !== undefined), 'ad-libs need their words, and only ad-libs take words')
  .refine((o) => (o.instrument === 'adlibs') === (o.voice !== undefined), 'ad-libs need a voice, and only ad-libs take one');
export type AceLayerOptions = z.infer<typeof AceLayerOptionsSchema>;

const BEATS_PER_BAR = 4;
/** Rap: ACE takes per round for each section (svc-ace keeps the clearest; spike 2026-11-27). */
export const RAP_TAKES = 4;
/** The level a layer is brought to, as the sample library's tonal samples are (~-24 LUFS integrated): the engine's
 *  per-instrument levels (mix-config.json) assume it, so the layer sits in the mix like its instrument would. */
export const ACE_LAYER_LUFS = -24;

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

/** A section's kind: its name without the number ("chorus2" → "chorus", "preChorus1" → "preChorus"). */
export function sectionKind(name: string): string {
  const m = /^[A-Za-z]+/u.exec(name);
  if (!m) throw new Error(`the section "${name}" has no kind (its name does not start with letters)`);
  return m[0];
}

/** The sections a layer covers: all of them, or those the selection touches, of the chosen kinds (an Error for a
 *  selection outside the song, a kind the song does not have, or nothing left to cover). */
export function coveredSections(song: Song, range: AceLayerOptions['range'], kinds?: readonly string[], names?: readonly string[]): AceSection[] {
  const all = sectionsOf(song);
  let covered = all;
  if (names) {
    const unknown = names.filter((n) => !all.some((s) => s.name === n));
    if (unknown.length) throw new Error(`the song has no section ${unknown.map((n) => `"${n}"`).join(', ')}`);
    covered = covered.filter((s) => names.includes(s.name));
  }
  if (range) {
    covered = covered.filter((s) => s.startBar < range.endBar && s.startBar + s.bars > range.startBar);
    if (covered.length === 0) throw new Error(`the selection (bars ${range.startBar + 1}–${range.endBar}) is outside the song`);
  }
  if (kinds) {
    const songKinds = new Set(all.map((s) => sectionKind(s.name)));
    const unknown = kinds.filter((k) => !songKinds.has(k));
    if (unknown.length) throw new Error(`the song has no section of the kind ${unknown.map((k) => `"${k}"`).join(', ')}`);
    covered = covered.filter((s) => kinds.includes(sectionKind(s.name)));
    if (covered.length === 0) throw new Error(`the selection has no section of the chosen kinds (${kinds.join(', ')})`);
  }
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
  // Rap is ACE repainting the section of the song without its vocals (docs/superpowers/specs/
  // 2026-11-28-rap-like-singing-design.md), so the caption describes that music with a rapper on it: fast, high-energy,
  // spoken (owner 2026-11-28: "It's not a rap. It's sung." then "it's a tad slow. More energy.").
  if (options.instrument === 'rap') {
    if (!words) throw new Error("rap needs its style (the rapper's voice and flow)");
    return `hip-hop, rap, ${words}, fast high-energy rap, aggressive punchy delivery, rapid-fire spoken word flow on the beat, punchy drums, no singing, no sung melody, ${song.bpm} bpm`;
  }
  return [ACE_INSTRUMENT_CAPTIONS[options.instrument], ...(words ? [words] : []), `${song.bpm} bpm`, keyScale(song.key)].join(', ');
}

const ACE_TAGS: Readonly<Record<string, string>> = { intro: 'Intro', verse: 'Verse', preChorus: 'Pre-Chorus', chorus: 'Chorus', bridge: 'Bridge', outro: 'Outro' };

/** ACE's lyrics for ad-libs: every section of the song as a tag in song order (another kind as an instrumental
 *  break), the user's words under each chorus. */
export function aceLyrics(song: Song, words: string): string {
  return song.songStructure
    .map((s) => {
      const kind = sectionKind(s.name);
      const tag = ACE_TAGS[kind] ?? 'Instrumental Break';
      return kind === 'chorus' ? `[${tag}]\n${words.trim()}` : `[${tag}]`;
    })
    .join('\n\n');
}

/** Every track name the song uses (instrument tracks and audio-only tracks such as Ad-libs or earlier ACE layers). */
export function trackNames(song: Song): string[] {
  const names = song.instrumentDefinitions.map((d) => d.name);
  for (const a of song.aiArtifacts) if (a.attachedTo.scope === 'segment' && a.attachedTo.instrument) names.push(a.attachedTo.instrument);
  return [...new Set(names)];
}

const SECTION_LABELS: Readonly<Record<string, string>> = { intro: 'Intro', verse: 'Verse', preChorus: 'Pre-chorus', chorus: 'Chorus', bridge: 'Bridge', outro: 'Outro' };

/** A section as people call it: "verse2" → "Verse 2", "preChorus1" → "Pre-chorus 1". */
export function sectionLabel(name: string): string {
  const kind = sectionKind(name);
  const label = SECTION_LABELS[kind];
  if (!label) throw new Error(`the section "${name}" is of a kind (${kind}) with no name for people`);
  const n = name.slice(kind.length);
  return n ? `${label} ${n}` : label;
}

/** The song's sung words, each section's once, in song order (for the rap's writer). */
export function songWordsOf(song: Song): string[] {
  const lyrics = writtenLyricsOf((song.generator?.params as { params?: Record<string, unknown> } | undefined)?.params);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of song.songStructure) {
    const lines = lyrics[s.name];
    if (!lines || seen.has(lines.join('\n'))) continue;
    seen.add(lines.join('\n'));
    out.push(...lines);
  }
  return out;
}

/** The lines of a user's rap words (empty lines dropped). */
export const rapLinesOf = (text: string) => text.split('\n').map((l) => l.trim()).filter(Boolean);

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
  const covered = coveredSections(input, options.range, options.sectionKinds, options.sections);
  const rap = options.instrument === 'rap';
  const log = new StepLog(ctx);
  if (ctx.jobs === null) rmSync(ctx.filesDir, { recursive: true, force: true });
  mkdirSync(ctx.filesDir, { recursive: true });
  const track = rap ? RAP_TRACK : aceTrackName(options.instrument, trackNames(input));
  const caption = aceCaption(input, options);
  const secPerBar = (BEATS_PER_BAR * 60) / input.bpm;

  const wav = await log.run('render', async () => {
    // Rap is made over the song without its takes (no singing, no earlier rap or layers): its drums, bass and chords,
    // so ACE raps on the beat and in the key, and the rap's words come out clearly (spike 2026-11-28).
    const path = await ctx.renderWav(rap ? { ...input, aiArtifacts: [] } : input);
    if (ctx.signal.aborted) throw new CancelledError();
    const seconds = wavSeconds(readFileSync(path), 'the render');
    return { value: path, text: `${fmt(seconds)} rendered`, numbers: { seconds } };
  });

  // Rap: every section's lines, as the Rap dialog sent them.
  const rapWords = rap
    ? Object.fromEntries(
        covered.map((sec) => {
          const text = options.rapWords?.[sec.name];
          if (text === undefined) throw new Error(`the rap has no words for ${sec.name}: write rap lyrics first`);
          return [sec.name, rapLinesOf(text)];
        }),
      )
    : undefined;

  let jobs: TaskJobs;
  if (ctx.jobs?.ace === undefined) {
    if (ctx.signal.aborted) throw new CancelledError();
    jobs = {
      ace: await ctx.client.submit({
        src_wav: wav,
        track: aceTrackOf(options.instrument, options.voice),
        caption,
        bpm: input.bpm,
        key_scale: keyScale(input.key),
        seed: options.seed,
        ...(options.lyrics !== undefined ? { lyrics: aceLyrics(input, options.lyrics) } : {}),
        ...(rapWords
          ? {
              takes: RAP_TAKES,
              sections: covered.map((s) => ({ name: s.name, start: s.startBar * secPerBar, end: (s.startBar + s.bars) * secPerBar, lyrics: rapWords![s.name]!.join('\n') })),
            }
          : {}),
      }),
    };
    ctx.setJobs(jobs);
  } else jobs = ctx.jobs;
  const layer = await followJob(ctx, 'ace', jobs.ace!, (steps) => log.service(steps));
  const layerPath = join(ctx.filesDir, 'ace', 'layer.wav');
  writeAtomic(layerPath, layer);

  const takes = await log.run('clips', async () => {
    // One gain for the whole layer (measured over the whole song), so its sections keep their levels to each other.
    const lufs = await integratedLoudnessOf(ctx.ffmpegBin, [layerPath], "ACE's part (nothing to add)");
    const gainDb = ACE_LAYER_LUFS - lufs;
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
      await cutClip(ctx.ffmpegBin, layerPath, tmp, start, duration, gainDb, mute);
      const sha256 = createHash('sha256').update(readFileSync(tmp)).digest('hex');
      const dest = join(ctx.takesDir, `${sha256}.ogg`);
      if (existsSync(dest)) unlinkSync(tmp);
      else renameSync(tmp, dest);
      out.push({ segment: s.name, sha256, durationSeconds: duration, fingerprint: vocalTakeFingerprint(input, s.name, track) });
    }
    return {
      value: out,
      text: `${ACE_INSTRUMENT_LABELS[options.instrument]} on ${track}: ${out.length} clips (${covered.map((s) => s.name).join(', ')}), levelled from ${lufs.toFixed(1)} to ${ACE_LAYER_LUFS} LUFS`,
      numbers: { clips: out.length, lufs, gainDb },
    };
  });
  return AceLayerResultSchema.parse({ track, instrument: options.instrument, caption, seed: options.seed, takes, ...(rapWords ? { rapLyrics: rapWords } : {}) });
}

const fmt = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;

/** One section's clip of the layer as Ogg Vorbis: `duration` seconds from `start`, `gainDb` louder (or quieter),
 *  silent outside `keep` when given. */
function cutClip(ffmpegBin: string, src: string, dest: string, start: number, duration: number, gainDb: number, keep?: { from: number; to: number }): Promise<void> {
  const filters = [`volume=${gainDb.toFixed(2)}dB`, `apad=whole_dur=${duration.toFixed(6)}`];
  if (keep) filters.push(`volume=volume=0:enable='not(between(t,${keep.from.toFixed(6)},${keep.to.toFixed(6)}))'`);
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-ss', start.toFixed(6), '-t', duration.toFixed(6), '-i', src, '-af', filters.join(','), '-t', duration.toFixed(6), '-c:a', 'libvorbis', '-q:a', '6', '-f', 'ogg', dest];
  return new Promise((resolve, reject) => {
    execFile(ffmpegBin, args, (err, _out, stderr) => {
      if (err) reject(new Error(`ffmpeg could not cut the layer for ${dest}: ${stderr.trim() || err.message}`));
      else resolve();
    });
  });
}
