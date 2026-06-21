// Step 13 — legacy-derived keys pattern bank tests.
//
// Pins the chordsStraight bank loader's invariants, the selection
// determinism contract, per-genre coverage, and the chord-aware comping
// shape lowered from the legacy
// ChordsPianoPatternGeneratorClass.createPianoPattern (classic + straight
// substyles × busyness 1/2/3 × longChords/shortChords). See docs/53x.

import { describe, expect, it } from 'vitest';

import {
  beatsPerBar,
  createRng,
  formatBarBeat,
  parseBarBeat,
  parseChord,
  type Rng,
} from '@casperaki/music-theory';
import {
  ChordSymbolSchema,
  GenreSchema,
  stableStringify,
  type Genre,
} from '@casperaki/song-schema';

import {
  DataAssetError,
  describeKeysBank,
  generateChords,
  generateKeysPattern,
  generatePatterns,
  generateSongStructure,
  selectInstruments,
  selectKeysPattern,
  type FamilyPattern,
  type GenerateParams,
  type GeneratorContext,
} from '../src/index.js';
import { _resetKeysBankCache } from '../src/patterns/keys-bank.js';

function makeCtx(seed: string | number, genre: Genre = 'brightPop'): GeneratorContext {
  const params: GenerateParams = { genre, key: 'C', bpm: 120, seed };
  return { rng: createRng(seed), params };
}

function freshKeysRng(seed: string | number): Rng {
  return createRng(seed).fork('patterns/keys');
}

// docs/58i — the roster is probabilistic, so Keys is not guaranteed on a given
// seed. Scan for a brightPop seed whose roster includes a Keys lane.
function keysPresentSeed(start = 0): string {
  for (let i = start; i < 400; i++) {
    const seed = `keys-present-${i}`;
    const ctx = makeCtx(seed);
    const structure = generateChords(ctx, generateSongStructure(ctx));
    const selection = selectInstruments(ctx, structure);
    if (selection.instruments.some((s) => s.lane === 'Keys')) return seed;
  }
  throw new Error('keysPresentSeed: no brightPop seed produced a Keys lane');
}

describe('keys bank manifest', () => {
  it('declares the legacy chordsStraight style', () => {
    expect(describeKeysBank().styles).toContain('chordsStraight');
  });

  it('maps every canonical brain genre to at least one keys style', () => {
    const bank = describeKeysBank();
    for (const g of GenreSchema.options) {
      expect(bank.genreStyles[g], `genre "${g}" missing keys style mapping`).toBeDefined();
      expect(bank.genreStyles[g]!.length).toBeGreaterThan(0);
    }
  });

  it('every style bank carries at least one pattern (the bank import is non-empty)', () => {
    const bank = describeKeysBank();
    for (const [name, count] of Object.entries(bank.patternCount)) {
      expect(count, `style "${name}" has no patterns`).toBeGreaterThan(0);
    }
  });

  it('declares the legacy lengthDurations map (short/medium/long)', () => {
    const ld = describeKeysBank().lengthDurations;
    expect(ld.short).toEqual([0.25, 0.5]);
    expect(ld.medium).toEqual([1]);
    expect(ld.long).toEqual([2, 3]);
  });

  it('selector throws DataAssetError on a non-canonical genre name', () => {
    const rng = freshKeysRng('any');
    expect(() => selectKeysPattern(rng, 'pop')).toThrow(DataAssetError);
    expect(() => selectKeysPattern(rng, 'jazz')).toThrow(DataAssetError);
  });

  it('cache reset re-reads disk without changing semantics', () => {
    const before = describeKeysBank();
    _resetKeysBankCache();
    const after = describeKeysBank();
    expect(after).toEqual(before);
  });
});

describe('selectKeysPattern determinism', () => {
  it('same seed → same pattern index (a contract the goldens depend on)', () => {
    const a = selectKeysPattern(freshKeysRng('repro-seed'), 'brightPop');
    const b = selectKeysPattern(freshKeysRng('repro-seed'), 'brightPop');
    expect(a.patternIndex).toBe(b.patternIndex);
    expect(a.styleName).toBe(b.styleName);
    expect(a.pattern.id).toBe(b.pattern.id);
  });

  it('different seeds → distinct picks across 16 trials (chordsStraight has > 1 pattern)', () => {
    const seeds = Array.from({ length: 16 }, (_, i) => `keys-seed-${i}`);
    const picks = new Set(
      seeds.map((s) => selectKeysPattern(freshKeysRng(s), 'brightPop').patternIndex),
    );
    expect(picks.size).toBeGreaterThan(1);
  });

  it('patternBars >= 1 and matches the legacy 2-bar shape for every imported style', () => {
    for (const g of GenreSchema.options) {
      const sel = selectKeysPattern(freshKeysRng(`bars-${g}`), g);
      expect(sel.patternBars).toBeGreaterThanOrEqual(1);
      expect(sel.patternBars).toBeLessThanOrEqual(2);
    }
  });
});

describe('generateKeysPattern × per-genre coverage', () => {
  // `selectInstruments` is brightPop-only (the slice gate from
  // 53d-step5-selection.md). These bank-level tests exercise every
  // canonical genre directly via the keys generator, with a synthetic
  // Segment carrying valid chord symbols.
  const SYNTHETIC_SEGMENT = {
    name: 'chorus1',
    bars: [
      { chords: ['C', 'G', 'Am', 'F'] },
      { chords: ['C', 'G', 'Am', 'F'] },
      { chords: ['F', 'C', 'G', 'G'] },
      { chords: ['Am', 'F', 'C', 'G'] },
    ],
  };
  for (const genre of GenreSchema.options) {
    it(`emits a non-empty keys pattern for genre "${genre}"`, () => {
      const ctx = makeCtx(`${genre}-coverage`, genre);
      const result = generateKeysPattern(
        ctx,
        SYNTHETIC_SEGMENT as never,
        ['keys'] as never,
      );
      expect(result).toBeDefined();
      let events = 0;
      for (const bar of result!.bars) {
        for (const evs of Object.values(bar.notes)) events += evs.length;
      }
      expect(events).toBeGreaterThan(0);
    });
  }

  it('end-to-end brightPop pipeline emits keys events for every keys-active segment', () => {
    const ctx = makeCtx(keysPresentSeed());
    const structure = generateChords(ctx, generateSongStructure(ctx));
    const selection = selectInstruments(ctx, structure);
    const patterns = generatePatterns(ctx, structure, selection);
    let keysActiveSegments = 0;
    let keysEvents = 0;
    for (const segment of patterns.segments) {
      const keys = segment.lanes.Keys;
      if (!keys) continue;
      keysActiveSegments++;
      for (const bar of keys.bars) {
        for (const evs of Object.values(bar.notes)) keysEvents += evs.length;
      }
    }
    expect(keysActiveSegments).toBeGreaterThan(0);
    expect(keysEvents).toBeGreaterThan(0);
  });
});

describe('generateKeysPattern invariants', () => {
  function keysFor(seed: string | number): {
    structure: ReturnType<typeof generateSongStructure>;
    patterns: ReturnType<typeof generatePatterns>;
  } {
    const ctx = makeCtx(seed);
    const structure = generateChords(ctx, generateSongStructure(ctx));
    const selection = selectInstruments(ctx, structure);
    const patterns = generatePatterns(ctx, structure, selection);
    return { structure, patterns };
  }

  // docs/58 — keys dispatches per-genre via bank-index.json#genreStyles to
  // either `library`/`altLibrary` (emits noteRelative) or a chord-event
  // style. edm + schlager route to `edmHousePiano` (chord events). The
  // three invariants below pin the CHORD-EVENT contract — they call
  // `generateKeysPattern` directly with a synthetic chord-bearing
  // segment + genre='edm' so the dispatcher routes to edmHousePiano
  // regardless of selection-side activity. The noteRelative invariants
  // for the library path are pinned in patterns.spec.ts (keys
  // noteRelative tests).
  const SYNTHETIC_KEYS_SEGMENT = {
    name: 'chorus1',
    bars: [
      { chords: ['C', 'G', 'Am', 'F'] },
      { chords: ['C', 'G', 'Am', 'F'] },
      { chords: ['F', 'C', 'G', 'G'] },
      { chords: ['Am', 'F', 'C', 'G'] },
    ],
  };
  function chordEventKeysFor(seed: string | number): {
    structure: { name: string; bars: { chords: string[] }[] }[];
    family: FamilyPattern;
  } {
    const ctx = makeCtx(seed, 'edm');
    const family = generateKeysPattern(
      ctx,
      SYNTHETIC_KEYS_SEGMENT as never,
      ['keys'] as never,
    );
    if (!family) throw new Error('chordEventKeysFor: keys generator returned undefined');
    return {
      structure: [SYNTHETIC_KEYS_SEGMENT],
      family,
    };
  }

  it('every emitted BarBeat key is in [0, beatsPerBar()) — no overflow into the next bar', () => {
    const beats = beatsPerBar();
    for (const seed of ['kb-1', 'kb-2', 'kb-3']) {
      const { patterns } = keysFor(seed);
      for (const segment of patterns.segments) {
        const keys = segment.lanes.Keys;
        if (!keys) continue;
        for (const bar of keys.bars) {
          for (const key of Object.keys(bar.notes)) {
            const b = parseBarBeat(key);
            expect(b).toBeGreaterThanOrEqual(0);
            expect(b).toBeLessThan(beats);
          }
        }
      }
    }
  });

  it('keys bar count matches structure bar count for every keys-active segment', () => {
    const { structure, patterns } = keysFor('keys-bar-alignment');
    const byName = new Map(structure.map((s) => [s.name, s.bars.length]));
    for (const segment of patterns.segments) {
      const keys = segment.lanes.Keys;
      if (!keys) continue;
      expect(keys.bars.length).toBe(byName.get(segment.segmentName));
    }
  });

  it('edmHousePiano: every emitted event is a chord event with a parseable ChordSymbol and a positive duration', () => {
    const { family } = chordEventKeysFor('keys-shape');
    let inspected = 0;
    for (const bar of family.bars) {
      for (const evs of Object.values(bar.notes)) {
        for (const ev of evs) {
          expect(ev.type).toBe('chord');
          if (ev.type !== 'chord') continue;
          expect(ChordSymbolSchema.safeParse(ev.chord).success).toBe(true);
          expect(parseChord(ev.chord).quality).not.toBe('unknown');
          expect(ev.duration).toBeDefined();
          expect(ev.duration!).toBeGreaterThan(0);
          inspected++;
        }
      }
    }
    expect(inspected).toBeGreaterThan(0);
  });

  it("edmHousePiano: every emitted keys event's chord matches the segment-bar's chord at floor(beat)", () => {
    const { structure, family } = chordEventKeysFor('keys-chord-relation');
    let inspected = 0;
    family.bars.forEach((bar, barIdx) => {
      for (const [key, evs] of Object.entries(bar.notes)) {
        const beat = parseBarBeat(key);
        const chordIdx = Math.floor(beat);
        const expected =
          structure[0]!.bars[barIdx]!.chords[chordIdx] ?? structure[0]!.bars[barIdx]!.chords[0]!;
        for (const ev of evs) {
          if (ev.type !== 'chord') continue;
          expect(ev.chord).toBe(expected);
          inspected++;
        }
      }
    });
    expect(inspected).toBeGreaterThan(0);
  });

  it('edmHousePiano: emitted hit durations are clamped to the legacy min(duration, 0.5)', () => {
    const allowed = new Set<number>([0.25, 0.5]);
    const { family } = chordEventKeysFor('duration-pool-check');
    let inspected = 0;
    for (const bar of family.bars) {
      for (const evs of Object.values(bar.notes)) {
        for (const ev of evs) {
          if (ev.type !== 'chord') continue;
          expect(allowed.has(ev.duration!)).toBe(true);
          inspected++;
        }
      }
    }
    expect(inspected).toBeGreaterThan(0);
  });

  it('emitted BarBeat keys are normalised via formatBarBeat', () => {
    const { patterns } = keysFor('format-check');
    for (const segment of patterns.segments) {
      const keys = segment.lanes.Keys;
      if (!keys) continue;
      for (const bar of keys.bars) {
        for (const key of Object.keys(bar.notes)) {
          expect(key).toBe(formatBarBeat(parseBarBeat(key)));
        }
      }
    }
  });

  it('same seed → byte-identical keys content (canary against hidden Math.random use)', () => {
    function keysBytes(seed: string): string {
      const { patterns } = keysFor(seed);
      const onlyKeys: Record<string, FamilyPattern> = {};
      for (const segment of patterns.segments) {
        if (segment.lanes.Keys) onlyKeys[segment.segmentName] = segment.lanes.Keys;
      }
      return stableStringify(onlyKeys, 2);
    }
    expect(keysBytes('determinism-A')).toBe(keysBytes('determinism-A'));
  });

  it('different seeds → different keys content somewhere across a multi-bar song', () => {
    function keysBytes(seed: string): string {
      const { patterns } = keysFor(seed);
      const onlyKeys: Record<string, FamilyPattern> = {};
      for (const segment of patterns.segments) {
        if (segment.lanes.Keys) onlyKeys[segment.segmentName] = segment.lanes.Keys;
      }
      return stableStringify(onlyKeys, 2);
    }
    // Two distinct keys-present seeds (roster is probabilistic — docs/58i).
    const s1 = keysPresentSeed(0);
    const s2 = keysPresentSeed(Number(s1.split('-').pop()) + 1);
    expect(keysBytes(s1)).not.toBe(keysBytes(s2));
  });

  it('does not mutate the input structure', () => {
    const ctx = makeCtx('immutability-keys');
    const structure = generateChords(ctx, generateSongStructure(ctx));
    const before = stableStringify(structure, 2);
    const selection = selectInstruments(ctx, structure);
    generatePatterns(ctx, structure, selection);
    expect(stableStringify(structure, 2)).toBe(before);
  });
});

describe('cross-family fork-salt independence (drums/bass goldens stay byte-stable)', () => {
  // Adding the keys bank fork (`patterns/keys`) must not shift the drum
  // or bass streams. Reproduce step-10 / step-11 invariants for the
  // canonical seed exactly.
  it('step-10 drum invariant + step-11 bass-relationship invariant for the canonical seed', () => {
    const ctx = makeCtx('brightPop-vertical-slice');
    const structure = generateChords(ctx, generateSongStructure(ctx));
    const selection = selectInstruments(ctx, structure);
    const patterns = generatePatterns(ctx, structure, selection);
    const chorus = patterns.segments.find((s) => s.segmentName === 'chorus1');
    expect(chorus, 'chorus1 segment missing').toBeDefined();

    // Drums — popTight algo invariant (docs/58): bassDrum1 (36) on
    // beats 1 & 3 (0.0, 2.0), snareDrum1 (38) on beats 2 & 4 (1.0,
    // 3.0), clap (39) on the & of beat 4 (3.5), closed-hat (42) on
    // the offbeats.
    const drums = chorus!.lanes.Drums!;
    expect(drums).toBeDefined();
    const bar0 = drums.bars[0]!;
    const at = (k: string): number[] =>
      (bar0.notes[k] ?? [])
        .filter((e) => e.type === 'note')
        .map((e) => (e.type === 'note' ? (e.note as number) : -1));
    expect(at('0.0')).toContain(36);
    expect(at('2.0')).toContain(36);
    expect(at('1.0')).toContain(38);
    expect(at('3.0')).toContain(38);
    expect(at('3.5')).toContain(39);
    expect(at('0.5')).toContain(42);

    // Bass — relationship invariant: every bass pitch within ±2
    // octaves of the chord root in bass octave 2.
    const bass = chorus!.lanes.Bass!;
    expect(bass).toBeDefined();
    const structSeg = structure.find((s) => s.name === 'chorus1')!;
    bass.bars.forEach((bar, barIdx) => {
      for (const [key, evs] of Object.entries(bar.notes)) {
        const beat = parseBarBeat(key);
        const chordIdx = Math.floor(beat);
        const chordSymbol =
          structSeg.bars[barIdx]!.chords[chordIdx] ?? structSeg.bars[barIdx]!.chords[0]!;
        const expectedRoot = parseChord(chordSymbol).root;
        const baseMidi = 36 + expectedRoot;
        for (const ev of evs) {
          if (ev.type !== 'note') continue;
          expect(Math.abs((ev.note as number) - baseMidi)).toBeLessThanOrEqual(24);
        }
      }
    });
  });
});
