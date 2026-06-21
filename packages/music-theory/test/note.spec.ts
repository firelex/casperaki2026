import { describe, expect, it } from 'vitest';
import {
  parseNoteString,
  midiToNoteString,
  transposeMidi,
  pitchClassDistance,
} from '../src/note.js';

describe('parseNoteString', () => {
  it('parses middle C (C4 → MIDI 60)', () => {
    expect(parseNoteString('C4').midi).toBe(60);
    expect(parseNoteString('c4').midi).toBe(60);
  });

  it('parses accidentals', () => {
    expect(parseNoteString('C#4').midi).toBe(61);
    expect(parseNoteString('Db4').midi).toBe(61);
    expect(parseNoteString('F#3').midi).toBe(54);
  });

  it('parses negative octaves', () => {
    expect(parseNoteString('C-1').midi).toBe(0);
    expect(parseNoteString('B-1').midi).toBe(11);
  });

  it('rejects malformed strings', () => {
    expect(() => parseNoteString('H4')).toThrow();
    expect(() => parseNoteString('C')).toThrow();
    expect(() => parseNoteString('')).toThrow();
  });

  it('rejects out-of-range MIDI', () => {
    expect(() => parseNoteString('C-2')).toThrow();
    expect(() => parseNoteString('G10')).toThrow();
  });
});

describe('midiToNoteString', () => {
  it('round-trips with parseNoteString', () => {
    for (let m = 0; m <= 127; m++) {
      const s = midiToNoteString(m);
      expect(parseNoteString(s).midi).toBe(m);
    }
  });

  it('emits uppercase sharps for canonicalization', () => {
    expect(midiToNoteString(61)).toBe('C#4');
    expect(midiToNoteString(54)).toBe('F#3');
  });
});

describe('transposeMidi', () => {
  it('shifts within range', () => {
    expect(transposeMidi(60, 12)).toBe(72);
    expect(transposeMidi(60, -12)).toBe(48);
  });
  it('rejects out-of-range results', () => {
    expect(() => transposeMidi(120, 12)).toThrow();
    expect(() => transposeMidi(5, -12)).toThrow();
  });
});

describe('pitchClassDistance', () => {
  it('wraps modulo 12', () => {
    expect(pitchClassDistance(0, 7)).toBe(7);
    expect(pitchClassDistance(7, 0)).toBe(5);
    expect(pitchClassDistance(11, 0)).toBe(1);
    expect(pitchClassDistance(0, 0)).toBe(0);
  });
});
