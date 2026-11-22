import { describe, expect, it } from 'vitest';

import { loadValidatedCatalog, orchestrate, setTransition, transitionSoundChoices } from '../src/index.js';

describe('setTransition', () => {
  const song = orchestrate({ genre: 'brightPop', key: 'C', bpm: 120, seed: 'set-transition' });
  const choruses = song.songStructure.filter((s) => s.name.startsWith('chorus')).map((s) => s.name);
  it('adds a transition to several sections and removes it again', () => {
    const on = setTransition(song, { segments: choruses, type: 'fxUplifter', placement: 'endOfSegment', on: true });
    for (const c of choruses) {
      const e = on.arrangement[c]!.transitions!['fxUplifter'] as unknown as { type: string; placement: string; soundId: string };
      expect(e.type).toBe('fxUplifter');
      expect(e.placement).toBe('endOfSegment');
      expect(e.soundId).toMatch(/^[0-9a-f]{16}$/u);
    }
    const off = setTransition(on, { segments: choruses, type: 'fxUplifter', placement: 'endOfSegment', on: false });
    for (const c of choruses) expect(off.arrangement[c]!.transitions!['fxUplifter']).toBeUndefined();
  });
  it('writes a snare roll grid and refuses unknown types or placements', () => {
    const roll = setTransition(song, { segments: ['verse1'], type: 'edmSnareDrumRoll', placement: 'endOfSegment', on: true });
    const e = roll.arrangement['verse1']!.transitions!['edmSnareDrumRoll'] as unknown as { pattern: Record<string, string>; lengthInBars: number };
    expect(e.lengthInBars).toBeGreaterThan(0);
    expect(Object.keys(e.pattern).length).toBeGreaterThan(0);
    expect(() => setTransition(song, { segments: ['verse1'], type: 'fxBoom', placement: 'endOfSegment', on: true })).toThrow(/Unknown transition/);
    expect(() => setTransition(song, { segments: ['verse1'], type: 'cymbalsCrashHit', placement: 'endOfSegment', on: true })).toThrow(/cannot sit/);
  });

  it('changes the sound of a transition already there, and keeps it when only the placement changes', () => {
    const catalog = loadValidatedCatalog();
    const [first, second] = transitionSoundChoices(catalog, 'fxReverse');
    const on = setTransition(song, { segments: ['verse1', 'verse2'], type: 'fxReverse', placement: 'endOfSegment', on: true, soundId: first!.id });
    const swapped = setTransition(on, { segments: ['verse2'], type: 'fxReverse', placement: 'endOfSegment', on: true, soundId: second!.id });
    const sound = (s: typeof song, sec: string) => (s.arrangement[sec]!.transitions!['fxReverse'] as unknown as { soundId: string }).soundId;
    expect(sound(swapped, 'verse1')).toBe(first!.id);
    expect(sound(swapped, 'verse2')).toBe(second!.id);
    const moved = setTransition(swapped, { segments: ['verse2'], type: 'fxReverse', placement: 'beginningOfSegment', on: true });
    expect(sound(moved, 'verse2')).toBe(second!.id);
    expect(() => setTransition(song, { segments: ['verse1'], type: 'fxReverse', placement: 'endOfSegment', on: true, soundId: catalog.entries.find((e) => e.lowLevel === 'fxUplifter')!.id })).toThrow(/not a reverse sound/);
    expect(() => setTransition(song, { segments: ['verse1'], type: 'fxNoiseRise', placement: 'endOfSegment', on: true, soundId: first!.id })).toThrow(/no sound to choose/);
  });
});
