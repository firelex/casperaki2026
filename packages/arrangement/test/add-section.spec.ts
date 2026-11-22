import { describe, expect, it } from 'vitest';

import { addSection, nextSectionName, orchestrate } from '../src/index.js';

describe('addSection', () => {
  const song = orchestrate({ genre: 'brightPop', key: 'C', bpm: 120, seed: 'add-section-1' });
  it('inserts a generated section with chords and parts, leaving the rest unchanged', () => {
    const at = 2;
    const { song: out, name } = addSection(song, 'bridge', at);
    expect(out.songStructure[at]!.name).toBe(name);
    expect(name.startsWith('bridge')).toBe(true);
    expect(out.songStructure).toHaveLength(song.songStructure.length + 1);
    expect(out.songStructure[at]!.bars.every((b) => b.chords.length > 0)).toBe(true);
    const parts = Object.keys(out.arrangement[name]!.overrides);
    expect(parts.length).toBeGreaterThan(0);
    const tracks = new Set(song.instrumentDefinitions.map((d) => d.name));
    expect(parts.every((p) => tracks.has(p))).toBe(true);
    for (const s of song.songStructure) expect(out.arrangement[s.name]).toEqual(song.arrangement[s.name]);
  });
  it('names sections and rejects unknown types', () => {
    expect(nextSectionName('chorus', new Set(['chorus1', 'chorus2']))).toBe('chorus3');
    expect(nextSectionName('outro', new Set(['intro']))).toBe('outro');
    expect(() => addSection(song, 'solo', 0)).toThrow(/Unknown section type/);
  });
});
