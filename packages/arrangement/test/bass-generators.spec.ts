// to-do #2 — real bass generator ports. Phase 1: SimpleBass (ballad).
//
// Pins the faithful port of SimpleBassPatternGeneratorClass.js:
//   - busyness filters the 20-pattern pool by hit count (1 -> <=8,
//     2 -> 4..10, 3 -> >=6);
//   - notes are the chord root at octave 2 (MIDI 36..47 for any key),
//     i.e. semitone offset 0;
//   - ballad routes through SimpleBass end-to-end (busyness forced to 1).

import { describe, expect, it } from 'vitest';

import { createRng } from '@casperaki/music-theory';

import { orchestrate } from '../src/orchestrate/index.js';
import {
  selectCenteredBankPattern,
  selectEdmSimpleBassPattern,
  selectHipHopBassPattern,
  selectSimpleBassPattern,
  _resetRealBassBankCache,
} from '../src/patterns/bass-generators.js';
import type { FamilyPattern } from '../src/patterns/types.js';

/** Build a 2-bar drum FamilyPattern with bassDrum1 (MIDI 36) hits at the given
 *  beats per bar. */
function drumWithKicks(barBeats: number[][]): FamilyPattern {
  return {
    bars: barBeats.map((beats) => ({
      notes: Object.fromEntries(beats.map((b) => [String(b), [{ type: 'note' as const, note: 36 }]])),
    })),
  } as FamilyPattern;
}

describe('SimpleBass pattern selection', () => {
  it('busyness=1 picks patterns with <= 8 hits', () => {
    for (let s = 0; s < 60; s++) {
      const sel = selectSimpleBassPattern(createRng('a' + s), 1);
      expect(sel.pattern.length).toBeLessThanOrEqual(8);
    }
  });

  it('busyness=2 picks patterns with 4..10 hits', () => {
    for (let s = 0; s < 60; s++) {
      const sel = selectSimpleBassPattern(createRng('b' + s), 2);
      expect(sel.pattern.length).toBeGreaterThanOrEqual(4);
      expect(sel.pattern.length).toBeLessThanOrEqual(10);
    }
  });

  it('busyness=3 picks patterns with >= 6 hits', () => {
    for (let s = 0; s < 60; s++) {
      const sel = selectSimpleBassPattern(createRng('c' + s), 3);
      expect(sel.pattern.length).toBeGreaterThanOrEqual(6);
    }
  });

  it('emits root-only patterns at octave 2 (semitone offset 0, rootMidiOctave 2)', () => {
    const sel = selectSimpleBassPattern(createRng('d'), 2);
    expect(sel.rootMidiOctave).toBe(2);
    for (const [position, duration, offset] of sel.pattern) {
      expect(offset).toBe(0);
      expect(position).toBeGreaterThanOrEqual(0);
      expect(duration).toBeGreaterThan(0);
    }
  });

  it('is deterministic for a fixed rng seed', () => {
    const a = selectSimpleBassPattern(createRng('det'), 2);
    const b = selectSimpleBassPattern(createRng('det'), 2);
    expect(a.patternIndex).toBe(b.patternIndex);
  });
});

describe('edmSimple pattern selection', () => {
  it('is chord-relative with rootMidiOctave -1 and octave-encoded offsets', () => {
    _resetRealBassBankCache();
    for (let s = 0; s < 30; s++) {
      const sel = selectEdmSimpleBassPattern(createRng('e' + s));
      expect(sel.mode).toBe('chordRelative');
      if (sel.mode !== 'chordRelative') continue;
      expect(sel.rootMidiOctave).toBe(-1);
      for (const [, , offset] of sel.pattern) {
        // offset = (octave + 1) * 12 — always a positive multiple of 12.
        expect(offset % 12).toBe(0);
        expect(offset).toBeGreaterThan(0);
      }
    }
  });

  it('is deterministic for a fixed rng seed', () => {
    _resetRealBassBankCache();
    const a = selectEdmSimpleBassPattern(createRng('det'));
    const b = selectEdmSimpleBassPattern(createRng('det'));
    expect(a.patternIndex).toBe(b.patternIndex);
  });
});

describe('centered-MIDI-bank pattern selection (edmComplex / Library)', () => {
  it('emits absolute octave-centred MIDI events in the bass register', () => {
    _resetRealBassBankCache();
    for (const style of ['edmComplex', 'brightPop', 'organicVibes', 'latin', 'rock']) {
      for (let s = 0; s < 20; s++) {
        const sel = selectCenteredBankPattern(createRng(style + s), style, 'major');
        expect(sel.mode).toBe('absolute');
        if (sel.mode !== 'absolute') continue;
        expect(sel.events.length).toBeGreaterThan(0);
        for (const ev of sel.events) {
          expect(Number.isInteger(ev.midi)).toBe(true);
          expect(ev.midi).toBeGreaterThanOrEqual(0);
          expect(ev.midi).toBeLessThanOrEqual(60);
          expect(ev.duration).toBeGreaterThan(0);
          expect(ev.bar).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it('major vs minor select different note banks', () => {
    _resetRealBassBankCache();
    // Find a pattern index whose major/minor banks differ (most do).
    let sawDifference = false;
    for (let s = 0; s < 30 && !sawDifference; s++) {
      const major = selectCenteredBankPattern(createRng('x' + s), 'edmComplex', 'major');
      const minor = selectCenteredBankPattern(createRng('x' + s), 'edmComplex', 'minor');
      if (major.mode !== 'absolute' || minor.mode !== 'absolute') continue;
      // Same rng -> same patternIndex; scale picks a different note bank.
      expect(major.patternIndex).toBe(minor.patternIndex);
      if (JSON.stringify(major.events) !== JSON.stringify(minor.events)) sawDifference = true;
    }
    expect(sawDifference).toBe(true);
  });

  it('is deterministic for a fixed rng seed', () => {
    _resetRealBassBankCache();
    const a = selectCenteredBankPattern(createRng('det'), 'brightPop', 'major');
    const b = selectCenteredBankPattern(createRng('det'), 'brightPop', 'major');
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('HipHopBass (urban) — derived from drum kicks', () => {
  // Kicks on beats 0 and 2 of each bar → slots {0,16,32,48}.
  const drums = drumWithKicks([
    [0, 2],
    [0, 2],
  ]);

  it('only places notes on kick slots, chord-relative at octave 2', () => {
    for (let s = 0; s < 40; s++) {
      const sel = selectHipHopBassPattern(createRng('h' + s), drums, 3);
      if (sel === null) continue;
      expect(sel.mode).toBe('chordRelative');
      if (sel.mode !== 'chordRelative') continue;
      expect(sel.rootMidiOctave).toBe(2);
      for (const [position, duration, offset] of sel.pattern) {
        expect(offset).toBe(0);
        expect(duration).toBeGreaterThan(0);
        // positions are kick slots / 8 → {0, 2, 4, 6}.
        expect([0, 2, 4, 6]).toContain(position);
      }
    }
  });

  it('returns null when the drum pattern has no kicks', () => {
    const noKicks = drumWithKicks([[], []]);
    expect(selectHipHopBassPattern(createRng('n'), noKicks, 2)).toBeNull();
  });

  it('higher busyness yields more notes on average', () => {
    const avg = (busyness: 1 | 2 | 3): number => {
      let total = 0;
      const runs = 200;
      for (let s = 0; s < runs; s++) {
        const sel = selectHipHopBassPattern(createRng('b' + busyness + s), drums, busyness);
        total += sel && sel.mode === 'chordRelative' ? sel.pattern.length : 0;
      }
      return total / runs;
    };
    expect(avg(3)).toBeGreaterThan(avg(1));
  });

  it('is deterministic for a fixed rng seed', () => {
    const a = selectHipHopBassPattern(createRng('det'), drums, 2);
    const b = selectHipHopBassPattern(createRng('det'), drums, 2);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('urban bass derives from drums end-to-end (octave-2 roots)', () => {
    let sawBass = false;
    for (let seed = 0; seed < 12; seed++) {
      const song = orchestrate({ genre: 'urban', key: 'C', bpm: 95, seed });
      for (const seg of Object.values(song.arrangement)) {
        const bass = (seg as { overrides?: Record<string, { bars: { notes: Record<string, { note?: number }[]> }[] }> })
          .overrides?.Bass;
        if (!bass) continue;
        for (const bar of bass.bars) {
          for (const evs of Object.values(bar.notes)) {
            for (const e of evs) {
              if (typeof e.note === 'number') {
                sawBass = true;
                expect(e.note).toBeGreaterThanOrEqual(36);
                expect(e.note).toBeLessThanOrEqual(47);
              }
            }
          }
        }
      }
    }
    expect(sawBass).toBe(true);
  });
});

describe('ballad bass routes through SimpleBass end-to-end', () => {
  it('every ballad bass note is a chord root at octave 2 (MIDI 36..47)', () => {
    let sawBass = false;
    for (let seed = 0; seed < 12; seed++) {
      const song = orchestrate({ genre: 'ballad', key: 'C', bpm: 90, seed });
      for (const seg of Object.values(song.arrangement)) {
        const bass = (seg as { overrides?: Record<string, { bars: { notes: Record<string, { note?: number }[]> }[] }> })
          .overrides?.Bass;
        if (!bass) continue;
        for (const bar of bass.bars) {
          for (const evs of Object.values(bar.notes)) {
            for (const e of evs) {
              if (typeof e.note === 'number') {
                sawBass = true;
                expect(e.note).toBeGreaterThanOrEqual(36);
                expect(e.note).toBeLessThanOrEqual(47);
              }
            }
          }
        }
      }
    }
    expect(sawBass).toBe(true);
  });
});
