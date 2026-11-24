import { describe, expect, it } from 'vitest';
import { hum } from '@casperaki/arrangement';

import { chordOptions, refitChords, slotsOfChords, type BeatNote } from '../src/hum/fit.js';

const C_MAJOR = { tonic: 0, scale: 'major' } as const;
// C-E-G as whole notes in every bar: the C major triad throughout.
const triadMelody: BeatNote[] = Array.from({ length: 8 }, (_, bar) => [
  { beat: bar * 4, midi: 60, duration: 1.5 },
  { beat: bar * 4 + 1.5, midi: 64, duration: 1 },
  { beat: bar * 4 + 2.5, midi: 67, duration: 1.5 },
]).flat();

describe('refitChords', () => {
  it('gives 16 half-bar chords for an edited 8-bar melody, C under a C triad', () => {
    const r = refitChords(triadMelody, C_MAJOR);
    expect(r.chords).toHaveLength(16);
    expect(r.slots).toHaveLength(16);
    expect(r.chords[0]).toBe('C');
  });
});

describe('chordOptions', () => {
  it('ranks every chord the fitter knows, best fit first', () => {
    const opts = chordOptions(triadMelody, 0, C_MAJOR);
    expect(opts).toHaveLength(hum.loadChordFitModel().prior.vocab.length);
    for (let i = 1; i < opts.length; i++) expect(opts[i - 1]!.fit).toBeGreaterThanOrEqual(opts[i]!.fit);
    const best = hum.chordPcs(hum.parseChordSymbol(opts[0]!.chord, 0));
    expect(best.has(0) && best.has(4)).toBe(true);
  });

  it('refuses a half bar outside 0..15', () => {
    expect(() => chordOptions(triadMelody, 16, C_MAJOR)).toThrow(/half bar/);
  });
});

describe('slotsOfChords', () => {
  it('turns symbols in the song key into chord ids', () => {
    expect(slotsOfChords(['C', 'Am'], C_MAJOR)).toEqual(['0:maj', '9:min']);
  });

  it('works from the relative major in a minor key', () => {
    expect(slotsOfChords(['Am', 'C'], { tonic: 9, scale: 'minor' })).toEqual(['9:min', '0:maj']);
  });

  it('throws on an unknown chord', () => {
    expect(() => slotsOfChords(['Cxyz'], C_MAJOR)).toThrow(/Cxyz/);
  });
});
