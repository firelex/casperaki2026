// docs/54x — Lane A guitar bank loader + selector tests.

import { describe, expect, it } from 'vitest';
import { createRng } from '@casperaki/music-theory';

import {
  _resetGuitarBankCache,
  describeGuitarBank,
  selectGuitarPattern,
} from '../src/patterns/guitar-bank.js';

describe('describeGuitarBank', () => {
  it('exposes the total pattern count + per-genre filtered counts', () => {
    _resetGuitarBankCache();
    const info = describeGuitarBank();
    expect(info.bankFile).toBe('guitarPatterns.json');
    expect(info.totalPatterns).toBeGreaterThan(100);
    // brightPop = [country, pop, rock] (docs/62 A4): union of Country+Folk (118),
    // Pop (33) and Rock (116) candidate sets = 267.
    expect(info.genreCandidateCounts.brightPop).toBe(267);
    expect(info.genreCandidateCounts.rock).toBeGreaterThan(0);
  });
});

describe('selectGuitarPattern', () => {
  it('brightPop picks one of its three legacy styles (country/pop/rock)', () => {
    // docs/62 A4: legacy popTight→brightPop maps to [country, pop, rock].
    const styles = new Set<string>();
    for (const seed of Array.from({ length: 24 }, (_, i) => `bp-${i}`)) {
      const sel = selectGuitarPattern(createRng(seed), 'brightPop');
      expect(['country', 'pop', 'rock']).toContain(sel.style);
      if (sel.style === 'country') expect(sel.markers).toEqual(['Country', 'Folk']);
      else if (sel.style === 'pop') expect(sel.markers).toEqual(['Pop']);
      else expect(sel.markers).toEqual(['Rock']);
      expect(sel.candidateCount).toBeGreaterThan(0);
      expect(sel.pattern.bars.length).toBeGreaterThanOrEqual(1);
      styles.add(sel.style);
    }
    expect(styles.size).toBeGreaterThan(1);
  });

  it('is deterministic: same rng seed → identical pattern name', () => {
    const a = selectGuitarPattern(createRng('det-seed'), 'brightPop');
    const b = selectGuitarPattern(createRng('det-seed'), 'brightPop');
    expect(a.pattern.name).toBe(b.pattern.name);
  });

  it('different seeds produce different picks across enough samples', () => {
    const names = new Set<string>();
    for (const seed of ['s1', 's2', 's3', 's4', 's5', 's6']) {
      names.add(selectGuitarPattern(createRng(seed), 'brightPop').pattern.name);
    }
    expect(names.size).toBeGreaterThanOrEqual(2);
  });

  it('throws on a non-canonical genre', () => {
    expect(() => selectGuitarPattern(createRng('x'), 'not-a-genre' as never)).toThrowError(
      /unsupported genre/,
    );
  });

  it('rock filters by the Rock substring (per legacy contract)', () => {
    const rng = createRng('lane-a-rk-1');
    const sel = selectGuitarPattern(rng, 'rock');
    expect(sel.style).toBe('rock');
    expect(sel.markers).toEqual(['Rock']);
    expect(sel.pattern.name).toMatch(/Rock/);
  });

  it('latin resolves to the legacy Pop marker (Latin bank commented out upstream)', () => {
    const sel = selectGuitarPattern(createRng('lane-a-lt-1'), 'latin');
    expect(sel.style).toBe('latin');
    expect(sel.markers).toEqual(['Pop']);
    expect(sel.pattern.name).toMatch(/Pop/);
  });

  it('urban picks one of jazz/funk/playful and resolves to the legacy markers', () => {
    // jazz→Jazz, funk→Jazz, playful→Pop (per the legacy switch).
    const styles = new Set<string>();
    for (const seed of Array.from({ length: 24 }, (_, i) => `urban-${i}`)) {
      const sel = selectGuitarPattern(createRng(seed), 'urban');
      expect(['jazz', 'funk', 'playful']).toContain(sel.style);
      if (sel.style === 'playful') expect(sel.markers).toEqual(['Pop']);
      else expect(sel.markers).toEqual(['Jazz']);
      styles.add(sel.style);
    }
    // The multi-style pick should surface more than one style across seeds.
    expect(styles.size).toBeGreaterThan(1);
  });

  it('ballad picks one of its four legacy styles', () => {
    const styles = new Set<string>();
    for (const seed of Array.from({ length: 32 }, (_, i) => `ballad-${i}`)) {
      const sel = selectGuitarPattern(createRng(seed), 'ballad');
      expect(['arpeggio', 'country', 'latin', 'pop']).toContain(sel.style);
      styles.add(sel.style);
    }
    expect(styles.size).toBeGreaterThan(1);
  });

  it('arpeggio style filters by the ARP substring; country by Country/Folk', () => {
    const info = describeGuitarBank();
    expect(info.styleCandidateCounts.arpeggio).toBe(40);
    expect(info.styleCandidateCounts.country).toBe(118); // Country∪Folk
    expect(info.styleCandidateCounts.jazz).toBe(50);
    expect(info.styleCandidateCounts.pop).toBe(33);
    expect(info.styleCandidateCounts.rock).toBe(116);
  });
});
