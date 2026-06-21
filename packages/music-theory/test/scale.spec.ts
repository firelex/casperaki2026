import { describe, expect, it } from 'vitest';
import {
  degreePitchClass,
  isInScale,
  parseKey,
  scalePitchClasses,
} from '../src/scale.js';

describe('parseKey', () => {
  it('defaults to major', () => {
    expect(parseKey('C')).toEqual({ tonic: 0, mode: 'major' });
    expect(parseKey('C').mode).toBe('major');
  });

  it('parses explicit modes', () => {
    expect(parseKey('Cm').mode).toBe('minor');
    expect(parseKey('Cmin').mode).toBe('minor');
    expect(parseKey('Cminor').mode).toBe('minor');
    expect(parseKey('Cmaj').mode).toBe('major');
    expect(parseKey('Cmajor').mode).toBe('major');
    expect(parseKey('CM').mode).toBe('major');
  });

  it('parses accidentals', () => {
    expect(parseKey('F#m').tonic).toBe(6);
    expect(parseKey('Bb').tonic).toBe(10);
  });
});

describe('scalePitchClasses', () => {
  it('emits C major', () => {
    expect(scalePitchClasses(parseKey('C'))).toEqual([0, 2, 4, 5, 7, 9, 11]);
  });
  it('emits A minor (natural)', () => {
    expect(scalePitchClasses(parseKey('Am'))).toEqual([9, 11, 0, 2, 4, 5, 7]);
  });
});

describe('degreePitchClass', () => {
  it('finds the dominant (5) of C major', () => {
    expect(degreePitchClass(parseKey('C'), 5)).toBe(7);
  });
  it('finds the relative ii in A minor', () => {
    expect(degreePitchClass(parseKey('Am'), 2)).toBe(11);
  });
  it('rejects degree out of range', () => {
    expect(() => degreePitchClass(parseKey('C'), 0)).toThrow();
    expect(() => degreePitchClass(parseKey('C'), 8)).toThrow();
  });
});

describe('isInScale', () => {
  it('accepts in-scale pitches', () => {
    const c = parseKey('C');
    expect(isInScale(c, 0)).toBe(true); // C
    expect(isInScale(c, 7)).toBe(true); // G
  });
  it('rejects out-of-scale pitches', () => {
    const c = parseKey('C');
    expect(isInScale(c, 1)).toBe(false); // C#
    expect(isInScale(c, 6)).toBe(false); // F#
  });
});
