import { describe, expect, it } from 'vitest';

import { buildSequencerModel, noteToMidi } from '../src/editor/sequencerModel';
import { makeFixtureSong } from './fixture';

describe('sequencer model', () => {
  it('lays sections end to end and places clips at their section', () => {
    const { song } = makeFixtureSong();
    const m = buildSequencerModel(song);
    let bar = 0;
    for (const s of m.sections) {
      expect(s.startBar).toBe(bar);
      bar += s.bars;
    }
    expect(m.totalBars).toBe(bar);
    for (const t of m.tracks) {
      for (const c of t.clips) {
        const sec = m.sections[c.section]!;
        expect(c.startBar).toBe(sec.startBar);
        for (const n of c.notes) {
          expect(n.start).toBeGreaterThanOrEqual(sec.startBar * 4);
          expect(n.start).toBeLessThan((sec.startBar + sec.bars) * 4);
        }
      }
    }
  });

  it('reads note names and MIDI numbers', () => {
    expect(noteToMidi(60)).toBe(60);
    expect(noteToMidi('C4')).toBe(60);
    expect(noteToMidi('A#2')).toBe(46);
    expect(noteToMidi('Bb2')).toBe(46);
    expect(noteToMidi('nope')).toBeNull();
  });
});
