// In-browser playback support (docs/60): everything the browser's WASM engine
// needs to play a song in real time, without a server render.
//
//   envelope(songId, canonical)  the song lowered to the engine's input
//                                (song.json + inst-N.json), cached per song id
//   plan(songId)                 the samples that song plays, each with the URL
//                                of a small OGG and the engine join key
//   sampleFile(sampleId)         that OGG: a slice of a library file (tonal
//                                multisample notes) or a whole short file (drum
//                                hits, loops, guitar strums), transcoded on first
//                                use and cached on disk
//
// Only the slices a song uses leave the server, never whole multisample files.
// Mirrors native audio/SampleLibrary.h (and the old dev-only plan in
// apps/web/vite.config.ts) so the browser hears what the server render plays.

import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { commitAndPush } from '../git.js';
import { runLogged } from './renderService.js';

const execFileAsync = promisify(execFile);

export interface PlaybackServiceConfig {
  /** Per-song lowered envelopes: <playbackDir>/<songId>/. */
  readonly playbackDir: string;
  /** Transcoded sample OGGs + their specs: <sampleCacheDir>/<sampleId>.{ogg,json}. */
  readonly sampleCacheDir: string;
  readonly emitScript: string;
  readonly nodeBin: string;
  readonly sampleLibraryRoot: string;
  readonly ffmpegBin: string;
  /** The five engine fallback samples (kick, snare, hat, tone, bass-c2 .ogg). */
  readonly stubSamplesDir: string;
  /** Shared mix tables (casperaki_engine/config/mix-config.json), handed to
   *  the browser engine so the live mix matches the server render. */
  readonly mixConfigPath: string;
  /** Sung vocal takes (BRAIN_VOCAL_TAKES_DIR): handed to the lowering as CASPERAKI_VOCAL_TAKES_DIR; take files
   *  are served only from inside it. */
  readonly vocalTakesDir?: string;
}

export interface Envelope {
  readonly song: string;
  readonly insts: string[];
}

export type PlanKind = 'tonal' | 'drum' | 'wave' | 'fret' | 'strum';

export interface PlanEntry {
  /** Engine join key: tonal slot id, drum lane name, "playsample-<id>.ogg", … */
  readonly key: string;
  readonly kind: PlanKind;
  /** Id of the OGG to fetch from GET /api/playback/samples/<sampleId>.ogg. */
  readonly sampleId: string;
  /** Fret noises: this entry is slice `index` of `count` equal slices of the file. */
  readonly index?: number;
  readonly count?: number;
}

/** A sung vocal take (an audioClips clip): the whole file, inside the takes directory. */
interface TakeSpec {
  readonly takePath: string;
}

/** What one sample OGG is cut from. Stored next to the OGG so ids stay valid
 *  across restarts. */
interface SampleSpec {
  readonly relativePath: string;
  readonly sliceStart?: number;
  readonly sliceEnd?: number;
  /** Semitones to resample the slice up by: the recording stops below this slot's pitch (e.g. a
   *  sax section's note ladder runs above its range), so the slot plays the highest recorded
   *  pitch of the same articulation shifted up, as a sampler stretches a sample. */
  readonly pitchShift?: number;
}

const PITCH_CLASS: Record<string, number> = { c: 0, 'c#': 1, db: 1, d: 2, 'd#': 3, eb: 3, e: 4, f: 5, 'f#': 6, gb: 6, g: 7, 'g#': 8, ab: 8, a: 9, 'a#': 10, bb: 10, b: 11 };
/** "c2" / "a#5" / "eb3" → MIDI note number (C4 = 60). */
function noteToMidi(note: string): number {
  const m = /^([a-g](?:#|b)?)(-?\d)$/u.exec(note.toLowerCase());
  const pc = m ? PITCH_CLASS[m[1]!] : undefined;
  if (!m || pc === undefined) throw new Error(`not a note name: "${note}"`);
  return (Number(m[2]) + 1) * 12 + pc;
}

export const STUB_SAMPLES = ['kick.ogg', 'snare.ogg', 'hat.ogg', 'tone.ogg', 'bass-c2.ogg'] as const;
const SONG_ID = /^[0-9a-f]{16}$/u;
const SAMPLE_ID = /^[0-9a-f]{24}$/u;
const LOWER_TIMEOUT_MS = 60_000;
const TRANSCODE_TIMEOUT_MS = 60_000;
const PREWARM_PARALLEL = 4;

// Native SampleLibrary.h / vite.config.ts: guitar strum chord files are spelled
// with the library's accidentals.
const CHORD_ROOT_TO_DISK: Record<string, string> = {
  'A#': 'Bb', 'B#': 'C', 'C#': 'C#', 'D#': 'Eb', 'E#': 'F', 'F#': 'F#', 'G#': 'Ab',
};
function engineChordToDiskChord(chord: string): string {
  const m = chord.match(/^([A-G])([#b])(.*)$/u);
  if (!m) return chord;
  const root = `${m[1]}${m[2]}`;
  return `${CHORD_ROOT_TO_DISK[root] ?? root}${m[3]}`;
}
function chordFileBasename(chord: string, pos: string, type: string): string | null {
  const m = type.match(/^chord(Long|Short)Strum(Up|Down)$/u);
  if (!m) return null;
  return `${chord} _ Pos ${pos} _ ${m[1]} Strum ${m[2]}.mp3`;
}

export class PlaybackService {
  private readonly lowering = new Map<string, Promise<void>>();
  private readonly transcoding = new Map<string, Promise<string>>();
  private readonly libraryRoot: string;
  private readonly durations = new Map<string, number>();

  constructor(private readonly config: PlaybackServiceConfig) {
    for (const [name, p] of [
      ['emit script', config.emitScript],
      ['sample library root', config.sampleLibraryRoot],
      ['stub samples dir', config.stubSamplesDir],
      ['mix config', config.mixConfigPath],
    ] as const) {
      if (!existsSync(p)) throw new Error(`PlaybackService: ${name} not found at ${p}`);
    }
    mkdirSync(config.playbackDir, { recursive: true });
    mkdirSync(config.sampleCacheDir, { recursive: true });
    this.loweringVersion = loweringFingerprint(config.emitScript, config.sampleLibraryRoot);
    this.libraryRoot = resolve(config.sampleLibraryRoot);
    this.mixText = readFileSync(config.mixConfigPath, 'utf8');
    JSON.parse(this.mixText); // fail at startup on a broken file
  }

  private mixText: string;

  /** mix-config.json text (the standard mix), for the browser engine. */
  get mixConfig(): string {
    return this.mixText;
  }

  /**
   * Replace the standard mix (an approved suggestion): writes mix-config.json
   * (whole file, via a temporary file and a rename) and uses it from now on.
   * Native renders read the same file.
   */
  replaceMixConfig(text: string, message: string): void {
    JSON.parse(text);
    const path = this.config.mixConfigPath;
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, path);
    this.mixText = text;
    // The standard mix lives in git (the engine repo): every approval is a commit, pushed at once.
    commitAndPush([path], message);
  }

  /** Fingerprint of the lowering code: cached envelopes are kept per version,
   *  so a fix to the lowering (adapter, emit script) reaches songs already lowered. */
  private readonly loweringVersion: string;

  /** Lower the song (once per id and lowering version) and return the engine input files. */
  async envelope(songId: string, canonical: string): Promise<Envelope> {
    const dir = this.songDir(songId);
    if (!existsSync(join(dir, 'song.json'))) {
      let job = this.lowering.get(songId);
      if (!job) {
        job = this.lower(songId, canonical, dir).finally(() => this.lowering.delete(songId));
        this.lowering.set(songId, job);
      }
      await job;
    }
    const insts = readdirSync(dir)
      .filter((n) => /^inst-\d+\.json$/u.test(n))
      .sort((a, b) => parseInt(a.slice(5), 10) - parseInt(b.slice(5), 10))
      .map((n) => readFileSync(join(dir, n), 'utf8'));
    return { song: readFileSync(join(dir, 'song.json'), 'utf8'), insts };
  }

  /** The samples a lowered song plays. Starts transcoding them in the
   *  background so they are ready by the time the browser asks. */
  plan(songId: string): PlanEntry[] {
    const dir = this.songDir(songId);
    const manifestPath = join(dir, 'asset-manifest.json');
    if (!existsSync(manifestPath)) throw new Error(`Song ${songId} has not been lowered (no asset-manifest.json).`);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, any>;
    const insts = readdirSync(dir)
      .filter((n) => /^inst-\d+\.json$/u.test(n))
      .sort((a, b) => parseInt(a.slice(5), 10) - parseInt(b.slice(5), 10))
      .map((n) => JSON.parse(readFileSync(join(dir, n), 'utf8')) as Record<string, any>);

    const entries: PlanEntry[] = [];
    const add = (key: string, kind: PlanKind, spec: SampleSpec | TakeSpec, extra: { index?: number; count?: number } = {}) =>
      entries.push({ key, kind, sampleId: this.register(spec), ...extra });
    const laneEntry = (name: string) => manifest.lanes?.[name] ?? manifest[name];

    // Tonal multisample lanes: one slice per resolved slot.
    for (const inst of insts) {
      if (!Array.isArray(inst.samples) || inst.samples.length === 0) continue;
      if (inst.type === 'drums' || inst.type === 'transitionPattern') continue;
      if (typeof inst.name !== 'string' || !inst.name) continue;
      const entry = laneEntry(inst.name);
      if (!entry || entry.status !== 'resolved' || typeof entry.relativePath !== 'string') continue;
      const slots = entry.multisample?.slots;
      if (!Array.isArray(slots)) continue;
      const fileSec = this.durationSync(entry.relativePath);
      /** The highest fully recorded slot of an articulation (the stand-in for pitches past the end). */
      const recorded = (type: unknown) =>
        slots
          .filter((x: any) => x?.status === 'resolved' && x.slot?.type === type && x.sliceEnd <= fileSec + 0.05 && typeof x.slot?.note === 'string')
          .sort((a: any, b: any) => noteToMidi(b.slot.note) - noteToMidi(a.slot.note))[0];
      for (const slot of slots) {
        if (slot?.status !== 'resolved' || slot.slot?.id == null) continue;
        const s0 = slot.sliceStart as number;
        const s1 = slot.sliceEnd as number;
        if (!(s1 > s0) || s0 < 0) continue;
        // A pitch the recording does not reach: the highest recorded one of the same articulation,
        // resampled up (its own spec, so its own URL past any cached broken file).
        if (s0 >= fileSec - 0.01) {
          const src = recorded(slot.slot.type);
          if (!src) throw new Error(`${entry.relativePath} is ${fileSec.toFixed(2)} s and has no fully recorded ${String(slot.slot.type)} slot to stand in for ${String(slot.slot.note)}`);
          const shift = noteToMidi(String(slot.slot.note)) - noteToMidi(src.slot.note);
          if (!(shift > 0)) throw new Error(`${entry.relativePath}: ${String(slot.slot.note)} is past the end but not above the highest recorded ${src.slot.note}`);
          this.warnBeyondEnd(entry.relativePath, fileSec, s0, src.slot.note);
          add(String(slot.slot.id), 'tonal', { relativePath: entry.relativePath, sliceStart: src.sliceStart, sliceEnd: src.sliceEnd, pitchShift: shift });
        } else {
          add(String(slot.slot.id), 'tonal', { relativePath: entry.relativePath, sliceStart: s0, sliceEnd: s1 });
        }
      }
    }

    // Drum lanes: one whole one-shot each.
    const drumLanes = manifest.Drums?.lanes;
    if (drumLanes && typeof drumLanes === 'object') {
      for (const [name, e] of Object.entries<any>(drumLanes)) {
        if (!e || e.status !== 'resolved' || typeof e.relativePath !== 'string') continue;
        add(name, 'drum', { relativePath: e.relativePath });
      }
    }

    // Loops, transitions and percussion: whole files keyed playsample-<id>.ogg.
    const waves = new Map<number, string>();
    for (const inst of insts) {
      if (inst.type === 'transitionPattern') {
        for (const s of inst.samples ?? [])
          if (s?.id != null && typeof s.sourcePath === 'string' && !waves.has(s.id)) waves.set(s.id, s.sourcePath);
        continue;
      }
      if (['transitionSample', 'percussionLoops', 'percussion'].includes(inst.type)
          && inst.id != null && typeof inst.sourcePath === 'string' && !waves.has(inst.id))
        waves.set(inst.id, inst.sourcePath);
    }
    for (const [id, src] of waves) add(`playsample-${id}.ogg`, 'wave', { relativePath: src });

    // Sung vocal takes (audioClips): each clip's own file, keyed by the clip's key.
    for (const inst of insts) {
      if (inst.type !== 'audioClips') continue;
      for (const c of inst.clips ?? []) {
        if (typeof c?.key !== 'string' || typeof c?.sourcePath !== 'string') throw new Error(`audioClips ${String(inst.name)}: a clip without key or sourcePath`);
        add(c.key, 'wave', { takePath: this.takeFile(c.sourcePath) });
      }
    }

    // Guitar fret noises (equal slices of one file, cut in the browser) and
    // strums (one whole pre-sliced chord/fx file per pool entry).
    const guitar = manifest.Guitar;
    for (const inst of insts) {
      if (inst.type !== 'acousticGuitars' && inst.type !== 'electricGuitars') continue;
      const fretIds = inst.fx?.fxFretNoise;
      const fretRel = guitar?.fretNoiseSibling?.relativePath;
      if (Array.isArray(fretIds) && fretIds.length && typeof fretRel === 'string') {
        fretIds.forEach((id: unknown, i: number) => {
          if (typeof id === 'number') add(String(id), 'fret', { relativePath: fretRel }, { index: i, count: fretIds.length });
        });
      }
      const chordsDir = guitar?.chordsAbsDir;
      const fxDir = guitar?.fxAbsDir;
      for (const e of inst.virtualGuitaristSamples ?? []) {
        if (e?.id == null) continue;
        let abs: string | null = null;
        if (typeof e.fx === 'string' && e.fx) {
          if (typeof fxDir === 'string') abs = join(fxDir, `${e.fx}.mp3`);
        } else if (typeof chordsDir === 'string') {
          const base = chordFileBasename(engineChordToDiskChord(String(e.chord)), String(e.chordPosition), String(e.type));
          if (base) abs = join(chordsDir, base);
        }
        const what = typeof e.fx === 'string' && e.fx ? `effect ${e.fx}` : `strum ${String(e.chord)} ${String(e.type)}`;
        if (!abs) throw new Error(`PlaybackService: guitar ${String(inst.name)} (${String(inst.type)}): the sound library has no folder for ${what}`);
        if (!existsSync(abs)) throw new Error(`PlaybackService: guitar ${String(inst.name)} (${String(inst.type)}) has no recording for ${what}: ${abs}`);
        const rel = relative(this.libraryRoot, abs);
        if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`PlaybackService: guitar sample ${abs} lies outside the sound library ${this.libraryRoot}`);
        add(String(e.id), 'strum', { relativePath: rel });
      }
    }

    this.prewarm([...new Set(entries.map((e) => e.sampleId))]);
    return entries;
  }

  /** Path of the sample's OGG, transcoding it first if needed. */
  async sampleFile(sampleId: string): Promise<string> {
    if (!SAMPLE_ID.test(sampleId)) throw new Error(`invalid sample id: ${sampleId}`);
    const out = join(this.config.sampleCacheDir, `${sampleId}.ogg`);
    if (existsSync(out)) return out;
    let job = this.transcoding.get(sampleId);
    if (!job) {
      job = this.transcode(sampleId, out).finally(() => this.transcoding.delete(sampleId));
      this.transcoding.set(sampleId, job);
    }
    return job;
  }

  /**
   * Register a library file (relative to the library root) as a sample, cut to
   * [0, maxSec) when given, and return its id (for the Sounds page's audio
   * previews). Throws when the file is outside the library or missing.
   */
  fileSample(relativePath: string, maxSec?: number): string {
    const src = resolve(this.libraryRoot, relativePath);
    if (!src.startsWith(this.libraryRoot + '/')) throw new Error(`sound file points outside the library: ${relativePath}`);
    if (!existsSync(src)) throw new Error(`sound file missing in the library: ${relativePath}`);
    return this.register(maxSec !== undefined ? { relativePath, sliceStart: 0, sliceEnd: maxSec } : { relativePath });
  }

  /** Length in seconds of a library file (ffprobe, next to the configured ffmpeg); cached. */
  async probeSeconds(relativePath: string): Promise<number> {
    const cached = this.durations.get(relativePath);
    if (cached !== undefined) return cached;
    const src = resolve(this.libraryRoot, relativePath);
    if (!src.startsWith(this.libraryRoot + '/')) throw new Error(`sound file points outside the library: ${relativePath}`);
    if (!existsSync(src)) throw new Error(`sound file missing in the library: ${relativePath}`);
    if (!/ffmpeg$/u.test(this.config.ffmpegBin)) throw new Error(`cannot find ffprobe: FFMPEG_BIN (${this.config.ffmpegBin}) does not end in "ffmpeg"`);
    const ffprobe = this.config.ffmpegBin.replace(/ffmpeg$/u, 'ffprobe');
    const { stdout } = await execFileAsync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', src], { timeout: 30_000 });
    const sec = Number(stdout.trim());
    if (!(sec > 0)) throw new Error(`ffprobe gave no duration for ${relativePath}: "${stdout.trim()}"`);
    this.durations.set(relativePath, sec);
    return sec;
  }

  /** Length in seconds of a library file, synchronously (for plan(); one ffprobe per file, cached). */
  private durationSync(relativePath: string): number {
    const cached = this.durations.get(relativePath);
    if (cached !== undefined) return cached;
    const src = resolve(this.libraryRoot, relativePath);
    if (!src.startsWith(this.libraryRoot + '/')) throw new Error(`sound file points outside the library: ${relativePath}`);
    if (!existsSync(src)) throw new Error(`sound file missing in the library: ${relativePath}`);
    if (!/ffmpeg$/u.test(this.config.ffmpegBin)) throw new Error(`cannot find ffprobe: FFMPEG_BIN (${this.config.ffmpegBin}) does not end in "ffmpeg"`);
    const ffprobe = this.config.ffmpegBin.replace(/ffmpeg$/u, 'ffprobe');
    const r = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', src], { encoding: 'utf8', timeout: 30_000 });
    if (r.status !== 0) throw new Error(`ffprobe failed for ${relativePath}: ${r.stderr || r.error?.message || `exit ${r.status}`}`);
    const sec = Number(r.stdout.trim());
    if (!(sec > 0)) throw new Error(`ffprobe gave no duration for ${relativePath}: "${r.stdout.trim()}"`);
    this.durations.set(relativePath, sec);
    return sec;
  }

  private readonly warnedBeyondEnd = new Set<string>();
  private warnBeyondEnd(relativePath: string, fileSec: number, sliceStart: number, from: string): void {
    if (this.warnedBeyondEnd.has(relativePath)) return;
    this.warnedBeyondEnd.add(relativePath);
    console.warn(`[playback] ${relativePath} is ${fileSec.toFixed(2)} s; its pitches from ${sliceStart.toFixed(2)} s on are not recorded and play ${from} (the highest recorded) shifted up`);
  }

  /** A library file's sample rate (ffprobe, first audio stream). */
  private async sampleRateOf(relativePath: string): Promise<number> {
    const ffprobe = this.config.ffmpegBin.replace(/ffmpeg$/u, 'ffprobe');
    const src = resolve(this.libraryRoot, relativePath);
    const { stdout } = await execFileAsync(ffprobe, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=sample_rate', '-of', 'default=nw=1:nk=1', src], { timeout: 30_000 });
    const sr = Number(stdout.trim());
    if (!(sr > 0)) throw new Error(`ffprobe gave no sample rate for ${relativePath}: "${stdout.trim()}"`);
    return sr;
  }

  /** Whether a sample id has been registered by some song's plan. */
  knowsSample(sampleId: string): boolean {
    return SAMPLE_ID.test(sampleId) && existsSync(join(this.config.sampleCacheDir, `${sampleId}.json`));
  }

  stubFile(name: string): string {
    if (!(STUB_SAMPLES as readonly string[]).includes(name)) throw new Error(`unknown stub sample: ${name}`);
    return join(this.config.stubSamplesDir, name);
  }

  private songDir(songId: string): string {
    if (!SONG_ID.test(songId)) throw new Error(`invalid song id: ${songId}`);
    return join(this.config.playbackDir, this.loweringVersion, songId);
  }

  private async lower(songId: string, canonical: string, dir: string): Promise<void> {
    mkdirSync(dirname(dir), { recursive: true });
    // Lower into a temp dir and rename, so a half-written envelope is never served.
    const tmp = `${dir}.tmp-${process.pid}-${Date.now()}`;
    mkdirSync(tmp, { recursive: true });
    writeFileSync(join(tmp, 'song-in.json'), canonical);
    await runLogged(
      this.config.nodeBin,
      [this.config.emitScript],
      {
        ...process.env,
        BRAIN_SONG_FILE: join(tmp, 'song-in.json'),
        OUT_DIR: tmp,
        ...(this.config.vocalTakesDir ? { CASPERAKI_VOCAL_TAKES_DIR: resolve(this.config.vocalTakesDir) } : {}),
      },
      join(tmp, 'lower.log'),
      LOWER_TIMEOUT_MS,
    );
    if (!existsSync(join(tmp, 'song.json'))) throw new Error(`lowering song ${songId} wrote no song.json (see ${tmp}/lower.log)`);
    renameSync(tmp, dir);
  }

  /** A take file, which must be inside the vocal takes directory. */
  private takeFile(path: string): string {
    const dir = this.config.vocalTakesDir;
    if (!dir) throw new Error('the song has sung vocal takes but BRAIN_VOCAL_TAKES_DIR is not set');
    const root = resolve(dir);
    const abs = resolve(root, path);
    if (!abs.startsWith(root + '/')) throw new Error(`a vocal take points outside the vocal takes directory: ${path}`);
    return abs;
  }

  private register(spec: SampleSpec | TakeSpec): string {
    const id = createHash('sha256').update(JSON.stringify(spec)).digest('hex').slice(0, 24);
    const specPath = join(this.config.sampleCacheDir, `${id}.json`);
    if (!existsSync(specPath)) writeFileSync(specPath, JSON.stringify(spec));
    return id;
  }

  private async transcode(sampleId: string, out: string): Promise<string> {
    const specPath = join(this.config.sampleCacheDir, `${sampleId}.json`);
    if (!existsSync(specPath)) throw new Error(`unknown sample id ${sampleId} (no song plan registered it)`);
    const anySpec = JSON.parse(readFileSync(specPath, 'utf8')) as SampleSpec | TakeSpec;
    if ('takePath' in anySpec) {
      const take = this.takeFile(anySpec.takePath);
      if (!existsSync(take)) throw new Error(`sample ${sampleId}: vocal take missing: ${take}`);
      const tmpTake = `${out}.tmp-${process.pid}`;
      await runLogged(
        this.config.ffmpegBin,
        ['-y', '-hide_banner', '-loglevel', 'error', '-i', take, '-c:a', 'libvorbis', '-q:a', '6', '-f', 'ogg', tmpTake],
        process.env,
        `${out}.log`,
        TRANSCODE_TIMEOUT_MS,
      );
      renameSync(tmpTake, out);
      return out;
    }
    const spec = anySpec;
    const src = resolve(this.libraryRoot, spec.relativePath);
    if (!src.startsWith(this.libraryRoot + '/')) throw new Error(`sample ${sampleId} points outside the library`);
    if (!existsSync(src)) throw new Error(`sample ${sampleId}: library file missing: ${spec.relativePath}`);
    const tmp = `${out}.tmp-${process.pid}`;
    if (spec.pitchShift !== undefined) {
      if (spec.sliceStart === undefined || spec.sliceEnd === undefined) throw new Error(`sample ${sampleId}: a pitched slice needs its start and end`);
      // Cut, then play it faster by the interval (a sampler's pitch shift: higher and shorter).
      const sr = await this.sampleRateOf(spec.relativePath);
      const ratio = 2 ** (spec.pitchShift / 12);
      const filter = `atrim=start=${spec.sliceStart.toFixed(6)}:end=${spec.sliceEnd.toFixed(6)},asetpts=PTS-STARTPTS,asetrate=${(sr * ratio).toFixed(3)},aresample=${sr}`;
      await runLogged(
        this.config.ffmpegBin,
        ['-y', '-hide_banner', '-loglevel', 'error', '-i', src, '-af', filter, '-c:a', 'libvorbis', '-q:a', '6', '-f', 'ogg', tmp],
        process.env,
        `${out}.log`,
        TRANSCODE_TIMEOUT_MS,
      );
      renameSync(tmp, out);
      return out;
    }
    // -ss/-to after -i: cut on the decoded stream, so slice edges are exact.
    const cut = spec.sliceStart !== undefined && spec.sliceEnd !== undefined
      ? ['-ss', spec.sliceStart.toFixed(6), '-to', spec.sliceEnd.toFixed(6)]
      : [];
    await runLogged(
      this.config.ffmpegBin,
      ['-y', '-hide_banner', '-loglevel', 'error', '-i', src, ...cut, '-c:a', 'libvorbis', '-q:a', '6', '-f', 'ogg', tmp],
      process.env,
      `${out}.log`,
      TRANSCODE_TIMEOUT_MS,
    );
    renameSync(tmp, out);
    return out;
  }

  private prewarm(ids: string[]): void {
    const todo = ids.filter((id) => !existsSync(join(this.config.sampleCacheDir, `${id}.ogg`)));
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < todo.length) {
        const id = todo[next++]!;
        try {
          await this.sampleFile(id);
        } catch (err) {
          // The browser's own request for this sample will surface the error.
          console.error(`[playback] pre-transcoding ${id} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    };
    for (let i = 0; i < Math.min(PREWARM_PARALLEL, todo.length); i++) void worker();
  }
}

/**
 * Hash of what lowering a song depends on: the emit script, the built
 * @casperaki packages it imports (their dist/*.js, as linked next to it), and
 * the sound library's fx sheet (fxMetadata.json, beside the instruments folder:
 * the transitions' durations and climaxes).
 */
function loweringFingerprint(emitScript: string, sampleLibraryRoot: string): string {
  const fxSheet = join(sampleLibraryRoot, '..', 'fxMetadata.json');
  if (!existsSync(fxSheet)) throw new Error(`PlaybackService: the sound library has no fx sheet at ${fxSheet}`);
  const h = createHash('sha256').update(readFileSync(emitScript)).update(readFileSync(fxSheet));
  const scope = join(dirname(emitScript), '..', 'node_modules', '@casperaki');
  if (!existsSync(scope)) throw new Error(`PlaybackService: ${scope} not found (the emit script's @casperaki packages)`);
  for (const pkg of readdirSync(scope).sort()) {
    const dist = join(scope, pkg, 'dist');
    if (!existsSync(dist)) throw new Error(`PlaybackService: ${dist} not found: build @casperaki/${pkg}`);
    const files = (readdirSync(dist, { recursive: true }) as string[]).filter((f) => f.endsWith('.js')).sort();
    for (const f of files) h.update(f).update(readFileSync(join(dist, f)));
  }
  return h.digest('hex').slice(0, 12);
}
