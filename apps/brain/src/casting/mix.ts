// The casting video's soundtrack (docs/superpowers/plans/2026-11-28-casting-4-soundtrack.md): one 48 kHz stereo WAV
// as long as the timeline: "Poised and Ready" under the backstage narration (ducked under the voice, faded out at the
// door), "The Grand Entrance" whole at the stage door, the song from its start to the end of its first chorus then
// faded, and every spoken line at its time.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import type { CastingTimeline } from './timeline.js';

export interface SoundtrackFiles {
  /** Each line's WAV, by line id. */
  readonly lines: ReadonlyMap<string, string>;
  readonly song: string;
  readonly poised: string;
  readonly entrance: string;
  /** Each line's gain (linear), by line id: its speaker's, evening the voices out. */
  readonly gains: ReadonlyMap<string, number>;
  /** The applause after the song, and the music under the verdicts, each with the gain (linear) that brings it to its
   *  level (APPLAUSE_LUFS, BED_LUFS: the generated files' own loudness varies by 15 dB). */
  readonly applause: string;
  readonly applauseGain: number;
  readonly verdictBed: string;
  readonly bedGain: number;
  /** The music under the meeting after the fanfare (fading to zero before the song's second of silence). */
  readonly talkBed: string;
  readonly talkBedGain: number;
}

/** The applause's loudness (a little under the voices' -16), and how long it dies away once the judges start talking. */
export const APPLAUSE_LUFS = -18;
const APPLAUSE_FADE = 2.5;
/** The verdict music's loudness: quiet under the voices; it fades in after the applause and out at the end. */
export const BED_LUFS = -31;
const BED_FADE = 2;

/** The gain (linear) bringing a file to `targetLufs`. */
export function gainTo(ffmpegBin: string, file: string, targetLufs: number): number {
  return 10 ** ((targetLufs - loudness(ffmpegBin, [file])) / 20);
}

/** One of `files`, fixed by `key` (each script gets its own applause and verdict music, the same every time). */
export function pickFor(files: readonly string[], key: string, what: string): string {
  if (files.length === 0) throw new Error(`casting soundtrack: there is no ${what} to choose from`);
  let h = 0x811c9dc5;
  for (const ch of `${what}:${key}`) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return [...files].sort()[h % files.length]!;
}

/** The backstage music's level under the narration. */
const MUSIC_GAIN = 0.5;
/** The backstage music fades out under the fanfare over this long, from the fanfare's start. */
const MUSIC_CROSSFADE = 1;
/** The narrator sits into the music rather than cutting through it (the owner: "too compressed, cuts a tad too much
 *  through"): about 3 dB down, the music ducking gently under it. */
const NARRATION_GAIN = 0.7;
/** The judges in the meeting after the fanfare sit a little softer (the owner: "also a bit softer"): about 2 dB. */
const MEETING_GAIN = 0.8;

/** Integrated loudness (LUFS) of several files played one after another (a speaker's lines). */
export function loudness(ffmpegBin: string, files: readonly string[]): number {
  if (files.length === 0) throw new Error('casting soundtrack: no files to measure');
  for (const f of files) if (!existsSync(f)) throw new Error(`casting soundtrack: the file is missing: ${f}`);
  const inputs = files.flatMap((f) => ['-i', f]);
  const concat = `${files.map((_, i) => `[${i}:a]aresample=48000,aformat=channel_layouts=mono[a${i}]`).join(';')};${files.map((_, i) => `[a${i}]`).join('')}concat=n=${files.length}:v=0:a=1,ebur128=framelog=quiet[out]`;
  const res = spawnSync(ffmpegBin, ['-hide_banner', '-nostats', ...inputs, '-filter_complex', concat, '-map', '[out]', '-f', 'null', '-'], { encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`casting soundtrack: cannot measure loudness: ${(res.stderr ?? '').trim().split('\n').slice(-2).join(' ')}`);
  const m = /Integrated loudness:\s*I:\s*(-?[\d.]+) LUFS/u.exec(res.stderr ?? '');
  if (!m) throw new Error('casting soundtrack: ffmpeg gave no loudness');
  return Number(m[1]);
}

/** One gain per speaker (linear) bringing all their lines together to `targetLufs`: every voice at one loudness, each
 *  line keeping its own rise and fall. */
export function speakerGains(ffmpegBin: string, linesBySpeaker: ReadonlyMap<string, readonly string[]>, targetLufs: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const [speaker, files] of linesBySpeaker) out.set(speaker, 10 ** ((targetLufs - loudness(ffmpegBin, files)) / 20));
  return out;
}

/** How long an audio file is heard: its length without the silence at its end (quieter than -45 dB for 0.3 s or more). */
export function audibleSeconds(ffmpegBin: string, path: string): number {
  if (!existsSync(path)) throw new Error(`casting soundtrack: the file is missing: ${path}`);
  const res = spawnSync(ffmpegBin, ['-hide_banner', '-nostats', '-i', path, '-af', 'silencedetect=noise=-45dB:d=0.3', '-f', 'null', '-'], { encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`casting soundtrack: cannot measure ${path}: ${(res.stderr ?? '').trim().split('\n').slice(-2).join(' ')}`);
  const log = res.stderr ?? '';
  const duration = /Duration: (\d+):(\d+):([\d.]+)/u.exec(log);
  if (!duration) throw new Error(`casting soundtrack: cannot tell the length of ${path}`);
  const total = Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]);
  const starts = [...log.matchAll(/silence_start: ([\d.]+)/gu)].map((m) => Number(m[1]));
  const ends = [...log.matchAll(/silence_end: ([\d.]+)/gu)].map((m) => Number(m[1]));
  // Silence running to the end: a start without an end, or an end at the very end of the file.
  const last = starts.at(-1);
  if (last !== undefined && (ends.length < starts.length || Math.abs((ends.at(-1) ?? 0) - total) < 0.1)) return last;
  return total;
}

export function mixSoundtrack(timeline: CastingTimeline, files: SoundtrackFiles, outPath: string, ffmpegBin: string): void {
  for (const [what, p] of [['backstage music', files.poised], ['stage door music', files.entrance], ['song', files.song], ['applause', files.applause], ['verdict music', files.verdictBed]] as const) {
    if (!existsSync(p)) throw new Error(`casting soundtrack: the ${what} file is missing: ${p}`);
  }
  const seg = (kind: string) => {
    const s = timeline.segments.find((x) => x.kind === kind);
    if (!s) throw new Error(`casting soundtrack: the timeline has no ${kind} segment`);
    return s;
  };
  const backstage = seg('backstage');
  const door = seg('door');
  const talk = seg('talk');
  const ms = (s: number) => Math.round(s * 1000);
  const inputs: string[] = ['-i', files.poised, '-i', files.entrance, '-i', files.song, '-i', files.applause, '-i', files.verdictBed, '-i', files.talkBed];
  const graph: string[] = [];
  const stereo = 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo';
  const narration: string[] = [];
  const voices: string[] = [];
  timeline.lines.forEach((l, i) => {
    const file = files.lines.get(l.id);
    if (!file || !existsSync(file)) throw new Error(`casting soundtrack: the line ${l.id} has no spoken file`);
    inputs.push('-i', file);
    const label = `l${i}`;
    const isNarration = l.startSeconds < backstage.endSeconds;
    const gain = files.gains.get(l.id);
    if (gain === undefined) throw new Error(`casting soundtrack: the line ${l.id} has no gain`);
    const inMeeting = l.startSeconds >= talk.startSeconds && l.startSeconds < talk.endSeconds;
    graph.push(`[${6 + i}:a]${stereo},volume=${(gain * (isNarration ? NARRATION_GAIN : inMeeting ? MEETING_GAIN : 1)).toFixed(4)},adelay=${ms(l.startSeconds)}:all=1[${label}]`);
    if (isNarration) narration.push(label);
    voices.push(label);
  });
  // The narration also drives the music's ducking.
  const voiceLabels = voices.map((v) => (narration.includes(v) ? `${v}a` : v));
  for (const n of narration) graph.push(`[${n}]asplit=2[${n}a][${n}b]`);
  // The backstage music plays at full level up to the fanfare and crosses into it (no dip before the stage door).
  const musicLen = backstage.endSeconds - backstage.startSeconds;
  const fadeAt = timeline.doorMusic.startSeconds - backstage.startSeconds;
  graph.push(`[0:a]${stereo},atrim=0:${(fadeAt + MUSIC_CROSSFADE).toFixed(3)},volume=${MUSIC_GAIN},afade=t=out:st=${fadeAt.toFixed(3)}:d=${MUSIC_CROSSFADE}[poised]`);
  if (narration.length > 0) {
    graph.push(`${narration.map((n) => `[${n}b]`).join('')}amix=inputs=${narration.length}:normalize=0[duck]`);
    graph.push('[poised][duck]sidechaincompress=threshold=0.05:ratio=3:attack=30:release=600[music]');
  } else graph.push('[poised]anull[music]');
  graph.push(`[1:a]${stereo},atrim=0:${timeline.doorMusic.seconds.toFixed(3)},adelay=${ms(timeline.doorMusic.startSeconds)}:all=1[door]`);
  const { songToSeconds, fadeSeconds, videoStartSeconds } = timeline.performance;
  graph.push(`[2:a]${stereo},atrim=0:${(songToSeconds + fadeSeconds).toFixed(3)},afade=t=out:st=${songToSeconds.toFixed(3)}:d=${fadeSeconds},adelay=${ms(videoStartSeconds)}:all=1[song]`);
  // The applause rises as the song fades and dies away once the first verdict comes in over it.
  const verdicts = seg('verdicts');
  const firstVerdict = timeline.lines.find((l) => l.startSeconds >= verdicts.startSeconds);
  if (!firstVerdict) throw new Error('casting soundtrack: the verdicts have no lines');
  const applauseLen = firstVerdict.startSeconds - timeline.applauseStartSeconds + APPLAUSE_FADE;
  graph.push(`[3:a]${stereo},atrim=0:${applauseLen.toFixed(3)},volume=${files.applauseGain.toFixed(4)},afade=t=out:st=${(applauseLen - APPLAUSE_FADE).toFixed(3)}:d=${APPLAUSE_FADE},adelay=${ms(timeline.applauseStartSeconds)}:all=1[applause]`);
  // The verdict music under the talk: in after the applause, out at the end (looped if the verdicts outlast it).
  const bedStart = firstVerdict.startSeconds;
  const bedLen = verdicts.endSeconds - bedStart;
  graph.push(`[4:a]${stereo},aloop=loop=-1:size=2147483647,atrim=0:${bedLen.toFixed(3)},volume=${files.bedGain.toFixed(4)},afade=t=in:d=${BED_FADE},afade=t=out:st=${Math.max(0, bedLen - BED_FADE).toFixed(3)}:d=${BED_FADE},adelay=${ms(bedStart)}:all=1[bed]`);
  // Music under the meeting: in with the talk, faded to zero by its end (then the song's second of silence).
  const talkLen = talk.endSeconds - talk.startSeconds;
  graph.push(`[5:a]${stereo},aloop=loop=-1:size=2147483647,atrim=0:${talkLen.toFixed(3)},volume=${files.talkBedGain.toFixed(4)},afade=t=in:d=${Math.min(BED_FADE, talkLen / 3).toFixed(3)},afade=t=out:st=${Math.max(0, talkLen - BED_FADE).toFixed(3)}:d=${BED_FADE},adelay=${ms(talk.startSeconds)}:all=1[talkbed]`);
  const all = ['music', 'door', 'song', 'applause', 'bed', 'talkbed', ...voiceLabels];
  graph.push(`${all.map((a) => `[${a}]`).join('')}amix=inputs=${all.length}:normalize=0:duration=longest,alimiter=limit=0.95,apad,atrim=0:${timeline.durationSeconds.toFixed(3)}[out]`);
  try {
    execFileSync(ffmpegBin, ['-loglevel', 'error', '-y', ...inputs, '-filter_complex', graph.join(';'), '-map', '[out]', '-ar', '48000', '-c:a', 'pcm_s16le', outPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    const e = err as { stderr?: Buffer; message: string };
    throw new Error(`casting soundtrack: ffmpeg failed: ${e.stderr?.toString().trim().split('\n').slice(-3).join(' ') || e.message}`);
  }
}
