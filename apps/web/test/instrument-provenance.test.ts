import { describe, expect, it } from 'vitest';

import {
  resolveInstrumentProvenance,
  splitShortName,
} from '../src/types/song';
import type { InstrumentDefinition } from '@casperaki/song-schema';

describe('splitShortName', () => {
  it('splits "library - preset" on the " - " separator', () => {
    expect(splitShortName('addictiveKeys - Grand Mr Bright')).toEqual({
      library: 'addictiveKeys',
      preset: 'Grand Mr Bright',
    });
  });

  it('returns just preset for a single-token shortName', () => {
    expect(splitShortName('Dynamite Kick1')).toEqual({ preset: 'Dynamite Kick1' });
  });

  it('handles undefined / empty input', () => {
    expect(splitShortName(undefined)).toEqual({});
    expect(splitShortName('')).toEqual({});
  });
});

describe('resolveInstrumentProvenance', () => {
  const catalogDef: InstrumentDefinition = {
    id: 'f91e64bd0b4d2991',
    name: 'Drums',
    shortName: 'drLuke - Dynamite Kick1',
    type: 'kickDrumsElectronic',
    lowLevelType: 'kickDrumsElectronic',
    instrumentGroup: 'kickDrums',
  };

  it('classifies a 16-hex id as a validated catalog selection', () => {
    const info = resolveInstrumentProvenance('Drums', catalogDef, []);
    expect(info.provenance).toBe('catalog');
    expect(info.catalogId).toBe('f91e64bd0b4d2991');
    expect(info.badge).toMatch(/validated/u);
    // Reverse-engineered from shortName when no catalog entry passed in.
    expect(info.library).toBe('drLuke');
    expect(info.preset).toBe('Dynamite Kick1');
    expect(info.family).toBe('kickDrums');
    expect(info.lowLevel).toBe('kickDrumsElectronic');
  });

  it('prefers an explicit catalogEntry over the reverse-engineered values', () => {
    const info = resolveInstrumentProvenance('Drums', catalogDef, [], {
      id: 'f91e64bd0b4d2991',
      library: 'override-library',
      preset: 'override-preset',
      family: 'override-family',
      lowLevel: 'override-lowLevel',
      mainStyle: 'brightPop',
      addStyles: ['edm', 'rock'],
      matchedPath: '/D/samples/x.wav',
    });
    expect(info.library).toBe('override-library');
    expect(info.preset).toBe('override-preset');
    expect(info.family).toBe('override-family');
    expect(info.lowLevel).toBe('override-lowLevel');
    expect(info.mainStyle).toBe('brightPop');
    expect(info.addStyles).toEqual(['edm', 'rock']);
    expect(info.matchedPath).toBe('/D/samples/x.wav');
  });

  it('marks vocaloid fixture ids as an adapter fixture, not catalog', () => {
    const def: InstrumentDefinition = {
      id: 'vocaloid-default',
      name: 'Vocal',
    };
    const info = resolveInstrumentProvenance('Vocal', def, []);
    expect(info.provenance).toBe('adapterFixture');
    expect(info.catalogId).toBeUndefined();
    expect(info.badge).toMatch(/fixture/u);
  });

  it('marks legacy non-catalog ids as definitionOnly', () => {
    const def: InstrumentDefinition = {
      id: 'dev-drums-pop-01',
      name: 'Drums',
      shortName: 'Studio Pop Kit',
    };
    const info = resolveInstrumentProvenance('Drums', def, []);
    expect(info.provenance).toBe('definitionOnly');
    expect(info.catalogId).toBeUndefined();
    expect(info.badge).toMatch(/legacy/u);
  });

  it('marks "no definition + only brainRoundtrip patterns" as render fixture', () => {
    const info = resolveInstrumentProvenance(
      'Bass',
      undefined,
      ['brainRoundtrip'],
    );
    expect(info.provenance).toBe('renderFixture');
    expect(info.badge).toMatch(/render fixture/u);
  });

  it('marks completely missing definition + no patterns as unknown', () => {
    const info = resolveInstrumentProvenance('Mystery', undefined, []);
    expect(info.provenance).toBe('unknown');
    expect(info.badge).toMatch(/no instrument/u);
  });
});
