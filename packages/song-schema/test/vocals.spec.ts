import { describe, expect, it } from 'vitest';
import { SongSchema, VocalsSettingSchema } from '../src/index.js';

const base = { key: 'C', bpm: 100, songStructure: [], arrangement: {} };

describe('song vocals setting', () => {
  it('is absent on songs made before sung vocals (off)', () => {
    expect(SongSchema.parse(base).vocals).toBeUndefined();
  });

  it('round-trips on, voice and take numbers', () => {
    const vocals = { enabled: true, voice: 'en_prompt', takeNumbers: { chorus1: 2 } };
    expect(SongSchema.parse({ ...base, vocals }).vocals).toEqual(vocals);
  });

  it('refuses unknown keys and take numbers below 1', () => {
    expect(VocalsSettingSchema.safeParse({ enabled: true, voice: 'v', takeNumbers: {}, extra: 1 }).success).toBe(false);
    expect(VocalsSettingSchema.safeParse({ enabled: true, voice: 'v', takeNumbers: { chorus1: 0 } }).success).toBe(false);
    expect(VocalsSettingSchema.safeParse({ enabled: true, voice: '', takeNumbers: {} }).success).toBe(false);
  });
});
