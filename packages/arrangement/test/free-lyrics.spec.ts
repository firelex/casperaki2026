import { describe, expect, it } from 'vitest';

import { checkFreeLyrics, MAX_LINE_SYLLABLES, MIN_LINE_SYLLABLES } from '../src/vocals/free-lyrics.js';

const CHORUS = ['Cinnamon Boulevard that is where we are', 'Dancing in the summer heat', 'Cinnamon Boulevard that is where we are', 'Moving to the beat'];
const VERSE = ['Saw your phone light up again', 'A name I do not know', 'You said it was nothing', 'But I could see it show'];
const counts = { verse: 4, chorus: 4 };

describe('checks for lyrics written first', () => {
  it('accepts a good song', () => {
    expect(checkFreeLyrics({ verse: VERSE, chorus: CHORUS }, counts, 'Cinnamon Boulevard', [])).toEqual([]);
  });

  it('the syllable range is 4 to 11', () => {
    expect([MIN_LINE_SYLLABLES, MAX_LINE_SYLLABLES]).toEqual([4, 11]);
    const p = checkFreeLyrics({ verse: ['Oh no', ...VERSE.slice(1)], chorus: CHORUS }, counts, 'Cinnamon Boulevard', []);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ type: 'verse', line: 0 });
    expect(p[0]!.message).toMatch(/4 to 11/u);
  });

  it('names a word the dictionary does not know', () => {
    const p = checkFreeLyrics({ verse: ['Saw your phone light up zxqvy', ...VERSE.slice(1)], chorus: CHORUS }, counts, 'Cinnamon Boulevard', []);
    expect(p.some((x) => x.line === 0 && /zxqvy/u.test(x.message))).toBe(true);
  });

  it('the opening may not start like a recent song', () => {
    const p = checkFreeLyrics({ verse: ['Met you at the gas station', ...VERSE.slice(1)], chorus: CHORUS }, counts, 'Cinnamon Boulevard', ['Met you at the corner store']);
    expect(p.some((x) => x.type === 'verse' && x.line === 0 && /recent/u.test(x.message))).toBe(true);
    // Most of its words in a recent opening is too close as well.
    const q = checkFreeLyrics({ verse: ['Your phone lit up again', ...VERSE.slice(1)], chorus: CHORUS }, counts, 'Cinnamon Boulevard', ['Saw your phone light up again tonight']);
    expect(q.some((x) => x.line === 0 && /recent/u.test(x.message))).toBe(true);
  });

  it('a word ends two different lines only when it is a title word or the lines are the same', () => {
    const night = ['Running through the city night', 'A name I do not know', 'Waiting for the night', 'But I could see it show'];
    const p = checkFreeLyrics({ verse: night, chorus: CHORUS }, counts, 'Cinnamon Boulevard', []);
    expect(p.some((x) => /night/u.test(x.message))).toBe(true);
    expect(checkFreeLyrics({ verse: night, chorus: CHORUS }, counts, 'Night Moves', [])).toEqual([]);
  });

  it('a rhyme pair may end on the same word only for the title or a repeated line', () => {
    const same = ['Saw your phone light up again', 'A name I do not know', 'You said it was nothing', 'I really want to know'];
    expect(checkFreeLyrics({ verse: same, chorus: CHORUS }, counts, 'Cinnamon Boulevard', []).some((x) => x.line === 3)).toBe(true);
    expect(checkFreeLyrics({ verse: same, chorus: CHORUS }, counts, 'Want to Know', [])).toEqual([]);
  });

  it('lines that do not rhyme where they must are named', () => {
    const bad = ['Saw your phone light up again', 'A name I do not know', 'You said it was nothing', 'But I could feel it then'];
    expect(checkFreeLyrics({ verse: bad, chorus: CHORUS }, counts, 'Cinnamon Boulevard', []).some((x) => x.type === 'verse' && x.line === 3)).toBe(true);
  });

  it('the line count of each part', () => {
    expect(checkFreeLyrics({ verse: VERSE.slice(0, 3), chorus: CHORUS }, counts, 'Cinnamon Boulevard', [])).toEqual([expect.objectContaining({ type: 'verse', line: -1 })]);
  });
});
