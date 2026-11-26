// A Casperaki song as the music-video engine (@casperaki/video) sees it: the
// engine never reads a Casperaki song; this adapter builds its VideoInput.

import { catalog, ConsoleInputObjectSchema, ConsoleInputSchema, VideoInputSchema, type ConsoleInput, type VideoInput } from '@casperaki/video';
import { z } from 'zod';
import type { Song } from '@casperaki/song-schema';

export class VideoInputError extends Error {
  constructor(
    readonly status: 400 | 409,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const BEATS_PER_BAR = 4;
/** The lead vocal track (backing vocals sing the same words). */
/** Bars per lyric line: the lyric bank writes one rhyme line per 4 bars (vocals/scaffolding.ts). */
const LINE_BARS = 4;
const LEAD_VOCAL = 'Vocal';

/** "verse1" → "Verse 1", "preChorus2" → "Pre-chorus 2", "intro" → "Intro". */
export function sectionDisplayName(name: string): string {
  const m = /^([A-Za-z]+?)(\d*)$/u.exec(name);
  if (!m) return name;
  const words = m[1]!.replace(/([a-z])([A-Z])/gu, '$1-$2').toLowerCase();
  const label = words.charAt(0).toUpperCase() + words.slice(1);
  return m[2] ? `${label} ${m[2]}` : label;
}

interface SungNote {
  readonly start: number; // seconds
  readonly end: number; // seconds
  readonly word: string;
  readonly endOfPhrase: boolean;
}

/**
 * The song's lyric lines with their times: the lead vocal's notes in order,
 * syllables joined into words ("Wal-" + "King" → "Walking"; the lyric bank
 * capitalises every syllable), one line per 4-bar block from each section's
 * start (the lyric bank's rhyme lines), so a banner carries a sentence.
 */
export function lyricLines(song: Song): VideoInput['lyrics'] {
  const secPerBeat = 60 / song.bpm;
  // Sung syllables in order, each tagged with its line: 4-bar blocks from each
  // section's start, the lyric bank's rhyme lines.
  const notes: (SungNote & { line: string })[] = [];
  let barStart = 0;
  for (const seg of song.songStructure) {
    const bars = seg.lengthInBars ?? seg.bars.length;
    const part = song.arrangement[seg.name]?.overrides?.[LEAD_VOCAL];
    (part?.bars ?? []).slice(0, bars).forEach((bar, barIdx) => {
      const events = Object.entries(bar.notes ?? {})
        .flatMap(([beat, evs]) => (evs ?? []).map((e) => ({ beat: Number.parseFloat(beat), e: e as { type?: string; duration?: number; fullWord?: string } })))
        .filter(({ e }) => e.type === 'vocalNote' && typeof e.fullWord === 'string' && e.fullWord.length > 0)
        .sort((x, y) => x.beat - y.beat);
      for (const { beat, e } of events) {
        const startBeat = (barStart + barIdx) * BEATS_PER_BAR + beat;
        notes.push({
          start: startBeat * secPerBeat,
          end: (startBeat + (e.duration ?? 0)) * secPerBeat,
          word: e.fullWord!,
          endOfPhrase: false,
          line: `${seg.name}#${Math.floor(barIdx / LINE_BARS)}`,
        });
      }
    });
    barStart += bars;
  }

  const lines: VideoInput['lyrics'] = [];
  let words: string[] = [];
  let pending = ''; // a syllable ending in "-" waiting for the rest of its word
  let lineStart: number | undefined;
  let lineEnd = 0;
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i]!;
    const next = notes[i + 1];
    lineStart ??= n.start;
    lineEnd = Math.max(lineEnd, n.end);
    // A syllable continuing a word keeps the word's capitalisation (the lyric
    // bank capitalises every syllable: "Wal-" + "King" → "Walking").
    const syllable = pending ? n.word.charAt(0).toLowerCase() + n.word.slice(1) : n.word;
    if (syllable.endsWith('-')) pending += syllable.slice(0, -1);
    else {
      words.push(pending + syllable);
      pending = '';
    }
    // A line ends with its block. A word whose last syllable is never sung
    // (the melody ran out of notes) shows as sung, without its hyphen.
    if (next === undefined || next.line !== n.line) {
      if (pending) {
        words.push(pending);
        pending = '';
      }
      if (words.length && lineEnd > lineStart) lines.push({ text: words.join(' '), startSeconds: round(lineStart), endSeconds: round(lineEnd) });
      words = [];
      lineStart = undefined;
      lineEnd = 0;
    }
  }
  return lines;
}

const round = (s: number) => Math.round(s * 1000) / 1000;

export interface VideoAudio {
  /** Absolute path of the song's exported mix. */
  readonly path: string;
  readonly durationSeconds: number;
}

/** The song's timing as the video engines see it: tempo, bars and sections in seconds. */
export function songTiming(song: Song): Pick<VideoInput, 'bpm' | 'firstBeatSeconds' | 'beatsPerBar' | 'sections'> {
  const secPerBar = (BEATS_PER_BAR * 60) / song.bpm;
  let bar = 0;
  const sections = song.songStructure.map((seg) => {
    const bars = seg.lengthInBars ?? seg.bars.length;
    const s = { name: sectionDisplayName(seg.name), startSeconds: round(bar * secPerBar), endSeconds: round((bar + bars) * secPerBar) };
    bar += bars;
    return s;
  });
  return { bpm: song.bpm, firstBeatSeconds: 0, beatsPerBar: BEATS_PER_BAR, sections };
}

/** The engine's VideoInput for a song (validated by the engine's own schema). */
export function songToVideoInput(args: { title: string; artist: string; song: Song; audio: VideoAudio }): VideoInput {
  const { song } = args;
  const genres = Object.keys(catalog.GENRES);
  if (!song.genre || !genres.includes(song.genre)) {
    throw new VideoInputError(400, 'unsupported_genre', `Music videos are made for the styles ${genres.join(', ')}; this song is "${song.genre ?? 'without a style'}".`);
  }
  return VideoInputSchema.parse({
    title: args.title,
    artist: args.artist,
    genre: song.genre,
    audio: { path: args.audio.path, durationSeconds: args.audio.durationSeconds },
    ...songTiming(song),
    lyrics: lyricLines(song),
    cast: [],
  });
}

/** The tracks the browser measured (the engine's schema, without the song fields the brain adds: title, artist,
 *  audio and timing). The engine's zod (v4) is not the brain's (v3): this schema stays the engine's. */
const ConsoleTracksSchema = ConsoleInputObjectSchema.omit({
  title: true,
  artist: true,
  audio: true,
  bpm: true,
  firstBeatSeconds: true,
  beatsPerBar: true,
  sections: true,
});
const VersionKeySchema = z.object({ versionKey: z.string().regex(/^[0-9a-f]{16}$/u, 'a version key is 16 hex digits') });

/** What the browser sends for a console video: the version of the song it measured, and the tracks. */
export type ConsoleBody = ReturnType<typeof ConsoleTracksSchema.parse> & { versionKey: string };

/** Parses the browser's console data; throws VideoInputError(400) naming the first problem. */
export function parseConsoleBody(raw: unknown): ConsoleBody {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new VideoInputError(400, 'invalid_body', 'console: the measured tracks are missing');
  const { versionKey, ...tracks } = raw as Record<string, unknown>;
  const key = VersionKeySchema.safeParse({ versionKey });
  if (!key.success) throw new VideoInputError(400, 'invalid_body', `console.versionKey: ${key.error.issues[0]!.message}`);
  const parsed = ConsoleTracksSchema.safeParse(tracks);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new VideoInputError(400, 'invalid_body', `console.${issue.path.join('.')}: ${issue.message}`);
  }
  return { ...parsed.data, versionKey: key.data.versionKey };
}

/** The engine's ConsoleInput for a song and the tracks measured for it (any genre). */
/** How far the measured levels' length may differ from the exported audio's: the browser renders the song itself to
 *  measure it, and the export's MP3 is a little longer or shorter (encoder padding, effect tails). */
export const LEVELS_LENGTH_TOLERANCE_SECONDS = 2;

/** The engine's ConsoleInput for a song and the tracks measured for it (any genre). Levels within
 *  LEVELS_LENGTH_TOLERANCE_SECONDS of the audio are fitted to its length: trimmed, or extended with silence (nothing
 *  was measured to play there); a larger difference is left for the engine's check to refuse. */
export function songToConsoleInput(args: { title: string; artist: string; song: Song; audio: VideoAudio; body: Omit<ConsoleBody, 'versionKey'> }): ConsoleInput {
  const { binSeconds } = args.body;
  const bins = Math.round(args.audio.durationSeconds / binSeconds);
  const measured = args.body.master.length * binSeconds;
  const fit = Math.abs(measured - args.audio.durationSeconds) <= LEVELS_LENGTH_TOLERANCE_SECONDS;
  const fitted = (levels: readonly number[]) =>
    fit ? Array.from({ length: bins }, (_, i) => (i < levels.length ? levels[i]! : 0)) : [...levels];
  const tracks = args.body.tracks.map((t) => ({ ...t, levels: fitted(t.levels) }));
  const master = fitted(args.body.master);
  return ConsoleInputSchema.parse({
    title: args.title,
    artist: args.artist,
    audio: { path: args.audio.path, durationSeconds: args.audio.durationSeconds },
    ...songTiming(args.song),
    binSeconds,
    tracks,
    master,
  });
}
