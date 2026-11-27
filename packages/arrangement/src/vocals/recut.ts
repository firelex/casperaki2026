// The recut: a rhythm pattern bent to written lines (docs/superpowers/specs/2026-11-27-lyrics-first-singing-design.md,
// step 3). The pattern is laid over the section (tiled as melodies are tiled) and cut into lines of LINE_BARS bars,
// one per written line. Each line gets, one note per syllable, the cheapest layout on an eighth grid that the
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

import { heardStress, type Stress } from './stress.js';
import { lyricLines } from './lyric-lines.js';
import { lengthFits, syllableLength, type SyllableLength } from './syllable-length.js';
import { HOLD_BEATS, pronounce, wordsOf } from './written-lyrics.js';
import { PrecedentSchema, type Precedent } from './precedents.js';

/** A rhythm recut to a section's words: its notes (beats from the section start), over `bars` bars, and the pattern
 *  it was cut from (as shaped), so new words for the section are cut from the same pattern. */
export const RecutSchema = z
  .object({
    pattern: z.string().min(1),
    source: PrecedentSchema,
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
/** Notes start on an eighth and last whole eighths (owner, 2026-11-27: sixteenths sang too fast, and a quarter
 *  straight into a sixteenth jumped). */
const EIGHTH = 2;
const DURATIONS = [2, 4, 6, 8, 12, 16];
const HOLD = HOLD_BEATS * Q;

const COST = { length: 1, movePerStep: 2, moveBeatPerStep: 3, drop: 3, split: 3, add: 4, heldSmallWord: 3 } as const;
/** Small words that carry no meaning of their own: pronouns, articles, auxiliaries and modals (and their
 *  contractions), prepositions and conjunctions. Held a beat or more inside a line they sound wrong ("don't" held before
 *  "give a frown", owner 2026-11-27), so holding one costs as much as dropping a pattern note: the search keeps a
 *  pattern's long note on such a word only when moving it costs more. */
const SMALL_WORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'the', 'this', 'that', 'these', 'those', 'my', 'your', 'his', 'her', 'its', 'our', 'their',
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'us', 'them',
  "i'm", "you're", "he's", "she's", "it's", "we're", "they're", "i've", "you've", "we've", "they've", "i'll", "you'll",
  "we'll", "they'll", "i'd", "you'd", "we'd", "they'd", "that's", "there's",
  'am', 'is', 'are', 'was', 'were', 'be', 'been', 'do', 'does', 'did', 'have', 'has', 'had',
  'can', 'could', 'will', 'would', 'shall', 'should', 'may', 'might', 'must',
  "don't", "doesn't", "didn't", "can't", "won't", "isn't", "aren't", "wasn't", "weren't", "couldn't", "wouldn't",
  "shouldn't", "haven't", "hasn't",
  'to', 'of', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'up', 'down', 'out', 'off', 'into', 'onto', 'through',
  'and', 'but', 'or', 'so', 'if', 'as', 'than', 'when', 'while',
]);
/** A note may move this far onto (or from) a pattern note and still count as that note moved. */
const MAX_MOVE = 2;

interface Syllable {
  readonly stress: Stress;
  /** Whether it is next to its word's stressed syllable ("light" in "flashlight"). */
  readonly byStress: boolean;
  /** A stressed syllable next to another of its word ("out-side", both stressed in the dictionary). */
  readonly twinStress: boolean;
  /** One of SMALL_WORDS. */
  readonly small: boolean;
  readonly length: SyllableLength;
  readonly endsWord: boolean;
}

interface Note {
  readonly s: number;
  readonly d: number;
}

/** The previous line's last note, as the next line's search needs it. */
interface Tail extends Note {
  readonly syllable: Syllable;
  /** Length of the note before it in its bar (steps), if any. */
  readonly pd: number | undefined;
}

function syllablesOf(text: string): Syllable[] {
  return wordsOf(text).flatMap((w) => {
    const p = pronounce(w);
    if (!p) throw new Error(`recut: "${w}" is not in the pronunciation dictionary (line "${text}")`);
    return p.phones.map((phones, i) => {
      const endsWord = i === p.phones.length - 1;
      const byStress = p.rhythm[i - 1] === '+' || p.rhythm[i + 1] === '+';
      const twinStress = p.rhythm[i] === '+' && byStress;
      const small = p.phones.length === 1 && SMALL_WORDS.has(w.toLowerCase().replace(/[‘’`]/gu, "'"));
      return { stress: p.rhythm[i]!, byStress, twinStress, small, length: syllableLength(phones, endsWord), endsWord };
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
  heardStress((n.s % (BEATS_PER_BAR * Q)) / Q, n.d / Q, pd === undefined ? undefined : pd / Q, nd === undefined ? undefined : nd / Q);

/** The recut makes its own notes, so it asks for the stresses as they are heard (owner, 2026-11-27: "a" on an
 *  off-beat quarter and "flashlight" as flash-LIGHT both passed the old check, which lets a '0' note take anything):
 *  a stressed syllable on a note heard stressed, an unstressed one on a note heard unstressed (stress.ts
 *  heardStress), a syllable with a secondary stress not on a stressed note right next to its word's stressed
 *  syllable ("light" in "flashlight" would outweigh "flash"; "a" in "anymore" may take a beat); a one-syllable word
 *  marked '0' ("ghosts") takes any note. What is asked and not met costs more than any change to the rhythm, so the
 *  recut meets it wherever a layout can: on the eighth grid some lines have none ("DAN-ge-rous" ending a line puts
 *  "-rous" on a beat), and those take the layout that misses least. A syllable on a note heard the opposite way costs
 *  STRESS.opposite, on a note heard as either STRESS.either. */
const STRESS = { opposite: 12, either: 6 } as const;
function stressCost(n: Note, pd: number | undefined, nd: number | undefined, nextStart: number | undefined, y: Syllable): number {
  const g = grade(n, pd, nd);
  // Two stressed syllables side by side in a word cannot both be heard stressed on an eighth grid when the first
  // is short ("out-side"): either may take a note the ear hears as either.
  if (y.stress === '+') return g === '+' || (y.twinStress && g === '0') ? 0 : g === '-' ? STRESS.opposite : STRESS.either;
  if (y.stress === '-') return g === '-' || weakBeat(n, pd, nextStart) ? 0 : g === '+' ? STRESS.opposite : STRESS.either;
  return y.byStress && g === '+' ? STRESS.either : 0;
}

/** An eighth on beat 2 or 4, no longer than the note before it and followed by a note on beat 1 or 3, is weak against
 *  both: "EV-e-ry TIME" on 1, &, 2, 3. On an eighth grid two unstressed syllables in a row, sung straight through, put
 *  one of them on a beat, and this is the beat they take, even where the old grade calls the note stressed (the old
 *  writer had sixteenths for "CIN-na-mon BOU-le-vard"; the eighth grid has only this). */
function weakBeat(n: Note, pd: number | undefined, nextStart: number | undefined): boolean {
  const inBar = n.s % (BEATS_PER_BAR * Q);
  return n.d === EIGHTH && (inBar === Q || inBar === 3 * Q) && (pd === undefined || n.d <= pd) && nextStart !== undefined && nextStart % (2 * Q) === 0;
}

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
function recutLine(source: readonly Note[], syl: readonly Syllable[], lineStart: number, prev: Tail | undefined, bpm: number, what: string): Note[] {
  const lineEnd = lineStart + LINE_STEPS;
  // Longest first: on equal cost the longer note wins (an added note fills its time rather than clipping to a
  // sixteenth).
  const durs = [...new Set([...DURATIONS, ...source.map((n) => n.d).filter((d) => d % EIGHTH === 0)])].sort((a, b) => b - a);
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
      // A line of pickups only would be read as the end of the line before (lyric-lines.ts).
      if (last.s < lineStart) continue;
      // The tail stays out of the next line's pickup: long, early, or ending half a beat before the line's end. The
      // last line too: a longer section of the type plays the recut again, its first line right after.
      if (!(last.d > PICKUP_MAX || last.s < lineEnd - PICKUP_ZONE || last.s + last.d <= lineEnd - LEGATO_GAP)) continue;
      // Final cost: the last note's stress, and the pattern notes after the last match dropped. Pushed back as a
      // finished state, so the cheapest finished layout comes out first.
      const extra = stressCost(last, st.pd, undefined, undefined, syl[st.j - 1]!) + (source.length - 1 - st.k) * COST.drop;
      if (extra > 0) {
        heap.push(cost + extra, { ...st, j: syl.length + 1, k: source.length - 1, parent: st, g: cost + extra });
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
    const start = Math.max(from, prev ? prev.s + prev.d : 0);
    for (let s = Math.ceil(start / EIGHTH) * EIGHTH; s <= to; s += EIGHTH) {
      const pickup = s < lineStart;
      // A word is sung straight through: after a syllable that does not end its word, the next starts as it ends.
      if (!first && !syl[st.j - 1]!.endsWord && s !== st.last!.s + st.last!.d) continue;
      if (!first && st.last!.s < lineStart) {
        // After a pickup: legato on, and the line's first own note within its first beat.
        if (s - (st.last!.s + st.last!.d) >= LEGATO_GAP) continue;
        if (!pickup && s > lineStart + Q) continue;
      }
      for (const d of durs) {
        if (s + d > lineEnd) continue;
        if (pickup && d > PICKUP_MAX) continue;
        if (!fitsLength(y, d)) continue;
        const note = { s, d };
        // The note before it in its bar, and the grade of the last placed note now that its next is known.
        let pd: number | undefined;
        let stress = 0;
        if (first) {
          if (prev && barOf(prev.s) === barOf(s)) {
            // A pickup in the previous line's last bar: that note's grade changes, and it must not join the pickup.
            stress += stressCost(prev, prev.pd, d, s, prev.syllable);
            if (!(prev.d > PICKUP_MAX || prev.s < lineStart - PICKUP_ZONE || s - (prev.s + prev.d) >= LEGATO_GAP)) continue;
            pd = prev.d;
          }
        } else {
          const last = st.last!;
          // Inside a word, a secondary stress next to the stressed syllable is never the longer of the two ("flash"
          // short and "light" held is heard flash-LIGHT).
          const before = syl[st.j - 1]!;
          if (!before.endsWord && ((y.stress !== '+' && before.stress === '+' && d > last.d) || (y.stress === '+' && before.stress !== '+' && last.d > d))) stress += STRESS.either;
          const same = barOf(last.s) === barOf(s);
          stress += stressCost(last, st.pd, same ? d : undefined, s, syl[st.j - 1]!);
          pd = same ? last.d : undefined;
        }
        const held = y.small && d >= Q && st.j < syl.length - 1 ? COST.heldSmallWord : 0;
        for (const p of placements(s, d, st.k)) {
          const next: State = { j: st.j + 1, last: note, pd, k: p.k, parent: st, g: cost + p.cost + held + stress };
          const nk = key(next);
          if (done.has(nk) || (best.get(nk) ?? Infinity) <= next.g) continue;
          best.set(nk, next.g);
          heap.push(next.g + h(next.j, next.k), next);
        }
      }
    }
  }
  throw new Error(`recut: no rhythm for ${what} (a bug: every line of 4 to 11 syllables has one)`);
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
    const laid = recutLine(own, syl, lineStart, prev, opts.bpm, `line ${i + 1} "${text}" on "${rhythm.id}"`);
    notes.push(...laid);
    const last = laid.at(-1)!;
    const before = laid.at(-2);
    prev = { ...last, syllable: syl.at(-1)!, pd: before && barOf(before.s) === barOf(last.s) ? before.d : undefined };
  });
  const out: RecutRhythm = { pattern: String(rhythm.id), source: rhythm, bars: opts.bars, notes: notes.map((n) => ({ start: n.s / Q, duration: n.d / Q })) };
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
