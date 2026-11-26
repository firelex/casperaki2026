// A sung section's melody cut into lyric lines: the units a lyricist writes one line of words for, one syllable per
// note (docs/superpowers/specs/2026-11-24-written-lyrics-design.md).
//
// Every line is LINE_BARS bars of the melody (owner, 2026-11-25, as the legacy lyricist cut its lines on a bar grid):
// a note belongs to the line whose bars it starts in, except a pickup: a short run of notes in the last PICKUP_BEATS
// of a line's bars that runs straight (no rest of PICKUP_GAP or more) into the next line's first note, which belongs
// to the next line. (Before, a line ended at a rest of a beat or after a held note, so in Tangerine Sidewalk "We",
// sung in line 3's bars before a rest, opened line 4: the words then fell on the wrong notes.) Lines over MAX_NOTES are
// split at their longest pause near the middle; a short line stays as it is (the melody's two bars, however few
// notes). Each note is a syllable slot with the old lyric writer's grade (stress.ts): '+' a note for a stressed
// syllable, '-' one for an unstressed syllable, '0' either.

import { gradeBar, type Stress } from './stress.js';

const BEATS_PER_BAR = 4;
const EPS = 1e-6;
/** Bars per lyric line. */
const LINE_BARS = 2;
/** A pickup starts within this many beats of the end of its line's bars… */
const PICKUP_BEATS = 2;
/** …and runs into the next line's first note with no rest this long (beats) or longer, on short notes (a held note
 *  ending a phrase into the next line is not a pickup). */
const PICKUP_GAP = 0.5;
const PICKUP_NOTE = 1;
const MAX_NOTES = 16;
/** A long line is split so that both halves keep at least this many notes. */
const SPLIT_MIN_NOTES = 4;

export interface LyricSlot {
  readonly barIndex: number;
  /** Bar beat as written in the bar's notes (from 0, "1.5" → 1.5). */
  readonly beat: number;
  readonly duration: number;
  /** Beats from the section start. */
  readonly start: number;
  /** The old grade of the note as written (stress.ts gradeNote, from its length, place in the bar and neighbours). */
  readonly grade: Stress;
  /** Lengths of the notes just before and after it in its bar (undefined at the bar's start or end): the neighbours
   *  its grade was taken with, kept so that a note split or held for a line can be graded again (written-lyrics). */
  readonly prevInBar: number | undefined;
  readonly nextInBar: number | undefined;
}

export type LyricLine = readonly LyricSlot[];

/** Bars as the vocal tracks store them: notes keyed by bar beat, vocal notes among them. */
export type VocalBarsLike = readonly { readonly notes?: Readonly<Record<string, readonly unknown[] | undefined>> }[];

/** The section's vocal notes in order, one slot each. Two notes starting together is an error (one voice). */
export function lyricSlots(bars: VocalBarsLike): LyricSlot[] {
  const slots: LyricSlot[] = [];
  bars.forEach((bar, barIndex) => {
    const notes: { beat: number; duration: number }[] = [];
    for (const [key, evs] of Object.entries(bar.notes ?? {})) {
      for (const ev of evs ?? []) {
        const e = ev as { type?: unknown; duration?: unknown };
        if (e.type !== 'vocalNote') continue;
        if (typeof e.duration !== 'number' || !(e.duration > 0)) throw new Error(`lyricSlots: bar ${barIndex + 1} beat ${key}: a vocal note without a positive duration`);
        notes.push({ beat: Number.parseFloat(key), duration: e.duration });
      }
    }
    notes.sort((a, b) => a.beat - b.beat);
    const grades = gradeBar(notes);
    notes.forEach((n, i) =>
      slots.push({
        barIndex,
        beat: n.beat,
        duration: n.duration,
        start: barIndex * BEATS_PER_BAR + n.beat,
        grade: grades[i]!,
        prevInBar: notes[i - 1]?.duration,
        nextInBar: notes[i + 1]?.duration,
      }),
    );
  });
  slots.sort((a, b) => a.start - b.start);
  for (let i = 1; i < slots.length; i++) {
    if (Math.abs(slots[i]!.start - slots[i - 1]!.start) < EPS) throw new Error(`lyricSlots: bar ${slots[i]!.barIndex + 1}: two vocal notes start together`);
  }
  return slots;
}

/** The pause after slot i: its own length plus any rest before the next note (beats). */
function pauseAfter(slots: readonly LyricSlot[], i: number): number {
  const next = slots[i + 1];
  return next ? next.start - slots[i]!.start : Infinity;
}

/** The section's lyric lines (empty when it has no vocal notes). */
export function lyricLines(bars: VocalBarsLike): LyricLine[] {
  const slots = lyricSlots(bars);
  if (slots.length === 0) return [];
  // 1. Cut every LINE_BARS bars, pickups going to the line they lead into.
  const span = LINE_BARS * BEATS_PER_BAR;
  const lineOf = slots.map((s) => Math.floor((s.start + EPS) / span));
  for (let i = slots.length - 1; i >= 0; i--) {
    const next = slots[i + 1];
    // Slot i is the last note of its line's bars, and the next line starts within its first beat.
    if (!next || lineOf[i + 1]! <= lineOf[i]! || next.start - lineOf[i + 1]! * span > 1 + EPS) continue;
    const lineEnd = (lineOf[i]! + 1) * span;
    // The pickup: the notes back from slot i that start in the line's last PICKUP_BEATS, each running on into the
    // next note with no rest of PICKUP_GAP or more.
    let first = i + 1;
    for (let k = i; k >= 0 && lineOf[k] === lineOf[i] && slots[k]!.start >= lineEnd - PICKUP_BEATS - EPS; k--) {
      const after = k === i ? next : slots[k + 1]!;
      if (slots[k]!.duration > PICKUP_NOTE + EPS || after.start - (slots[k]!.start + slots[k]!.duration) >= PICKUP_GAP - EPS) break;
      first = k;
    }
    // A pickup never takes the whole of its line.
    const wholeLine = first === 0 || lineOf[first - 1] !== lineOf[i];
    if (first > i || wholeLine) continue;
    for (let k = first; k <= i; k++) lineOf[k] = lineOf[i + 1]!;
  }
  let lines: LyricSlot[][] = [];
  slots.forEach((s, i) => {
    if (i === 0 || lineOf[i] !== lineOf[i - 1]) lines.push([]);
    lines[lines.length - 1]!.push(s);
  });
  // 2. Long lines split at the longest pause near the middle.
  const out: LyricSlot[][] = [];
  const split = (line: LyricSlot[]) => {
    if (line.length <= MAX_NOTES) {
      out.push(line);
      return;
    }
    let best = -1;
    let bestScore = -Infinity;
    for (let i = SPLIT_MIN_NOTES - 1; i < line.length - SPLIT_MIN_NOTES; i++) {
      const offCentre = Math.abs(i + 1 - line.length / 2) / line.length;
      const score = pauseAfter(line, i) - offCentre * 2;
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    split(line.slice(0, best + 1));
    split(line.slice(best + 1));
  };
  lines.forEach(split);
  return out;
}

/** Each line's rhyme group letter (lines with the same letter rhyme; a letter used once is a line that need not rhyme).
 *  Lines go in fours, ABCB: line 4 rhymes with line 2, lines 1 and 3 are free. A leftover three rhymes its first and
 *  last line (ABA), a leftover two rhyme together (AA), a leftover single line is free. */
export function rhymeScheme(lineCount: number): string[] {
  const letters: string[] = [];
  let next = 0;
  const fresh = () => String.fromCharCode(65 + next++);
  for (let g = 0; g < lineCount; g += 4) {
    const size = Math.min(4, lineCount - g);
    if (size === 4) {
      const [a, b, c] = [fresh(), fresh(), fresh()];
      letters.push(a, b, c, b);
    } else if (size === 3) {
      const [a, b] = [fresh(), fresh()];
      letters.push(a, b, a);
    } else if (size === 2) {
      const a = fresh();
      letters.push(a, a);
    } else letters.push(fresh());
  }
  return letters;
}
