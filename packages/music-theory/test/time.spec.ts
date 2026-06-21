import { describe, expect, it } from 'vitest';
import {
  barsToBeats,
  barsToSeconds,
  beatsPerBar,
  formatBarBeat,
  parseBarBeat,
} from '../src/time.js';

describe('formatBarBeat', () => {
  it('emits zero as "0.0"', () => {
    expect(formatBarBeat(0)).toBe('0.0');
  });
  it('keeps a single trailing zero on integer beats', () => {
    expect(formatBarBeat(1)).toBe('1.0');
    expect(formatBarBeat(2)).toBe('2.0');
  });
  it('strips trailing zeros beyond one decimal', () => {
    expect(formatBarBeat(0.5)).toBe('0.5');
    expect(formatBarBeat(0.75)).toBe('0.75');
    expect(formatBarBeat(2.25)).toBe('2.25');
  });
});

describe('parseBarBeat round-trips formatBarBeat', () => {
  it('handles the canonical samples', () => {
    for (const v of [0, 0.5, 0.75, 1, 2.25, 3.875]) {
      expect(parseBarBeat(formatBarBeat(v))).toBeCloseTo(v, 8);
    }
  });
});

describe('time conversions', () => {
  it('beatsPerBar returns 4 (4/4)', () => {
    expect(beatsPerBar()).toBe(4);
  });
  it('barsToBeats multiplies', () => {
    expect(barsToBeats(2)).toBe(8);
  });
  it('barsToSeconds at 120 bpm', () => {
    // 2 bars * 4 beats * 60/120 = 4 seconds
    expect(barsToSeconds(2, 120)).toBeCloseTo(4, 6);
  });
  it('rejects non-positive bpm', () => {
    expect(() => barsToSeconds(1, 0)).toThrow();
    expect(() => barsToSeconds(1, -1)).toThrow();
  });
});
