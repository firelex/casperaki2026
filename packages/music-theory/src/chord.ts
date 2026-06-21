// Chord: parse a ChordSymbol string into a root pitch class + interval set.
//
// Vocabulary covers the engine's `Chord.h` types plus a permissive tail —
// the regex in `@casperaki/song-schema/ChordSymbol` is the outer gate;
// here we focus on the qualities the brain actually emits. Anything beyond
// is parsed leniently into the closest match; unknown qualities fall back
// to a root triad with a logged `unknown_quality` flag in the result so the
// caller can decide whether to reject.

import { LETTER_TO_PITCH_CLASS_ALIAS } from './chord-internals.js';

export type ChordQuality =
  | 'maj' | 'min' | 'dim' | 'aug'
  | 'sus2' | 'sus4'
  | '7' | 'maj7' | 'min7' | 'dim7' | 'm7b5'
  | '9' | 'maj9' | 'min9'
  | '6' | 'min6' | 'add9' | 'minAdd9';

export interface ParsedChord {
  root: number;             // pitch class 0..11
  quality: ChordQuality | 'unknown';
  intervals: readonly number[]; // semitone offsets from root, ascending, including 0
  bass?: number;             // pitch class for slash-chord bass, if present
  raw: string;
}

const CHORD_REGEX = /^([A-Ga-g])([#b]?)([^/]*)(?:\/([A-Ga-g])([#b]?))?$/u;

// Order matters: longer prefixes first so "maj7" matches before "maj".
const QUALITY_TABLE: Array<{ prefix: string; quality: ChordQuality; intervals: readonly number[] }> = [
  { prefix: 'maj9',    quality: 'maj9',    intervals: [0, 4, 7, 11, 14] },
  { prefix: 'maj7',    quality: 'maj7',    intervals: [0, 4, 7, 11] },
  { prefix: 'm7b5',    quality: 'm7b5',    intervals: [0, 3, 6, 10] },
  { prefix: 'minAdd9', quality: 'minAdd9', intervals: [0, 3, 7, 14] },
  { prefix: 'min9',    quality: 'min9',    intervals: [0, 3, 7, 10, 14] },
  { prefix: 'add9',    quality: 'add9',    intervals: [0, 4, 7, 14] },
  { prefix: 'min7',    quality: 'min7',    intervals: [0, 3, 7, 10] },
  { prefix: 'min6',    quality: 'min6',    intervals: [0, 3, 7, 9] },
  { prefix: 'dim7',    quality: 'dim7',    intervals: [0, 3, 6, 9] },
  { prefix: 'm9',      quality: 'min9',    intervals: [0, 3, 7, 10, 14] },
  { prefix: 'm7',      quality: 'min7',    intervals: [0, 3, 7, 10] },
  { prefix: 'm6',      quality: 'min6',    intervals: [0, 3, 7, 9] },
  { prefix: 'sus4',    quality: 'sus4',    intervals: [0, 5, 7] },
  { prefix: 'sus2',    quality: 'sus2',    intervals: [0, 2, 7] },
  { prefix: 'min',     quality: 'min',     intervals: [0, 3, 7] },
  { prefix: 'dim',     quality: 'dim',     intervals: [0, 3, 6] },
  { prefix: 'aug',     quality: 'aug',     intervals: [0, 4, 8] },
  { prefix: 'maj',     quality: 'maj',     intervals: [0, 4, 7] },
  { prefix: '9',       quality: '9',       intervals: [0, 4, 7, 10, 14] },
  { prefix: '7',       quality: '7',       intervals: [0, 4, 7, 10] },
  { prefix: '6',       quality: '6',       intervals: [0, 4, 7, 9] },
  { prefix: 'm',       quality: 'min',     intervals: [0, 3, 7] },
];

const TRIAD: readonly number[] = [0, 4, 7];

function parseRoot(letter: string, accidental: string): number {
  const base = LETTER_TO_PITCH_CLASS_ALIAS[letter.toUpperCase()];
  if (base === undefined) throw new Error(`parseChord: unknown letter "${letter}"`);
  if (accidental === '#') return (base + 1) % 12;
  if (accidental === 'b') return (base + 11) % 12;
  return base;
}

export function parseChord(symbol: string): ParsedChord {
  const m = CHORD_REGEX.exec(symbol);
  if (!m) throw new Error(`parseChord: cannot parse "${symbol}"`);
  const root = parseRoot(m[1]!, m[2] ?? '');
  const tail = (m[3] ?? '').trim();
  const bass = m[4] !== undefined ? parseRoot(m[4]!, m[5] ?? '') : undefined;

  if (tail === '') {
    return { root, quality: 'maj', intervals: TRIAD, ...(bass !== undefined && { bass }), raw: symbol };
  }
  for (const row of QUALITY_TABLE) {
    if (tail === row.prefix || tail.startsWith(row.prefix)) {
      return {
        root,
        quality: row.quality,
        intervals: row.intervals,
        ...(bass !== undefined && { bass }),
        raw: symbol,
      };
    }
  }
  return { root, quality: 'unknown', intervals: TRIAD, ...(bass !== undefined && { bass }), raw: symbol };
}

export function chordNotes(parsed: ParsedChord, octave = 4): number[] {
  const baseMidi = (octave + 1) * 12 + parsed.root;
  return parsed.intervals.map((i) => baseMidi + i);
}
