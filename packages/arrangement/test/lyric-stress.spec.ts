// The old lyric writer's stress rules (casperaki1 LyricsClass.js note grades, LyricsTemplatePoetClass.js word rhythm,
// LyricsTemplatePoetVerseClass.js matching), ported in src/vocals/stress.ts. Each grading case below follows one
// branch of the old switch; lengths in beats ('4' quarter = 1, '4+' = 1.5, '8' = 0.5, '8+' = 0.75, '16' = 0.25).

import { describe, expect, it } from 'vitest';

import { gradeBar, gradeNote, legacyDuration, lyricSlots, pronounce, stressFits, wordRhythm } from '../src/index.js';

describe('note grades (old LyricsClass.js switch)', () => {
  it('names lengths as the old code did (tools.js convertHitLengthToNoteDuration)', () => {
    const names = [4, 2, 3, 2.5, 3.5, 1, 1.5, 1.25, 1.75, 0.5, 0.75, 0.25, 0.375, 0.125, 5].map(legacyDuration);
    expect(names).toEqual(['1', '2', '2+', '2+', '2++', '4', '4+', '4+', '4++', '8', '8+', '16', '16+', '32', '1+']);
  });

  it('half notes and longer are free wherever they are; a whole note (no case in the old switch) too', () => {
    expect(gradeNote(0, 2, undefined, 1)).toBe('0');
    expect(gradeNote(1, 3, 1, undefined)).toBe('0');
    expect(gradeNote(0.5, 2.5, 0.5, undefined)).toBe('0');
    expect(gradeNote(0, 4, undefined, undefined)).toBe('0');
  });

  it('quarter notes on beat 1 or 3, or half a beat before beat 2 or 4: strong unless a long note follows or a short one precedes', () => {
    expect(gradeNote(0, 1, undefined, 1)).toBe('+');
    expect(gradeNote(2, 1, 1, 0.5)).toBe('+');
    expect(gradeNote(1.5, 1, 0.5, 1)).toBe('0'); // after an eighth
    expect(gradeNote(1.5, 1, 1, 1)).toBe('+');
    expect(gradeNote(3.5, 1, undefined, undefined)).toBe('+');
    // Next a whole, half, dotted half or dotted quarter: free.
    for (const next of [4, 2, 3, 1.5]) expect(gradeNote(0, 1, undefined, next)).toBe('0');
    // 2.5 beats is named '2+' by the old code (it rounds a length up to the next dotted name): a long note, free.
    expect(gradeNote(0, 1, undefined, 2.5)).toBe('0');
    // 3.5 beats is '2++', which the old list leaves out: still strong.
    expect(gradeNote(0, 1, undefined, 3.5)).toBe('+');
    // After an eighth or a sixteenth: free.
    expect(gradeNote(2, 1, 0.5, 1)).toBe('0');
    expect(gradeNote(2, 1, 0.25, 1)).toBe('0');
  });

  it('quarter notes elsewhere: weak, except a dotted quarter on beat 2 or 4, or after a short note', () => {
    expect(gradeNote(1, 1, 1, 1)).toBe('-');
    expect(gradeNote(3, 1, 1, undefined)).toBe('-');
    expect(gradeNote(1, 1.5, 1, 1)).toBe('0');
    expect(gradeNote(3, 1.5, 1, undefined)).toBe('0');
    expect(gradeNote(1, 1.25, 1, undefined)).toBe('0'); // 1.25 beats is named '4+' like the dotted quarter
    expect(gradeNote(1, 1.75, 1, undefined)).toBe('-'); // 1.75 is '4++', not '4+'
    expect(gradeNote(1, 1, 0.5, 1)).toBe('0');
    expect(gradeNote(0.5, 1, 0.5, 1)).toBe('0');
    expect(gradeNote(0.5, 1, undefined, 1)).toBe('-');
  });

  it('eighth notes on a beat or a sixteenth before one: strong unless a note of a quarter or more (or a dotted eighth) follows, or a sixteenth precedes', () => {
    expect(gradeNote(0, 0.5, undefined, 0.5)).toBe('+');
    expect(gradeNote(2.75, 0.5, 0.25, 0.5)).toBe('0'); // after a sixteenth
    expect(gradeNote(1.75, 0.5, 0.5, 0.5)).toBe('+');
    for (const next of [4, 2, 3, 1, 1.5, 0.75]) expect(gradeNote(1, 0.5, undefined, next)).toBe('0');
    expect(gradeNote(1, 0.5, undefined, 0.25)).toBe('+');
    expect(gradeNote(1, 0.5, undefined, undefined)).toBe('+');
  });

  it('eighth notes off the beat: weak, except a dotted eighth half a beat before a beat, or after a sixteenth', () => {
    expect(gradeNote(0.5, 0.5, 0.5, 0.5)).toBe('-');
    expect(gradeNote(0.5, 0.75, 0.5, 0.25)).toBe('0');
    expect(gradeNote(0.25, 0.75, 0.25, 0.5)).toBe('0'); // after a sixteenth
    expect(gradeNote(0.25, 0.75, undefined, 0.5)).toBe('-');
    expect(gradeNote(1.5, 0.5, 0.25, 0.5)).toBe('0');
  });

  it('sixteenths on an eighth position: strong unless a note of a dotted sixteenth or more follows; others weak', () => {
    expect(gradeNote(0, 0.25, undefined, 0.25)).toBe('+');
    expect(gradeNote(0.5, 0.25, 0.25, 0.25)).toBe('+');
    for (const next of [4, 2, 3, 1, 1.5, 0.5, 0.75, 0.375]) expect(gradeNote(1, 0.25, undefined, next)).toBe('0');
    expect(gradeNote(0.25, 0.25, 0.25, 1)).toBe('-');
    expect(gradeNote(0.75, 0.25, 0.25, 0.25)).toBe('-');
  });

  it('a dotted sixteenth (no case in the old switch) is free', () => {
    expect(gradeNote(0, 0.375, undefined, 0.5)).toBe('0');
  });

  it('a bar is graded with each note\'s neighbours in that bar, whatever the rests between them', () => {
    // Quarter on 0, a rest, eighth on 2, eighth on 2.5: the quarter's next note is the eighth (not a long note): strong.
    expect(gradeBar([{ beat: 0, duration: 1 }, { beat: 2, duration: 0.5 }, { beat: 2.5, duration: 0.5 }])).toEqual(['+', '+', '-']);
    // The slots of a section carry these grades; a bar's first note has no neighbour before it.
    const bars = [{ notes: { '0.0': [{ type: 'vocalNote', duration: 0.5 }], '0.5': [{ type: 'vocalNote', duration: 0.5 }] } }, { notes: { '0.0': [{ type: 'vocalNote', duration: 1 }] } }];
    expect(lyricSlots(bars).map((s) => s.grade)).toEqual(['+', '-', '+']);
  });
});

describe('word rhythm (old LyricsTemplatePoetClass.js _getSyllables)', () => {
  it('a word of two or more syllables: its dictionary stress, secondary stress free', () => {
    expect(pronounce('tonight')!.rhythm).toEqual(['-', '+']);
    expect(pronounce('beautiful')!.rhythm).toEqual(['+', '-', '-']);
    expect(pronounce('sidewalk')!.rhythm).toEqual(['+', '0']);
    expect(pronounce('understand')!.rhythm).toEqual(['0', '-', '+']);
  });

  it('a one-syllable word: unstressed for a, an, and, but, for, the, this, or, to; free for any other', () => {
    for (const w of ['a', 'an', 'and', 'but', 'for', 'the', 'this', 'or', 'to']) expect(pronounce(w)!.rhythm).toEqual(['-']);
    for (const w of ['night', 'I', 'you', 'in', 'of', 'love']) expect(pronounce(w)!.rhythm).toEqual(['0']);
    expect(wordRhythm('the', [0])).toEqual(['-']);
    expect(wordRhythm('sun', [1])).toEqual(['0']);
  });

  it('matches a syllable to a note when the marks are equal or either is free', () => {
    expect(stressFits('+', '+')).toBe(true);
    expect(stressFits('0', '-')).toBe(true);
    expect(stressFits('-', '0')).toBe(true);
    expect(stressFits('+', '-')).toBe(false);
    expect(stressFits('-', '+')).toBe(false);
  });
});
