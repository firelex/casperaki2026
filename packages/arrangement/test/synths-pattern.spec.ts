// docs/54z — Synths (leadSynths / EDMArpeggiator) pattern generator tests.

import { describe, expect, it } from 'vitest';
import { createRng } from '@casperaki/music-theory';

import { generateSynthsPattern } from '../src/patterns/synths.js';
import type { GeneratorContext } from '../src/context.js';
import type { Segment } from '@casperaki/song-schema';

function ctxFor(seed = 'synths-pattern'): GeneratorContext {
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

const ARP_TYPES = new Set([
  'up',
  'down',
  'upAndDown',
  'downAndUp',
  'insideOut',
  'outsideIn',
]);
const ARP_RHYTHMS = new Set([
  'eighthNotes',
  'sixteenthNotes',
  'eighthNotes332',
]);

describe('generateSynthsPattern', () => {
  it('returns undefined when synths is NOT in the activity list', () => {
    const ctx = ctxFor();
    const seg = fakeSegment('chorus1', 4);
    expect(generateSynthsPattern(ctx, seg, ['drums', 'bass', 'keys'])).toBeUndefined();
  });

  function isArpeggiatorPattern(pattern: { bars: { notes: Record<string, { type: string }[]> }[] }): boolean {
    return pattern.bars.some((b) =>
      Object.values(b.notes).some((evs) => evs.some((e) => e.type === 'EDMArpeggiator')),
    );
  }

  it('returns a bars-shaped FamilyPattern when synths IS active', () => {
    const ctx = ctxFor();
    const seg = fakeSegment('chorus1', 8);
    const pattern = generateSynthsPattern(ctx, seg, ['synths']);
    expect(pattern).toBeDefined();
    // docs/62 A8 — the EDMArpeggiator route emits a FIXED 2-bar legacy block
    // (one seed event in bar 0, bar 1 empty); the piano-bank routes emit one
    // bar per segment bar. So the bar count is style-dependent.
    expect(pattern!.bars.length).toBe(isArpeggiatorPattern(pattern!) ? 2 : 8);
  });

  it('emits synth events (per-bar for piano routes; a single 2-bar seed for EDMArpeggiator)', () => {
    // docs/55a — the style pick determines whether the lane carries
    // EDMArpeggiator events (54z route) or noteRelative events (piano-bank
    // route for EDMSynthsPlucked / EDMSynthsStabs). docs/62 A8 — the
    // EDMArpeggiator route is now a single seed in a 2-bar block (bar 1 empty,
    // the engine self-unfolds across both); piano routes emit every bar.
    const ctx = ctxFor();
    const seg = fakeSegment('chorus1', 4);
    const pattern = generateSynthsPattern(ctx, seg, ['synths'])!;
    if (isArpeggiatorPattern(pattern)) {
      expect(pattern.bars.length).toBe(2);
      const bar0 = Object.values(pattern.bars[0]!.notes).flat().filter((e) => e.type === 'EDMArpeggiator');
      expect(bar0.length).toBe(1);
      expect(Object.values(pattern.bars[1]!.notes).flat().length).toBe(0);
    } else {
      for (const bar of pattern.bars) {
        const count = Object.values(bar.notes)
          .flat()
          .filter((e) => e.type === 'EDMArpeggiator' || e.type === 'noteRelative').length;
        expect(count, 'bar missing synth events').toBeGreaterThan(0);
      }
    }
  });

  it('EDMArpeggiator branch (when picked) carries the expected shape', () => {
    // Cherry-pick a seed that lands on EDMArpeggiator. Most seeds hit
    // one of the three style branches roughly equally; we scan for an
    // EDMArpeggiator-emitting seed and assert its shape.
    for (const seed of ['arp-seed-1', 'arp-seed-2', 'arp-seed-3', 'arp-seed-4', 'arp-seed-5']) {
      const pattern = generateSynthsPattern(ctxFor(seed), fakeSegment('chorus1', 1), ['synths'])!;
      const ev = pattern.bars[0]!.notes['0.0']?.find((e) => e.type === 'EDMArpeggiator') as
        | { chord: string; arpeggioType: string; arpeggioRhythm: string; numberOfOctaves: number; duration: number; noteDuration: number }
        | undefined;
      if (!ev) continue;
      expect(typeof ev.chord).toBe('string');
      expect(ARP_TYPES.has(ev.arpeggioType)).toBe(true);
      expect(ARP_RHYTHMS.has(ev.arpeggioRhythm)).toBe(true);
      expect([2, 3]).toContain(ev.numberOfOctaves);
      expect(ev.duration).toBe(0.25);
      expect(ev.noteDuration).toBe(0.25);
      return; // tested one seed; done.
    }
    // If no seed landed on EDMArpeggiator across 5 samples, the
    // style pool implementation is broken or the bias is too narrow.
    throw new Error('expected at least one seed in [arp-seed-1..5] to pick EDMArpeggiator');
  });

  it('noteRelative events carry one complete encoding + duration', () => {
    // distanceFromMiddleC (piano-library styles) or the legacy chord walk
    // octave + direction + note + offset (playful).
    const pattern = generateSynthsPattern(
      ctxFor('brightPop-vertical-slice'),
      fakeSegment('chorus1', 4),
      ['synths'],
    )!;
    let noteRelativeCount = 0;
    for (const bar of pattern.bars) {
      for (const events of Object.values(bar.notes)) {
        for (const ev of events) {
          if (ev.type !== 'noteRelative') continue;
          const e = ev as { chord: string; distanceFromMiddleC?: number; octave?: number; direction?: string; note?: number; offset?: number; duration: number };
          expect(typeof e.chord).toBe('string');
          if (e.distanceFromMiddleC === undefined) {
            expect(typeof e.octave).toBe('number');
            expect(typeof e.direction).toBe('string');
            expect(typeof e.note).toBe('number');
            expect(typeof e.offset).toBe('number');
          } else {
            expect(typeof e.distanceFromMiddleC).toBe('number');
          }
          expect(typeof e.duration).toBe('number');
          noteRelativeCount++;
        }
      }
    }
    expect(noteRelativeCount).toBeGreaterThan(0);
  });

  it('is deterministic: same seed → identical pattern', () => {
    const a = generateSynthsPattern(ctxFor('det-seed'), fakeSegment('chorus1', 4), ['synths']);
    const b = generateSynthsPattern(ctxFor('det-seed'), fakeSegment('chorus1', 4), ['synths']);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('different seeds produce different patterns across enough samples', () => {
    // docs/55a — pattern style is picked from the brightPop synth
    // pool (EDMArpeggiator / EDMSynthsPlucked / EDMSynthsStabs). The
    // signature includes the picked style and event count to span
    // the style branches.
    const sigs = new Set<string>();
    for (const seed of ['s1', 's2', 's3', 's4', 's5', 's6']) {
      const p = generateSynthsPattern(ctxFor(seed), fakeSegment('chorus1', 1), ['synths'])!;
      let arpeggiator = 0;
      let noteRelative = 0;
      for (const events of Object.values(p.bars[0]!.notes)) {
        for (const ev of events) {
          if (ev.type === 'EDMArpeggiator') arpeggiator++;
          else if (ev.type === 'noteRelative') noteRelative++;
        }
      }
      sigs.add(`${arpeggiator}/${noteRelative}`);
    }
    expect(sigs.size).toBeGreaterThanOrEqual(2);
  });

  it('uses an independent fork — same parent state, same pick', () => {
    // Both calls fork('patterns/synths') off the same parent; the
    // fork is deterministic, so the same parent → same pick regardless
    // of intervening calls on OTHER forks.
    const parentA = createRng('parent');
    const parentB = createRng('parent');
    parentB.fork('patterns/bass'); // simulate another generator forking
    const ctxA: GeneratorContext = {
      params: { genre: 'brightPop', key: 'C', bpm: 120, seed: 'parent' },
      rng: parentA,
    };
    const ctxB: GeneratorContext = {
      params: { genre: 'brightPop', key: 'C', bpm: 120, seed: 'parent' },
      rng: parentB,
    };
    const a = generateSynthsPattern(ctxA, fakeSegment('chorus1', 1), ['synths']);
    const b = generateSynthsPattern(ctxB, fakeSegment('chorus1', 1), ['synths']);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
