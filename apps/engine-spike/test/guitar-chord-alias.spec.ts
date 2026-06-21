// docs/54v — engine-sharp → disk-canonical chord alias.

import { describe, expect, it } from 'vitest';

import {
  ENGINE_ROOT_TO_DISK_ROOT,
  engineChordToDiskChord,
} from '../scripts/lib/guitar-chord-alias.mjs';

describe('engineChordToDiskChord', () => {
  it('passes naturals through unchanged', () => {
    expect(engineChordToDiskChord('C')).toBe('C');
    expect(engineChordToDiskChord('Dm')).toBe('Dm');
    expect(engineChordToDiskChord('F')).toBe('F');
    expect(engineChordToDiskChord('G')).toBe('G');
    expect(engineChordToDiskChord('Am7')).toBe('Am7');
  });

  it('translates A#/D#/G# (engine) → Bb/Eb/Ab (disk)', () => {
    expect(engineChordToDiskChord('A#')).toBe('Bb');
    expect(engineChordToDiskChord('D#')).toBe('Eb');
    expect(engineChordToDiskChord('G#')).toBe('Ab');
  });

  it('keeps C# and F# in sharp form (disk uses sharps for those)', () => {
    expect(engineChordToDiskChord('C#')).toBe('C#');
    expect(engineChordToDiskChord('F#')).toBe('F#');
  });

  it('preserves suffix after root translation', () => {
    expect(engineChordToDiskChord('A#9')).toBe('Bb9');
    expect(engineChordToDiskChord('D#m7')).toBe('Ebm7');
    expect(engineChordToDiskChord('G#sus2')).toBe('Absus2');
    expect(engineChordToDiskChord('C#m7')).toBe('C#m7');
  });

  it('handles B# → C and E# → F (legacy enharmonic edge cases)', () => {
    expect(engineChordToDiskChord('B#')).toBe('C');
    expect(engineChordToDiskChord('E#')).toBe('F');
  });

  it('returns input unchanged for unknown / malformed roots', () => {
    expect(engineChordToDiskChord('H')).toBe('H'); // not a real chord
    expect(engineChordToDiskChord('')).toBe('');
  });

  it('exposes the canonical map as a frozen object', () => {
    expect(Object.isFrozen(ENGINE_ROOT_TO_DISK_ROOT)).toBe(true);
    expect(ENGINE_ROOT_TO_DISK_ROOT['A#']).toBe('Bb');
  });
});
