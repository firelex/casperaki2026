// Per-song server-side render jobs.
//
// A render turns one stored canonical Song into audio in three steps, each a
// child process so a crash in native code can never take the brain down:
//
//   1. lower  — apps/engine-spike/scripts/emit-brain-roundtrip.mjs with
//               BRAIN_SONG_FILE=<song-in.json>: writes the engine envelope
//               (song.json + inst-N.json + asset-manifest.json).
//   2. render — the native build of the WASM engine (casperaki_render):
//               envelope + real sample library → out-unmastered.wav (24-bit,
//               natural level, no mastering — legacy's <title>_unmastered.wav).
//   3. master — casperaki_master (the engine's JUCE-free port of the legacy
//               matchering, SERGREE style, bit-identical to the JUCE original):
//               match levels and the mid/side EQ curve to the Atemlos reference,
//               then NC-17 → out.wav (docs/67 #1).
//   4. encode — ffmpeg (LAME VBR -V2, as legacy, 2 dB lower: MP3_HEADROOM_DB): out.wav →
//               out.mp3 and out-unmastered.wav → out-unmastered.mp3.
//
// Songs are content-addressed (id = hash prefix of the canonical bytes), so
// a render directory keyed by song id is valid forever: an edit produces a
// new id and therefore a new render. Jobs run one at a time — each render is
// CPU-bound and reads gigabytes of samples from the library.
//
// Job state lives in memory and in <dir>/status.json so a finished render
// survives a restart. A job that was queued or running when the process
// stopped is reported as failed ("interrupted"), never silently re-run.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { hasYue2Take, VOCALS_CREDIT } from '../export/vocalsCredit.js';

/** Fixed level change before encoding an MP3 (the WAVs are unchanged): MP3 encoding overshoots
 *  the peaks it is given (a master at -1 dBFS decodes up to about +1.6 dBFS, which players clip).
 *  Same as the browser export (public/engine/casperaki-audio-files.js). */
const MP3_HEADROOM_DB = -2;

export type RenderState = 'queued' | 'running' | 'done' | 'failed';

export interface RenderStatus {
  readonly songId: string;
  readonly state: RenderState;
  readonly step?: 'lower' | 'render' | 'master' | 'encode';
  readonly queuedAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly error?: string;
  readonly durationSec?: number;
  /** Fingerprint of the song's Pro-mode mix config and the vocal takes it plays ("" = the standard mix, no takes). */
  readonly mixHash?: string;
}

export interface RenderServiceConfig {
  /** Directory holding one sub-directory per rendered song. */
  readonly rendersDir: string;
  /** Path to emit-brain-roundtrip.mjs. */
  readonly emitScript: string;
  /** Path to the casperaki_render binary. */
  readonly renderBin: string;
  /** Directory with the engine's stub samples (kick/snare/hat/tone/bass). */
  readonly stubSamplesDir: string;
  /** Root of the real sample library. */
  readonly sampleLibraryRoot: string;
  /** Turn on the per-lane mix + rack FX chains (CASPERAKI_MIX=1). */
  readonly mix: boolean;
  readonly ffmpegBin: string;
  readonly nodeBin: string;
  /** casperaki_master: <in.wav> <out.wav> <sergree|boost>. */
  readonly masteringBin: string;
  /** Sung vocal takes (BRAIN_VOCAL_TAKES_DIR), handed to the lowering as CASPERAKI_VOCAL_TAKES_DIR. */
  readonly vocalTakesDir?: string;
}

/** Which version of a render: matchering-mastered (the default) or unmastered. */
export type RenderVersion = 'mastered' | 'unmastered';

const LOWER_TIMEOUT_MS = 3 * 60 * 1000;
const RENDER_TIMEOUT_MS = 20 * 60 * 1000;
const ENCODE_TIMEOUT_MS = 5 * 60 * 1000;
const MASTER_TIMEOUT_MS = 10 * 60 * 1000;

export class RenderService {
  private readonly statuses = new Map<string, RenderStatus>();
  /** Song renders and one-off mix renders (renderMix), run one at a time in order. */
  private readonly queue: Array<{ songId: string; canonical: string } | { oneOff: () => Promise<void> }> = [];
  private running = false;

  constructor(private readonly config: RenderServiceConfig) {
    for (const [label, path] of [
      ['emit script', config.emitScript],
      ['render binary', config.renderBin],
      ['stub samples directory', config.stubSamplesDir],
      ['sample library root', config.sampleLibraryRoot],
      ['mastering binary', config.masteringBin],
    ] as const) {
      if (!existsSync(path)) throw new Error(`render service: ${label} not found at ${path}`);
    }
    mkdirSync(config.rendersDir, { recursive: true });
  }

  dirFor(songId: string): string {
    if (!/^[0-9a-f]{16}$/.test(songId)) throw new Error(`invalid song id: ${songId}`);
    return join(resolve(this.config.rendersDir), songId);
  }

  wavPath(songId: string, version: RenderVersion = 'mastered'): string {
    return join(this.dirFor(songId), version === 'mastered' ? 'out.wav' : 'out-unmastered.wav');
  }

  mp3Path(songId: string, version: RenderVersion = 'mastered'): string {
    return join(this.dirFor(songId), version === 'mastered' ? 'out.mp3' : 'out-unmastered.mp3');
  }

  /** Whether a finished render has this version (renders made before the
   *  unmastered/mastered split have only out.wav/out.mp3). */
  hasVersion(songId: string, version: RenderVersion): boolean {
    return existsSync(this.mp3Path(songId, version)) && existsSync(this.wavPath(songId, version));
  }

  /** Current status, or undefined if the song was never rendered. */
  status(songId: string): RenderStatus | undefined {
    const live = this.statuses.get(songId);
    if (live) return live;
    const file = join(this.dirFor(songId), 'status.json');
    if (!existsSync(file)) return undefined;
    const stored = JSON.parse(readFileSync(file, 'utf8')) as RenderStatus;
    const restored: RenderStatus =
      stored.state === 'queued' || stored.state === 'running'
        ? { ...stored, state: 'failed', error: 'interrupted: the brain restarted while this render was in progress' }
        : stored;
    this.statuses.set(songId, restored);
    return restored;
  }

  /** Queue a render unless one is queued, running or already done. */
  /** Render a song. `mixConfig`: the song's own mix config (its Pro-mode changes
   *  applied), or undefined for the standard one. A song already rendered (or on
   *  its way) with the same mix is not rendered again; a changed mix is. */
  /** `takes`: the vocal takes the render plays (their fingerprints), so a render made before a section was sung is
   *  not reused once it is. */
  enqueue(songId: string, canonical: string, mixConfig?: string, takes?: string): RenderStatus {
    const key = [mixConfig ?? '', takes ?? ''].join('\u0000');
    const mixHash = mixConfig === undefined && !takes ? '' : createHash('sha256').update(key).digest('hex').slice(0, 16);
    const current = this.status(songId);
    if (current && current.state !== 'failed' && (current.mixHash ?? '') === mixHash) return current;
    if (current && (current.state === 'queued' || current.state === 'running')) {
      throw new Error(`song ${songId} is already rendering with another mix; render again when it has finished`);
    }
    const dir = this.dirFor(songId);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'song-in.json'), canonical);
    if (mixConfig !== undefined) writeFileSync(join(dir, 'mix-config.json'), mixConfig);
    this.set({ songId, state: 'queued', queuedAt: new Date().toISOString(), mixHash });
    this.queue.push({ songId, canonical });
    void this.drain();
    return this.status(songId)!;
  }

  /** Position in the queue (0 = next to run), or undefined if not queued. */
  queuePosition(songId: string): number | undefined {
    const i = this.queue.findIndex((j) => 'songId' in j && j.songId === songId);
    return i < 0 ? undefined : i;
  }

  private set(status: RenderStatus): void {
    this.statuses.set(status.songId, status);
    writeFileSync(join(this.dirFor(status.songId), 'status.json'), JSON.stringify(status, null, 2));
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let job = this.queue.shift(); job; job = this.queue.shift()) {
        if ('oneOff' in job) await job.oneOff();
        else await this.run(job.songId);
      }
    } finally {
      this.running = false;
    }
  }

  /** Renders a song's mix, unmastered, into `dir` (its own folder, e.g. a background task's), in turn with the song
   *  renders, without touching any song's render: the WAV's path. `mixConfig`: the song's Pro-mode mix, or undefined
   *  for the standard one. Rejects with the failing step's log tail. */
  renderMix(dir: string, canonical: string, mixConfig?: string): Promise<string> {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'song-in.json'), canonical);
    if (mixConfig !== undefined) writeFileSync(join(dir, 'mix-config.json'), mixConfig);
    const wav = join(dir, 'out-unmastered.wav');
    return new Promise((resolvePromise, reject) => {
      this.queue.push({
        oneOff: () => this.lowerAndRender(dir, wav).then(() => resolvePromise(wav), reject),
      });
      void this.drain();
    });
  }

  /** Lowers `dir`/song-in.json and renders it (with `dir`/mix-config.json when there is one) to `wav`, unmastered. */
  private async lowerAndRender(dir: string, wav: string, onStep?: (step: 'lower' | 'render') => void): Promise<void> {
    const c = this.config;
    const env = { ...process.env, CASPERAKI_SAMPLE_LIBRARY_ROOT: c.sampleLibraryRoot };
    onStep?.('lower');
    await runLogged(
      c.nodeBin,
      [c.emitScript],
      {
        ...env,
        BRAIN_SONG_FILE: join(dir, 'song-in.json'),
        OUT_DIR: dir,
        ...(c.vocalTakesDir ? { CASPERAKI_VOCAL_TAKES_DIR: resolve(c.vocalTakesDir) } : {}),
      },
      join(dir, 'lower.log'),
      LOWER_TIMEOUT_MS,
    );
    onStep?.('render');
    await runLogged(
      c.renderBin,
      [dir, wav, c.stubSamplesDir, c.sampleLibraryRoot],
      {
        ...env,
        CASPERAKI_BITS: '24',
        ...(c.mix ? { CASPERAKI_MIX: '1' } : {}),
        // The song's own mix (Pro-mode changes), else the renderer's standard config.
        ...(existsSync(join(dir, 'mix-config.json')) ? { CASPERAKI_MIX_CONFIG: join(dir, 'mix-config.json') } : {}),
      },
      join(dir, 'render.log'),
      RENDER_TIMEOUT_MS,
    );
    if (!existsSync(wav)) throw new Error(`renderer exited cleanly but wrote no ${wav.split('/').pop()} (see render.log)`);
  }

  private async run(songId: string): Promise<void> {
    const dir = this.dirFor(songId);
    const base = this.status(songId)!;
    const startedAt = new Date().toISOString();
    const c = this.config;
    const env = { ...process.env, CASPERAKI_SAMPLE_LIBRARY_ROOT: c.sampleLibraryRoot };
    try {
      const unmastered = this.wavPath(songId, 'unmastered');
      const mastered = this.wavPath(songId, 'mastered');
      await this.lowerAndRender(dir, unmastered, (step) => this.set({ ...base, state: 'running', step, startedAt }));

      this.set({ ...base, state: 'running', step: 'master', startedAt });
      await runLogged(c.masteringBin, [unmastered, mastered, 'sergree'], env, join(dir, 'master.log'), MASTER_TIMEOUT_MS);
      if (!existsSync(mastered)) {
        throw new Error('mastering exited cleanly but wrote no out.wav (see master.log)');
      }

      this.set({ ...base, state: 'running', step: 'encode', startedAt });
      for (const version of ['mastered', 'unmastered'] as const) {
        await runLogged(
          c.ffmpegBin,
          // LAME VBR quality 2 (= lame -V2, what legacy shipped).
          mp3EncodeArgs(this.wavPath(songId, version), this.mp3Path(songId, version), MP3_HEADROOM_DB, readFileSync(join(dir, 'song-in.json'), 'utf8')),
          env,
          join(dir, `encode-${version}.log`),
          ENCODE_TIMEOUT_MS,
        );
      }

      const durationSec = (Date.now() - Date.parse(startedAt)) / 1000;
      this.set({ ...base, state: 'done', startedAt, finishedAt: new Date().toISOString(), durationSec });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[render] ${songId} failed: ${message}`);
      this.set({ ...base, state: 'failed', startedAt, finishedAt: new Date().toISOString(), error: message });
    }
  }
}

/** Run a child process, writing its combined output to `logPath`. Rejects
 *  with the last lines of output when it exits non-zero or times out. */
export function runLogged(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  logPath: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    execFile(cmd, args, { env, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      const log = `$ ${cmd} ${args.join(' ')}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`;
      writeFileSync(logPath, log);
      if (err) {
        const tail = `${stderr}\n${stdout}`.trim().split('\n').slice(-6).join('\n');
        const why = (err as { killed?: boolean }).killed ? `timed out after ${timeoutMs / 1000}s` : err.message.split('\n')[0];
        reject(new Error(`${cmd.split('/').pop()} failed: ${why}\n${tail}`));
        return;
      }
      resolvePromise();
    });
  });
}

/** The ffmpeg arguments for one MP3 encode; a song with a YuE2 vocal take gets the CC BY-NC credit as MP3 metadata. */
export function mp3EncodeArgs(wav: string, mp3: string, headroomDb: number, canonical: string): string[] {
  const credit = hasYue2Take(canonical) ? ['-metadata', `comment=${VOCALS_CREDIT}`] : [];
  return ['-y', '-hide_banner', '-loglevel', 'error', '-i', wav, '-af', `volume=${headroomDb}dB`, '-codec:a', 'libmp3lame', '-q:a', '2', ...credit, mp3];
}
