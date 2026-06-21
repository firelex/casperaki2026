import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, compareVersions, migrate, safeParseSong } from '../src/index.js';

describe('version helpers', () => {
  it('exposes SCHEMA_VERSION = "1"', () => {
    expect(SCHEMA_VERSION).toBe('1');
  });

  it('compareVersions orders correctly', () => {
    expect(compareVersions('1', '1')).toBe(0);
    expect(compareVersions('1', '1.0')).toBe(0);
    expect(compareVersions('1', '2')).toBe(-1);
    expect(compareVersions('2', '1')).toBe(1);
    expect(compareVersions('1.0.1', '1.0.0')).toBe(1);
  });

  it('migrate is a no-op for v1', () => {
    const input = { foo: 'bar' };
    expect(migrate(input, '1')).toBe(input);
  });

  it('migrate rejects unknown versions', () => {
    expect(() => migrate({}, '2')).toThrow();
  });

  it('safeParseSong rejects an unknown schemaVersion', () => {
    const result = safeParseSong({
      schemaVersion: '2',
      key: 'C',
      bpm: 120,
      songStructure: [],
      arrangement: {},
    });
    expect(result.ok).toBe(false);
  });
});
