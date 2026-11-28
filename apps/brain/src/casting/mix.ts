// The casting video's soundtrack (docs/superpowers/plans/2026-11-28-casting-4-soundtrack.md): one 48 kHz stereo WAV
// as long as the timeline: "Poised and Ready" under the backstage narration (ducked under the voice, faded out at the
// door), "The Grand Entrance" whole at the stage door, the song from its start to the end of its first chorus then
// faded, and every spoken line at its time.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import type { CastingTimeline } from './timeline.js';

export interface SoundtrackFiles {
  /** Each line's WAV, by line id. */
  readonly lines: ReadonlyMap<string, string>;
  readonly song: string;
  readonly poised: string;
  readonly entrance: string;
}

/** The backstage music's level under the narration, and how long it fades out before the door. */
const MUSIC_GAIN = 0.5;
const MUSIC_FADE = 2;

export function mixSoundtrack(timeline: CastingTimeline, files: SoundtrackFiles, outPath: string, ffmpegBin: string): void {
  for (const [what, p] of [['backstage music', files.poised], ['stage door music', files.entrance], ['song', files.song]] as const) {
    if (!existsSync(p)) throw new Error(`casting soundtrack: the ${what} file is missing: ${p}`);
  }
  const seg = (kind: string) => {
    const s = timeline.segments.find((x) => x.kind === kind);
    if (!s) throw new Error(`casting soundtrack: the timeline has no ${kind} segment`);
    return s;
  };
  const backstage = seg('backstage');
  const door = seg('door');
  const ms = (s: number) => Math.round(s * 1000);
  const inputs: string[] = ['-i', files.poised, '-i', files.entrance, '-i', files.song];
  const graph: string[] = [];
  const stereo = 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo';
  const narration: string[] = [];
  const voices: string[] = [];
  timeline.lines.forEach((l, i) => {
    const file = files.lines.get(l.id);
    if (!file || !existsSync(file)) throw new Error(`casting soundtrack: the line ${l.id} has no spoken file`);
    inputs.push('-i', file);
    const label = `l${i}`;
    graph.push(`[${3 + i}:a]${stereo},adelay=${ms(l.startSeconds)}:all=1[${label}]`);
    if (l.startSeconds < backstage.endSeconds) narration.push(label);
    voices.push(label);
  });
  // The narration also drives the music's ducking.
  const voiceLabels = voices.map((v) => (narration.includes(v) ? `${v}a` : v));
  for (const n of narration) graph.push(`[${n}]asplit=2[${n}a][${n}b]`);
  const musicLen = backstage.endSeconds - backstage.startSeconds;
  graph.push(`[0:a]${stereo},atrim=0:${musicLen.toFixed(3)},volume=${MUSIC_GAIN},afade=t=out:st=${Math.max(0, musicLen - MUSIC_FADE).toFixed(3)}:d=${MUSIC_FADE}[poised]`);
  if (narration.length > 0) {
    graph.push(`${narration.map((n) => `[${n}b]`).join('')}amix=inputs=${narration.length}:normalize=0[duck]`);
    graph.push('[poised][duck]sidechaincompress=threshold=0.03:ratio=6:attack=20:release=500[music]');
  } else graph.push('[poised]anull[music]');
  graph.push(`[1:a]${stereo},adelay=${ms(door.startSeconds)}:all=1[door]`);
  const { songToSeconds, fadeSeconds, videoStartSeconds } = timeline.performance;
  graph.push(`[2:a]${stereo},atrim=0:${(songToSeconds + fadeSeconds).toFixed(3)},afade=t=out:st=${songToSeconds.toFixed(3)}:d=${fadeSeconds},adelay=${ms(videoStartSeconds)}:all=1[song]`);
  const all = ['music', 'door', 'song', ...voiceLabels];
  graph.push(`${all.map((a) => `[${a}]`).join('')}amix=inputs=${all.length}:normalize=0:duration=longest,alimiter=limit=0.95,apad,atrim=0:${timeline.durationSeconds.toFixed(3)}[out]`);
  try {
    execFileSync(ffmpegBin, ['-loglevel', 'error', '-y', ...inputs, '-filter_complex', graph.join(';'), '-map', '[out]', '-ar', '48000', '-c:a', 'pcm_s16le', outPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    const e = err as { stderr?: Buffer; message: string };
    throw new Error(`casting soundtrack: ffmpeg failed: ${e.stderr?.toString().trim().split('\n').slice(-3).join(' ') || e.message}`);
  }
}
