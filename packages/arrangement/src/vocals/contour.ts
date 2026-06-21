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
// It does this via BFS:
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

interface BfsNode {
  readonly sequence: readonly number[];
  readonly index: number;
  readonly maxDistance: number;
  readonly totalDistance: number;
}

interface CompletedSequence {
  readonly sequence: readonly number[];
  readonly maxDistance: number;
  readonly averageDistance: number;
}

/** Run the legacy `_buildTree` BFS on `midiSequence` and return the
 *  best-ranked octave-adjusted sequence. Throws `ContourBuildError` if
 *  none satisfies the constraints. */
export function buildContour(
  midiSequence: readonly number[],
  options: BuildContourOptions = {},
): number[] {
  const maxNote = options.maxNote ?? MAX_NOTE;
  const priority: ContourPriority = options.priority ?? 'highNotes';

  if (midiSequence.length === 0) return [];

  const queue: BfsNode[] = [];
  const completed: CompletedSequence[] = [];

  // Seed: all in-range octaves of the first note (legacy iterates octave
  // = -2..2). lastNote check is irrelevant here — only range matters.
  const firstNote = midiSequence[0]!;
  for (let octave = -2; octave <= 2; octave++) {
    const adjusted = firstNote + octave * 12;
    if (adjusted >= MIN_NOTE && adjusted <= maxNote) {
      queue.push({ sequence: [adjusted], index: 1, maxDistance: 0, totalDistance: 0 });
    }
  }

  while (queue.length > 0) {
    const node = queue.shift()!;
    if (node.index === midiSequence.length) {
      const avg = node.sequence.length > 1 ? node.totalDistance / (node.sequence.length - 1) : 0;
      completed.push({
        sequence: node.sequence,
        maxDistance: node.maxDistance,
        averageDistance: avg,
      });
      continue;
    }

    const nextOriginal = midiSequence[node.index]!;
    const lastNote = node.sequence[node.sequence.length - 1]!;
    // Legacy order: [orig, orig+12, orig-12]. Preserved so BFS
    // insertion order — and therefore the stable-sort tie-break — match.
    for (const candidate of [nextOriginal, nextOriginal + 12, nextOriginal - 12]) {
      if (isNoteValid(candidate, lastNote, maxNote)) {
        const distance = Math.abs(candidate - lastNote);
        queue.push({
          sequence: [...node.sequence, candidate],
          index: node.index + 1,
          maxDistance: Math.max(node.maxDistance, distance),
          totalDistance: node.totalDistance + distance,
        });
      }
    }
  }

  if (completed.length === 0) {
    throw new ContourBuildError(midiSequence, maxNote);
  }

  // Sort: maxDistance asc, averageDistance asc, then priority-driven
  // peak-direction tie-break. Legacy intended this but shipped with a
  // `Math.max(<array>)` bug that suppressed it (see header comment);
  // this port writes `Math.max(...sequence)` so 'highNotes' actually
  // prefers higher-peaked sequences and 'lowNotes' prefers lower-peaked
  // ones.
  const sorted = completed.slice().sort((a, b) => {
    if (a.maxDistance !== b.maxDistance) return a.maxDistance < b.maxDistance ? -1 : 1;
    if (a.averageDistance !== b.averageDistance)
      return a.averageDistance < b.averageDistance ? -1 : 1;
    const aPeak = Math.max(...a.sequence);
    const bPeak = Math.max(...b.sequence);
    if (aPeak === bPeak) return 0;
    if (priority === 'highNotes') return aPeak > bPeak ? -1 : 1;
    return aPeak > bPeak ? 1 : -1;
  });

  return [...sorted[0]!.sequence];
}

/** Re-export for callers that want to feed a chord-root sequence
 *  without importing range constants separately. */
export { MEDIAN_NOTE };
