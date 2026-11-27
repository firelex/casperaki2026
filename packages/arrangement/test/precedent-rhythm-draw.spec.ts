import { describe, expect, it } from 'vitest';
import { createRng } from '@casperaki/music-theory';

import { drapeOnRhythm, drawRhythm, rhythmPool, selectMergedPrecedent } from '../src/vocals/precedents.js';

const inputs = { desiredPatternLength: 8, segmentType: 'chorus', genre: 'brightPop', tempo: 120 } as const;

describe('a rhythm drawn on its own', () => {
  it("the pool holds the style's rhythm bank and the hooks written for the section", () => {
    const pool = rhythmPool(inputs);
    const banks = new Set(pool.map((e) => (e.properties as { kind?: string }).kind === 'hook' ? 'hooks' : 'style'));
    expect(banks).toEqual(new Set(['hooks', 'style']));
  });

  it('draws uniformly: every entry of the pool can come up, not only those that fit best', () => {
    const ids = new Set(rhythmPool(inputs).map((e) => String(e.id)));
    const seen = new Set<string>();
    for (let i = 0; i < 4000 && seen.size < ids.size; i++) seen.add(String(drawRhythm({ ...inputs, rng: createRng(`draw-${i}`) }).id));
    expect(seen).toEqual(ids);
  });

  it("drapes a melody on a given rhythm: the rhythm's onsets, the melody's chords", () => {
    const rhythm = drawRhythm({ ...inputs, rng: createRng('r') });
    const merged = selectMergedPrecedent({ ...inputs, rng: createRng('m') })!;
    const draped = drapeOnRhythm(rhythm, merged.melodic, merged.properties.maxNote);
    const onsets = Object.keys(draped.melody).map(Number);
    for (const b of onsets) expect(rhythm.melody[Object.keys(rhythm.melody).find((k) => Number(k) === b)!]).toBeDefined();
    expect(onsets.length).toBeGreaterThan(0.8 * Object.keys(rhythm.melody).length);
    expect(draped.chords).toEqual(Object.fromEntries(Object.entries(merged.melodic.chords).filter(([b]) => Number(b) >= 0 && Number(b) < merged.melodic.properties.end * 4)));
    expect(draped.rhythmic.id).toBe(rhythm.id);
    expect(draped.melodic.id).toBe(merged.melodic.id);
  });

  it('a merged melody carries the entries it was made from', () => {
    for (let i = 0; i < 30; i++) {
      const m = selectMergedPrecedent({ ...inputs, rng: createRng(`made-${i}`) })!;
      expect(m.rhythmic.id).toBe(m.rhythmicPrecedentId);
      expect(m.melodic.id).toBe(m.melodicPrecedentId);
    }
  });
});
