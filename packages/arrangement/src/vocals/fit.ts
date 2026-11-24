// Fitting the vocal melody to the song: its key, its chords and the singer's
// range. Port (refactored) of the legacy MelodyClass passes the first rebuild
// left out, so melodies were sung in C over chords in the song's key and over
// chords they were not written for:
//
//   - Sung sections take the chords that belong to the borrowed melody
//     (legacy MelodyClass.js:2671 replaces `songStructure[seg].bars` with the
//     merged precedent's chords, built per beat in `_getPattern` 1752-1800 and
//     tiled like the melody in 1814-1845).
//   - Everything is moved from C into the song's key. Legacy composed in C and
//     derived the key from the vocal range (2800-3030: transpose by
//     maxNote - chorusPeak, then key = C + that); here the key is chosen by
//     the user, so the move is fixed (the key's distance from C; minor keys
//     use their relative major, whose notes the C-major material maps onto)
//     and only the octave is fitted.
//   - Per section kind, the octave puts the melody's peak at or below the top
//     of the range (2879-2895: start 4 octaves up, drop octaves until the peak
//     fits). Non-chorus sections then re-run the contour search with their
//     kind's ceiling (2952-2966; on failure the full range with low notes for
//     verses, high notes otherwise) and smooth A-B-A jumps (`_eliminateJumps`,
//     127-179).

import { parseChord, parseKey } from '@casperaki/music-theory';
import { ChordSymbolSchema, type ChordSymbol } from '@casperaki/song-schema';

import { buildContour, ContourBuildError } from './contour.js';
import type { MergedPrecedent } from './precedents.js';
import { MAX_NOTE, MIN_NOTE } from './range.js';

const PITCH_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;
const LETTER_PC: Readonly<Record<string, number>> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11] as const;

/** Semitones from C up to the song's key (minor keys: to their relative major). */
export function keyOffsetFromC(key: string): number {
  const k = parseKey(key);
  return k.mode === 'minor' ? (k.tonic + 3) % 12 : k.tonic;
}

/** A chord symbol moved by `semitones` (sharps spelling, as the chord generator writes). */
export function transposeChordSymbol(symbol: string, semitones: number): ChordSymbol {
  const move = (note: string): string => {
    const m = /^([A-G])([#b]?)$/u.exec(note);
    if (!m) throw new Error(`transposeChordSymbol: cannot read the note "${note}" in "${symbol}"`);
    const pc = LETTER_PC[m[1]!]! + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
    return PITCH_NAMES[(((pc + semitones) % 12) + 12) % 12]!;
  };
  const m = /^([A-G][#b]?)([^/]*)(?:\/([A-G][#b]?))?$/u.exec(symbol);
  if (!m) throw new Error(`transposeChordSymbol: cannot read the chord "${symbol}"`);
  return ChordSymbolSchema.parse(`${move(m[1]!)}${m[2]}${m[3] ? `/${move(m[3])}` : ''}`);
}

/**
 * The borrowed melody's chords laid over `bars` bars, one chord per beat, the
 * way the melody itself is laid out (whole repeats, then the tail copied in
 * chunks of 4 / 2 / 1 bars).
 */
export function mergedChordBars(merged: MergedPrecedent, bars: number): string[][] {
  const { start, end } = merged.properties;
  const length = end - start;
  if (length <= 0) throw new Error('mergedChordBars: the borrowed melody has no length');
  const patternBar = (j: number): string[] =>
    [0, 1, 2, 3].map((b) => {
      const beat = (j + start) * 4 + b;
      const entry = merged.chords[beat.toFixed(1)];
      if (!entry) throw new Error(`mergedChordBars: the borrowed melody has no chord on beat ${beat}`);
      return entry.chord;
    });
  const out: string[][] = [];
  const iterations = Math.floor(bars / length);
  for (let i = 0; i < iterations; i++) for (let j = 0; j < length; j++) out.push(patternBar(j));
  const firstToFill = bars - (bars % length);
  for (let i = firstToFill; i < bars; ) {
    const left = bars - i;
    const chunk = left >= 4 ? 4 : left >= 2 ? 2 : 1;
    for (let c = 0; c < chunk; c++) out[i + c] = out[firstToFill - chunk + c]!;
    i += chunk;
  }
  if (out.length !== bars) throw new Error(`mergedChordBars: laid out ${out.length} bars, wanted ${bars}`);
  return out;
}

/** The transposition for a section kind: the key's move, plus whole octaves so the peak is at or below `ceiling`
 *  (the top of the range: MAX_NOTE, or higher for a melody placed with a higher ceiling, e.g. a hook). */
export function sectionTransposition(peak: number, keyOffset: number, ceiling = MAX_NOTE): number {
  let t = keyOffset + 48;
  while (peak + t > ceiling) t -= 12;
  return t;
}

/**
 * Non-chorus sections: the contour search again with the kind's ceiling (the
 * full range with low notes for verses / high notes otherwise when nothing
 * fits), then A-B-A jumps smoothed.
 */
export function refitNonChorus(
  seq: readonly number[],
  kind: string,
  kindMaxNote: number,
  chordAt: (index: number) => string,
  keyOffset: number,
): number[] {
  let fitted: number[];
  try {
    fitted = buildContour(seq, { maxNote: kindMaxNote });
  } catch (err) {
    if (!(err instanceof ContourBuildError)) throw err;
    fitted = fitRange(seq, kind === 'verse' ? 'lowNotes' : 'highNotes');
  }
  return smoothReturns(fitted, chordAt, keyOffset);
}

/**
 * The contour search over the whole range; when no octave assignment fits
 * (possible here, not in the legacy: the key is chosen by the user, while the
 * legacy chose the key so the melody fit), the octave of the whole line that
 * leaves the fewest semitones outside the range (ties: as placed).
 */
export function fitRange(seq: readonly number[], priority: 'highNotes' | 'lowNotes', ceiling = MAX_NOTE): number[] {
  try {
    return buildContour(seq, { maxNote: ceiling, priority });
  } catch (err) {
    if (!(err instanceof ContourBuildError)) throw err;
    const outside = (t: number) => seq.reduce((sum, m) => sum + Math.max(0, MIN_NOTE - (m + t)) + Math.max(0, m + t - ceiling), 0);
    const best = [0, 12, -12].reduce((a, b) => (outside(b) < outside(a) ? b : a));
    return seq.map((m) => m + best);
  }
}

/**
 * When the melody leaves a note and comes straight back to it (A-B-A), pull
 * the middle note closer: to a chord tone about a minor third from A when it
 * is a chord tone more than a fourth away, else to a scale note about a tone
 * from A when it is more than a tone away (legacy `_eliminateJumps`).
 */
export function smoothReturns(seq: readonly number[], chordAt: (index: number) => string, keyOffset: number): number[] {
  const out = [...seq];
  const scale = new Set(MAJOR_SCALE.map((s) => (s + keyOffset) % 12));
  for (let i = 2; i < out.length; i++) {
    const a = out[i - 2]!;
    const b = out[i - 1]!;
    const c = out[i]!;
    if (c !== a) continue;
    const dir = b > c ? 1 : -1;
    const chord = chordTones(chordAt(i - 1));
    if (chord.has(pc(b))) {
      if (Math.abs(c - b) > 5) out[i - 1] = nearestWith(c + dir * 3, chord);
    } else if (Math.abs(c - b) > 2) {
      out[i - 1] = nearestWith(c + dir * 2, scale);
    }
  }
  return out;
}

const pc = (midi: number) => ((midi % 12) + 12) % 12;

function chordTones(symbol: string): Set<number> {
  const c = parseChord(symbol);
  return new Set(c.intervals.map((iv) => (c.root + iv) % 12));
}

/** The nearest MIDI note to `target` whose pitch class is in `set` (the lower one on a tie). */
function nearestWith(target: number, set: ReadonlySet<number>): number {
  for (let d = 0; d <= 6; d++) {
    if (set.has(pc(target - d))) return target - d;
    if (set.has(pc(target + d))) return target + d;
  }
  throw new Error(`nearestWith: no note of the set near ${target}`);
}
