import { describe, expect, it } from 'vitest';
import { chordNotes, parseChord } from '../src/chord.js';

describe('parseChord', () => {
  it('parses bare letter as major triad', () => {
    const c = parseChord('C');
    expect(c.root).toBe(0);
    expect(c.quality).toBe('maj');
    expect(c.intervals).toEqual([0, 4, 7]);
  });

  it('parses minor with "m" suffix', () => {
    const a = parseChord('Am');
    expect(a.root).toBe(9);
    expect(a.quality).toBe('min');
    expect(a.intervals).toEqual([0, 3, 7]);
  });

  it('parses minor7 vs maj7 vs dom7', () => {
    expect(parseChord('Cm7').quality).toBe('min7');
    expect(parseChord('Cmaj7').quality).toBe('maj7');
    expect(parseChord('C7').quality).toBe('7');
    expect(parseChord('Cm7').intervals).toEqual([0, 3, 7, 10]);
    expect(parseChord('Cmaj7').intervals).toEqual([0, 4, 7, 11]);
    expect(parseChord('C7').intervals).toEqual([0, 4, 7, 10]);
  });

  it('parses m7b5 half-diminished', () => {
    expect(parseChord('Bm7b5').quality).toBe('m7b5');
    expect(parseChord('Bm7b5').intervals).toEqual([0, 3, 6, 10]);
  });

  it('parses sus chords', () => {
    expect(parseChord('Csus2').intervals).toEqual([0, 2, 7]);
    expect(parseChord('Csus4').intervals).toEqual([0, 5, 7]);
  });

  it('parses dim, aug, dim7', () => {
    expect(parseChord('Cdim').intervals).toEqual([0, 3, 6]);
    expect(parseChord('Caug').intervals).toEqual([0, 4, 8]);
    expect(parseChord('Cdim7').intervals).toEqual([0, 3, 6, 9]);
  });

  it('parses slash chord bass', () => {
    const c = parseChord('C/G');
    expect(c.root).toBe(0);
    expect(c.bass).toBe(7);
  });

  it('handles accidentals on root', () => {
    expect(parseChord('F#').root).toBe(6);
    expect(parseChord('Bb').root).toBe(10);
    expect(parseChord('Bbm7').root).toBe(10);
    expect(parseChord('Bbm7').quality).toBe('min7');
  });

  it('flags unknown qualities without throwing', () => {
    expect(parseChord('C13b9').quality).toBe('unknown');
    expect(parseChord('C13b9').intervals).toEqual([0, 4, 7]); // fallback triad
  });
});

describe('chordNotes', () => {
  it('renders C major triad at octave 4', () => {
    expect(chordNotes(parseChord('C'), 4)).toEqual([60, 64, 67]);
  });

  it('renders Am at octave 4', () => {
    expect(chordNotes(parseChord('Am'), 4)).toEqual([69, 72, 76]);
  });

  it('renders extended chord with extensions above octave', () => {
    expect(chordNotes(parseChord('Cmaj9'), 4)).toEqual([60, 64, 67, 71, 74]);
  });
});
