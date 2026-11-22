// Step 11 — legacy-derived bass pattern bank tests.
//
// Pin the SM (Simple/Manual) bank loader's invariants, the selection
// determinism contract, per-genre coverage, and the chord-aware MIDI
// lowering the legacy SMBassPatternGeneratorClass.createBassPattern
// performs. See docs/53v.

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
  GenreSchema,
  MidiNoteSchema,
  stableStringify,
  type Genre,
} from '@casperaki/song-schema';

import {
  DataAssetError,
  describeBassBank,
  generateBassPattern,
  generateChords,
  generatePatterns,
  generateSongStructure,
  selectBassPattern,
  selectInstruments,
  type FamilyPattern,
  type GenerateParams,
  type GeneratorContext,
} from '../src/index.js';
import { _resetBassBankCache } from '../src/patterns/bass-bank.js';

function makeCtx(seed: string | number, genre: Genre = 'brightPop'): GeneratorContext {
  const params: GenerateParams = { genre, key: 'C', bpm: 120, seed };
  return { rng: createRng(seed), params };
}

function freshBassRng(seed: string | number): Rng {
  return createRng(seed).fork('patterns/bass');
}

describe('bass bank manifest', () => {
  it('declares an SM style for every legacy SM bank that was imported', () => {
    const bank = describeBassBank();
    expect(new Set(bank.styles)).toEqual(
      new Set(['balladSM', 'brightPopSM', 'edmHardSM', 'edmSoftSM', 'latinSM', 'rockSM', 'urbanSM']),
    );
  });

  it('maps every canonical brain genre to at least one SM style', () => {
    const bank = describeBassBank();
    for (const g of GenreSchema.options) {
      expect(bank.genreStyles[g], `genre "${g}" missing bass style mapping`).toBeDefined();
      expect(bank.genreStyles[g]!.length).toBeGreaterThan(0);
    }
  });

  it('every style bank carries at least one pattern (the bank import is non-empty)', () => {
    const bank = describeBassBank();
    for (const [name, count] of Object.entries(bank.patternCount)) {
      expect(count, `style "${name}" has no patterns`).toBeGreaterThan(0);
    }
  });

  it('rootMidiOctave is 2 (the value SMBassPatternGeneratorClass hard-coded)', () => {
    expect(describeBassBank().rootMidiOctave).toBe(2);
  });

  it('selector throws DataAssetError on a non-canonical genre name', () => {
    const rng = freshBassRng('any');
    expect(() => selectBassPattern(rng, 'pop')).toThrow(DataAssetError);
    expect(() => selectBassPattern(rng, 'jazz')).toThrow(DataAssetError);
  });

  it('cache reset re-reads disk without changing semantics', () => {
    const before = describeBassBank();
    _resetBassBankCache();
    const after = describeBassBank();
    expect(after).toEqual(before);
  });
});

describe('selectBassPattern determinism', () => {
  it('same seed → same pattern index (a contract the goldens depend on)', () => {
    const a = selectBassPattern(freshBassRng('repro-seed'), 'brightPop');
    const b = selectBassPattern(freshBassRng('repro-seed'), 'brightPop');
    expect(a.patternIndex).toBe(b.patternIndex);
    expect(a.styleName).toBe(b.styleName);
  });

  it('different seeds → distinct picks across 16 trials (brightPopSM has > 1 pattern)', () => {
    const seeds = Array.from({ length: 16 }, (_, i) => `bass-seed-${i}`);
    const picks = new Set(
      seeds.map((s) => selectBassPattern(freshBassRng(s), 'brightPop').patternIndex),
    );
    expect(picks.size).toBeGreaterThan(1);
  });

  it('patternBars >= 1 and matches the legacy 2-bar SM shape for every imported style', () => {
    for (const g of GenreSchema.options) {
      const sel = selectBassPattern(freshBassRng(`bars-${g}`), g);
      expect(sel.patternBars).toBeGreaterThanOrEqual(1);
      expect(sel.patternBars).toBeLessThanOrEqual(2);
    }
  });
});

describe('generateBassPattern × per-genre coverage', () => {
  // `selectInstruments` is brightPop-only (the slice gate from
  // 53d-step5-selection.md). These bank-level tests therefore exercise
  // every canonical genre directly via the bass generator, with a
  // synthetic Segment carrying valid chord symbols.
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
    it(`emits a non-empty bass pattern for genre "${genre}"`, () => {
      const ctx = makeCtx(`${genre}-coverage`, genre);
      const result = generateBassPattern(
        ctx,
        SYNTHETIC_SEGMENT as never,
        ['bass'] as never,
        undefined,
        new Set([0, 5, 7, 9]), // C, F, G, A
      );
      expect(result).toBeDefined();
      let events = 0;
      for (const bar of result!.bars) {
        for (const evs of Object.values(bar.notes)) events += evs.length;
      }
      expect(events).toBeGreaterThan(0);
    });
  }

  it('end-to-end brightPop pipeline emits bass events for every bass-active segment', () => {
    const ctx = makeCtx('end-to-end-bass');
    const structure = generateChords(ctx, generateSongStructure(ctx));
    const selection = selectInstruments(ctx, structure);
    const patterns = generatePatterns(ctx, structure, selection);
    let bassActiveSegments = 0;
    let bassEvents = 0;
    for (const segment of patterns.segments) {
      const bass = segment.lanes.Bass;
      if (!bass) continue;
      bassActiveSegments++;
      for (const bar of bass.bars) {
        for (const evs of Object.values(bar.notes)) bassEvents += evs.length;
      }
    }
    expect(bassActiveSegments).toBeGreaterThan(0);
    expect(bassEvents).toBeGreaterThan(0);
  });
});

describe('generateBassPattern invariants', () => {
  function bassFor(seed: string | number): {
    structure: ReturnType<typeof generateSongStructure>;
    patterns: ReturnType<typeof generatePatterns>;
  } {
    const ctx = makeCtx(seed);
    const structure = generateChords(ctx, generateSongStructure(ctx));
    const selection = selectInstruments(ctx, structure);
    const patterns = generatePatterns(ctx, structure, selection);
    return { structure, patterns };
  }

  it('every emitted BarBeat key is in [0, beatsPerBar()) — no overflow into the next bar', () => {
    const beats = beatsPerBar();
    for (const seed of ['beat-1', 'beat-2', 'beat-3']) {
      const { patterns } = bassFor(seed);
      for (const segment of patterns.segments) {
        const bass = segment.lanes.Bass;
        if (!bass) continue;
        for (const bar of bass.bars) {
          for (const key of Object.keys(bar.notes)) {
            const b = parseBarBeat(key);
            expect(b).toBeGreaterThanOrEqual(0);
            expect(b).toBeLessThan(beats);
          }
        }
      }
    }
  });

  it('bass bar count matches structure bar count for every bass-active segment', () => {
    const { structure, patterns } = bassFor('bass-bar-alignment');
    const byName = new Map(structure.map((s) => [s.name, s.bars.length]));
    for (const segment of patterns.segments) {
      const bass = segment.lanes.Bass;
      if (!bass) continue;
      expect(bass.bars.length).toBe(byName.get(segment.segmentName));
    }
  });

  it('every emitted note validates as MidiNote (in [0, 127])', () => {
    const { patterns } = bassFor('midi-range');
    for (const segment of patterns.segments) {
      const bass = segment.lanes.Bass;
      if (!bass) continue;
      for (const bar of bass.bars) {
        for (const evs of Object.values(bar.notes)) {
          for (const ev of evs) {
            expect(ev.type).toBe('note');
            if (ev.type === 'note') {
              expect(MidiNoteSchema.safeParse(ev.note).success).toBe(true);
            }
          }
        }
      }
    }
  });

  it('every emitted note has a positive duration (SM bank carries explicit per-hit durations)', () => {
    const { patterns } = bassFor('duration-check');
    for (const segment of patterns.segments) {
      const bass = segment.lanes.Bass;
      if (!bass) continue;
      for (const bar of bass.bars) {
        for (const evs of Object.values(bar.notes)) {
          for (const ev of evs) {
            if (ev.type === 'note') {
              expect(ev.duration).toBeDefined();
              expect(ev.duration!).toBeGreaterThan(0);
            }
          }
        }
      }
    }
  });

  it('every emitted bass pitch is within ±2 octaves of the chord root at floor(beat) of its bar', () => {
    const { structure, patterns } = bassFor('chord-relation');
    const byName = new Map(structure.map((s) => [s.name, s]));
    for (const segment of patterns.segments) {
      const bass = segment.lanes.Bass;
      if (!bass) continue;
      const struct = byName.get(segment.segmentName)!;
      bass.bars.forEach((bar, barIdx) => {
        for (const [key, evs] of Object.entries(bar.notes)) {
          const beat = parseBarBeat(key);
          const chordIdx = Math.floor(beat);
          const chordSymbol =
            struct.bars[barIdx]!.chords[chordIdx] ?? struct.bars[barIdx]!.chords[0]!;
          const expectedRoot = parseChord(chordSymbol).root;
          const baseMidi = 36 + expectedRoot;
          for (const ev of evs) {
            if (ev.type !== 'note') continue;
            expect(Math.abs((ev.note as number) - baseMidi)).toBeLessThanOrEqual(24);
          }
        }
      });
    }
  });

  it('emitted BarBeat keys are normalised via formatBarBeat', () => {
    const { patterns } = bassFor('format-check');
    for (const segment of patterns.segments) {
      const bass = segment.lanes.Bass;
      if (!bass) continue;
      for (const bar of bass.bars) {
        for (const key of Object.keys(bar.notes)) {
          expect(key).toBe(formatBarBeat(parseBarBeat(key)));
        }
      }
    }
  });

  it('same seed → byte-identical bass content (canary against hidden Math.random use)', () => {
    function bassBytes(seed: string): string {
      const { patterns } = bassFor(seed);
      const onlyBass: Record<string, FamilyPattern> = {};
      for (const segment of patterns.segments) {
        if (segment.lanes.Bass) onlyBass[segment.segmentName] = segment.lanes.Bass;
      }
      return stableStringify(onlyBass, 2);
    }
    expect(bassBytes('determinism-A')).toBe(bassBytes('determinism-A'));
  });

  it('different seeds → different bass content somewhere across a multi-bar song', () => {
    function bassBytes(seed: string): string {
      const { patterns } = bassFor(seed);
      const onlyBass: Record<string, FamilyPattern> = {};
      for (const segment of patterns.segments) {
        if (segment.lanes.Bass) onlyBass[segment.segmentName] = segment.lanes.Bass;
      }
      return stableStringify(onlyBass, 2);
    }
    expect(bassBytes('variation-A')).not.toBe(bassBytes('variation-B'));
  });

  it('does not mutate the input structure', () => {
    const ctx = makeCtx('immutability-bass');
    const structure = generateChords(ctx, generateSongStructure(ctx));
    const before = stableStringify(structure, 2);
    const selection = selectInstruments(ctx, structure);
    generatePatterns(ctx, structure, selection);
    expect(stableStringify(structure, 2)).toBe(before);
  });
});

describe('cross-family fork-salt independence (drums golden invariance)', () => {
  // The bass generator forks `patterns/bass`; the drum generator forks
  // `patterns/drums`. Because Rng.fork creates a derived stream without
  // advancing the parent (music-theory/rng.ts), the drum bytes for the
  // canonical seed must be byte-identical to step 10's output.
  it('step-10 drum invariant for the canonical seed still holds (popTight tight backbeat)', () => {
    const ctx = makeCtx('brightPop-vertical-slice');
    const structure = generateChords(ctx, generateSongStructure(ctx));
    const selection = selectInstruments(ctx, structure);
    const patterns = generatePatterns(ctx, structure, selection);
    const chorus = patterns.segments.find((s) => s.segmentName === 'chorus1');
    expect(chorus, 'chorus1 segment missing').toBeDefined();
    const drums = chorus!.lanes.Drums!;
    expect(drums).toBeDefined();
    const bar0 = drums.bars[0]!;
    const at = (k: string): number[] =>
      (bar0.notes[k] ?? [])
        .filter((e) => e.type === 'note')
        .map((e) => (e.type === 'note' ? (e.note as number) : -1));
    // Frozen invariant — brightPop now resolves to the popTight algo
    // generator (docs/58). For this seed it lands a tight backbeat:
    // bassDrum1 (36) on beats 1 & 3 (0.0, 2.0), snareDrum1 (38) on
    // beats 2 & 4 (1.0, 3.0), clap (39) on the & of beat 4 (3.5), and
    // closed-hat (42) on the offbeats.
    expect(at('0.0')).toContain(36);
    expect(at('2.0')).toContain(36);
    expect(at('1.0')).toContain(38);
    expect(at('3.0')).toContain(38);
    expect(at('3.5')).toContain(39);
    expect(at('0.5')).toContain(42);
  });
});
