// How a written word is split over its sung syllables for display (src/vocals/word-split.ts): the owner's rule,
// 2026-11-26. As many parts as sung syllables, each with one sung vowel; consonants between two vowels go to the
// next part as far as they make a legal English syllable start (maximal onset), the rest stay before; letters with
// no vowel of their own stay with their syllable; a sung contraction drops the vowel letter it does not sing.

import { describe, expect, it } from 'vitest';

import { pronounce } from '../src/index.js';

const split = (w: string) => pronounce(w)!.syllables.join('-');

describe('written word splits', () => {
  it('the owner\'s examples', () => {
    expect(split('rhythm')).toBe('rhy-thm'); // "m" has no vowel letter: sung with "th" in the second syllable
    expect(split('control')).toBe('con-trol'); // "tr" may start a syllable, "ntr" may not
    expect(split('pulsing')).toBe('pul-sing'); // "ls" may not start a syllable: "l" stays
    expect(split('tonight')).toBe('to-night');
    expect(split('fire')).toBe('fi-re');
    expect(split('beautiful')).toBe('beau-ti-ful');
    expect(split('energy')).toBe('e-ner-gy');
    // "everything" is sung on three notes (the dictionary's "ev-ry-thing"): the unsung "e" goes.
    expect(split('everything')).toBe('e-vry-thing');
  });

  it('more words by the same rule', () => {
    const expected: Record<string, string> = {
      standing: 'stan-ding', // "nd" no legal start, "d" is
      morning: 'mor-ning',
      walking: 'wal-king',
      sunlight: 'sun-light',
      spotlight: 'spot-light', // "tl" no legal start
      become: 'be-come', // the silent final "e" stays with its syllable
      until: 'un-til',
      music: 'mu-sic',
      moment: 'mo-ment',
      golden: 'gol-den',
      carry: 'car-ry', // a double consonant is shared
      into: 'in-to',
      speakers: 'spea-kers',
      every: 'e-ve-ry', // three sung syllables in the dictionary
    };
    for (const [w, s] of Object.entries(expected)) expect(split(w), w).toBe(s);
  });

  it('sung contractions show the contracted spelling', () => {
    // "every" sung on two notes ("ev'ry"): the dropped vowel letter disappears, its consonant joins the next part.
    // The short forms come from written-lyrics' sung-contraction lists; the attach test checks "every" on 2 notes.
    expect(pronounce('every')!.syllables).toEqual(['e', 've', 'ry']);
  });
});
