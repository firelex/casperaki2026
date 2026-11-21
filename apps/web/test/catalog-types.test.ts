import { describe, expect, it } from 'vitest';

import type { CatalogEntry } from '../src/api/catalog';
import {
  NULL_FILTER_VALUE,
  filterOptionsFromCounts,
  filterOptionsFromVocabulary,
  formatStyleLabel,
  labelForCount,
  projectEntry,
} from '../src/types/catalog';

function makeEntry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: '0123456789abcdef',
    publicName: 'Iron Knocker',
    family: 'kickDrums',
    lowLevel: 'kickDrumsAcoustic',
    mainStyle: 'brightPop',
    addStyles: ['edm', 'rock'],
    library: 'addictiveDrums',
    preset: 'A Fair Ballad',
    info: null,
    addPlugins: null,
    bpm: 120,
    key: 'C',
    normalisation: null,
    status: null,
    legacyReplacement: null,
    sourceSheet: 'kickDrums',
    sourceRow: 14,
    matchedPath: 'kickDrums/kickDrumsAcoustic/kickDrums - kickDrumsAcoustic - brightPop - addictiveDrums - A Fair Ballad.mp3',
    matchedRule: 'simple',
    ...overrides,
  };
}

describe('catalog view helpers', () => {
  it('projectEntry shows the public name, not library + preset', () => {
    const row = projectEntry(makeEntry());
    expect(row.displayName).toBe('Iron Knocker');
    expect(row.familyLowLevel).toBe('kickDrums / kickDrumsAcoustic');
    expect(row.styleLabel).toBe('brightPop +edm,rock');
    expect(row.libraryLabel).toBe('addictiveDrums');
    expect(row.sourceLabel).toBe('kickDrums row 14');
    expect(row.availabilityLabel).toBe('audit:simple');
    expect(row.matchedPath).toContain('kickDrums - kickDrumsAcoustic');
  });

  it('projectEntry labels a missing library', () => {
    const row = projectEntry(makeEntry({ library: null, preset: null }));
    expect(row.displayName).toBe('Iron Knocker');
    expect(row.libraryLabel).toBe('— none —');
  });

  it('formatStyleLabel handles missing main + add styles', () => {
    expect(formatStyleLabel(makeEntry({ mainStyle: null, addStyles: [] }))).toBe('—');
    expect(formatStyleLabel(makeEntry({ mainStyle: 'ballad', addStyles: [] }))).toBe('ballad');
  });

  it('labelForCount surfaces the null sentinel with a friendly label', () => {
    expect(labelForCount({ key: NULL_FILTER_VALUE, count: 4 })).toBe('— none — (4)');
    expect(labelForCount({ key: 'kontakt', count: 12 })).toBe('kontakt (12)');
  });

  it('filterOptionsFromCounts prepends an All option', () => {
    const opts = filterOptionsFromCounts(
      [
        { key: 'a', count: 2 },
        { key: 'b', count: 3 },
      ],
      'Any library',
    );
    expect(opts[0]).toEqual({ value: '', label: 'Any library' });
    expect(opts).toHaveLength(3);
    expect(opts[1]?.label).toBe('a (2)');
  });

  it('filterOptionsFromVocabulary prepends an All option', () => {
    const opts = filterOptionsFromVocabulary(['brightPop', 'edm']);
    expect(opts[0]).toEqual({ value: '', label: 'All' });
    expect(opts.map((o) => o.value)).toEqual(['', 'brightPop', 'edm']);
  });
});
