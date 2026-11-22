// to-do #1 Phase A — per-segment override primitives.
//
// Pins the drum masks (faithful to the engine's piece predicates,
// Drums.h:165-219), the synthesized one-/four-on-the-floor replacements, and
// the bass onTheBeat descriptors.

import { describe, expect, it } from 'vitest';

import { createRng, type Rng } from '@casperaki/music-theory';

import {
  applyArrangementOverrides,
  applyDrumOverrideMask,
  bassOverrideNotes,
  decideBassOverrides,
  decideDrumOverrides,
  synthesizeBassOverrideForSegment,
  synthesizeFloorPattern,
  type DrumMaskType,
  _resetOverrideMidiMap,
} from '../src/arrangement-polish/overrides.js';
import {
  generateChords,
  generatePatterns,
  generateSongStructure,
  selectInstruments,
  type GenerateParams,
  type GeneratorContext,
} from '../src/index.js';
import { addNoteEvent, emptyBarPattern } from '../src/patterns/shared.js';
import { MidiNoteSchema, type Segment, type SongStructure } from '@casperaki/song-schema';
import type { BarPattern } from '../src/patterns/types.js';

// MIDI map (canonical drum bank): bassDrum1 36, bassDrum2 35, snareDrum1 38,
// snareDrum2 40, hiHatClosed1 42, hiHatOpen 46, crash1 49, ride 51, clap 39,
// shaker 70, tom1 50, rim 37.
const KICK = 36;
const KICK2 = 35;
const SNARE = 38;
const HIHAT = 42;
const HIHAT_OPEN = 46;
const CRASH = 49;
const RIDE = 51;
const CLAP = 39;
const SHAKER = 70;
const TOM = 50;
const RIM = 37;

function barWith(midis: number[]): BarPattern {
  const bar = emptyBarPattern();
  midis.forEach((m, i) =>
    addNoteEvent(bar, i * 0.5, { type: 'note', note: MidiNoteSchema.parse(m) }),
  );
  return bar;
}

function midisOf(bar: BarPattern): number[] {
  const out: number[] = [];
  for (const events of Object.values(bar.notes)) {
    for (const e of events ?? []) if (e.type === 'note' && typeof e.note === 'number') out.push(e.note);
  }
  return out.sort((a, b) => a - b);
}

describe('drum override masks', () => {
  _resetOverrideMidiMap();
  const all = [KICK, KICK2, SNARE, HIHAT, HIHAT_OPEN, CRASH, RIDE, CLAP, SHAKER, TOM, RIM];

  const cases: Array<[DrumMaskType, number[]]> = [
    ['bassDrumOnly', [KICK2, KICK]],
    ['noBassDrum', [SNARE, HIHAT, HIHAT_OPEN, CRASH, RIDE, CLAP, SHAKER, TOM, RIM]],
    ['bassDrumAndSnareDrumOnly', [KICK2, KICK, SNARE]],
    ['hiHatOnly', [HIHAT, HIHAT_OPEN]],
    ['bassDrumAndHiHatOnly', [KICK2, KICK, HIHAT, HIHAT_OPEN]],
    ['bassDrumSnareDrumAndHiHatOnly', [KICK2, KICK, SNARE, HIHAT, HIHAT_OPEN]],
    // percussion = NOT(hiHat|crash|ride|clap|snap|shaker) → kick/snare/tom/rim.
    ['percussionOnly', [KICK2, KICK, SNARE, TOM, RIM]],
    ['noPercussion', [HIHAT, HIHAT_OPEN, CRASH, RIDE, CLAP, SHAKER]],
  ];

  for (const [type, expected] of cases) {
    it(`${type} keeps exactly the right pieces`, () => {
      const [masked] = applyDrumOverrideMask([barWith(all)], type);
      expect(midisOf(masked!)).toEqual([...expected].sort((a, b) => a - b));
    });
  }

  it('does not mutate the input pattern', () => {
    const input = [barWith(all)];
    const before = midisOf(input[0]!);
    applyDrumOverrideMask(input, 'bassDrumOnly');
    expect(midisOf(input[0]!)).toEqual(before);
  });
});

describe('synthesized floor replacements', () => {
  it('one-on-the-floor places one kick on beat 0 of every bar', () => {
    const bars = synthesizeFloorPattern(4, 1, false, 'whole');
    expect(bars).toHaveLength(4);
    for (const bar of bars) {
      expect(Object.keys(bar.notes)).toEqual(['0.0']);
      expect(midisOf(bar)).toEqual([36]);
    }
  });

  it('four-on-the-floor places a kick on every beat', () => {
    const [bar] = synthesizeFloorPattern(2, 4, false, 'whole');
    expect(Object.keys(bar!.notes).sort()).toEqual(['0.0', '1.0', '2.0', '3.0']);
  });

  it('withClap layers a clap (39) on every kick', () => {
    const [bar] = synthesizeFloorPattern(1, 1, true, 'whole');
    expect(midisOf(bar!)).toEqual([36, 39]);
  });

  it('secondHalf only fills the back half; lastBar only the last bar', () => {
    const half = synthesizeFloorPattern(4, 1, false, 'secondHalf');
    expect(midisOf(half[0]!)).toEqual([]);
    expect(midisOf(half[2]!)).toEqual([36]);
    const last = synthesizeFloorPattern(4, 1, false, 'lastBar');
    expect(midisOf(last[2]!)).toEqual([]);
    expect(midisOf(last[3]!)).toEqual([36]);
  });
});

describe('bass override descriptors', () => {
  it('onTheBeat15 = whole notes on beats 1 and 5', () => {
    expect(bassOverrideNotes('onTheBeat15')).toEqual([
      [0, 4],
      [4, 4],
    ]);
  });
  it('onTheBeat157 = beat 1 whole + beats 5,7 half', () => {
    expect(bassOverrideNotes('onTheBeat157')).toEqual([
      [0, 4],
      [4, 2],
      [6, 2],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Phase B — cross-segment scratchpad state machine
// ---------------------------------------------------------------------------

// A scripted Rng for branch-targeted tests. `strategy:'first'` picks the first
// option (→ dropOut false, no floor-roll, etc.); `'last'` picks the last
// (→ dropOut true, floor-rolls fire). `int` drives the splice index (clamped to
// the live array range). `fork` returns the same instance so the same script
// drives every forked stream.
function scriptedRng(opts: { strategy: 'first' | 'last'; int?: number }): Rng {
  const self: Rng = {
    next: () => (opts.strategy === 'last' ? 0.999 : 0),
    int: (min, max) => Math.max(min, Math.min(opts.int ?? min, max)),
    pick: (vals) => (opts.strategy === 'last' ? vals[vals.length - 1]! : vals[0]!),
    pickWeighted: (vals) => vals[0]!,
    bool: () => opts.strategy === 'last',
    fork: () => self,
  };
  return self;
}

function structureOf(...names: string[]): SongStructure {
  return names.map((name) => ({ name, bars: [] })) as SongStructure;
}

const POOL_IDX = {
  noBassDrum: 0,
  bassDrumOnly: 1,
  bassDrumAndSnareDrumOnly: 2,
  hiHatOnly: 3,
  percussionOnly: 4,
} as const;

describe('decideDrumOverrides — scratchpad carry + verse mutation', () => {
  it('carries a non-"only" override into a same-type later segment, mutating snare→hiHat', () => {
    // ballad style never takes the floor branches → verse1 splices a mask.
    const rng = scriptedRng({ strategy: 'first', int: POOL_IDX.bassDrumAndSnareDrumOnly });
    const d = decideDrumOverrides(rng, structureOf('verse1', 'verse2'), 'ballad');
    expect(d.verse1).toEqual({ kind: 'mask', maskType: 'bassDrumAndSnareDrumOnly' });
    // verse2 carries it, and the verse mutation upgrades it (drums.js:319-321).
    expect(d.verse2).toEqual({ kind: 'mask', maskType: 'bassDrumSnareDrumAndHiHatOnly' });
  });

  it('never carries an "only" pattern — verse2 regenerates a different mask', () => {
    const rng = scriptedRng({ strategy: 'first', int: POOL_IDX.hiHatOnly });
    const d = decideDrumOverrides(rng, structureOf('verse1', 'verse2'), 'ballad');
    expect(d.verse1).toEqual({ kind: 'mask', maskType: 'hiHatOnly' });
    // hiHatOnly is in the no-carry set; verse2 regenerates and must not be hiHatOnly.
    expect(d.verse2.kind).toBe('mask');
    if (d.verse2.kind === 'mask') expect(d.verse2.maskType).not.toBe('hiHatOnly');
  });

  it('chorus segments get no drum override', () => {
    const rng = scriptedRng({ strategy: 'first', int: 0 });
    const d = decideDrumOverrides(rng, structureOf('chorus1', 'chorus2'), 'ballad');
    expect(d.chorus1).toEqual({ kind: 'none' });
    expect(d.chorus2).toEqual({ kind: 'none' });
  });

  it('is deterministic for a fixed seed', () => {
    const struct = structureOf('intro', 'verse1', 'verse2', 'chorus1', 'bridge1', 'outro');
    const a = decideDrumOverrides(createRng('seed-x').fork('d'), struct, 'edm');
    const b = decideDrumOverrides(createRng('seed-x').fork('d'), struct, 'edm');
    expect(a).toEqual(b);
  });
});

describe('decideDrumOverrides — dropOut', () => {
  it('silences the first instance of the dropped segment-type', () => {
    // strategy:'last' → dropOut roll true, dropOut type = last of [intro,verse,break,outro] = outro.
    const rng = scriptedRng({ strategy: 'last' });
    const d = decideDrumOverrides(rng, structureOf('outro'), 'edm');
    expect(d.outro).toEqual({ kind: 'dropOut' });
  });

  it('does not drop out when the 1/5 roll fails', () => {
    const rng = scriptedRng({ strategy: 'first', int: 0 });
    const d = decideDrumOverrides(rng, structureOf('outro'), 'edm');
    expect(d.outro.kind).not.toBe('dropOut');
  });
});

describe('decideDrumOverrides — floor + secondary branches', () => {
  it('edm verse can roll a four-on-the-floor override', () => {
    // strategy:'last': the verse floor gate `pick([f,f,f,t])` → true; floor pool
    // pick → last = fourOnTheFloorBassDrumAndHandClap. dropOut type = outro
    // (≠ verse), so verse1 is not dropped.
    const rng = scriptedRng({ strategy: 'last' });
    const d = decideDrumOverrides(rng, structureOf('verse1'), 'edm');
    expect(d.verse1).toEqual({ kind: 'floor', kicksPerBar: 4, withClap: true });
  });

  it('bridge can roll a secondaryPattern (full replacement)', () => {
    // strategy:'last': bridge useSecondary `pick([f,t])` → true.
    const rng = scriptedRng({ strategy: 'last' });
    const d = decideDrumOverrides(rng, structureOf('bridge1'), 'edm');
    expect(d.bridge1).toEqual({ kind: 'secondary' });
  });
});

describe('decideBassOverrides', () => {
  it('rolls + carries an override across same-type segments', () => {
    const rng = scriptedRng({ strategy: 'last' });
    const d = decideBassOverrides(rng, structureOf('verse1', 'verse2'));
    expect(d.verse1).toBe('onTheBeat157'); // last of the pool
    expect(d.verse2).toBe('onTheBeat157'); // carried
  });

  it('skips overrides on the 1/2 miss, and never on chorus', () => {
    const rng = scriptedRng({ strategy: 'first', int: 0 });
    const d = decideBassOverrides(rng, structureOf('verse1', 'chorus1'));
    expect(d.verse1).toBeUndefined();
    expect(d.chorus1).toBeUndefined();
  });
});

describe('synthesizeBassOverrideForSegment', () => {
  function chordSeg(name: string, bars: number, chord: string): Segment {
    return {
      name,
      bars: Array.from({ length: bars }, () => ({ chords: [chord, chord, chord, chord] })),
    } as Segment;
  }

  it('onTheBeat15 places a chord-root whole note on beat 0 of every bar at octave 2', () => {
    const seg = chordSeg('verse1', 4, 'C');
    const { bars } = synthesizeBassOverrideForSegment(seg, 'onTheBeat15');
    expect(bars).toHaveLength(4);
    for (const bar of bars) {
      expect(Object.keys(bar.notes)).toEqual(['0.0']);
      const e = bar.notes['0.0']![0]!;
      expect(e.type === 'note' && e.note).toBe(36); // C2 = MIDI 36
      expect(e.type === 'note' && e.duration).toBe(4);
    }
  });

  it('follows the chord root (G: C2 moved down to G1 = 31, the nearest way) and lays onTheBeat157 half-notes on odd bars', () => {
    const seg = chordSeg('verse1', 2, 'G');
    const { bars } = synthesizeBassOverrideForSegment(seg, 'onTheBeat157');
    // bar 0: whole note beat 0; bar 1: half notes beats 0 and 2.
    expect(Object.keys(bars[0]!.notes)).toEqual(['0.0']);
    expect(bars[0]!.notes['0.0']![0]!.type === 'note' && bars[0]!.notes['0.0']![0]!.note).toBe(31);
    expect(Object.keys(bars[1]!.notes).sort()).toEqual(['0.0', '2.0']);
    expect(bars[1]!.notes['2.0']![0]!.type === 'note' && bars[1]!.notes['2.0']![0]!.duration).toBe(2);
  });
});

describe('applyArrangementOverrides — integration', () => {
  function pipeline(genre: string, seed: string) {
    const params: GenerateParams = { genre, key: 'C', bpm: 120, seed };
    const ctx: GeneratorContext = { params, rng: createRng(seed) };
    const structure = generateChords(ctx, generateSongStructure(ctx));
    const selection = selectInstruments(ctx, structure);
    const base = generatePatterns(ctx, structure, selection);
    return { ctx, structure, selection, base };
  }

  it('rewrites at least one segment\'s Drums lane and leaves non-drum/bass lanes untouched', () => {
    const { ctx, structure, selection, base } = pipeline('brightPop', 'brightPop-vertical-slice');
    const out = applyArrangementOverrides(ctx, structure, selection, base);

    let drumsChanged = 0;
    for (let i = 0; i < base.segments.length; i++) {
      const b = base.segments[i]!.lanes['Drums'];
      const o = out.segments[i]!.lanes['Drums'];
      if (b && o && JSON.stringify(b) !== JSON.stringify(o)) drumsChanged++;
      // Non-drum/bass lanes (e.g. Keys / Pad / Guitar / Synths) are identical.
      for (const lane of Object.keys(base.segments[i]!.lanes)) {
        if (lane === 'Drums' || lane === 'Bass') continue;
        expect(out.segments[i]!.lanes[lane]).toEqual(base.segments[i]!.lanes[lane]);
      }
    }
    expect(drumsChanged).toBeGreaterThan(0);
  });

  it('is deterministic (same seed → identical override output)', () => {
    const a = pipeline('edm', 'edm-vertical-slice');
    const b = pipeline('edm', 'edm-vertical-slice');
    const outA = applyArrangementOverrides(a.ctx, a.structure, a.selection, a.base);
    const outB = applyArrangementOverrides(b.ctx, b.structure, b.selection, b.base);
    expect(JSON.stringify(outA)).toBe(JSON.stringify(outB));
  });

  it('masked drum segments are a strict subset of the base pattern', () => {
    // Recompute the decisions so we only assert the subset property where the
    // override is actually a mask (floor/secondary REPLACE; dropOut empties).
    const { ctx, structure, selection, base } = pipeline('ballad', 'ballad-1');
    const decisions = decideDrumOverrides(
      ctx.rng.fork('arrangement-polish/drum-overrides'),
      structure,
      'ballad',
    );
    const out = applyArrangementOverrides(ctx, structure, selection, base);
    for (let i = 0; i < base.segments.length; i++) {
      const name = base.segments[i]!.segmentName;
      if (decisions[name]?.kind !== 'mask') continue;
      const b = base.segments[i]!.lanes['Drums'];
      const o = out.segments[i]!.lanes['Drums'];
      if (!b || !o) continue;
      for (let bar = 0; bar < b.bars.length; bar++) {
        const baseCount = Object.values(b.bars[bar]!.notes).flat().length;
        const outCount = Object.values(o.bars[bar]!.notes).flat().length;
        expect(outCount).toBeLessThanOrEqual(baseCount);
      }
    }
  });
});
