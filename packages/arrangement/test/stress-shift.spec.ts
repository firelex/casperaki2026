import { describe, expect, it } from 'vitest';

import { pronounceLine } from '../src/vocals/written-lyrics.js';
import { recutRhythm } from '../src/vocals/recut.js';
import { loadPrecedentBank } from '../src/vocals/precedents.js';

/** The stress marks of one word of a line, as the line is read. */
const rhythmIn = (line: string, word: string) => {
  const words = line.split(' ');
  // Where the main stress is: "+-" (or "+0", a secondary stress after it) early, "-+" ("0+") late.
  const r = pronounceLine(line)[words.findIndex((w) => w.toLowerCase().replace(/[^a-z']/gu, '') === word)]!.rhythm.join('');
  return r.replace(/0/gu, '-');
};

describe('noun/verb stress shifts are read from the sentence (owner, 2026-11-27: "full of PER-fect", not per-FECT)', () => {
  it('a noun or adjective takes the early stress, a verb the late one', () => {
    expect(rhythmIn('It is full of perfect moments', 'perfect')).toBe('+-');
    expect(rhythmIn('I will perfect it', 'perfect')).toBe('-+');
    expect(rhythmIn('Put on a record', 'record')).toBe('+-');
    expect(rhythmIn('We record the song', 'record')).toBe('-+');
    expect(rhythmIn('What an insult', 'insult')).toBe('+-');
    expect(rhythmIn('Do not insult me', 'insult')).toBe('-+');
    expect(rhythmIn('The present you gave', 'present')).toBe('+-');
    expect(rhythmIn('I present to you', 'present')).toBe('-+');
  });

  it('the sung sounds follow: PER-fect is P ER1 | F IH2 K T', () => {
    const [, , , , perfect] = pronounceLine('It is full of perfect moments');
    expect(perfect!.phones.map((s) => s.join(' '))).toEqual(['P ER1', 'F IH2 K T']);
  });

  it('a word not on the list keeps its one pronunciation, whatever its part of speech', () => {
    expect(rhythmIn('I was born in July', 'july')).toBe('-+');
  });

  it('the recut puts the stress where the sentence has it', () => {
    const verse = loadPrecedentBank('hooks').find((p) => String(p.id) === '25-fast-edm-04')!;
    const lines = ['Full of perfect little lies', 'You said it would be fine', 'Every record that we played', 'Was spinning out of time'];
    const r = recutRhythm(verse, lines, { bpm: 128, bars: 8 });
    // "per" (syllable 3) on a beat, "fect" off it: PER-fect.
    const per = r.notes[2]!;
    const fect = r.notes[3]!;
    expect(per.start % 1, `"per" at ${per.start}`).toBe(0);
    expect(fect.start % 1, `"fect" at ${fect.start}`).not.toBe(0);
  });
});
