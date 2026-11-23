// Step 17a — octave-aware contour search (first MelodyClass slice).
//
// Legacy source: casperaki2-engine-js/api/v1.0/services/classes/vocals/
// MelodyClass.js lines 45-125 (`_buildTree`).
//
// The legacy function takes a `midiSequence` (one raw MIDI per slot —
// typically a chord-root or precedent-bank pitch) and assigns an octave
// to each slot such that:
//   - Every chosen note is in [minNote, maxNote].
//   - Each adjacent pair differs by ≤ 9 semitones.
//
// Legacy does this via BFS (this port finds the same result without the
// exponential enumeration, see buildContour):
//   - Seed the queue with all octaves of the first note (±2 octaves)
//     that fall in range.
//   - For each partial sequence, expand to {nextOriginal, +12, -12}
//     candidates and keep the ones that satisfy `_isNoteValid`.
//   - Complete sequences are ranked by (maxDistance asc,
//     averageDistance asc, priority tie-break) and the best is taken.
//
// One bug-fix worth flagging:
//
//   Legacy `_buildTree` writes `Math.max(a.sequence)` for the priority
//   tie-break. `Math.max` takes spread args, not an array, so this
//   evaluates to `NaN` and every NaN comparison returns `false` — the
//   branch falls through to `return 0` and the `priority` parameter is
//   silently a no-op in legacy. The port writes `Math.max(...sequence)`
//   so the intended `highNotes` / `lowNotes` direction selection
//   actually fires when sequences tie on `maxDistance` +
//   `averageDistance`. Documented in docs/53ad as an intentional
//   semantic divergence (not a wire-compatible port).
//
// Legacy throws when no sequence satisfies the constraints. The brain
// port surfaces it as a typed `ContourBuildError` so the caller can
// decide whether to retry (legacy retries by picking a different
// precedent bank entry; the slice has no banks yet).

import { MEDIAN_NOTE, MIN_NOTE, MAX_NOTE, isNoteValid } from './range.js';

export type ContourPriority = 'highNotes' | 'lowNotes';

export interface BuildContourOptions {
  readonly maxNote?: number;
  readonly priority?: ContourPriority;
}

export class ContourBuildError extends Error {
  constructor(
    public readonly midiSequence: readonly number[],
    public readonly maxNote: number,
  ) {
    super(
      `vocals/contour: no octave assignment satisfies range [${MIN_NOTE}..${maxNote}] + adjacent-step ≤ 9 for sequence [${midiSequence.join(
        ', ',
      )}]`,
    );
    this.name = 'ContourBuildError';
  }
}

/** A partial octave assignment: notes so far, the choices that made them (their
 *  position in the legacy BFS order), and what the ranking looks at. */
interface Partial {
  readonly sequence: readonly number[];
  /** Per note, the index of the choice taken: first note octave -2..2 → 0..4, then
   *  [orig, +12, -12] → 0..2. Lexicographic order of these = the legacy BFS order. */
  readonly choices: readonly number[];
  readonly maxDistance: number;
  readonly totalDistance: number;
  readonly peak: number;
}

const earlier = (a: readonly number[], b: readonly number[]): number => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
};

/**
 * The legacy `_buildTree` result, found without enumerating every sequence.
 *
 * Legacy (and this port until 2026-11-23) ran a breadth-first search over all
 * octave choices, up to 3 per note: exponential in the melody's length (one
 * ballad melody took 60 s). This walks the notes once, keeping per (position,
 * note) only the partial sequences that can still win: a partial is dropped when
 * another one reaching the same note is at least as good on max step, total step
 * and peak (in the priority's direction) AND comes earlier in the legacy BFS
 * order. Every later step adds the same amounts to both, so the dropped one can
 * never rank first (a tie goes to the earlier one, as the legacy stable sort did).
 * The result is identical to the full search (tested against it).
 */
export function buildContour(
  midiSequence: readonly number[],
  options: BuildContourOptions = {},
): number[] {
  const maxNote = options.maxNote ?? MAX_NOTE;
  const priority: ContourPriority = options.priority ?? 'highNotes';

  if (midiSequence.length === 0) return [];

  const peakAtLeastAsGood = (a: number, b: number) => (priority === 'highNotes' ? a >= b : a <= b);
  /** Keep the partials no earlier partial dominates (input: any order; output: legacy order). */
  const prune = (list: Partial[]): Partial[] => {
    list.sort((a, b) => earlier(a.choices, b.choices));
    const kept: Partial[] = [];
    for (const p of list) {
      const dominated = kept.some(
        (k) => k.maxDistance <= p.maxDistance && k.totalDistance <= p.totalDistance && peakAtLeastAsGood(k.peak, p.peak),
      );
      if (!dominated) kept.push(p);
    }
    return kept;
  };

  // Seed: all in-range octaves of the first note (legacy iterates octave
  // = -2..2). lastNote check is irrelevant here — only range matters.
  let states = new Map<number, Partial[]>();
  const firstNote = midiSequence[0]!;
  for (let octave = -2; octave <= 2; octave++) {
    const adjusted = firstNote + octave * 12;
    if (adjusted >= MIN_NOTE && adjusted <= maxNote) {
      states.set(adjusted, [{ sequence: [adjusted], choices: [octave + 2], maxDistance: 0, totalDistance: 0, peak: adjusted }]);
    }
  }

  for (let index = 1; index < midiSequence.length && states.size > 0; index++) {
    const nextOriginal = midiSequence[index]!;
    const next = new Map<number, Partial[]>();
    for (const partials of states.values()) {
      for (const node of partials) {
        const lastNote = node.sequence[node.sequence.length - 1]!;
        // Legacy order: [orig, orig+12, orig-12] (the BFS insertion order).
        [nextOriginal, nextOriginal + 12, nextOriginal - 12].forEach((candidate, choice) => {
          if (!isNoteValid(candidate, lastNote, maxNote)) return;
          const distance = Math.abs(candidate - lastNote);
          const list = next.get(candidate) ?? [];
          list.push({
            sequence: [...node.sequence, candidate],
            choices: [...node.choices, choice],
            maxDistance: Math.max(node.maxDistance, distance),
            totalDistance: node.totalDistance + distance,
            peak: Math.max(node.peak, candidate),
          });
          next.set(candidate, list);
        });
      }
    }
    states = new Map([...next].map(([note, list]) => [note, prune(list)]));
  }

  const completed = [...states.values()].flat().sort((a, b) => earlier(a.choices, b.choices));
  if (completed.length === 0) {
    throw new ContourBuildError(midiSequence, maxNote);
  }

  // Rank: maxDistance asc, averageDistance asc (same length: total), then the
  // priority-driven peak (legacy intended this but shipped with a `Math.max(<array>)`
  // bug that suppressed it, see the header); ties keep the legacy BFS order.
  let best = completed[0]!;
  for (const c of completed.slice(1)) {
    const better =
      c.maxDistance !== best.maxDistance
        ? c.maxDistance < best.maxDistance
        : c.totalDistance !== best.totalDistance
          ? c.totalDistance < best.totalDistance
          : c.peak !== best.peak && (priority === 'highNotes' ? c.peak > best.peak : c.peak < best.peak);
    if (better) best = c;
  }
  return [...best.sequence];
}

/** Re-export for callers that want to feed a chord-root sequence
 *  without importing range constants separately. */
export { MEDIAN_NOTE };
