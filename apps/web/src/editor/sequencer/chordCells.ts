/**
 * Layout of the chord lane: the song's chords as cells on the bar timeline.
 * Pure, so it can be tested.
 *
 * Timing: a bar stores its chords as a list that splits the bar into equal
 * parts. The generator writes one entry per beat (four per bar) and the
 * engine plays entry `trunc(beat)` (getChordAtTime in wasm/engine/src/Tonal.h),
 * so with four entries each cell is exactly the beat the engine plays it on;
 * [C, C, G, G] is C for the first half and G for the second. Consecutive
 * identical chords merge into one cell, also across bars, but never across a
 * section boundary.
 */

import type { SeqSection } from '../sequencerModel';

export interface ChordCell {
  readonly chord: string;
  /** In bars from the song start (fractions are parts of a bar). */
  readonly start: number;
  readonly end: number;
  /** Index of the section the cell is in. */
  readonly section: number;
}

const EPS = 1e-9;

/** The song's chords as merged cells, in time order. Bars without chords leave a gap. */
export function chordCells(sections: readonly Pick<SeqSection, 'startBar' | 'bars' | 'chordsByBar'>[]): ChordCell[] {
  const cells: { chord: string; start: number; end: number; section: number }[] = [];
  sections.forEach((s, si) => {
    const bars = Math.min(s.bars, s.chordsByBar.length);
    for (let b = 0; b < bars; b++) {
      const row = s.chordsByBar[b]!;
      const n = row.length;
      for (let j = 0; j < n; j++) {
        const start = s.startBar + b + j / n;
        const end = s.startBar + b + (j + 1) / n;
        const last = cells[cells.length - 1];
        if (last && last.section === si && last.chord === row[j] && Math.abs(last.end - start) < EPS) last.end = end;
        else cells.push({ chord: row[j]!, start, end, section: si });
      }
    }
  });
  return cells;
}

/** Width of one character of the lane's 11px monospace type, and the cell's side padding. */
export const CHORD_CHAR_W = 6.6;
export const CHORD_PAD = 6;

/**
 * The label that fits a cell `widthPx` wide: the full symbol, else the symbol
 * cut short with an ellipsis (at least one character of it), else nothing.
 */
export function chordLabel(chord: string, widthPx: number): string {
  const fit = Math.floor((widthPx - CHORD_PAD) / CHORD_CHAR_W + EPS);
  if (chord.length <= fit) return chord;
  if (fit >= 2) return `${chord.slice(0, fit - 1)}…`;
  return '';
}

/** Index of the cell under bar position `bar`, or -1 when no chord plays there. */
export function chordCellAt(cells: readonly ChordCell[], bar: number): number {
  let lo = 0;
  let hi = cells.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = cells[mid]!;
    if (bar < c.start) hi = mid - 1;
    else if (bar >= c.end) lo = mid + 1;
    else return mid;
  }
  return -1;
}
