// The adapter's port of the render engine's chord parsing (music/Chord.h)
// and strum-sample suffix collapse (Guitar.h virtualGuitaristSuffix). Every
// type string in the engine's table is enumerated against the suffix the
// engine picks for it.

import { describe, expect, it } from 'vitest';

import {
  ENGINE_CHORD_TYPE_TABLE,
  parseEngineChord,
  virtualGuitaristChordName,
} from '../src/virtual-guitarist-chord.js';

// Chord.h typeTable string → Guitar.h virtualGuitaristSuffix result, read off
// the engine source case by case.
const ENGINE_SUFFIX_BY_TYPE_STRING: Record<string, string> = {
  major: '', '': '', minor: 'm', m: 'm',
  dim: '', dim7: '7', sus2: 'sus2', sus4: 'sus4',
  sus: 'sus4', '7sus4': 'sus4', '5': '', alt: '',
  aug: '', '6': '6', '69': '6', '7': '7', '7b5': '7',
  aug7: '7', '9': '9', '9b5': '9', aug9: '9',
  '7b9': '7', '7#9': '7', '11': '9', '9#11': '9',
  '13': '6', maj7: '7', maj7b5: '7', 'maj7#5': '7',
  maj9: '9', maj11: '9', maj13: '6', m6: 'm',
  m7: 'm7', m7b5: 'm7', m9: 'm', m69: 'm', m11: 'm',
  mmaj7: 'm7', mmaj7b5: 'm7', mmaj9: 'm',
  mmaj11: 'm', add9: '9', madd9: 'm',
};

describe('virtualGuitaristChordName', () => {
  it('covers exactly the engine type table (44 strings)', () => {
    expect(Object.keys(ENGINE_CHORD_TYPE_TABLE).sort()).toEqual(Object.keys(ENGINE_SUFFIX_BY_TYPE_STRING).sort());
    expect(Object.keys(ENGINE_CHORD_TYPE_TABLE).length).toBe(44);
  });

  for (const [typeStr, suffix] of Object.entries(ENGINE_SUFFIX_BY_TYPE_STRING)) {
    it(`"F${typeStr}" → "F${suffix}"`, () => {
      expect(virtualGuitaristChordName(parseEngineChord(`F${typeStr}`))).toBe(`F${suffix}`);
    });
  }

  it('only ever yields the eight shipped suffixes', () => {
    const suffixes = new Set(Object.values(ENGINE_SUFFIX_BY_TYPE_STRING));
    expect([...suffixes].sort()).toEqual(['', '6', '7', '9', 'm', 'm7', 'sus2', 'sus4']);
  });

  it('spells every root with sharps, as Note::toString does', () => {
    const cases: Array<[string, string]> = [
      ['C', 'C'], ['C#', 'C#'], ['Db', 'C#'], ['D', 'D'], ['D#', 'D#'], ['Eb', 'D#'],
      ['E', 'E'], ['F', 'F'], ['F#', 'F#'], ['Gb', 'F#'], ['G', 'G'], ['G#', 'G#'],
      ['Ab', 'G#'], ['A', 'A'], ['A#', 'A#'], ['Bb', 'A#'], ['B', 'B'], ['f', 'F'], ['bb', 'A#'],
    ];
    for (const [root, spelled] of cases) {
      expect(virtualGuitaristChordName(parseEngineChord(`${root}m7`))).toBe(`${spelled}m7`);
    }
  });

  it('ignores a slash bass, as the engine regex search does', () => {
    expect(virtualGuitaristChordName(parseEngineChord('C/E'))).toBe('C');
    expect(virtualGuitaristChordName(parseEngineChord('Am7/G'))).toBe('Am7');
  });

  it('throws on symbols the engine cannot key', () => {
    expect(() => parseEngineChord('H7')).toThrow(/no root/);
    expect(() => parseEngineChord('')).toThrow(/no root/);
    expect(() => parseEngineChord('Cb')).toThrow(/root "Cb"/);
    expect(() => parseEngineChord('E#m')).toThrow(/root "E#"/);
    expect(() => parseEngineChord('Cmaj')).toThrow(/type "maj"/);
    expect(() => parseEngineChord('Cmin7')).toThrow(/type "min7"/);
  });
});
