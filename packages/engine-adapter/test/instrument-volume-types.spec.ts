import { describe, expect, it } from 'vitest';

import {
  RECOGNIZED_LOW_LEVEL_TYPES,
  collectUnrecognizedLowLevelTypes,
} from '../src/instrument-volume-types.js';

describe('RECOGNIZED_LOW_LEVEL_TYPES', () => {
  it('covers the per-type levels the legacy app applied', () => {
    // spot-check one from each family that carries a non-zero level
    for (const t of [
      'bassesSynthSoft',
      'leadSynthsBright',
      'keysAcousticPiano',
      'percussionLoopsAcoustic',
      'percussionLoopsElectronic',
      'kickDrumsElectronic',
      'snareDrumsElectronic',
      'acousticGuitarsNylonStereo',
      'electricGuitarsStratDriveStereo',
    ]) {
      expect(RECOGNIZED_LOW_LEVEL_TYPES.has(t)).toBe(true);
    }
  });

  it('includes the family-map types that take a deliberate 0 dB default', () => {
    for (const t of ['cymbalsSwell', 'drumKitsAcoustic', 'fx8bitArcade', 'hiHatsOpen']) {
      expect(RECOGNIZED_LOW_LEVEL_TYPES.has(t)).toBe(true);
    }
  });
});

describe('collectUnrecognizedLowLevelTypes', () => {
  it('returns nothing for a kit + tonal lineup the engine recognises', () => {
    const insts = [
      {
        filename: 'inst-1.json',
        json: {
          lowLevelType: 'drums',
          subInstruments: {
            bassDrum1: { lowLevelType: 'kickDrumsElectronic' },
            snareDrum1: { lowLevelType: 'snareDrumsElectronic' },
          },
        },
      },
      { filename: 'inst-2.json', json: { lowLevelType: 'bassesSynthSoft' } },
      { filename: 'inst-13.json', json: { lowLevelType: 'percussionLoopsAcoustic' } },
    ];
    expect(collectUnrecognizedLowLevelTypes(insts)).toEqual([]);
  });

  it('flags a suffixed loop type that would fall through to 0 dB', () => {
    const insts = [
      {
        filename: 'inst-13.json',
        json: { lowLevelType: 'percussionLoopsAcoustic_120-150bpm' },
      },
    ];
    const out = collectUnrecognizedLowLevelTypes(insts);
    expect(out).toEqual([
      {
        filename: 'inst-13.json',
        lowLevelType: 'percussionLoopsAcoustic_120-150bpm',
        where: 'lowLevelType',
      },
    ]);
  });

  it('flags an unrecognised drum sub-instrument but never the kit parent', () => {
    const insts = [
      {
        filename: 'inst-1.json',
        json: {
          lowLevelType: 'drums',
          subInstruments: {
            bassDrum1: { lowLevelType: 'kickDrumsElectronic' },
            mystery: { lowLevelType: 'kickDrumsQuantum' },
          },
        },
      },
    ];
    const out = collectUnrecognizedLowLevelTypes(insts);
    expect(out).toEqual([
      {
        filename: 'inst-1.json',
        lowLevelType: 'kickDrumsQuantum',
        where: 'subInstruments.mystery',
      },
    ]);
  });
});
