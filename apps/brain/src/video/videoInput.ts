// A Casperaki song as the music-video engine (@casperaki/video) sees it: the
// engine never reads a Casperaki song; this adapter builds its VideoInput.

import { catalog, VideoInputSchema, type VideoInput } from '@casperaki/video';
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
 * syllables joined into words ("Wal-" + "king" → "Walking"), a line ending at
 * a note that ends a phrase (the last note of its bar when none is marked).
 */
export function lyricLines(song: Song): VideoInput['lyrics'] {
  const secPerBeat = 60 / song.bpm;
  const notes: SungNote[] = [];
  let barStart = 0;
  for (const seg of song.songStructure) {
    const bars = seg.lengthInBars ?? seg.bars.length;
    const part = song.arrangement[seg.name]?.overrides?.[LEAD_VOCAL];
    (part?.bars ?? []).slice(0, bars).forEach((bar, barIdx) => {
      const events = Object.entries(bar.notes ?? {})
        .flatMap(([beat, evs]) => (evs ?? []).map((e) => ({ beat: Number.parseFloat(beat), e: e as { type?: string; duration?: number; fullWord?: string; endOfPhrase?: boolean } })))
        .filter(({ e }) => e.type === 'vocalNote' && typeof e.fullWord === 'string' && e.fullWord.length > 0)
        .sort((a, b) => a.beat - b.beat);
      events.forEach(({ beat, e }, i) => {
        const startBeat = (barStart + barIdx) * BEATS_PER_BAR + beat;
        notes.push({
          start: startBeat * secPerBeat,
          end: (startBeat + (e.duration ?? 0)) * secPerBeat,
          word: e.fullWord!,
          endOfPhrase: e.endOfPhrase ?? i === events.length - 1,
        });
      });
    });
    barStart += bars;
  }

  const lines: VideoInput['lyrics'] = [];
  let words: string[] = [];
  let pending = ''; // a syllable ending in "-" waiting for the rest of its word
  let lineStart: number | undefined;
  let lineEnd = 0;
  for (const n of notes) {
    lineStart ??= n.start;
    lineEnd = Math.max(lineEnd, n.end);
    if (n.word.endsWith('-')) pending += n.word.slice(0, -1);
    else {
      words.push(pending + n.word);
      pending = '';
    }
    if (n.endOfPhrase) {
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
  if (pending) words.push(pending);
  if (words.length && lineStart !== undefined && lineEnd > lineStart) lines.push({ text: words.join(' '), startSeconds: round(lineStart), endSeconds: round(lineEnd) });
  return lines;
}

const round = (s: number) => Math.round(s * 1000) / 1000;

export interface VideoAudio {
  /** Absolute path of the song's exported mix. */
  readonly path: string;
  readonly durationSeconds: number;
}

/** The engine's VideoInput for a song (validated by the engine's own schema). */
export function songToVideoInput(args: { title: string; artist: string; song: Song; audio: VideoAudio }): VideoInput {
  const { song } = args;
  const genres = Object.keys(catalog.GENRES);
  if (!song.genre || !genres.includes(song.genre)) {
    throw new VideoInputError(400, 'unsupported_genre', `Music videos are made for the styles ${genres.join(', ')}; this song is "${song.genre ?? 'without a style'}".`);
  }
  const secPerBar = (BEATS_PER_BAR * 60) / song.bpm;
  let bar = 0;
  const sections = song.songStructure.map((seg) => {
    const bars = seg.lengthInBars ?? seg.bars.length;
    const s = { name: sectionDisplayName(seg.name), startSeconds: round(bar * secPerBar), endSeconds: round((bar + bars) * secPerBar) };
    bar += bars;
    return s;
  });
  return VideoInputSchema.parse({
    title: args.title,
    artist: args.artist,
    genre: song.genre,
    audio: { path: args.audio.path, durationSeconds: args.audio.durationSeconds },
    bpm: song.bpm,
    firstBeatSeconds: 0,
    beatsPerBar: BEATS_PER_BAR,
    sections,
    lyrics: lyricLines(song),
    cast: [],
  });
}
