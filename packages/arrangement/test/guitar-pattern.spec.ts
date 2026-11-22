// Guitar pattern generator tests: the legacy Virtual Guitarist generator
// (every guitar plays the picked Virtual Guitarist pattern, all its bars).

import { describe, expect, it } from 'vitest';
import { createRng } from '@casperaki/music-theory';

import { generateGuitarPattern } from '../src/patterns/guitar.js';
import { postProcessVirtualGuitaristPattern, selectVirtualGuitaristPattern } from '../src/patterns/virtual-guitarist-bank.js';
import type { GeneratorContext } from '../src/context.js';
import type { Segment } from '@casperaki/song-schema';

/** Extract a bank pattern bar's fretNoise events keyed by beat string. */
function bankFretNoiseByBeat(
  bar: { notes?: Record<string, readonly unknown[]> } | undefined,
): Record<string, { sounds: number[]; offset: number[]; durations: number[]; velocities: number[] }> {
  const out: Record<string, { sounds: number[]; offset: number[]; durations: number[]; velocities: number[] }> = {};
  for (const [beatKey, evs] of Object.entries(bar?.notes ?? {})) {
    for (const raw of evs) {
      const ev = raw as { type?: unknown; sounds?: unknown[]; offset?: unknown[]; durations?: unknown[]; velocities?: unknown[] };
      if (ev?.type !== 'fretNoise') continue;
      out[beatKey] = {
        sounds: (ev.sounds as unknown[]).map(Number),
        offset: (ev.offset as unknown[]).map(Number),
        durations: (ev.durations as unknown[]).map(Number),
        velocities: (ev.velocities as unknown[]).map(Number),
      };
    }
  }
  return out;
}

function ctxFor(seed = 'guitar-pattern'): GeneratorContext {
  return {
    params: { genre: 'brightPop', key: 'C', bpm: 120, seed },
    rng: createRng(seed),
  };
}

function fakeSegment(name: string, barCount: number, chords: string[][] = []): Segment {
  return {
    name,
    bars: Array.from({ length: barCount }, (_, i) => ({
      chords: (chords[i] ?? ['C', 'C', 'C', 'C']) as [string, string, string, string],
    })),
  } as Segment;
}

describe('generateGuitarPattern', () => {
  it('plays the legacy Virtual Guitarist pattern: every bar, as processed, repeated across the section', () => {
    const ctx = ctxFor('vg-legacy');
    const seg = fakeSegment('verse1', 8, [['C', 'C', 'G', 'G'], ['Am', 'Am', 'F', 'F']]);
    const out = generateGuitarPattern(ctx, seg, ['guitar'])!;
    const rng = createRng('vg-legacy').fork('patterns/guitar/virtualGuitarist');
    const expected = postProcessVirtualGuitaristPattern(rng, selectVirtualGuitaristPattern(rng, 'brightPop', 120).pattern);
    out.bars.forEach((bar, i) => {
      const src = expected.bars[i % expected.bars.length]!;
      const strip = (notes: Record<string, readonly unknown[]>) =>
        Object.fromEntries(Object.entries(notes).map(([k, evs]) => [Number(k), (evs as Record<string, unknown>[]).map(({ chord: _c, ...rest }) => rest)]));
      expect(strip(bar.notes as never)).toEqual(strip(src.notes as never));
      for (const evs of Object.values(bar.notes)) for (const ev of evs as { type: string }[]) expect(['strum', 'virtualGuitarist']).toContain(ev.type);
    });
  });

  it('returns undefined when guitar is NOT in the activity list', () => {
    const ctx = ctxFor();
    const seg = fakeSegment('verse1', 4);
    expect(generateGuitarPattern(ctx, seg, ['drums', 'bass', 'keys'])).toBeUndefined();
  });

  it('returns a bars-shaped FamilyPattern when guitar IS active', () => {
    const ctx = ctxFor();
    const seg = fakeSegment('chorus1', 8);
    const pattern = generateGuitarPattern(ctx, seg, ['drums', 'bass', 'keys', 'pad', 'guitar']);
    expect(pattern).toBeDefined();
    expect(pattern!.bars.length).toBe(8);
  });

  it('carries the per-bar chord symbol from the segment', () => {
    const ctx = ctxFor();
    // Different chord per bar — verify each bar's events match the
    // first chord of that bar (beat 0.0 uses chord[0], beat 2.0 uses
    // chord[2]).
    const seg = fakeSegment('chorus1', 2, [
      ['C', 'C', 'F', 'F'],
      ['G', 'G', 'Am', 'Am'],
    ]);
    const pattern = generateGuitarPattern(ctx, seg, ['guitar'])!;
    const bar0 = pattern.bars[0]!;
    expect((bar0.notes['0.0']![0] as { chord: string }).chord).toBe('C');
    expect((bar0.notes['2.0']![0] as { chord: string }).chord).toBe('F');
    const bar1 = pattern.bars[1]!;
    expect((bar1.notes['0.0']![0] as { chord: string }).chord).toBe('G');
    expect((bar1.notes['2.0']![0] as { chord: string }).chord).toBe('Am');
  });

  it('is deterministic: same input → identical pattern', () => {
    const a = generateGuitarPattern(ctxFor(), fakeSegment('chorus1', 4), ['guitar']);
    const b = generateGuitarPattern(ctxFor(), fakeSegment('chorus1', 4), ['guitar']);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  // docs/54y — virtualGuitarist multi-event-per-bar emission from the
  // legacy virtualGuitaristPatterns.json bank (replaces 54v's single
  // chordShortStrumDown at beat 2.0). Each picked pattern carries a
  // mix of chord-strum types + fx1..fx7 events.
  it('virtualGuitarist chord-strum events carry the bar chord at their beat', () => {
    const ctx = ctxFor();
    const seg = fakeSegment('chorus1', 1, [['C', 'F', 'G', 'Am']]);
    const pattern = generateGuitarPattern(ctx, seg, ['guitar'])!;
    const bar0 = pattern.bars[0]!;
    for (const [beatKey, events] of Object.entries(bar0.notes)) {
      const beat = Number.parseFloat(beatKey);
      const chordIdx = Math.floor(beat);
      const expected = ['C', 'F', 'G', 'Am'][chordIdx];
      for (const ev of events) {
        if (ev.type !== 'virtualGuitarist') continue;
        const event = (ev as { event?: string }).event;
        if (!event || !event.startsWith('chord')) continue; // fx events ignore chord
        expect(
          (ev as { chord: string }).chord,
          `bar 0 chord-strum at beat ${beatKey} should carry chord ${expected}`,
        ).toBe(expected);
      }
    }
  });

  it('emits at least one type:"strum" event per bar (docs/54x)', () => {
    const ctx = ctxFor();
    const seg = fakeSegment('chorus1', 8);
    const pattern = generateGuitarPattern(ctx, seg, ['guitar'])!;
    let totalStrums = 0;
    for (const bar of pattern.bars) {
      let perBar = 0;
      for (const events of Object.values(bar.notes)) {
        for (const ev of events) {
          if (ev.type === 'strum') perBar++;
        }
      }
      expect(perBar, 'bar missing per-string strum events').toBeGreaterThan(0);
      totalStrums += perBar;
    }
    expect(totalStrums).toBeGreaterThan(0);
  });

  it('strum events carry parallel strings/offset/durations/velocities arrays', () => {
    const ctx = ctxFor();
    const seg = fakeSegment('chorus1', 4);
    const pattern = generateGuitarPattern(ctx, seg, ['guitar'])!;
    let inspected = 0;
    for (const bar of pattern.bars) {
      for (const events of Object.values(bar.notes)) {
        for (const ev of events) {
          if (ev.type !== 'strum') continue;
          const strum = ev as {
            chord: string;
            strings: number[];
            offset: number[];
            durations: number[];
            velocities: number[];
          };
          expect(strum.strings.length).toBeGreaterThan(0);
          expect(strum.offset.length).toBe(strum.strings.length);
          expect(strum.durations.length).toBe(strum.strings.length);
          expect(strum.velocities.length).toBe(strum.strings.length);
          expect(typeof strum.chord).toBe('string');
          inspected++;
        }
      }
    }
    expect(inspected).toBeGreaterThan(0);
  });

  it('strum chord is rewritten to the bar chord at the event beat position', () => {
    const ctx = ctxFor();
    const seg = fakeSegment('chorus1', 1, [['C', 'F', 'G', 'Am']]);
    const pattern = generateGuitarPattern(ctx, seg, ['guitar'])!;
    const bar0 = pattern.bars[0]!;
    for (const [beatKey, events] of Object.entries(bar0.notes)) {
      const beat = Number.parseFloat(beatKey);
      const chordIdx = Math.floor(beat);
      const expected = ['C', 'F', 'G', 'Am'][chordIdx];
      for (const ev of events) {
        if (ev.type !== 'strum') continue;
        expect(
          (ev as { chord: string }).chord,
          `bar 0 strum at beat ${beatKey} should carry chord ${expected}`,
        ).toBe(expected);
      }
    }
  });

  it('bank pick is deterministic across runs with same seed', () => {
    const a = generateGuitarPattern(ctxFor('bank-determinism'), fakeSegment('chorus1', 1), ['guitar']);
    const b = generateGuitarPattern(ctxFor('bank-determinism'), fakeSegment('chorus1', 1), ['guitar']);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('bank pick differs across seeds (typically — large enough bank)', () => {
    // The Pop-filtered bank has 33 candidates. Two different seeds
    // produce different picks with high probability; we sample 4
    // seeds and expect at least 2 distinct strum-event signatures.
    const sigs = new Set<string>();
    for (const seed of ['s-1', 's-2', 's-3', 's-4']) {
      const p = generateGuitarPattern(ctxFor(seed), fakeSegment('chorus1', 1), ['guitar'])!;
      const strums: unknown[] = [];
      for (const events of Object.values(p.bars[0]!.notes)) {
        for (const ev of events) {
          if (ev.type === 'strum') strums.push(ev);
        }
      }
      sigs.add(JSON.stringify(strums));
    }
    expect(sigs.size).toBeGreaterThanOrEqual(2);
  });
});
