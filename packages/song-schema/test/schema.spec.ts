import { describe, expect, it } from 'vitest';
import { allEngineFixtures } from './fixtures/index.js';
import { fromEngineEnvelope, safeParseSong } from '../src/index.js';

describe('schema accepts all legacy engine fixtures', () => {
  for (const fixture of allEngineFixtures()) {
    it(`accepts ${fixture.id}`, () => {
      const { song } = fromEngineEnvelope({
        song: fixture.song as Record<string, unknown>,
        instruments: fixture.instruments as Record<string, unknown>[],
      });
      const result = safeParseSong(song);
      expect(result.ok).toBe(true);
    });
  }
});

describe('schema rejects missing required fields', () => {
  it('rejects an object missing bpm', () => {
    const result = safeParseSong({
      key: 'C',
      songStructure: [],
      arrangement: {},
    });
    expect(result.ok).toBe(false);
  });

  it('rejects an object missing key', () => {
    const result = safeParseSong({
      bpm: 120,
      songStructure: [],
      arrangement: {},
    });
    expect(result.ok).toBe(false);
  });

  it('rejects unknown top-level fields on canonical Song', () => {
    const result = safeParseSong({
      schemaVersion: '1',
      key: 'C',
      bpm: 120,
      songStructure: [],
      arrangement: {},
      mysteryField: 'nope',
    });
    expect(result.ok).toBe(false);
  });
});
