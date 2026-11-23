// buildContour (dynamic programming) must pick exactly what the legacy
// breadth-first search picked (the version before 2026-11-23, kept below as the
// reference), on many random melodies: same notes, or the same failure.

import { describe, expect, it } from 'vitest';

import { buildContour, ContourBuildError, type ContourPriority } from '../src/vocals/contour.js';
import { isNoteValid, MAX_NOTE, MIN_NOTE } from '../src/vocals/range.js';

/** The legacy `_buildTree` BFS, as ported before (exponential; reference only). */
function bfsContour(midiSequence: readonly number[], maxNote: number, priority: ContourPriority): number[] {
  if (midiSequence.length === 0) return [];
  type Node = { sequence: number[]; index: number; maxDistance: number; totalDistance: number };
  const queue: Node[] = [];
  const completed: { sequence: number[]; maxDistance: number; averageDistance: number }[] = [];
  const first = midiSequence[0]!;
  for (let octave = -2; octave <= 2; octave++) {
    const adjusted = first + octave * 12;
    if (adjusted >= MIN_NOTE && adjusted <= maxNote) queue.push({ sequence: [adjusted], index: 1, maxDistance: 0, totalDistance: 0 });
  }
  while (queue.length > 0) {
    const node = queue.shift()!;
    if (node.index === midiSequence.length) {
      const avg = node.sequence.length > 1 ? node.totalDistance / (node.sequence.length - 1) : 0;
      completed.push({ sequence: node.sequence, maxDistance: node.maxDistance, averageDistance: avg });
      continue;
    }
    const nextOriginal = midiSequence[node.index]!;
    const lastNote = node.sequence[node.sequence.length - 1]!;
    for (const candidate of [nextOriginal, nextOriginal + 12, nextOriginal - 12]) {
      if (isNoteValid(candidate, lastNote, maxNote)) {
        const distance = Math.abs(candidate - lastNote);
        queue.push({ sequence: [...node.sequence, candidate], index: node.index + 1, maxDistance: Math.max(node.maxDistance, distance), totalDistance: node.totalDistance + distance });
      }
    }
  }
  if (completed.length === 0) throw new ContourBuildError(midiSequence, maxNote);
  const sorted = completed.slice().sort((a, b) => {
    if (a.maxDistance !== b.maxDistance) return a.maxDistance < b.maxDistance ? -1 : 1;
    if (a.averageDistance !== b.averageDistance) return a.averageDistance < b.averageDistance ? -1 : 1;
    const aPeak = Math.max(...a.sequence);
    const bPeak = Math.max(...b.sequence);
    if (aPeak === bPeak) return 0;
    if (priority === 'highNotes') return aPeak > bPeak ? -1 : 1;
    return aPeak > bPeak ? 1 : -1;
  });
  return [...sorted[0]!.sequence];
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

const outcome = (f: () => number[]) => {
  try {
    return f();
  } catch (err) {
    if (err instanceof ContourBuildError) return 'no contour';
    throw err;
  }
};

describe('buildContour', () => {
  it('picks exactly what the legacy breadth-first search picked', () => {
    const r = rng(20261123);
    let compared = 0;
    for (let n = 0; n < 4000; n++) {
      const len = 1 + Math.floor(r() * 11);
      const seq = Array.from({ length: len }, () => 40 + Math.floor(r() * 50));
      const maxNote = r() < 0.5 ? MAX_NOTE : MAX_NOTE - 5;
      for (const priority of ['highNotes', 'lowNotes'] as const) {
        expect(outcome(() => buildContour(seq, { maxNote, priority })), JSON.stringify({ seq, maxNote, priority })).toEqual(
          outcome(() => bfsContour(seq, maxNote, priority)),
        );
        compared++;
      }
    }
    expect(compared).toBe(8000);
  });

  it('handles a long melody at once (the old search took a minute on a ballad)', () => {
    const r = rng(7);
    // A singable line: small steps, so a contour exists.
    const seq: number[] = [50];
    for (let i = 1; i < 64; i++) seq.push(Math.max(45, Math.min(57, seq[i - 1]! + Math.floor(r() * 7) - 3)));
    const t = performance.now();
    expect(buildContour(seq)).toHaveLength(64);
    expect(performance.now() - t).toBeLessThan(2000);
  });
});
