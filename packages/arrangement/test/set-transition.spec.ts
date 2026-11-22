import { describe, expect, it } from 'vitest';

import { orchestrate, setTransition } from '../src/index.js';

describe('setTransition', () => {
  const song = orchestrate({ genre: 'brightPop', key: 'C', bpm: 120, seed: 'set-transition' });
  const choruses = song.songStructure.filter((s) => s.name.startsWith('chorus')).map((s) => s.name);
  it('adds a transition to several sections and removes it again', () => {
    const on = setTransition(song, { segments: choruses, type: 'fxUplifter', placement: 'endOfSegment', on: true });
    for (const c of choruses) expect(on.arrangement[c]!.transitions!['fxUplifter']).toEqual({ type: 'fxUplifter', placement: 'endOfSegment' });
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
});
