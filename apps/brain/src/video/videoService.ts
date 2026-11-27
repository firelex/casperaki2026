// Music videos, one job per (song, style, format): make sure the song has an
// exported mix with its own mix (start the export and wait when it has none),
// then for the cartoon style ask the planner for a scene plan, for the console
// style check the measured tracks belong to this version of the song, and
// render the MP4 with the video engine. Status lives in memory and on disk
// (status-<job>.json), like RenderService. A job is named by jobId(): the
// cartoon's keep their format names ("portrait"), console ones are
// "console-portrait".

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';

import type { AvatarRenderRequest, ConsoleRenderRequest, RenderRequest } from '@casperaki/video';
import { parseSong } from '@casperaki/song-schema';

import type { RenderService } from '../render/renderService.js';
import type { SongsStore } from '../store.js';
import type { Planner } from './planner.js';
import { songVersionKey } from '../render/songVersion.js';
import { songToAvatarInput, songToConsoleInput, songToVideoInput, VideoInputError, type ConsoleBody, type VideoAvatar } from './videoInput.js';

const execFileAsync = promisify(execFile);

export type Orientation = 'landscape' | 'portrait';
/** A video of a song: wide or tall, full size or a half-size quick preview (its own job and file). */
export type VideoFormat = Orientation | `${Orientation}-preview`;
export const FORMATS: readonly VideoFormat[] = ['landscape', 'portrait', 'landscape-preview', 'portrait-preview'];
export const orientationOf = (f: VideoFormat): Orientation => (f.startsWith('portrait') ? 'portrait' : 'landscape');
export const qualityOf = (f: VideoFormat): 'full' | 'preview' => (f.endsWith('-preview') ? 'preview' : 'full');
export type VideoStyle = 'cartoon' | 'console' | 'avatars';
export const STYLES: readonly VideoStyle[] = ['cartoon', 'console', 'avatars'];
/** A job's name, for its files and its status: the cartoon's keep their format names. */
export const jobId = (style: VideoStyle, format: VideoFormat): string => (style === 'cartoon' ? format : `${style}-${format}`);

/** The measured tracks are for another version of the song than the saved one. */
export const SONG_CHANGED_MESSAGE = 'The song changed after its tracks were measured. Open the Music Video tab again to measure the saved version.';

export interface VideoStatus {
  readonly songId: string;
  readonly style: VideoStyle;
  readonly format: VideoFormat;
  readonly state: 'queued' | 'running' | 'done' | 'failed';
  readonly step?: 'audio' | 'planning' | 'rendering';
  /** Progress of the current step, 0..1 (planning: shots written; rendering: frames). */
  readonly progress?: number;
  /** What exactly is happening, in plain words ("shot 5 of about 12 written"). */
  readonly detail?: string;
  /** When the current step began (the page shows a running timer). */
  readonly stepStartedAt?: string;
  readonly error?: string;
  readonly queuedAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
}

export interface VideoServiceConfig {
  /** One sub-directory per song: <videosDir>/<songId>/<format>.mp4 (+ plan.json). */
  readonly videosDir: string;
  readonly ffmpegBin: string;
  /** Frames rendered in parallel (undefined: the engine's default, 8). */
  readonly renderConcurrency?: number | undefined;
}

export interface VideoServiceDeps {
  readonly config: VideoServiceConfig;
  readonly store: SongsStore;
  readonly renders: RenderService;
  readonly planner: Planner;
  /** The engine's renderVideo (injected so tests need no Chrome). */
  readonly renderVideo: (request: RenderRequest) => Promise<void>;
  /** The engine's renderConsoleVideo (injected so tests need no Chrome). */
  readonly renderConsoleVideo: (request: ConsoleRenderRequest) => Promise<void>;
  /** The engine's renderAvatarVideo (injected so tests need no Chrome). */
  readonly renderAvatarVideo: (request: AvatarRenderRequest) => Promise<void>;
  /** Avatars on a dance floor: the owner's avatars by id, the lead marked (throws VideoInputError naming the
   *  problem), and the part packs' folder. Unset: the avatars style answers 503. */
  readonly avatars?: { readonly resolve: (ownerId: string, songId: string, ids: readonly string[]) => VideoAvatar[]; readonly packsDir: string };
  /** The song's own mix config (Pro-mode changes applied), or undefined on the standard mix (render/songVersion.ts). */
  readonly songMix: (ownerId: string, songId: string) => string | undefined;
  /** The standard mix config (for the version key of a song on the standard mix). */
  readonly standardMixConfig: () => string;
  /** Audio length in seconds (default: ffprobe next to the configured ffmpeg). */
  readonly probeSeconds?: (path: string) => Promise<number>;
}

const AUDIO_POLL_MS = 1000;
/** The song export's stages (RenderService steps) in plain words. */
const EXPORT_STEP: Readonly<Record<string, string>> = {
  lower: 'preparing the arrangement',
  render: 'rendering the mix',
  master: 'mastering',
  encode: 'encoding WAV and MP3',
};
const AUDIO_TIMEOUT_MS = 30 * 60_000;

export type StartArgs = { ownerId: string; songId: string; format: VideoFormat; title: string; artist: string } & (
  | { style: 'cartoon' }
  | { style: 'console'; console: ConsoleBody }
  | { style: 'avatars'; console: ConsoleBody; avatarIds: readonly string[] }
);

export class VideoBusyError extends Error {
  constructor(songId: string) {
    super(`A music video for song ${songId} is already being made.`);
  }
}

export class VideoService {
  private readonly statuses = new Map<string, VideoStatus>();

  constructor(private readonly deps: VideoServiceDeps) {}

  dirFor(songId: string): string {
    if (!/^[0-9a-f]{16}$/u.test(songId)) throw new Error(`invalid song id: ${songId}`);
    return join(this.deps.config.videosDir, songId);
  }

  mp4Path(songId: string, style: VideoStyle, format: VideoFormat): string {
    return join(this.dirFor(songId), `${jobId(style, format)}.mp4`);
  }

  status(songId: string, style: VideoStyle, format: VideoFormat): VideoStatus | undefined {
    const job = jobId(style, format);
    const key = `${songId}:${job}`;
    const live = this.statuses.get(key);
    if (live) return live;
    const file = join(this.dirFor(songId), `status-${job}.json`);
    if (!existsSync(file)) return undefined;
    // Cartoon statuses written before styles existed have no style.
    const stored = { style, ...(JSON.parse(readFileSync(file, 'utf8')) as Omit<VideoStatus, 'style'>) } as VideoStatus;
    const restored: VideoStatus =
      stored.state === 'queued' || stored.state === 'running'
        ? { ...stored, state: 'failed', error: 'interrupted: the brain restarted while this video was being made' }
        : stored;
    this.statuses.set(key, restored);
    return restored;
  }

  /** Start a video; one job at a time per song, of either style (VideoBusyError otherwise). A console video needs
   *  the tracks measured for the saved version of the song (VideoInputError 409 song_changed otherwise). */
  start(args: StartArgs): VideoStatus {
    for (const style of STYLES)
      for (const f of FORMATS) {
        const s = this.status(args.songId, style, f);
        if (s && (s.state === 'queued' || s.state === 'running')) throw new VideoBusyError(args.songId);
      }
    if (args.style !== 'cartoon' && args.console.versionKey !== this.versionKey(args.ownerId, args.songId)) {
      throw new VideoInputError(409, 'song_changed', SONG_CHANGED_MESSAGE);
    }
    if (args.style === 'avatars') {
      if (!this.deps.avatars) throw new VideoInputError(503, 'avatars_not_configured', 'Avatar videos are not set up: BRAIN_AVATAR_PACKS_DIR and BRAIN_SINGERS_DATA_DIR are needed.');
      this.deps.avatars.resolve(args.ownerId, args.songId, args.avatarIds);
    }
    mkdirSync(this.dirFor(args.songId), { recursive: true });
    const status: VideoStatus = { songId: args.songId, style: args.style, format: args.format, state: 'queued', queuedAt: new Date().toISOString() };
    this.set(status);
    void this.run(args, status);
    return status;
  }

  private set(status: VideoStatus): void {
    const job = jobId(status.style, status.format);
    this.statuses.set(`${status.songId}:${job}`, status);
    writeFileSync(join(this.dirFor(status.songId), `status-${job}.json`), JSON.stringify(status, null, 2));
  }

  private async run(args: StartArgs, base: VideoStatus): Promise<void> {
    const startedAt = new Date().toISOString();
    const out = this.mp4Path(args.songId, args.style, args.format);
    const tmp = join(dirname(out), `.${basename(out)}.tmp-${process.pid}.mp4`);
    try {
      const step = (s: 'audio' | 'planning' | 'rendering', extra: Partial<VideoStatus> = {}) =>
        this.set({ ...base, state: 'running', step: s, startedAt, stepStartedAt: stepStart, ...extra });
      let stepStart = new Date().toISOString();
      step('audio', { detail: 'checking for the song’s exported mix' });
      const stored = this.deps.store.get(args.songId);
      if (!stored) throw new Error(`song ${args.songId} is not in the store`);
      const song = parseSong(JSON.parse(stored.canonical));
      const audioPath = await this.exportedMix(args.songId, stored.canonical, this.deps.songMix(args.ownerId, args.songId), (detail) => step('audio', { detail }));
      const durationSeconds = await (this.deps.probeSeconds ?? ((p: string) => this.probeSeconds(p)))(audioPath);
      const audio = { path: audioPath, durationSeconds };

      let lastWritten = 0;
      const onProgress = (progress: number) => {
        // Status file writes at most every 2%.
        if (progress - lastWritten >= 0.02 || progress >= 1) {
          lastWritten = progress;
          step('rendering', { progress, detail: `${Math.round(progress * 100)}% of ${Math.round(durationSeconds)} s of video rendered` });
        }
      };
      const render = { outPath: tmp, orientation: orientationOf(args.format), quality: qualityOf(args.format), concurrency: this.deps.config.renderConcurrency, onProgress };

      if (args.style === 'avatars') {
        if (args.console.versionKey !== this.versionKey(args.ownerId, args.songId)) throw new Error(SONG_CHANGED_MESSAGE);
        const { versionKey: _versionKey, ...tracks } = args.console;
        const avatars = this.deps.avatars!.resolve(args.ownerId, args.songId, args.avatarIds);
        const input = songToAvatarInput({ title: args.title, artist: args.artist, song, audio, body: tracks, avatars });
        writeFileSync(join(this.dirFor(args.songId), `avatars-input-${args.format}.json`), JSON.stringify(input));
        stepStart = new Date().toISOString();
        step('rendering', { progress: 0, detail: 'starting the renderer (bundling the scene, building the avatars)' });
        await this.deps.renderAvatarVideo({ input, packsDir: this.deps.avatars!.packsDir, ...render });
      } else if (args.style === 'console') {
        // The song's mix may have changed while it exported (a Pro-mode change).
        if (args.console.versionKey !== this.versionKey(args.ownerId, args.songId)) throw new Error(SONG_CHANGED_MESSAGE);
        const { versionKey: _versionKey, ...tracks } = args.console;
        const project = this.deps.store.getProject(args.ownerId, args.songId);
        if (!project) throw new Error(SONG_CHANGED_MESSAGE);
        // A song on the standard mix has no Pro-mode changes.
        const overrides = project.mixOverrides?.lanes ?? {};
        const input = songToConsoleInput({ title: args.title, artist: args.artist, song, audio, body: tracks, overrides });
        writeFileSync(join(this.dirFor(args.songId), `console-input-${args.format}.json`), JSON.stringify(input));
        stepStart = new Date().toISOString();
        step('rendering', { progress: 0, detail: 'starting the renderer (bundling the scene)' });
        await this.deps.renderConsoleVideo({ input, ...render });
      } else {
        const input = songToVideoInput({ title: args.title, artist: args.artist, song, audio });
        stepStart = new Date().toISOString();
        const expectedShots = Math.max(1, input.sections.length);
        step('planning', { progress: 0, detail: `asking the scene planner (about ${expectedShots} shots, one per section)` });
        let lastShots = -1;
        const plan = await this.deps.planner.plan(input, ({ shots, attempt }) => {
          if (shots === lastShots) return;
          lastShots = shots;
          step('planning', {
            progress: Math.min(0.95, shots / expectedShots),
            detail: `${attempt > 1 ? 'fixing the plan: ' : ''}shot ${shots}${shots <= expectedShots ? ` of about ${expectedShots}` : ''} written`,
          });
        });
        writeFileSync(join(this.dirFor(args.songId), `plan-${args.format}.json`), JSON.stringify({ input, plan }, null, 2));
        stepStart = new Date().toISOString();
        step('rendering', { progress: 0, detail: 'starting the renderer (bundling the scenes)' });
        await this.deps.renderVideo({ input, plan, ...render });
      }
      if (!existsSync(tmp)) throw new Error('the video renderer finished but wrote no file');
      renameSync(tmp, out);
      this.set({ ...base, state: 'done', startedAt, finishedAt: new Date().toISOString() });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      rmSync(tmp, { force: true });
      this.set({ ...base, state: 'failed', error: message, startedAt, finishedAt: new Date().toISOString() });
    }
  }

  /** The version key of the song as saved, with its mix (render/songVersion.ts). */
  versionKey(ownerId: string, songId: string): string {
    const stored = this.deps.store.get(songId);
    if (!stored) throw new Error(`song ${songId} is not in the store`);
    return songVersionKey(stored.canonical, this.deps.songMix(ownerId, songId) ?? this.deps.standardMixConfig());
  }

  /** The song's mastered export (MP3) with its mix (`mixConfig`: Pro-mode, or undefined for the standard mix);
   *  the render service re-exports when the mix differs from its last export. */
  private async exportedMix(songId: string, canonical: string, mixConfig: string | undefined, report: (detail: string) => void): Promise<string> {
    const renders = this.deps.renders;
    // enqueue reuses an export of the same mix (done or on its way) and re-exports for a different one.
    let s = renders.enqueue(songId, canonical, mixConfig);
    const deadline = Date.now() + AUDIO_TIMEOUT_MS;
    let lastDetail = '';
    while (s.state === 'queued' || s.state === 'running') {
      if (Date.now() > deadline) throw new Error('the song export took longer than 30 minutes');
      const detail = s.state === 'queued' ? 'the song’s export is waiting its turn' : `exporting the song: ${EXPORT_STEP[(s as { step?: string }).step ?? ''] ?? 'working'}`;
      if (detail !== lastDetail) report((lastDetail = detail));
      await new Promise((r) => setTimeout(r, AUDIO_POLL_MS));
      s = renders.status(songId)!;
    }
    if (s.state === 'failed') throw new Error(`the song export failed: ${s.error ?? 'no reason given'}`);
    const mp3 = renders.mp3Path(songId, 'mastered');
    if (!existsSync(mp3)) throw new Error(`the song export finished but ${basename(mp3)} is missing`);
    return mp3;
  }

  private async probeSeconds(path: string): Promise<number> {
    const ffmpeg = this.deps.config.ffmpegBin;
    const ffprobe = ffmpeg.includes('/') ? join(dirname(ffmpeg), 'ffprobe') : 'ffprobe';
    const { stdout } = await execFileAsync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', path]);
    const sec = Number.parseFloat(stdout.trim());
    if (!Number.isFinite(sec) || sec <= 0) throw new Error(`ffprobe gave no duration for ${basename(path)}`);
    return sec;
  }
}
