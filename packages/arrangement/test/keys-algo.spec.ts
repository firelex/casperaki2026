// docs/58 — algorithmic keys generators (chordsMixed + arpeggio), faithful
// ports of ChordsPianoPatternGeneratorClass (style2='straight') and
// ArpeggioPianoPatternGeneratorClass. These styles are legacy `freestyle`-only
// (no canonical rebuild genre routes to them), so they are exercised directly
// here rather than through the per-genre generateKeysPattern dispatch.

import { describe, expect, it } from 'vitest';

import { createRng } from '@casperaki/music-theory';
import { stableStringify } from '@casperaki/song-schema';

import {
  generateKeysAlgoBlueprint,
  isKeysAlgoStyleName,
  KEYS_ALGO_STYLE_NAMES,
  type KeysAlgoBlueprint,
} from '../src/index.js';

function blueprint(style: 'chordsMixed' | 'arpeggio', seed: string): KeysAlgoBlueprint {
  return generateKeysAlgoBlueprint(createRng(seed).fork('patterns/keys'), style);
}

describe('keys algo style registry', () => {
  it('declares chordsMixed and arpeggio', () => {
    expect([...KEYS_ALGO_STYLE_NAMES]).toEqual(['chordsMixed', 'arpeggio']);
    expect(isKeysAlgoStyleName('chordsMixed')).toBe(true);
    expect(isKeysAlgoStyleName('arpeggio')).toBe(true);
    expect(isKeysAlgoStyleName('chordsStraight')).toBe(false);
  });
});

describe('chordsMixed generator', () => {
  it('emits a 2-bar blueprint of chord events at in-bar beats with positive durations', () => {
    let totalEvents = 0;
    for (let i = 0; i < 24; i++) {
      const bp = blueprint('chordsMixed', `cm-${i}`);
      expect(bp.bars.length).toBe(2);
      for (const bar of bp.bars) {
        for (const ev of bar) {
          expect(ev.kind).toBe('chord');
          expect(ev.beat).toBeGreaterThanOrEqual(0);
          expect(ev.beat).toBeLessThan(4);
          expect(ev.duration).toBeGreaterThan(0);
          totalEvents++;
        }
      }
    }
    expect(totalEvents).toBeGreaterThan(0);
  });

  it('durations come from the legacy length-category pools', () => {
    const allowed = new Set<number>([0.25, 0.5, 1, 2, 3]);
    for (let i = 0; i < 24; i++) {
      for (const bar of blueprint('chordsMixed', `cmd-${i}`).bars) {
        for (const ev of bar) {
          if (ev.kind !== 'chord') continue;
          expect(allowed.has(ev.duration)).toBe(true);
        }
      }
    }
  });

  it('is deterministic for a fixed seed and varies across seeds', () => {
    expect(stableStringify(blueprint('chordsMixed', 'fixed'), 0)).toBe(
      stableStringify(blueprint('chordsMixed', 'fixed'), 0),
    );
    const variants = new Set(
      Array.from({ length: 16 }, (_, i) =>
        stableStringify(blueprint('chordsMixed', `var-${i}`), 0),
      ),
    );
    expect(variants.size).toBeGreaterThan(1);
  });
});

describe('arpeggio generator', () => {
  it('emits a 2-bar blueprint of arpeggio events with legacy octave/direction/note bounds', () => {
    let totalEvents = 0;
    for (let i = 0; i < 24; i++) {
      const bp = blueprint('arpeggio', `arp-${i}`);
      expect(bp.bars.length).toBe(2);
      for (const bar of bp.bars) {
        for (const ev of bar) {
          expect(ev.kind).toBe('arpeggio');
          if (ev.kind !== 'arpeggio') continue;
          // leftHand → octave 3 / 'up'; rightHand → octave 5 / 'down'.
          expect([3, 5]).toContain(ev.octave);
          expect(['up', 'down']).toContain(ev.direction);
          expect([3, 4]).toContain(ev.numberOfNotes);
          expect(ev.note).toBeGreaterThanOrEqual(0);
          expect(ev.note).toBeLessThan(ev.numberOfNotes);
          expect(ev.beat).toBeGreaterThanOrEqual(0);
          expect(ev.beat).toBeLessThan(4);
          expect(ev.duration).toBeGreaterThan(0);
          totalEvents++;
        }
      }
    }
    expect(totalEvents).toBeGreaterThan(0);
  });

  it('octave 3 always walks up and octave 5 always walks down (per-hand binding)', () => {
    for (let i = 0; i < 24; i++) {
      for (const bar of blueprint('arpeggio', `arpdir-${i}`).bars) {
        for (const ev of bar) {
          if (ev.kind !== 'arpeggio') continue;
          if (ev.octave === 3) expect(ev.direction).toBe('up');
          if (ev.octave === 5) expect(ev.direction).toBe('down');
        }
      }
    }
  });

  it('is deterministic for a fixed seed and varies across seeds', () => {
    expect(stableStringify(blueprint('arpeggio', 'fixed'), 0)).toBe(
      stableStringify(blueprint('arpeggio', 'fixed'), 0),
    );
    const variants = new Set(
      Array.from({ length: 16 }, (_, i) =>
        stableStringify(blueprint('arpeggio', `av-${i}`), 0),
      ),
    );
    expect(variants.size).toBeGreaterThan(1);
  });
});
