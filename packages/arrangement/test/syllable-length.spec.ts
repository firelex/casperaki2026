import { describe, expect, it } from 'vitest';

import { lengthFits, lineLengthProblems, syllableLength } from '../src/vocals/syllable-length.js';
import { pronounce } from '../src/vocals/written-lyrics.js';
import type { LyricLine } from '../src/vocals/lyric-lines.js';

const sylls = (w: string) => pronounce(w)!.phones;

/** A line of slots, one per note: [start, duration] in beats from the section start, graded free. */
const slots = (notes: readonly (readonly [number, number])[]): LyricLine =>
  notes.map(([start, duration]) => ({ barIndex: Math.floor(start / 4), beat: start % 4, duration, start, grade: '0', prevInBar: undefined, nextInBar: undefined }));

describe('the length rule', () => {
  it('"You gotta feel it": you any, go short, tta medium, feel any, it medium', () => {
    expect(syllableLength(sylls('you')[0]!, true)).toBe('any');
    expect(syllableLength(sylls('gotta')[0]!, false)).toBe('short');
    expect(syllableLength(sylls('gotta')[1]!, true)).toBe('medium');
    expect(syllableLength(sylls('feel')[0]!, true)).toBe('any');
    expect(syllableLength(sylls('it')[0]!, true)).toBe('medium');
  });

  it('long vowels and sonorant endings hold; stops on short vowels do not', () => {
    for (const w of ['night', 'home', 'mine', 'feel', 'sing']) expect(syllableLength(sylls(w).at(-1)!, true)).toBe('any');
    for (const w of ['get', 'up', 'back']) expect(syllableLength(sylls(w).at(-1)!, true)).toBe('medium');
  });

  it('thresholds are in milliseconds, whatever the tempo', () => {
    expect(lengthFits('short', 0.5, 120)).toBe(true); // 250 ms
    expect(lengthFits('short', 1, 120)).toBe(false); // 500 ms
    expect(lengthFits('medium', 1, 170)).toBe(true); // 353 ms
    expect(lengthFits('medium', 1, 100)).toBe(false); // 600 ms
    expect(lengthFits('any', 8, 60)).toBe(true);
  });

  it('names a syllable held too long in a line', () => {
    // you gotta feel it: "go" held two beats at 110 bpm (1091 ms).
    const line = slots([[0, 0.5], [0.5, 2], [2.5, 0.5], [3, 2], [5, 0.5]]);
    const problems = lineLengthProblems('You gotta feel it', line, 110);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('go');
    expect(lineLengthProblems('You gotta feel it', slots([[0, 0.5], [0.5, 0.5], [1, 0.5], [1.5, 2], [3.5, 0.5]]), 110)).toEqual([]);
  });
});
