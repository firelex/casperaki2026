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

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { runLogged } from './renderService.js';

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

/** What one sample OGG is cut from. Stored next to the OGG so ids stay valid
 *  across restarts. */
interface SampleSpec {
  readonly relativePath: string;
  readonly sliceStart?: number;
  readonly sliceEnd?: number;
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
    this.libraryRoot = resolve(config.sampleLibraryRoot);
    this.mixConfig = readFileSync(config.mixConfigPath, 'utf8');
    JSON.parse(this.mixConfig); // fail at startup on a broken file
  }

  /** mix-config.json text, for the browser engine. */
  readonly mixConfig: string;

  /** Lower the song (once per id) and return the engine input files. */
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
    const add = (key: string, kind: PlanKind, spec: SampleSpec, extra: { index?: number; count?: number } = {}) =>
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
      for (const slot of slots) {
        if (slot?.status !== 'resolved' || slot.slot?.id == null) continue;
        const s0 = slot.sliceStart as number;
        const s1 = slot.sliceEnd as number;
        if (!(s1 > s0) || s0 < 0) continue;
        add(String(slot.slot.id), 'tonal', { relativePath: entry.relativePath, sliceStart: s0, sliceEnd: s1 });
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
        if (!abs || !existsSync(abs)) continue;
        const rel = relative(this.libraryRoot, abs);
        if (rel.startsWith('..') || isAbsolute(rel)) continue;
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
    return join(this.config.playbackDir, songId);
  }

  private async lower(songId: string, canonical: string, dir: string): Promise<void> {
    // Lower into a temp dir and rename, so a half-written envelope is never served.
    const tmp = `${dir}.tmp-${process.pid}-${Date.now()}`;
    mkdirSync(tmp, { recursive: true });
    writeFileSync(join(tmp, 'song-in.json'), canonical);
    await runLogged(
      this.config.nodeBin,
      [this.config.emitScript],
      { ...process.env, BRAIN_SONG_FILE: join(tmp, 'song-in.json'), OUT_DIR: tmp },
      join(tmp, 'lower.log'),
      LOWER_TIMEOUT_MS,
    );
    if (!existsSync(join(tmp, 'song.json'))) throw new Error(`lowering song ${songId} wrote no song.json (see ${tmp}/lower.log)`);
    renameSync(tmp, dir);
  }

  private register(spec: SampleSpec): string {
    const id = createHash('sha256').update(JSON.stringify(spec)).digest('hex').slice(0, 24);
    const specPath = join(this.config.sampleCacheDir, `${id}.json`);
    if (!existsSync(specPath)) writeFileSync(specPath, JSON.stringify(spec));
    return id;
  }

  private async transcode(sampleId: string, out: string): Promise<string> {
    const specPath = join(this.config.sampleCacheDir, `${sampleId}.json`);
    if (!existsSync(specPath)) throw new Error(`unknown sample id ${sampleId} (no song plan registered it)`);
    const spec = JSON.parse(readFileSync(specPath, 'utf8')) as SampleSpec;
    const src = resolve(this.libraryRoot, spec.relativePath);
    if (!src.startsWith(this.libraryRoot + '/')) throw new Error(`sample ${sampleId} points outside the library`);
    if (!existsSync(src)) throw new Error(`sample ${sampleId}: library file missing: ${spec.relativePath}`);
    // -ss/-to after -i: cut on the decoded stream, so slice edges are exact.
    const cut = spec.sliceStart !== undefined && spec.sliceEnd !== undefined
      ? ['-ss', spec.sliceStart.toFixed(6), '-to', spec.sliceEnd.toFixed(6)]
      : [];
    const tmp = `${out}.tmp-${process.pid}`;
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
