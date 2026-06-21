// docs/54s — Guitar pattern generator tests.
//
// The 54s slice emits a deterministic two-hit-per-bar chord comp on
// every guitar-active segment. The pattern is intentionally minimal
// — chord events at beats 0.0 and 2.0 with duration=2 — to ride the
// proven chord-events-through-per-note-multisample path (54l + 54m).
// Tests assert: structural shape, chord-symbol carry-through, bar
// count alignment, activity gate.

import { describe, expect, it } from 'vitest';
import { createRng } from '@casperaki/music-theory';

import { generateGuitarPattern } from '../src/patterns/guitar.js';
import { selectGuitarPattern } from '../src/patterns/guitar-bank.js';
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

  it('emits chord events at beats 0.0 and 2.0 with duration=2', () => {
    const ctx = ctxFor();
    const seg = fakeSegment('chorus1', 4);
    const pattern = generateGuitarPattern(ctx, seg, ['guitar'])!;
    for (const bar of pattern.bars) {
      for (const beatKey of ['0.0', '2.0']) {
        const events = bar.notes[beatKey]!;
        // docs/54v adds a co-triggered virtualGuitarist event at
        // beat 2.0; the chord-comp event still lives in the array.
        const chordEv = events.find((e) => e.type === 'chord') as
          | { type: 'chord'; chord: string; duration: number }
          | undefined;
        expect(chordEv, `bar missing chord event at ${beatKey}`).toBeDefined();
        expect(chordEv!.duration).toBe(2);
        expect(typeof chordEv!.chord).toBe('string');
      }
    }
  });

  // docs/62 A9 — fret-noise events come from the selected bank pattern's own
  // author-placed `fretNoise` rows (multi-slice `sounds` + per-event arrays),
  // wrapped across the segment, NOT a synthesized one-per-bar placeholder.
  it("emits the selected bank pattern's fretNoise events verbatim, wrapped per bar (docs/62 A9)", () => {
    let exercised = false;
    for (let i = 0; i < 24 && !exercised; i++) {
      const ctx = ctxFor(`a9-fretnoise-${i}`);
      // Mirror the generator's internal pick (fork is name-keyed, so this does
      // not perturb the generator's own fork('patterns/guitar')).
      const sel = selectGuitarPattern(ctx.rng.fork('patterns/guitar'), ctx.params.genre);
      const patternBars = sel.pattern.bars.length;
      const expectedByBar = sel.pattern.bars.map((b) => bankFretNoiseByBeat(b));
      if (!expectedByBar.some((m) => Object.keys(m).length > 0)) continue;
      exercised = true;

      const seg = fakeSegment('chorus1', patternBars * 2 + 1); // exercise the wrap
      const pattern = generateGuitarPattern(ctx, seg, ['guitar'])!;
      for (let segBarIdx = 0; segBarIdx < pattern.bars.length; segBarIdx++) {
        const expected = expectedByBar[segBarIdx % patternBars]!;
        const emittedBeats = Object.entries(pattern.bars[segBarIdx]!.notes)
          .filter(([, evs]) => evs.some((e) => e.type === 'fretNoise'))
          .map(([k]) => k);
        expect(emittedBeats.sort()).toEqual(Object.keys(expected).sort());
        for (const [beatKey, exp] of Object.entries(expected)) {
          const fn = pattern.bars[segBarIdx]!.notes[beatKey]!.find((e) => e.type === 'fretNoise') as {
            sounds: number[];
            offset: number[];
            durations: number[];
            velocities: number[];
          };
          expect(fn.sounds).toEqual(exp.sounds);
          expect(fn.offset).toEqual(exp.offset);
          expect(fn.durations).toEqual(exp.durations);
          expect(fn.velocities).toEqual(exp.velocities);
        }
      }
    }
    expect(exercised, 'no brightPop seed selected a pattern carrying fretNoise events').toBe(true);
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
  it('emits at least one virtualGuitarist event per bar (docs/54y)', () => {
    const ctx = ctxFor();
    const seg = fakeSegment('chorus1', 8);
    const pattern = generateGuitarPattern(ctx, seg, ['guitar'])!;
    for (const bar of pattern.bars) {
      let vgCount = 0;
      for (const events of Object.values(bar.notes)) {
        for (const ev of events) if (ev.type === 'virtualGuitarist') vgCount++;
      }
      expect(vgCount, 'bar missing virtualGuitarist events').toBeGreaterThan(0);
    }
  });

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

  it('co-triggers with the chord-comp event when bank places an event at beat 2.0', () => {
    const ctx = ctxFor();
    const seg = fakeSegment('chorus1', 4);
    const pattern = generateGuitarPattern(ctx, seg, ['guitar'])!;
    for (const bar of pattern.bars) {
      const beat2 = bar.notes['2.0'] ?? [];
      const hasChord = beat2.some((e) => e.type === 'chord');
      // Chord-comp must still fire at beat 2.0 per 54s.
      expect(hasChord).toBe(true);
    }
  });

  // docs/54x — Lane A per-string strum events from guitarPatterns.json.
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
