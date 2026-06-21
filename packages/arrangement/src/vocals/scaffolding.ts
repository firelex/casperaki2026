// Step 17c — lyric scaffolding port of `Lyricist._extractMelodyFromSong`.
//
// Legacy source:
//   casperaki2-engine-js/api/v1.0/services/lyricist.js lines 22-273.
//
// Legacy walks every vocal note across every "vocals" section and emits a
// per-note record `{ syllableType, endOfPhrase, noteIsSuitableForSliding…,
// noteIsContuinationOfMelody }`, then buckets the per-note records into
// rhyme-lines every 4 bars. Brain port preserves the same shape:
//
//   VocalScaffolding = [
//     { segmentName, lines: [ [ noteScaffolding, ... ], ... ] },
//     ...
//   ]
//
//   noteScaffolding = {
//     barIndex,       // bar index within the segment
//     beat,           // bar-relative beat (0 ≤ beat < 4)
//     duration,       // beats
//     syllableType,   // '+' | '-' | '0'  (legacy '+ / - / 0' stress slots)
//     endOfPhrase,    // last note of its bar (legacy invariant)
//     noteIsSuitableForSlidingFromPreviousNote,
//     noteIsContuinationOfMelody,
//   }
//
// Differences from legacy that are intentional, documented:
//
//   1. Legacy `note.duration` is a fraction-of-whole-note string
//      ('2', '4', '4+', '8', '16', …). Brain durations are numeric beats
//      (1.0 = quarter, 0.5 = eighth, 0.25 = sixteenth). The classifier
//      below maps the duration to its legacy bucket then applies the
//      same beat-offset switch.
//   2. Legacy buckets rhyme-lines every 4 bars across the ENTIRE arrangement
//      (the `barIndex` counter is shared across segments). The brain port
//      buckets every 4 bars WITHIN A SEGMENT — every segment starts a
//      fresh `barIndex = 0` and finishes its own lines list. This matches
//      the brain's segment-isolated rng/lyric flow and lines up with the
//      seed-phrase picker, which selects per (segment, line) — not per
//      (song-global-line). Documented here so the divergence doesn't
//      surprise a future template-poet port.
//   3. Brain does not yet surface the `noteIsSuitableForSlidingFromPrevious…`
//      / `noteIsContuinationOfMelody` flags to the syllable picker; they
//      are computed and surfaced so the 17e rhyme-control layer can read
//      them without re-walking the note grid.

import { BarBeatSchema } from '@casperaki/song-schema';

import type { VocalResult, VocalSegment } from './types.js';

export type SyllableType = '+' | '-' | '0';

export interface NoteScaffolding {
  readonly barIndex: number;
  readonly beat: number;
  readonly duration: number;
  readonly syllableType: SyllableType;
  readonly endOfPhrase: boolean;
  readonly noteIsSuitableForSlidingFromPreviousNote: boolean;
  readonly noteIsContinuationOfMelody: boolean;
}

export interface SegmentScaffolding {
  readonly segmentName: string;
  /** Per-segment 4-bar rhyme-line bucketing. Each entry is the flat list of
   *  note records that fall inside that 4-bar window. */
  readonly lines: readonly (readonly NoteScaffolding[])[];
}

export type VocalScaffolding = readonly SegmentScaffolding[];

const EPSILON = 1e-6;

function approxInteger(value: number): boolean {
  return Math.abs(value - Math.round(value)) < EPSILON;
}

/** Classifies a note's stress slot from `duration` (beats) + `beat` (bar-
 *  relative). Smallest faithful approximation of the legacy switch
 *  (`lyricist.js:62-217`):
 *    - duration ≥ 2 (half-note+)  → always '0' (held)
 *    - duration ≥ 1 (quarter)     → '+' on integer beat, else '-'
 *    - duration ≥ 0.5 (eighth)    → '+' on integer beat, else '-'
 *    - duration < 0.5 (sixteenth) → '+' on integer or half-beat, else '-'
 *  Legacy uses neighbour-note dependent overrides (the "tied to a
 *  long note next door → 0" branch); the brain slice keeps the simpler
 *  rule because the 17c picker does not read syllableType yet — it's
 *  surfaced for 17e/17f. A full neighbour-aware port is straightforward
 *  but lands when a consumer needs it. */
function classifyStress(duration: number, beat: number): SyllableType {
  if (duration >= 2 - EPSILON) return '0';
  if (duration >= 1 - EPSILON) return approxInteger(beat) ? '+' : '-';
  if (duration >= 0.5 - EPSILON) return approxInteger(beat) ? '+' : '-';
  return approxInteger(beat * 2) ? '+' : '-';
}

/** Builds a per-segment, per-line scaffolding from a `VocalResult`. */
export function buildVocalScaffolding(result: VocalResult): VocalScaffolding {
  return result.segments.map(buildSegmentScaffolding);
}

function buildSegmentScaffolding(segment: VocalSegment): SegmentScaffolding {
  const lines: NoteScaffolding[][] = [];
  let currentLine: NoteScaffolding[] = [];
  let lastNoteHitPlusHitLength: number | undefined;

  for (let barIndex = 0; barIndex < segment.bars.length; barIndex++) {
    const bar = segment.bars[barIndex]!;
    const beatKeys = Object.keys(bar.notes)
      .map((k) => ({ key: k, beat: parseFloat(k) }))
      .sort((a, b) => a.beat - b.beat);

    // We need to know which note is the last note of the bar so we can
    // flag endOfPhrase on it (legacy: `vocalPatternNoteKeyIndex >=
    // vocalPatternNoteKeys.length - 1`).
    const flat: { beat: number; ev: NonNullable<ReturnType<typeof readEv>> }[] = [];
    for (const { key } of beatKeys) {
      const events = bar.notes[BarBeatSchema.parse(key)]!;
      for (const ev of events) {
        const read = readEv(ev);
        if (read) flat.push({ beat: parseFloat(key), ev: read });
      }
    }

    for (let i = 0; i < flat.length; i++) {
      const { beat, ev } = flat[i]!;
      const currentNoteHit = barIndex * 4 + beat;
      const isContinuation = lastNoteHitPlusHitLength !== undefined &&
        Math.abs(lastNoteHitPlusHitLength - currentNoteHit) < EPSILON;
      currentLine.push({
        barIndex,
        beat,
        duration: ev.duration,
        syllableType: classifyStress(ev.duration, beat),
        endOfPhrase: i === flat.length - 1,
        noteIsSuitableForSlidingFromPreviousNote: isContinuation && ev.duration < 0.5 + EPSILON,
        noteIsContinuationOfMelody: isContinuation,
      });
      lastNoteHitPlusHitLength = currentNoteHit + ev.duration;
    }

    // Legacy rhyme-line bucketing: every 4 bars push the current line and
    // start a fresh one. `(barIndex + 1) % 4 === 0` mirrors legacy's
    // `barIndex > 0 && barIndex % 4 === 0` (legacy starts barIndex at 1).
    if ((barIndex + 1) % 4 === 0) {
      lines.push(currentLine);
      currentLine = [];
    }
  }

  if (currentLine.length > 0) {
    lines.push(currentLine);
  }

  return { segmentName: segment.segmentName, lines };
}

interface ReadEv {
  duration: number;
}

function readEv(ev: unknown): ReadEv | undefined {
  if (!ev || typeof ev !== 'object') return undefined;
  const obj = ev as { type?: unknown; duration?: unknown };
  if (obj.type !== 'vocalNote') return undefined;
  const d = obj.duration;
  if (typeof d !== 'number' || !isFinite(d) || d <= 0) return undefined;
  return { duration: d };
}
