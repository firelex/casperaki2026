// DAW export jobs: a saved song as stems, a REAPER project or a Logic bundle.
//
//   1. lower    — emit-brain-roundtrip.mjs: song → engine envelope (as for a render)
//   2. mix      — casperaki_render, full mix, writes a report: the instrument
//                 lanes and the peak-normalise gain
//   3. stems    — one casperaki_render per chosen lane (CASPERAKI_STEM_LANE),
//                 at the mix's gain (CASPERAKI_GAIN) so the stems sum to the mix,
//                 24-bit WAV, several at once
//   4. package  — zip: Audio/<lane>.wav, the reference mix, the browser-made MIDI,
//                 and per format a REAPER project or a README for Logic
//
// Jobs live in memory (status) and on disk (<exportsDir>/<jobId>/).

import { randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cpus } from 'node:os';
import yazl from 'yazl';

import { runLogged } from '../render/renderService.js';
import { buildRpp } from './rpp.js';

export type DawFormat = 'stems' | 'reaper' | 'logic';

export interface DawExportRequest {
  readonly format: DawFormat;
  /** Engine lanes (instrument names) to include; empty = all. */
  readonly tracks: readonly string[];
  /** MIDI made in the browser: the whole song and one file per instrument (base64). */
  readonly midi?: { readonly song?: string; readonly tracks?: Readonly<Record<string, string>> };
  /** Track colours "#rrggbb", by instrument name. */
  readonly colors?: Readonly<Record<string, string>>;
}

export interface DawExportSong {
  readonly songId: string;
  readonly canonical: string;
  readonly title: string;
  readonly bpm: number;
  /** Sections in order with their length in bars. */
  readonly sections: readonly { readonly name: string; readonly bars: number }[];
}

export type DawExportState = 'queued' | 'lowering' | 'mixing' | 'stems' | 'packaging' | 'done' | 'failed';

export interface DawExportStatus {
  readonly id: string;
  readonly owner: string;
  readonly songId: string;
  readonly format: DawFormat;
  readonly state: DawExportState;
  readonly stemsDone: number;
  readonly stemsTotal: number;
  readonly fileName?: string;
  readonly error?: string;
}

export interface DawExportConfig {
  readonly exportsDir: string;
  readonly emitScript: string;
  readonly renderBin: string;
  readonly stubSamplesDir: string;
  readonly sampleLibraryRoot: string;
  readonly nodeBin: string;
}

const LOWER_TIMEOUT_MS = 3 * 60 * 1000;
const RENDER_TIMEOUT_MS = 20 * 60 * 1000;
/** Stem renders at once: each is one core; leave room for the rest of the machine. */
const STEM_CONCURRENCY = Math.max(1, Math.min(8, cpus().length - 2));

interface Report {
  normalizeGain: number;
  lanes: string[];
  frames: number;
  sampleRate: number;
}

export class DawExportService {
  private readonly jobs = new Map<string, DawExportStatus>();

  constructor(private readonly config: DawExportConfig) {
    for (const [label, path] of [
      ['emit script', config.emitScript],
      ['render binary', config.renderBin],
      ['stub samples directory', config.stubSamplesDir],
      ['sample library root', config.sampleLibraryRoot],
    ] as const) {
      if (!existsSync(path)) throw new Error(`DAW export: ${label} not found at ${path}`);
    }
    mkdirSync(config.exportsDir, { recursive: true });
  }

  start(owner: string, song: DawExportSong, request: DawExportRequest): DawExportStatus {
    const id = randomUUID();
    const status: DawExportStatus = { id, owner, songId: song.songId, format: request.format, state: 'queued', stemsDone: 0, stemsTotal: 0 };
    this.jobs.set(id, status);
    void this.run(id, song, request);
    return status;
  }

  status(id: string): DawExportStatus | undefined {
    return this.jobs.get(id);
  }

  /** The finished zip's path (throws unless the job is done). */
  zipPath(id: string): string {
    const s = this.jobs.get(id);
    if (!s || s.state !== 'done' || !s.fileName) throw new Error(`export ${id} is not ready`);
    return join(this.dirFor(id), s.fileName);
  }

  private dirFor(id: string): string {
    if (!/^[0-9a-f-]{36}$/u.test(id)) throw new Error(`invalid export id: ${id}`);
    return join(resolve(this.config.exportsDir), id);
  }

  private set(id: string, patch: Partial<DawExportStatus>): void {
    const cur = this.jobs.get(id);
    if (!cur) throw new Error(`unknown export ${id}`);
    this.jobs.set(id, { ...cur, ...patch });
  }

  private async run(id: string, song: DawExportSong, request: DawExportRequest): Promise<void> {
    const c = this.config;
    const dir = this.dirFor(id);
    const env = { ...process.env, CASPERAKI_SAMPLE_LIBRARY_ROOT: c.sampleLibraryRoot, CASPERAKI_MIX: '1', CASPERAKI_BITS: '24' };
    try {
      mkdirSync(join(dir, 'Audio'), { recursive: true });
      writeFileSync(join(dir, 'song-in.json'), song.canonical);

      this.set(id, { state: 'lowering' });
      await runLogged(c.nodeBin, [c.emitScript], { ...env, BRAIN_SONG_FILE: join(dir, 'song-in.json'), OUT_DIR: dir }, join(dir, 'lower.log'), LOWER_TIMEOUT_MS);

      this.set(id, { state: 'mixing' });
      const mixFile = 'Casperaki mix (reference).wav';
      await runLogged(
        c.renderBin,
        [dir, join(dir, 'Audio', mixFile), c.stubSamplesDir, c.sampleLibraryRoot],
        { ...env, CASPERAKI_REPORT: join(dir, 'report.json') },
        join(dir, 'mix.log'),
        RENDER_TIMEOUT_MS,
      );
      const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8')) as Report;
      const unknown = request.tracks.filter((t) => !report.lanes.includes(t));
      if (unknown.length) throw new Error(`not tracks the engine plays: ${unknown.join(', ')}`);
      const lanes = request.tracks.length ? report.lanes.filter((l) => request.tracks.includes(l)) : report.lanes;
      if (lanes.length === 0) throw new Error('no tracks to export');

      this.set(id, { state: 'stems', stemsTotal: lanes.length, stemsDone: 0 });
      const stemFile = (lane: string) => `${safeFile(lane)}.wav`;
      let next = 0;
      let done = 0;
      const worker = async () => {
        for (let i = next++; i < lanes.length; i = next++) {
          const lane = lanes[i]!;
          await runLogged(
            c.renderBin,
            [dir, join(dir, 'Audio', stemFile(lane)), c.stubSamplesDir, c.sampleLibraryRoot],
            { ...env, CASPERAKI_STEM_LANE: lane, CASPERAKI_GAIN: String(report.normalizeGain) },
            join(dir, `stem-${safeFile(lane)}.log`),
            RENDER_TIMEOUT_MS,
          );
          this.set(id, { stemsDone: ++done });
        }
      };
      await Promise.all(Array.from({ length: Math.min(STEM_CONCURRENCY, lanes.length) }, worker));

      this.set(id, { state: 'packaging' });
      const base = safeFile(song.title);
      const fileName = `${base} (${request.format === 'reaper' ? 'REAPER' : request.format === 'logic' ? 'Logic' : 'stems'}).zip`;
      const zip = new yazl.ZipFile();
      const root = `${base}/`;
      for (const lane of lanes) zip.addFile(join(dir, 'Audio', stemFile(lane)), `${root}Audio/${stemFile(lane)}`, { compress: false });
      zip.addFile(join(dir, 'Audio', mixFile), `${root}Audio/${mixFile}`, { compress: false });

      const midiTracks = Object.entries(request.midi?.tracks ?? {}).filter(([name]) => lanes.includes(name));
      if (request.midi?.song) zip.addBuffer(Buffer.from(request.midi.song, 'base64'), `${root}${base}.mid`);
      for (const [name, b64] of midiTracks) zip.addBuffer(Buffer.from(b64, 'base64'), `${root}MIDI/${safeFile(name)}.mid`);

      const lengthSec = report.frames / report.sampleRate;
      const secPerBar = (4 * 60) / song.bpm;
      let bar = 0;
      const sections = song.sections.map((s) => {
        const startSec = bar * secPerBar;
        bar += s.bars;
        return { name: s.name, startSec, endSec: bar * secPerBar };
      });
      if (request.format === 'reaper') {
        const rpp = buildRpp({
          title: song.title,
          bpm: song.bpm,
          lengthSec,
          sections,
          stems: lanes.map((l) => ({ name: l, file: `Audio/${stemFile(l)}`, ...(request.colors?.[l] ? { color: request.colors[l] } : {}) })),
          midi: midiTracks.map(([name]) => ({ name, file: `MIDI/${safeFile(name)}.mid`, ...(request.colors?.[name] ? { color: request.colors[name] } : {}) })),
        });
        zip.addBuffer(Buffer.from(rpp, 'utf8'), `${root}${base}.RPP`);
      }
      zip.addBuffer(Buffer.from(readme(song, request.format, lanes, lengthSec, sections), 'utf8'), `${root}README.txt`);
      zip.end();
      await new Promise<void>((ok, fail) => {
        const out = createWriteStream(join(dir, fileName));
        zip.outputStream.pipe(out).on('close', () => ok()).on('error', fail);
        zip.outputStream.on('error', fail);
      });
      this.set(id, { state: 'done', fileName });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[daw-export] ${id} failed: ${message}`);
      this.set(id, { state: 'failed', error: message });
    }
  }
}

/** A file name from a title or track name (letters, digits, spaces, - and _ kept). */
export function safeFile(name: string): string {
  const s = name.replace(/[^\p{L}\p{N} _-]+/gu, '-').replace(/\s+/gu, ' ').trim();
  if (!s) throw new Error(`no usable file name in "${name}"`);
  return s;
}

function readme(
  song: DawExportSong,
  format: DawFormat,
  lanes: readonly string[],
  lengthSec: number,
  sections: readonly { name: string; startSec: number }[],
): string {
  const lines = [
    `${song.title} — exported from Casperaki`,
    '',
    `Tempo ${song.bpm} BPM, 4/4. Length ${lengthSec.toFixed(1)} s (the last seconds are the effects' tail).`,
    '',
    'Audio/: one 24-bit WAV per track, each the full song from bar 1, with Casperaki\'s',
    'effects and mix level (the stems add up to the reference mix, also included).',
    `Tracks: ${lanes.join(', ')}.`,
    '',
  ];
  if (format === 'reaper') lines.push('Open the .RPP file in REAPER. Sections are regions; the muted "MIDI" folder holds each part as MIDI.', '');
  if (format === 'logic')
    lines.push(
      'In Logic Pro:',
      `  1. New empty project; set the tempo to ${song.bpm} BPM and the sample rate to 44.1 kHz.`,
      '  2. Drag the .mid file onto the start of the timeline (bar 1): it brings the parts as MIDI',
      '     and the sections as markers. Replace the instruments as you like.',
      '  3. Select all files in Audio/ and drag them in at bar 1, "Create new tracks".',
      '',
    );
  lines.push('Sections:', ...sections.map((s) => `  ${s.startSec.toFixed(2).padStart(7)} s  ${s.name}`), '');
  return lines.join('\n');
}
