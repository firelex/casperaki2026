// A sung section's melody cut into lyric lines: the units a lyricist writes one line of words for, one syllable per
// note (docs/superpowers/specs/2026-11-24-written-lyrics-design.md).
//
// A line ends at a rest of a beat or more, or on a held note (two beats or more). Lines shorter than MIN_NOTES join
// the next one (the last joins the one before), and lines over MAX_NOTES are split at their longest pause near the
// middle. Each note is a syllable slot, strong (on a beat, or a beat long or more) or weak.

const BEATS_PER_BAR = 4;
const EPS = 1e-6;
/** A rest at least this long (beats) ends a line. */
const LINE_REST = 1;
/** A note at least this long (beats) ends a line. */
const LINE_HOLD = 2;
const MIN_NOTES = 4;
const MAX_NOTES = 16;

export interface LyricSlot {
  readonly barIndex: number;
  /** Bar beat as written in the bar's notes (from 0, "1.5" → 1.5). */
  readonly beat: number;
  readonly duration: number;
  /** Beats from the section start. */
  readonly start: number;
  readonly strong: boolean;
}

export type LyricLine = readonly LyricSlot[];

/** Bars as the vocal tracks store them: notes keyed by bar beat, vocal notes among them. */
export type VocalBarsLike = readonly { readonly notes?: Readonly<Record<string, readonly unknown[] | undefined>> }[];

/** The section's vocal notes in order, one slot each. Two notes starting together is an error (one voice). */
export function lyricSlots(bars: VocalBarsLike): LyricSlot[] {
  const slots: LyricSlot[] = [];
  bars.forEach((bar, barIndex) => {
    for (const [key, evs] of Object.entries(bar.notes ?? {})) {
      for (const ev of evs ?? []) {
        const e = ev as { type?: unknown; duration?: unknown };
        if (e.type !== 'vocalNote') continue;
        if (typeof e.duration !== 'number' || !(e.duration > 0)) throw new Error(`lyricSlots: bar ${barIndex + 1} beat ${key}: a vocal note without a positive duration`);
        const beat = Number.parseFloat(key);
        const strong = Math.abs(beat - Math.round(beat)) < EPS || e.duration >= 1 - EPS;
        slots.push({ barIndex, beat, duration: e.duration, start: barIndex * BEATS_PER_BAR + beat, strong });
      }
    }
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
  // 1. Cut at rests and held notes.
  let lines: LyricSlot[][] = [[]];
  slots.forEach((s, i) => {
    lines[lines.length - 1]!.push(s);
    const next = slots[i + 1];
    if (!next) return;
    const rest = next.start - (s.start + s.duration);
    if (rest >= LINE_REST - EPS || s.duration >= LINE_HOLD - EPS) lines.push([]);
  });
  // 2. Short lines join the next one (the last one joins the one before).
  const merged: LyricSlot[][] = [];
  let carry: LyricSlot[] = [];
  for (const line of lines) {
    const joined = [...carry, ...line];
    if (joined.length < MIN_NOTES) carry = joined;
    else {
      merged.push(joined);
      carry = [];
    }
  }
  if (carry.length > 0) {
    if (merged.length > 0) merged[merged.length - 1]!.push(...carry);
    else merged.push(carry);
  }
  lines = merged;
  // 3. Long lines split at the longest pause near the middle.
  const out: LyricSlot[][] = [];
  const split = (line: LyricSlot[]) => {
    if (line.length <= MAX_NOTES) {
      out.push(line);
      return;
    }
    let best = -1;
    let bestScore = -Infinity;
    for (let i = MIN_NOTES - 1; i < line.length - MIN_NOTES; i++) {
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
