import { describe, expect, it } from 'vitest';
import {
  canonicalStringifySong,
  contentHash,
  fromEngineEnvelope,
  normalizeBarBeatKey,
  parseSong,
} from '../src/index.js';
import { allEngineFixtures, loadEngineWebTesterFixture } from './fixtures/index.js';

describe('canonicalStringifySong is idempotent', () => {
  for (const fixture of allEngineFixtures()) {
    it(`f(f(${fixture.id})) === f(${fixture.id})`, () => {
      const { song } = fromEngineEnvelope({
        song: fixture.song as Record<string, unknown>,
        instruments: fixture.instruments as Record<string, unknown>[],
      });
      const a = canonicalStringifySong(song);
      const reparsed = parseSong(JSON.parse(a));
      const b = canonicalStringifySong(reparsed);
      expect(b).toBe(a);
    });
  }
});

describe('contentHash is stable', () => {
  it('two runs on the same fixture produce the same hash', () => {
    const fixture = loadEngineWebTesterFixture();
    const { song } = fromEngineEnvelope({
      song: fixture.song as Record<string, unknown>,
      instruments: fixture.instruments as Record<string, unknown>[],
    });
    expect(contentHash(song)).toBe(contentHash(song));
  });

  it('object-key reordering does not change the hash', () => {
    const fixture = loadEngineWebTesterFixture();
    const reordered = reorderTopLevelKeys(fixture.song);
    const a = fromEngineEnvelope({
      song: fixture.song as Record<string, unknown>,
      instruments: fixture.instruments as Record<string, unknown>[],
    }).song;
    const b = fromEngineEnvelope({
      song: reordered,
      instruments: fixture.instruments as Record<string, unknown>[],
    }).song;
    expect(contentHash(a)).toBe(contentHash(b));
  });
});

describe('normalizeBarBeatKey', () => {
  it('rounds integers to ".0"', () => {
    expect(normalizeBarBeatKey('0')).toBe('0.0');
    expect(normalizeBarBeatKey('3')).toBe('3.0');
  });
  it('trims trailing zeros', () => {
    expect(normalizeBarBeatKey('0.50')).toBe('0.5');
    expect(normalizeBarBeatKey('2.75')).toBe('2.75');
  });
  it('passes through non-numeric strings unchanged', () => {
    expect(normalizeBarBeatKey('not-a-beat')).toBe('not-a-beat');
  });
});

function reorderTopLevelKeys(obj: unknown): Record<string, unknown> {
  if (!obj || typeof obj !== 'object') throw new Error('expected object');
  const entries = Object.entries(obj as Record<string, unknown>);
  return Object.fromEntries(entries.reverse());
}
