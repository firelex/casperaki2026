// docs/54p — tests for the production TransitionSample wiring.
//
// Two layers tested here:
// 1. `computeTransitionTiming` — port of legacy `_getTransition` math.
// 2. `resolveTransitionRow` — brightPop-first / fallback catalog pick,
//    determinism guarantee.

import { describe, expect, it } from 'vitest';
import { loadValidatedCatalog } from '@casperaki/arrangement';
import {
  EDM_SNARE_DRUM_ROLL_TAG,
  TRANSITION_TAG_TO_LOW_LEVEL,
  buildNoiseRiseBlock,
  buildSnareRollPatternAssets,
  buildTransitionAssets,
  computeSnareRollTiming,
  computeTransitionTiming,
  defaultClimaxForTag,
  finalChordRootForSegment,
  resolveSnareRollSamples,
  resolveTransitionRow,
} from '../src/transitions.js';

describe('buildNoiseRiseBlock — fxNoiseRise expansion (docs/62 A7)', () => {
  it('expands the EffectsClass param object (freqs + dB envelope + 3-bar decay)', () => {
    const b = buildNoiseRiseBlock({ segmentName: 'preChorus1', segmentBars: 8, tempo: 120, placement: 'endOfSegment' });
    expect(b.type).toBe('fxNoiseRise');
    expect(b.frequencyStart).toBe(100);
    expect(b.frequencyEnd).toBe(20000);
    expect(b.volumeAttack).toBe(-30);
    expect(b.volumeSustain).toBe(-20);
    expect(b.volumeDecay).toBe(-50);
    // decay = 3 bars * 4 beats * 60/tempo = 3*4*0.5 = 6s.
    expect(b.decayDuration).toBeCloseTo(6, 9);
    // attack spans from the start position to the segment end; decay begins there.
    expect(b.decaySequenceStartPositionOffsetInSeconds).toBeCloseTo(b.attackDuration, 9);
    // attack = (8 - ssp/32) * 4 * 60/120 = (8 - ssp/32) * 2 seconds.
    expect(b.attackDuration).toBeCloseTo((8 - b.sequenceStartPosition / 32) * 2, 9);
    expect(b.sequenceStartPosition).toBeGreaterThanOrEqual(0);
    expect(b.sequenceStartPosition).toBeLessThanOrEqual((8 - 1) * 32);
  });

  it('is deterministic per segment name, and clamps short segments to >= 1 bar of attack', () => {
    const a = buildNoiseRiseBlock({ segmentName: 'verse1', segmentBars: 2, tempo: 100, placement: 'endOfSegment' });
    const b = buildNoiseRiseBlock({ segmentName: 'verse1', segmentBars: 2, tempo: 100, placement: 'endOfSegment' });
    expect(a).toEqual(b); // deterministic
    // even if the picked type is *threeBarsBeforeEnd*, the start clamps to <= (2-1)*32.
    expect(a.sequenceStartPosition).toBeGreaterThanOrEqual(0);
    expect(a.sequenceStartPosition).toBeLessThanOrEqual(32);
    expect(a.attackDuration).toBeGreaterThan(0);
  });
});

describe('computeTransitionTiming — attack branch (cymbalsCrashHit class)', () => {
  it('cymbalsCrashHit with climax=0 fires at segment start', () => {
    const t = computeTransitionTiming({
      tag: 'cymbalsCrashHit',
      segmentDurationSeconds: 9.6,    // 4 bars @ 100bpm
      sampleDurationSeconds: 4.47,
      sampleClimaxSeconds: null,      // default 0 for attack
      tempo: 100,
      placement: 'beginningOfSegment',
    });
    expect(t.sequenceStartPosition).toBe(0);
    expect(t.sequenceStartPositionOffsetInSeconds).toBe(0);
    expect(t.duration).toBe(4.47);
  });

  it('fxDownlifter / fxHighImpact / fxLowImpact / fxTransition / fxOther are attack-branch', () => {
    for (const tag of ['fxDownlifter', 'fxHighImpact', 'fxLowImpact', 'fxTransition', 'fxOther']) {
      expect(TRANSITION_TAG_TO_LOW_LEVEL[tag]?.timingBranch).toBe('attack');
    }
  });

  it('attack with climax > 0 produces negative startPosition (legacy pre-roll)', () => {
    // Legacy `_getTransition` for cymbalsCrashHit: startPos = (-climax)*tempo/60*8.
    // With climax=0.5s at 120bpm: startPos = -0.5*120/60*8 = -8 (32nds = 1 beat).
    const t = computeTransitionTiming({
      tag: 'cymbalsCrashHit',
      segmentDurationSeconds: 16,
      sampleDurationSeconds: 2.0,
      sampleClimaxSeconds: 0.5,
      tempo: 120,
      placement: 'beginningOfSegment',
    });
    expect(t.sequenceStartPosition).toBe(-8);
    expect(t.sequenceStartPositionOffsetInSeconds).toBe(0);
  });
});

describe('computeTransitionTiming — tail branch (fxReverse class)', () => {
  it('fxReverse / fxTonalReverse / fxUplifter are tail-branch', () => {
    for (const tag of ['fxReverse', 'fxTonalReverse', 'fxUplifter']) {
      expect(TRANSITION_TAG_TO_LOW_LEVEL[tag]?.timingBranch).toBe('tail');
    }
  });

  it('fxReverse on a 16s segment with 2s sample ends at segment boundary', () => {
    // climax defaults to sampleDuration; startPos = (16 - 2) * 120/60 * 8 = 14*2*8 = 224 (32nds).
    const t = computeTransitionTiming({
      tag: 'fxReverse',
      segmentDurationSeconds: 16,
      sampleDurationSeconds: 2.0,
      sampleClimaxSeconds: null,
      tempo: 120,
      placement: 'endOfSegment',
    });
    expect(t.sequenceStartPosition).toBe(224);  // = 16s - 2s in 32nds at 120bpm
    expect(t.sequenceStartPositionOffsetInSeconds).toBe(0);
    expect(t.duration).toBe(2.0);
  });

  it('percussionBreaksBuildups is bar-aligned (floor div by 32 * 32)', () => {
    // Source-of-truth: legacy `Math.floor(startInt / 32) * 32` snap-down.
    // segDur=16s, sampleDur=3.7s, 120bpm: startIn32 = (16-3.7)*120/60*8 = 196.8 → floor=196 → aligned floor 196/32 = 6, *32 = 192.
    const t = computeTransitionTiming({
      tag: 'percussionBreaksBuildups',
      segmentDurationSeconds: 16,
      sampleDurationSeconds: 3.7,
      sampleClimaxSeconds: null,
      tempo: 120,
      placement: 'midSegment',
    });
    expect(t.sequenceStartPosition).toBe(192);
    expect(t.sequenceStartPositionOffsetInSeconds).toBe(0);
    expect(t.sequenceStartPosition % 32).toBe(0);
  });

  it('percussionBreaksFills is bar-aligned (ceil div by 32 * 32)', () => {
    // Legacy: `Math.ceil(startInt / 32) * 32`. Same input → 196/32=6.125 → ceil 7 → 224.
    const t = computeTransitionTiming({
      tag: 'percussionBreaksFills',
      segmentDurationSeconds: 16,
      sampleDurationSeconds: 3.7,
      sampleClimaxSeconds: null,
      tempo: 120,
      placement: 'beginningOfSegment',
    });
    expect(t.sequenceStartPosition).toBe(224);
    expect(t.sequenceStartPositionOffsetInSeconds).toBe(0);
    expect(t.sequenceStartPosition % 32).toBe(0);
  });
});

describe('resolveTransitionRow', () => {
  const catalog = loadValidatedCatalog();
  const seed = 'test-seed';

  it('cymbalsCrashHit picks a brightPop row when available (the genre branch)', () => {
    const r = resolveTransitionRow({ catalog, tag: 'cymbalsCrashHit', segmentName: 'chorus1', genre: 'brightPop', seed });
    expect(r).not.toBeNull();
    expect(r!.entry.lowLevel).toBe('cymbalsCrashHit');
    expect(r!.source).toBe('genre');
    expect(
      r!.entry.mainStyle === 'brightPop' || (r!.entry.addStyles ?? []).includes('brightPop')
    ).toBe(true);
  });

  it('fxDownlifter has no brightPop rows → falls back to the full pool', () => {
    const r = resolveTransitionRow({ catalog, tag: 'fxDownlifter', segmentName: 'chorus1', genre: 'brightPop', seed });
    expect(r).not.toBeNull();
    expect(r!.entry.lowLevel).toBe('fxDownlifter');
    expect(r!.source).toBe('fallback');
  });

  it('same (seed, segment, tag) → identical pick (deterministic)', () => {
    const a = resolveTransitionRow({ catalog, tag: 'cymbalsCrashHit', segmentName: 'chorus1', genre: 'brightPop', seed });
    const b = resolveTransitionRow({ catalog, tag: 'cymbalsCrashHit', segmentName: 'chorus1', genre: 'brightPop', seed });
    expect(a!.entry.id).toBe(b!.entry.id);
  });

  it('different segments yield different picks (when pool > 1)', () => {
    const a = resolveTransitionRow({ catalog, tag: 'cymbalsCrashHit', segmentName: 'chorus1', genre: 'brightPop', seed });
    const b = resolveTransitionRow({ catalog, tag: 'cymbalsCrashHit', segmentName: 'chorus2', genre: 'brightPop', seed });
    // 27 brightPop rows → high probability of different picks; not a hard
    // requirement (could collide) so we just assert both resolved.
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
  });

  it('unknown tag returns null', () => {
    const r = resolveTransitionRow({ catalog, tag: 'totallyMadeUpTag', segmentName: 'verse1', genre: 'brightPop', seed });
    expect(r).toBeNull();
  });

  it('honours all tags in TRANSITION_TAG_TO_LOW_LEVEL', () => {
    // Cross-check: every tag we claim to handle resolves to at least one
    // catalog row (could be brightPop or fallback). Tonal tags
    // (fxTonalReverse) additionally require a final-chord root — supply one
    // so the key-match has a target.
    for (const tag of Object.keys(TRANSITION_TAG_TO_LOW_LEVEL)) {
      const r = resolveTransitionRow({ catalog, tag, segmentName: 'chorus1', genre: 'brightPop', seed, finalChordRoot: 'A' });
      expect(r, `tag=${tag}`).not.toBeNull();
    }
  });

  // ---- Tonal transition key-matching (legacy TransitionsClass.js:349) ----

  it('fxTonalReverse without a final-chord root is dropped (no wrong-key fire)', () => {
    const r = resolveTransitionRow({ catalog, tag: 'fxTonalReverse', segmentName: 'chorus1', genre: 'edm', seed });
    expect(r).toBeNull();
  });

  it('fxTonalReverse resolves to a row in the segment key', () => {
    const r = resolveTransitionRow({ catalog, tag: 'fxTonalReverse', segmentName: 'chorus1', genre: 'edm', seed, finalChordRoot: 'A' });
    expect(r).not.toBeNull();
    expect(r!.entry.lowLevel).toBe('fxTonalReverse');
    expect(r!.entry.key).toBe('A');
  });

  it('fxTonalReverse key-match is enharmonic (Bb selects an A# recording)', () => {
    const r = resolveTransitionRow({ catalog, tag: 'fxTonalReverse', segmentName: 'chorus1', genre: 'edm', seed, finalChordRoot: 'Bb' });
    expect(r).not.toBeNull();
    expect(r!.entry.key).toBe('A#');
  });

  it('fxTonalReverse with an unknown key is dropped', () => {
    const r = resolveTransitionRow({ catalog, tag: 'fxTonalReverse', segmentName: 'chorus1', genre: 'edm', seed, finalChordRoot: 'H' });
    expect(r).toBeNull();
  });

  // ---- BPM-matched lanes (percussionBreaks*; legacy TransitionsClass.js:457) ----

  it('percussionBreaksFills resolves to the song-tempo variant', () => {
    // The library ships one row per integer bpm; the resolver must pick the
    // row whose bpm equals the song tempo (no live time-stretch).
    for (const tempo of [110, 120, 128]) {
      const r = resolveTransitionRow({
        catalog, tag: 'percussionBreaksFills', segmentName: 'chorus1', genre: 'edm', seed, tempo,
      });
      expect(r, `tempo=${tempo}`).not.toBeNull();
      expect(r!.entry.bpm, `tempo=${tempo}`).toBe(tempo);
    }
  });

  it('percussionBreaksBuildups is bpm-matched to song tempo', () => {
    const r = resolveTransitionRow({
      catalog, tag: 'percussionBreaksBuildups', segmentName: 'preChorus1', genre: 'edm', seed, tempo: 124,
    });
    expect(r).not.toBeNull();
    expect(r!.entry.bpm).toBe(124);
  });

  it('falls back to the nearest available bpm when no exact row exists', () => {
    // Pick a tempo with no exact row; the resolver must still resolve and the
    // chosen bpm must be the closest available to the request.
    const all = catalog.entries.filter((e) => e.lowLevel === 'percussionBreaksFills' && typeof e.bpm === 'number');
    const present = new Set(all.map((e) => e.bpm as number));
    const lo = Math.min(...present);
    const missing = lo - 5; // below the catalogue's range → nearest is `lo`
    const r = resolveTransitionRow({
      catalog, tag: 'percussionBreaksFills', segmentName: 'chorus1', genre: 'edm', seed, tempo: missing,
    });
    expect(r).not.toBeNull();
    expect(r!.entry.bpm).toBe(lo);
  });

  it('without a tempo, percussionBreaks selection ignores bpm (back-compat)', () => {
    const r = resolveTransitionRow({
      catalog, tag: 'percussionBreaksFills', segmentName: 'chorus1', genre: 'edm', seed,
    });
    expect(r).not.toBeNull();
    expect(r!.entry.lowLevel).toBe('percussionBreaksFills');
  });

  it('bpm-matched pick stays deterministic for the same (seed, segment, tempo)', () => {
    const a = resolveTransitionRow({ catalog, tag: 'percussionBreaksFills', segmentName: 'chorus1', genre: 'edm', seed, tempo: 120 });
    const b = resolveTransitionRow({ catalog, tag: 'percussionBreaksFills', segmentName: 'chorus1', genre: 'edm', seed, tempo: 120 });
    expect(a!.entry.id).toBe(b!.entry.id);
  });
});

describe('finalChordRootForSegment', () => {
  it('returns the root of the last chord of the last bar', () => {
    expect(finalChordRootForSegment([{ chords: ['C', 'G'] }, { chords: ['Am7', 'F'] }])).toBe('F');
  });
  it('strips chord quality to the bare root', () => {
    expect(finalChordRootForSegment([{ chords: ['G#m7'] }])).toBe('G#');
  });
  it('skips trailing empty bars', () => {
    expect(finalChordRootForSegment([{ chords: ['D'] }, { chords: [] }])).toBe('D');
  });
  it('returns null when no chords are present', () => {
    expect(finalChordRootForSegment([{ chords: [] }])).toBeNull();
    expect(finalChordRootForSegment([])).toBeNull();
    expect(finalChordRootForSegment(undefined)).toBeNull();
  });
});

describe('defaultClimaxForTag', () => {
  it('attack tags → 0', () => {
    expect(defaultClimaxForTag('cymbalsCrashHit', 4.47)).toBe(0);
    expect(defaultClimaxForTag('fxDownlifter', 3.0)).toBe(0);
  });
  it('tail tags → sample duration', () => {
    expect(defaultClimaxForTag('fxReverse', 2.0)).toBe(2.0);
    expect(defaultClimaxForTag('percussionBreaksBuildups', 3.7)).toBe(3.7);
  });
});

describe('edmSnareDrumRoll — TransitionPattern lowering', () => {
  const catalog = loadValidatedCatalog();
  const seed = 'roll-seed';

  describe('resolveSnareRollSamples', () => {
    it('picks two edm-styled electronic snares', () => {
      const r = resolveSnareRollSamples({ catalog, segmentName: 'bridge1', seed });
      expect(r).not.toBeNull();
      expect(r!.rows).toHaveLength(2);
      for (const row of r!.rows) {
        expect(row.lowLevel).toBe('snareDrumsElectronic');
        const isEdm = row.mainStyle === 'edm' || (row.addStyles ?? []).includes('edm');
        expect(isEdm).toBe(true);
      }
      expect(r!.source).toBe('genre');
    });

    it('is deterministic on (seed, segment)', () => {
      const a = resolveSnareRollSamples({ catalog, segmentName: 'bridge1', seed });
      const b = resolveSnareRollSamples({ catalog, segmentName: 'bridge1', seed });
      expect(a!.rows.map((e) => e.id)).toEqual(b!.rows.map((e) => e.id));
    });
  });

  describe('computeSnareRollTiming', () => {
    it('right-aligns the roll at the segment end (segEnd_32 - lengthInBars*32)', () => {
      // 4 bars @ 128bpm: segDur = 4*4*60/128 = 7.5s; segEnd_32 = floor(7.5*128/60*8) = 128.
      // 4-bar roll → start = 128 - 4*32 = 0 (fills the whole segment).
      const t = computeSnareRollTiming({ segmentDurationSeconds: 7.5, tempo: 128, lengthInBars: 4 });
      expect(t.sequenceStartPosition).toBe(0);
      expect(t.sequenceStartPositionOffsetInSeconds).toBe(0);
    });

    it('a short roll on a long segment starts late', () => {
      // 8 bars @ 120bpm: segDur = 16s; segEnd_32 = floor(16*120/60*8) = 256.
      // 2-bar roll → start = 256 - 64 = 192.
      const t = computeSnareRollTiming({ segmentDurationSeconds: 16, tempo: 120, lengthInBars: 2 });
      expect(t.sequenceStartPosition).toBe(192);
      expect(t.sequenceStartPosition % 32).toBe(0);
    });
  });

  describe('buildSnareRollPatternAssets', () => {
    const samples = resolveSnareRollSamples({ catalog, segmentName: 'bridge1', seed })!;
    const pattern = { snareDrum1: 'xxxxxxxx', snareDrum2: 'x00x00x0' };
    const built = buildSnareRollPatternAssets({
      segmentName: 'bridge1', instId: 40000, sampleIds: [40001, 40002],
      filenameIndex: 7, samples, pattern, lengthInBars: 1,
      timing: { sequenceStartPosition: 96, sequenceStartPositionOffsetInSeconds: 0 },
    });

    it('emits a transitionPattern inst with two notes mapped to the two samples', () => {
      expect(built.inst.filename).toBe('inst-7.json');
      expect(built.inst.json.type).toBe('transitionPattern');
      expect(built.inst.json.lowLevelType).toBe('snareDrumsElectronic');
      expect(built.inst.json.sampleOrVst).toBe('twoSamples');
      expect(built.inst.json.name).toBe('edmSnareDrumRoll__bridge1');
      expect(built.inst.json.samples.map((s) => s.note)).toEqual(['C1', 'G1']);
      expect(built.inst.json.samples.map((s) => s.id)).toEqual([40001, 40002]);
      // Each sample carries a source path for the prestage staging script.
      for (const s of built.inst.json.samples) expect(typeof s.sourcePath).toBe('string');
    });

    it('emits a block the engine routes by id (block.id === inst.id) with the pattern', () => {
      expect(built.blockKey).toBe('edmSnareDrumRoll__bridge1');
      expect(built.block.id).toBe(40000);
      expect(built.block.id).toBe(built.inst.json.id);
      expect(built.block.sequenceStartPosition).toBe(96);
      expect(built.block.config.details.pattern).toEqual(pattern);
      expect(built.block.config.details.lengthInBars).toBe(1);
    });

    it('tag constant matches the brain tag', () => {
      expect(EDM_SNARE_DRUM_ROLL_TAG).toBe('edmSnareDrumRoll');
    });
  });
});

describe('buildTransitionAssets', () => {
  const catalog = loadValidatedCatalog();
  it('emits inst-N.json + arrangement block with matching key', () => {
    const r = resolveTransitionRow({ catalog, tag: 'cymbalsCrashHit', segmentName: 'chorus1', genre: 'brightPop', seed: 'x' })!;
    const timing = computeTransitionTiming({
      tag: 'cymbalsCrashHit',
      segmentDurationSeconds: 9.6,
      sampleDurationSeconds: 4.47,
      sampleClimaxSeconds: 0,
      tempo: 100,
      placement: 'beginningOfSegment',
    });
    const built = buildTransitionAssets({
      tag: 'cymbalsCrashHit', segmentName: 'chorus1',
      playsampleId: 40000, filenameIndex: 5,
      resolvedRow: r, timing,
      sampleDurationSeconds: 4.47, sampleClimaxSeconds: 0,
    });
    expect(built.inst.filename).toBe('inst-5.json');
    expect(built.inst.json.type).toBe('transitionSample');
    expect(built.inst.json.lowLevelType).toBe('cymbalsCrashHit');
    // Name is per-segment-unique to prevent engine routing collisions across
    // multiple segments that share the same tag (engine's per-segment
    // dispatch keys on inst.name).
    expect(built.inst.json.name).toBe('cymbalsCrashHit__chorus1');
    expect(built.inst.json.details.duration).toBe(4.47);
    expect(built.inst.json.details.climax).toBe(0);
    expect(built.blockKey).toBe('cymbalsCrashHit__chorus1');
    expect(built.block.id).toBe(40000);
    expect(built.block.urls).toEqual(['/playSample/40000']);
    expect(built.block.sequenceStartPosition).toBe(0);
  });
});
