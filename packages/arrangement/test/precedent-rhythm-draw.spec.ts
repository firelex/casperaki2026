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

describe('a melody laid on a recut rhythm keeps its shape', () => {
  it("per two-bar line, the draped pitches climb and fall as the melody's own notes there do", () => {
    // A melody that rises through a line and falls through the next, on a rhythm bunched into each line's first bar.
    const notes = (pairs: readonly (readonly [number, number])[]) => Object.fromEntries(pairs.map(([b, m]) => [Number.isInteger(b) ? `${b}.0` : String(b), [{ note: 'x', midi: m, duration: 1 }]]));
    const melodic = {
      id: 'm', properties: { start: 0, end: 4, useOriginal: false, useRemix: true, source: { kind: 'casperaki' as const } },
      melody: notes([[0, 48], [2, 50], [4, 52], [6, 53], [8, 55], [10, 53], [12, 52], [14, 50]]),
      chords: Object.fromEntries(Array.from({ length: 16 }, (_, b) => [`${b}.0`, { chord: 'C' }])),
    };
    const rhythm = { ...melodic, id: 'r', melody: notes([[0, 0], [0.5, 0], [1, 0], [1.5, 0], [8, 0], [8.5, 0], [9, 0], [9.5, 0]]) };
    const draped = drapeOnRhythm(rhythm, melodic, 76);
    const midis = Object.keys(draped.melody).sort((a, b) => Number(a) - Number(b)).map((k) => draped.melody[k]![0]!.midi);
    expect(midis).toHaveLength(8);
    const up = midis.slice(0, 4);
    const down = midis.slice(4);
    expect(up).toEqual([...up].sort((a, b) => a - b));
    expect(down).toEqual([...down].sort((a, b) => b - a));
    expect(Math.max(...up) - Math.min(...up)).toBeGreaterThanOrEqual(4);
  });
});

describe('a note moved onto a chord tone', () => {
  it("stays within the melody's own range, so a narrow ceiling still places it", () => {
    // The melody's G (43) lands under F: F's tones nearest it are F (41) below the melody and A (45) inside it; the
    // narrow verse ceiling (55) has no octave for a 41 among these notes.
    const notes = (pairs: readonly (readonly [number, number])[]) => Object.fromEntries(pairs.map(([b, m]) => [Number.isInteger(b) ? `${b}.0` : String(b), [{ note: 'x', midi: m, duration: 1 }]]));
    const chords = Object.fromEntries(Array.from({ length: 16 }, (_, b) => [`${b}.0`, { chord: b < 9 ? 'C' : 'F' }]));
    const melodic = { id: 'm', properties: { start: 0, end: 4, useOriginal: false, useRemix: true, source: { kind: 'casperaki' as const } }, melody: notes([[0, 45], [4, 45], [8, 43], [10, 43], [12, 45]]), chords };
    const rhythm = { ...melodic, id: 'r', melody: notes([[0, 0], [4, 0], [9.5, 0], [10, 0], [12, 0]]) };
    const midis = Object.values(drapeOnRhythm(rhythm, melodic, 55).melody).map((v) => v[0]!.midi);
    expect(midis).toHaveLength(5);
    expect(Math.min(...midis)).toBeGreaterThanOrEqual(43);
  });
});
