// docs/54y — Lane B virtualGuitarist bank loader + selector tests.

import { describe, expect, it } from 'vitest';
import { createRng } from '@casperaki/music-theory';

import {
  _resetVirtualGuitaristBankCache,
  describeVirtualGuitaristBank,
  postProcessVirtualGuitaristPattern,
  selectVirtualGuitaristPattern,
} from '../src/patterns/virtual-guitarist-bank.js';

describe('describeVirtualGuitaristBank', () => {
  it('exposes bank totals + brightPop bpm ranges', () => {
    _resetVirtualGuitaristBankCache();
    const info = describeVirtualGuitaristBank();
    expect(info.mainTotal).toBe(702);
    expect(info.stefanTotal).toBeGreaterThan(0);
    expect(info.styleMapTotal).toBeGreaterThan(150);
    expect(info.brightPopBpmRanges.length).toBeGreaterThan(150);
    for (const r of info.brightPopBpmRanges) {
      expect(r.bpmMin).toBeGreaterThanOrEqual(0);
      expect(r.bpmMax).toBeGreaterThan(0);
      expect(r.bpmMin).toBeLessThanOrEqual(r.bpmMax);
    }
  });
});

describe('selectVirtualGuitaristPattern', () => {
  it('returns a non-empty pattern for brightPop @ 120bpm', () => {
    const rng = createRng('vg-bp-1');
    const sel = selectVirtualGuitaristPattern(rng, 'brightPop', 120);
    expect(['main', 'stefan']).toContain(sel.source);
    expect(sel.pattern.bars.length).toBeGreaterThanOrEqual(1);
  });

  it('determinism: same seed → identical pick (source + name)', () => {
    const a = selectVirtualGuitaristPattern(createRng('vg-det'), 'brightPop', 120);
    const b = selectVirtualGuitaristPattern(createRng('vg-det'), 'brightPop', 120);
    expect(a.source).toBe(b.source);
    expect(a.pattern.name).toBe(b.pattern.name);
  });

  it('different seeds produce different picks (within a few samples)', () => {
    const names = new Set<string>();
    for (const seed of ['s1', 's2', 's3', 's4', 's5', 's6']) {
      const sel = selectVirtualGuitaristPattern(createRng(seed), 'brightPop', 120);
      names.add(`${sel.source}/${sel.pattern.name}`);
    }
    expect(names.size).toBeGreaterThanOrEqual(2);
  });

  it('throws on a non-canonical genre', () => {
    expect(() =>
      selectVirtualGuitaristPattern(createRng('x'), 'not-a-genre' as never, 120),
    ).toThrowError(/unsupported genre/);
  });

  it('throws on invalid bpm', () => {
    expect(() => selectVirtualGuitaristPattern(createRng('x'), 'brightPop', 0)).toThrowError(
      /invalid bpm/,
    );
    expect(() => selectVirtualGuitaristPattern(createRng('x'), 'brightPop', Number.NaN)).toThrowError(
      /invalid bpm/,
    );
  });

  it('throws when no style-map entries match (e.g. brightPop @ 1000bpm)', () => {
    expect(() =>
      selectVirtualGuitaristPattern(createRng('x'), 'brightPop', 1000),
    ).toThrowError(/no virtualGuitarist style-map entries/);
  });
});

describe('postProcessVirtualGuitaristPattern (legacy port)', () => {
  // Synthetic test pattern exercising every branch.
  const PATTERN = {
    name: 'TEST',
    source: 'main' as const,
    bars: Object.freeze([
      {
        notes: Object.freeze({
          '0.0': Object.freeze([
            { type: 'virtualGuitarist', event: 'fx3' }, // dropped (not in allowed set)
            { type: 'virtualGuitarist', event: 'fx5' }, // dropped
            { type: 'virtualGuitarist', event: 'fx1' }, // kept (allowed)
            { type: 'virtualGuitarist', chord: 'C', event: 'chordShortStrumDown', duration: 0.25 },
            { type: 'strum', chord: 'C', strings: [0], offset: [0], durations: [0.5], velocities: [80] },
          ]) as readonly unknown[],
        }) as Record<string, readonly unknown[]>,
      },
    ]),
  };

  it('drops fx events not in [fx1, fx2, fx4, fx6]', () => {
    const result = postProcessVirtualGuitaristPattern(createRng('pp-1'), PATTERN);
    const events = result.bars[0]!.notes['0.0'] as Array<{ type?: string; event?: string }>;
    expect(events.some((e) => e.event === 'fx3')).toBe(false);
    expect(events.some((e) => e.event === 'fx5')).toBe(false);
  });

  it('keeps fx events in the allowed set', () => {
    const result = postProcessVirtualGuitaristPattern(createRng('pp-2'), PATTERN);
    const events = result.bars[0]!.notes['0.0'] as Array<{ type?: string; event?: string }>;
    expect(events.some((e) => e.event === 'fx1')).toBe(true);
  });

  it('substitutes dropped fx with random picks from [fx1, fx2, fx4]', () => {
    const result = postProcessVirtualGuitaristPattern(createRng('pp-3'), PATTERN);
    const events = result.bars[0]!.notes['0.0'] as Array<{ type?: string; event?: string }>;
    // 2 fx events were dropped (fx3, fx5). fx1 was already in the bar
    // → substitution pool starts as [fx2, fx4]. 2 picks consume both.
    const fxEvents = events.filter((e) => e.event && e.event.startsWith('fx'));
    expect(fxEvents.length).toBe(3); // fx1 (kept) + 2 substitutions
    const fxSet = new Set(fxEvents.map((e) => e.event));
    expect(fxSet.has('fx2')).toBe(true);
    expect(fxSet.has('fx4')).toBe(true);
  });

  it('clamps strum durations at min 1.0', () => {
    const result = postProcessVirtualGuitaristPattern(createRng('pp-4'), PATTERN);
    const events = result.bars[0]!.notes['0.0'] as Array<{ type?: string; durations?: number[] }>;
    const strum = events.find((e) => e.type === 'strum');
    expect(strum).toBeDefined();
    expect(strum!.durations![0]).toBe(1); // clamped from 0.5
  });

  it('keeps chord-strum events untouched', () => {
    const result = postProcessVirtualGuitaristPattern(createRng('pp-5'), PATTERN);
    const events = result.bars[0]!.notes['0.0'] as Array<{
      type?: string;
      event?: string;
      duration?: number;
    }>;
    const strum = events.find((e) => e.event === 'chordShortStrumDown');
    expect(strum).toBeDefined();
    expect(strum!.duration).toBe(0.25);
  });
});
