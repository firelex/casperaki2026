// Music videos, one job per (song, orientation): make sure the song has an
// exported mix (start the export and wait when it has none), ask the planner
// for a scene plan, render the MP4 with the video engine. Status lives in
// memory and on disk (status-<orientation>.json), like RenderService.

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';

import type { RenderRequest } from '@casperaki/video';
import { parseSong } from '@casperaki/song-schema';

import type { RenderService } from '../render/renderService.js';
import type { SongsStore } from '../store.js';
import type { Planner } from './planner.js';
import { songToVideoInput, VideoInputError } from './videoInput.js';

const execFileAsync = promisify(execFile);

export type Orientation = 'landscape' | 'portrait';
export const ORIENTATIONS: readonly Orientation[] = ['landscape', 'portrait'];

export interface VideoStatus {
  readonly songId: string;
  readonly orientation: Orientation;
  readonly state: 'queued' | 'running' | 'done' | 'failed';
  readonly step?: 'audio' | 'planning' | 'rendering';
  /** Rendering progress, 0..1. */
  readonly progress?: number;
  readonly error?: string;
  readonly queuedAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
}

export interface VideoServiceConfig {
  /** One sub-directory per song: <videosDir>/<songId>/<orientation>.mp4 (+ plan.json). */
  readonly videosDir: string;
  readonly ffmpegBin: string;
}

export interface VideoServiceDeps {
  readonly config: VideoServiceConfig;
  readonly store: SongsStore;
  readonly renders: RenderService;
  readonly planner: Planner;
  /** The engine's renderVideo (injected so tests need no Chrome). */
  readonly renderVideo: (request: RenderRequest) => Promise<void>;
  /** Audio length in seconds (default: ffprobe next to the configured ffmpeg). */
  readonly probeSeconds?: (path: string) => Promise<number>;
}

const AUDIO_POLL_MS = 1000;
const AUDIO_TIMEOUT_MS = 30 * 60_000;

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

  mp4Path(songId: string, orientation: Orientation): string {
    return join(this.dirFor(songId), `${orientation}.mp4`);
  }

  status(songId: string, orientation: Orientation): VideoStatus | undefined {
    const key = `${songId}:${orientation}`;
    const live = this.statuses.get(key);
    if (live) return live;
    const file = join(this.dirFor(songId), `status-${orientation}.json`);
    if (!existsSync(file)) return undefined;
    const stored = JSON.parse(readFileSync(file, 'utf8')) as VideoStatus;
    const restored: VideoStatus =
      stored.state === 'queued' || stored.state === 'running'
        ? { ...stored, state: 'failed', error: 'interrupted: the brain restarted while this video was being made' }
        : stored;
    this.statuses.set(key, restored);
    return restored;
  }

  /** Start a video; one job at a time per song (VideoBusyError otherwise). */
  start(args: { songId: string; orientation: Orientation; title: string; artist: string }): VideoStatus {
    for (const o of ORIENTATIONS) {
      const s = this.status(args.songId, o);
      if (s && (s.state === 'queued' || s.state === 'running')) throw new VideoBusyError(args.songId);
    }
    mkdirSync(this.dirFor(args.songId), { recursive: true });
    const status: VideoStatus = { songId: args.songId, orientation: args.orientation, state: 'queued', queuedAt: new Date().toISOString() };
    this.set(status);
    void this.run(args, status);
    return status;
  }

  private set(status: VideoStatus): void {
    this.statuses.set(`${status.songId}:${status.orientation}`, status);
    writeFileSync(join(this.dirFor(status.songId), `status-${status.orientation}.json`), JSON.stringify(status, null, 2));
  }

  private async run(args: { songId: string; orientation: Orientation; title: string; artist: string }, base: VideoStatus): Promise<void> {
    const startedAt = new Date().toISOString();
    try {
      this.set({ ...base, state: 'running', step: 'audio', startedAt });
      const stored = this.deps.store.get(args.songId);
      if (!stored) throw new Error(`song ${args.songId} is not in the store`);
      const song = parseSong(JSON.parse(stored.canonical));
      const audioPath = await this.exportedMix(args.songId, stored.canonical);
      const durationSeconds = await (this.deps.probeSeconds ?? ((p: string) => this.probeSeconds(p)))(audioPath);
      const input = songToVideoInput({ title: args.title, artist: args.artist, song, audio: { path: audioPath, durationSeconds } });

      this.set({ ...base, state: 'running', step: 'planning', startedAt });
      const plan = await this.deps.planner.plan(input);
      writeFileSync(join(this.dirFor(args.songId), `plan-${args.orientation}.json`), JSON.stringify({ input, plan }, null, 2));

      this.set({ ...base, state: 'running', step: 'rendering', progress: 0, startedAt });
      const out = this.mp4Path(args.songId, args.orientation);
      const tmp = join(dirname(out), `.${basename(out)}.tmp-${process.pid}.mp4`);
      let lastWritten = 0;
      await this.deps.renderVideo({
        input,
        plan,
        outPath: tmp,
        orientation: args.orientation,
        onProgress: (progress) => {
          // Status file writes at most every 2%.
          if (progress - lastWritten >= 0.02 || progress >= 1) {
            lastWritten = progress;
            this.set({ ...base, state: 'running', step: 'rendering', progress, startedAt });
          }
        },
      });
      if (!existsSync(tmp)) throw new Error('the video renderer finished but wrote no file');
      renameSync(tmp, out);
      this.set({ ...base, state: 'done', startedAt, finishedAt: new Date().toISOString() });
    } catch (err) {
      const message = err instanceof VideoInputError || err instanceof Error ? err.message : String(err);
      rmSync(join(this.dirFor(args.songId), `.${args.orientation}.mp4.tmp-${process.pid}.mp4`), { force: true });
      this.set({ ...base, state: 'failed', error: message, startedAt, finishedAt: new Date().toISOString() });
    }
  }

  /** The song's mastered export (MP3), starting the export and waiting for it when there is none. */
  private async exportedMix(songId: string, canonical: string): Promise<string> {
    const renders = this.deps.renders;
    let s = renders.status(songId);
    if (!s || s.state === 'failed') s = renders.enqueue(songId, canonical);
    const deadline = Date.now() + AUDIO_TIMEOUT_MS;
    while (s.state === 'queued' || s.state === 'running') {
      if (Date.now() > deadline) throw new Error('the song export took longer than 30 minutes');
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
