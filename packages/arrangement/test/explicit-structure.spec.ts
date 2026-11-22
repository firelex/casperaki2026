import { describe, expect, it } from 'vitest';

import { orchestrate } from '../src/index.js';

describe('explicit structure (params.structure)', () => {
  const base = { genre: 'brightPop', key: 'C', bpm: 120, seed: 'explicit-1' };
  it('builds exactly the sections given, with chords and parts', () => {
    const song = orchestrate({ ...base, params: { structure: [{ name: 'intro', bars: 4 }, { name: 'verse1', bars: 8 }, { name: 'bridge1', bars: 4 }] } });
    expect(song.songStructure.map((s) => [s.name, s.bars.length])).toEqual([
      ['intro', 4],
      ['verse1', 8],
      ['bridge1', 4],
    ]);
    expect(song.songStructure[2]!.bars.every((b) => b.chords.length > 0)).toBe(true);
    expect(Object.keys(song.arrangement.bridge1!.overrides).length).toBeGreaterThan(0);
  });
  it('rejects unknown section types', () => {
    expect(() => orchestrate({ ...base, params: { structure: [{ name: 'solo1', bars: 4 }] } })).toThrow(/unknown section type/);
  });
});
