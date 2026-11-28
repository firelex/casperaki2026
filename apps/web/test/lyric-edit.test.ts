import { describe, expect, it } from 'vitest';

import { lyricOrder, stepLyric, syllablesInOrder } from '../src/editor/sequencer/lyricEdit';

describe('lyrics edited on the notes', () => {
  const notes = [{ start: 2, label: 'lo' }, { start: 0, label: 'Hel-' }, { start: 4, label: 'world' }];

  it('Tab walks the notes in time order and stops at the ends', () => {
    const order = lyricOrder(notes);
    expect(order).toEqual([1, 0, 2]);
    expect(stepLyric(order, 1, 1)).toBe(0);
    expect(stepLyric(order, 0, 1)).toBe(2);
    expect(stepLyric(order, 2, 1)).toBe(2);
    expect(stepLyric(order, 1, -1)).toBe(1);
  });

  it('sends every syllable in time order, the typed ones replacing theirs', () => {
    expect(syllablesInOrder(notes, lyricOrder(notes), { 2: 'there' })).toEqual(['Hel-', 'lo', 'there']);
  });
});
