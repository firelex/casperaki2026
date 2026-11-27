// The recut: a rhythm pattern bent to written lines (docs/superpowers/specs/2026-11-27-lyrics-first-singing-design.md,
// step 3). The pattern is laid over the section (tiled as melodies are tiled) and cut into lines of LINE_BARS bars,
// one per written line. Each line gets, one note per syllable, the cheapest layout on a sixteenth grid that the
// lyric check accepts: every syllable on a note whose grade (stress.ts) takes it, no note longer than the syllable may
// be sung (syllable-length.ts), a note held for HOLD_BEATS or more only on a word's end, and the lines read back as
// the same lines (lyric-lines.ts moves short legato notes at a line's end into the next line as its pickup; the
// recut keeps a line's tail clear of that, and makes the pickups it wants exactly as that rule reads them).
//
// Cost (owner and Claude, 2026-11-27: keep what works, change what must change): a note kept as the pattern has it
// costs nothing, so the longest stretches that already fit survive; its length changed 1; its onset moved a sixteenth
// or an eighth 2 per sixteenth (3 when it moves from or onto beat 1 or 3); a pattern note left out 3; a note added
// inside a pattern note (a split) 3, anywhere else 4. The search is exact over that grid (Dijkstra over layouts), so
// it always finds a layout when one exists, and one always exists for a line of up to 11 syllables in two bars: a
// recut that finds none is a bug and throws, naming the line.

import { z } from 'zod';

import { gradeNote, stressFits, type Stress } from './stress.js';
import { lyricLines } from './lyric-lines.js';
import { lengthFits, syllableLength, type SyllableLength } from './syllable-length.js';
import { HOLD_BEATS, pronounce, wordsOf } from './written-lyrics.js';
import type { Precedent } from './precedents.js';

/** A rhythm recut to a section's words: its notes (beats from the section start), over `bars` bars. */
export const RecutSchema = z
  .object({
    pattern: z.string().min(1),
    bars: z.number().int().positive(),
    notes: z.array(z.object({ start: z.number().nonnegative(), duration: z.number().positive() }).strict()).min(1),
  })
  .strict();
export type RecutRhythm = z.infer<typeof RecutSchema>;

const LINE_BARS = 2;
const BEATS_PER_BAR = 4;
/** Grid steps per beat (sixteenths). */
const Q = 4;
const LINE_STEPS = LINE_BARS * BEATS_PER_BAR * Q;
/** Pickups may start up to a beat before their line. */
const PICKUP_STEPS = Q;
/** lyric-lines.ts: a pickup note is at most a beat long, runs on into the next note with less than half a beat of
 *  rest, and its line's first note in its own bars starts within the first beat; a note at a line's end is taken
 *  into the next line on the same terms when it starts in the line's last 2 beats. */
const PICKUP_MAX = 1 * Q;
const LEGATO_GAP = 0.5 * Q;
const PICKUP_ZONE = 2 * Q;
/** The longest rest between two notes of a line the search tries. */
const MAX_REST = 4 * Q;
const DURATIONS = [1, 2, 3, 4, 6, 8, 12, 16];
const HOLD = HOLD_BEATS * Q;

const COST = { length: 1, movePerStep: 2, moveBeatPerStep: 3, drop: 3, split: 3, add: 4 } as const;
/** A note may move this far onto (or from) a pattern note and still count as that note moved. */
const MAX_MOVE = 2;

interface Syllable {
  readonly stress: Stress;
  readonly length: SyllableLength;
  readonly endsWord: boolean;
}

interface Note {
  readonly s: number;
  readonly d: number;
}

/** The previous line's last note, as the next line's search needs it. */
interface Tail extends Note {
  readonly stress: Stress;
  /** Length of the note before it in its bar (steps), if any. */
  readonly pd: number | undefined;
}

function syllablesOf(text: string): Syllable[] {
  return wordsOf(text).flatMap((w) => {
    const p = pronounce(w);
    if (!p) throw new Error(`recut: "${w}" is not in the pronunciation dictionary (line "${text}")`);
    return p.phones.map((phones, i) => {
      const endsWord = i === p.phones.length - 1;
      return { stress: p.rhythm[i]!, length: syllableLength(phones, endsWord), endsWord };
    });
  });
}

/** The pattern's notes over the section, in grid steps: its own length tiled, cut at the section's end. */
function laidOut(rhythm: Precedent, bars: number): Note[] {
  const from = rhythm.properties.start * BEATS_PER_BAR;
  const length = (rhythm.properties.end - rhythm.properties.start) * BEATS_PER_BAR;
  if (!(length > 0)) throw new Error(`recut: the rhythm "${rhythm.id}" has no length`);
  const own = Object.entries(rhythm.melody)
    .map(([k, v]) => ({ beat: Number.parseFloat(k) - from, duration: v[0]!.duration }))
    .filter((n) => n.beat >= 0 && n.beat < length)
    .sort((a, b) => a.beat - b.beat);
  const out: Note[] = [];
  for (let at = 0; at < bars * BEATS_PER_BAR; at += length) {
    for (const n of own) {
      const beat = at + n.beat;
      if (beat >= bars * BEATS_PER_BAR) break;
      out.push({ s: Math.round(beat * Q), d: Math.max(1, Math.round(n.duration * Q)) });
    }
  }
  return out;
}

const barOf = (step: number) => Math.floor(step / (BEATS_PER_BAR * Q));
const onBeatOneOrThree = (step: number) => step % (2 * Q) === 0;
const grade = (n: Note, pd: number | undefined, nd: number | undefined): Stress =>
  gradeNote((n.s % (BEATS_PER_BAR * Q)) / Q, n.d / Q, pd === undefined ? undefined : pd / Q, nd === undefined ? undefined : nd / Q);

/** Min-heap on cost, ties by insertion (deterministic). */
class Heap<T> {
  private readonly items: { cost: number; seq: number; value: T }[] = [];
  private seq = 0;
  get size(): number {
    return this.items.length;
  }
  push(cost: number, value: T): void {
    const a = this.items;
    a.push({ cost, seq: this.seq++, value });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.less(a[p]!, a[i]!)) break;
      [a[p], a[i]] = [a[i]!, a[p]!];
      i = p;
    }
  }
  pop(): { cost: number; value: T } {
    const a = this.items;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && this.less(a[l]!, a[m]!)) m = l;
        if (r < a.length && this.less(a[r]!, a[m]!)) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i]!, a[m]!];
        i = m;
      }
    }
    return top;
  }
  private less(a: { cost: number; seq: number }, b: { cost: number; seq: number }): boolean {
    return a.cost < b.cost || (a.cost === b.cost && a.seq < b.seq);
  }
}

interface State {
  /** Syllables placed. */
  readonly j: number;
  /** The last placed note (its grade waits for the next note). */
  readonly last: Note | undefined;
  /** Length of the note before `last` in its bar. */
  readonly pd: number | undefined;
  /** Index of the last pattern note matched (−1: none). */
  readonly k: number;
  /** The state it came from (the layout is read back through these). */
  readonly parent: State | undefined;
  /** Cost so far (without the estimate). */
  readonly g: number;
}

const notesOf = (st: State): Note[] => {
  const out: Note[] = [];
  for (let x: State | undefined = st; x && x.last; x = x.parent) if (x.parent?.j !== x.j) out.push(x.last);
  return out.reverse();
};

/** The cheapest layout of one line (grid steps from the section start), given the previous line's last note. */
function recutLine(source: readonly Note[], syl: readonly Syllable[], lineStart: number, prev: Tail | undefined, bpm: number, isLast: boolean, what: string): Note[] {
  const lineEnd = lineStart + LINE_STEPS;
  const durs = [...new Set([...DURATIONS, ...source.map((n) => n.d)])].sort((a, b) => a - b);
  const fitsLength = (y: Syllable, d: number) => lengthFits(y.length, d / Q, bpm) && (d < HOLD || y.endsWord);
  // The cost of placing a note: matched to a pattern note after k (moved, re-lengthened, the ones between dropped)
  // or added.
  const placements = (s: number, d: number, k: number): { cost: number; k: number }[] => {
    const out: { cost: number; k: number }[] = [];
    for (let m = k + 1; m < source.length && source[m]!.s <= s + MAX_MOVE; m++) {
      const o = source[m]!;
      if (o.s < s - MAX_MOVE) continue;
      const steps = Math.abs(o.s - s);
      const move = steps * (onBeatOneOrThree(o.s) || onBeatOneOrThree(s) ? COST.moveBeatPerStep : COST.movePerStep);
      out.push({ cost: (m - k - 1) * COST.drop + move + (o.d === d ? 0 : COST.length), k: m });
    }
    const inside = source.some((o) => o.s < s && s < o.s + o.d);
    out.push({ cost: inside ? COST.split : COST.add, k });
    return out;
  };
  // The grade of a note reads the note before it only as an eighth, a sixteenth or anything else (stress.ts), so
  // layouts that differ only there are the same state.
  const pdClass = (pd: number | undefined) => (pd === 2 ? 1 : pd === 1 ? 2 : 0);
  const key = (st: State) => ((((st.j * 64 + (st.last ? st.last.s + 8 : 0)) * 64 + (st.last?.d ?? 0)) * 3 + pdClass(st.pd)) * 64 + st.k + 1);
  const heap = new Heap<State>();
  const done = new Set<number>();
  const best = new Map<number, number>();
  // A* estimate: the syllables and pattern notes still to place can pair up at no cost at best; the rest are
  // added or dropped (3 at least each). Never more than the true cost, so the first finished layout is the cheapest.
  const h = (j: number, k: number) => Math.abs(syl.length - j - (source.length - 1 - k)) * Math.min(COST.drop, COST.split);
  heap.push(h(0, -1), { j: 0, last: undefined, pd: undefined, k: -1, parent: undefined, g: 0 });
  while (heap.size > 0) {
    const { value: st } = heap.pop();
    const cost = st.g;
    const id = key(st);
    if (done.has(id)) continue;
    done.add(id);
    if (st.j === syl.length) {
      // The line is laid; its last note's grade with nothing after it in the line.
      const last = st.last!;
      if (!stressFits(grade(last, st.pd, undefined), syl[st.j - 1]!.stress)) continue;
      // The tail stays out of the next line's pickup: long, early, or ending half a beat before the line's end.
      if (!isLast && !(last.d > PICKUP_MAX || last.s < lineEnd - PICKUP_ZONE || last.s + last.d <= lineEnd - LEGATO_GAP)) continue;
      // Final cost: the pattern notes after the last match are dropped. Pushed back as a finished state, so the
      // cheapest finished layout comes out first.
      const left = source.length - 1 - st.k;
      if (left > 0) {
        heap.push(cost + left * COST.drop, { ...st, j: syl.length + 1, k: source.length - 1, parent: st, g: cost + left * COST.drop });
        continue;
      }
      return notesOf(st);
    }
    if (st.j > syl.length) return notesOf(st.parent!);
    const y = syl[st.j]!;
    const first = st.j === 0;
    // Where the next note may start.
    let from: number;
    let to: number;
    if (first) {
      from = prev ? lineStart - PICKUP_STEPS : lineStart;
      to = lineStart + MAX_REST;
    } else {
      from = st.last!.s + st.last!.d;
      to = Math.min(lineEnd - 1, from + MAX_REST);
    }
    for (let s = Math.max(from, prev ? prev.s + prev.d : 0); s <= to; s++) {
      const pickup = s < lineStart;
      if (!first && st.last!.s < lineStart) {
        // After a pickup: legato on, and the line's first own note within its first beat.
        if (s - (st.last!.s + st.last!.d) >= LEGATO_GAP) continue;
        if (!pickup && s > lineStart + Q) continue;
      }
      for (const d of durs) {
        if (s + d > lineEnd) break;
        if (pickup && d > PICKUP_MAX) break;
        if (!fitsLength(y, d)) continue;
        const note = { s, d };
        // The note before it in its bar, and the grade of the last placed note now that its next is known.
        let pd: number | undefined;
        if (first) {
          if (prev && barOf(prev.s) === barOf(s)) {
            // A pickup in the previous line's last bar: that note's grade changes, and it must not join the pickup.
            if (!stressFits(grade(prev, prev.pd, d), prev.stress)) continue;
            if (!(prev.d > PICKUP_MAX || prev.s < lineStart - PICKUP_ZONE || s - (prev.s + prev.d) >= LEGATO_GAP)) continue;
            pd = prev.d;
          }
        } else {
          const last = st.last!;
          const same = barOf(last.s) === barOf(s);
          if (!stressFits(grade(last, st.pd, same ? d : undefined), syl[st.j - 1]!.stress)) continue;
          pd = same ? last.d : undefined;
        }
        for (const p of placements(s, d, st.k)) {
          const next: State = { j: st.j + 1, last: note, pd, k: p.k, parent: st, g: cost + p.cost };
          const nk = key(next);
          if (done.has(nk) || (best.get(nk) ?? Infinity) <= next.g) continue;
          best.set(nk, next.g);
          heap.push(next.g + h(next.j, next.k), next);
        }
      }
    }
  }
  throw new Error(`recut: no rhythm for ${what} (a bug: every line the lyric checks accept has one)`);
}

/** The rhythm recut to the section's lines (one line per LINE_BARS bars, in order). */
export function recutRhythm(rhythm: Precedent, lines: readonly string[], opts: { readonly bpm: number; readonly bars: number }): RecutRhythm {
  if (lines.length * LINE_BARS !== opts.bars) {
    throw new Error(`recut: ${lines.length} lines for ${opts.bars} bars (one line per ${LINE_BARS} bars)`);
  }
  const source = laidOut(rhythm, opts.bars);
  const notes: Note[] = [];
  let prev: Tail | undefined;
  lines.forEach((text, i) => {
    const lineStart = i * LINE_STEPS;
    const syl = syllablesOf(text);
    if (syl.length === 0) throw new Error(`recut: line ${i + 1} has no words`);
    const own = source.filter((n) => n.s >= lineStart && n.s < lineStart + LINE_STEPS);
    const laid = recutLine(own, syl, lineStart, prev, opts.bpm, i === lines.length - 1, `line ${i + 1} "${text}" on "${rhythm.id}"`);
    notes.push(...laid);
    const last = laid.at(-1)!;
    const before = laid.at(-2);
    prev = { ...last, stress: syl.at(-1)!.stress, pd: before && barOf(before.s) === barOf(last.s) ? before.d : undefined };
  });
  const out: RecutRhythm = { pattern: String(rhythm.id), bars: opts.bars, notes: notes.map((n) => ({ start: n.s / Q, duration: n.d / Q })) };
  // The lines must read back as written (a bug otherwise).
  const read = lyricLines(recutBars(out));
  const counts = lines.map((l) => syllablesOf(l).length);
  if (read.length !== lines.length || read.some((l, i) => l.length !== counts[i])) {
    throw new Error(`recut: the lines on "${rhythm.id}" read back as ${read.map((l) => l.length).join('/')} notes, not ${counts.join('/')}`);
  }
  return out;
}

/** The recut's notes as vocal bars (lyric-lines.ts reads them so). */
export function recutBars(r: RecutRhythm): { notes: Record<string, { type: 'vocalNote'; duration: number }[]> }[] {
  return Array.from({ length: r.bars }, (_, bar) => ({
    notes: Object.fromEntries(
      r.notes.filter((n) => Math.floor(n.start / BEATS_PER_BAR + 1e-9) === bar).map((n) => [String(n.start - bar * BEATS_PER_BAR), [{ type: 'vocalNote' as const, duration: n.duration }]]),
    ),
  }));
}

/** The recut as a rhythm precedent (start 0, end its bars) for drapeOnRhythm; the drape gives the notes their pitches. */
export function recutAsPrecedent(r: RecutRhythm): Precedent {
  const key = (b: number) => (Number.isInteger(b) ? `${b}.0` : String(b));
  return {
    id: `${r.pattern}~recut`,
    properties: { name: `${r.pattern} recut`, start: 0, end: r.bars, useOriginal: false, useRemix: false, source: { kind: 'casperaki' } },
    melody: Object.fromEntries(r.notes.map((n) => [key(n.start), [{ note: 'recut', midi: 0, duration: n.duration }]])),
    chords: {},
  };
}
