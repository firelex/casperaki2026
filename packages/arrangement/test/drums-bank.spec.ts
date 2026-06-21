// Step 10 — legacy-derived drum pattern bank tests.
//
// Pin the bank loader's invariants, the selection determinism contract, and
// per-genre coverage. Goldens live in
// `packages/arrangement/test/fixtures/golden/patterns/…` and are exercised
// by patterns.spec.ts; this file targets the bank/selector and the per-
// genre fan-out the legacy import enables (see docs/53u).

import { describe, expect, it } from 'vitest';

import {
  beatsPerBar,
  createRng,
  formatBarBeat,
  parseBarBeat,
  type Rng,
} from '@casperaki/music-theory';
import { GenreSchema, MidiNoteSchema, type Genre } from '@casperaki/song-schema';

import {
  DataAssetError,
  describeDrumBank,
  generateChords,
  generatePatterns,
  generateSongStructure,
  selectDrumBlueprint,
  selectInstruments,
  type GenerateParams,
  type GeneratorContext,
} from '../src/index.js';
import { _resetDrumBankCache } from '../src/patterns/drums-bank.js';

function makeCtx(seed: string | number, genre: Genre = 'brightPop'): GeneratorContext {
  const params: GenerateParams = { genre, key: 'C', bpm: 120, seed };
  return { rng: createRng(seed), params };
}

function freshDrumRng(seed: string | number): Rng {
  // Mirror what generateDrumPattern does internally so blueprint-pick tests
  // and pipeline tests observe the same selection.
  return createRng(seed).fork('patterns/drums');
}

describe('drum bank manifest', () => {
  it('describes lanes, styles, and a genreStyles mapping for every canonical brain genre', () => {
    const bank = describeDrumBank();
    expect(bank.styles).toContain('drLuke');
    expect(bank.styles).toContain('rock');
    expect(Object.keys(bank.lanes).sort()).toEqual(
      [
        'bassDrum1', 'bassDrum2', 'clap', 'crash1', 'crash2',
        'hiHatClosed1', 'hiHatClosed2', 'hiHatOpen', 'hiHatPedal',
        'ride', 'rim', 'shaker', 'snap', 'snareDrum1', 'snareDrum2',
        'tom1', 'tom2', 'tom3',
      ].sort(),
    );
    // Every canonical brain genre must resolve to *some* style; per-genre
    // dedicated banks are deferred (53k engine-bridge inventory) but the
    // pipeline must not throw for them today.
    for (const g of GenreSchema.options) {
      expect(bank.genreStyles[g], `genre "${g}" has no drum style mapping`).toBeDefined();
      expect(bank.genreStyles[g]!.length).toBeGreaterThan(0);
    }
  });

  it('all lane MIDI numbers validate as canonical MidiNote', () => {
    const bank = describeDrumBank();
    for (const [lane, midi] of Object.entries(bank.lanes)) {
      const parse = MidiNoteSchema.safeParse(midi);
      expect(parse.success, `${lane} → ${midi}`).toBe(true);
    }
  });

  it('canonical Drums-only kit lanes (bassDrum1=36, snareDrum1=38, hiHatClosed1=42) are stable', () => {
    const bank = describeDrumBank();
    expect(bank.lanes.bassDrum1).toBe(36);
    expect(bank.lanes.snareDrum1).toBe(38);
    expect(bank.lanes.hiHatClosed1).toBe(42);
  });

  it('selector throws DataAssetError on a non-canonical genre name', () => {
    const rng = freshDrumRng('any');
    expect(() => selectDrumBlueprint(rng, 'pop')).toThrow(DataAssetError);
    expect(() => selectDrumBlueprint(rng, 'jazz')).toThrow(DataAssetError);
  });

  it('cache reset re-reads disk without changing semantics', () => {
    const before = describeDrumBank();
    _resetDrumBankCache();
    const after = describeDrumBank();
    expect(after).toEqual(before);
  });
});

describe('selectDrumBlueprint determinism', () => {
  it('same seed → same blueprint index (a contract the goldens depend on)', () => {
    const a = selectDrumBlueprint(freshDrumRng('repro-seed'), 'brightPop');
    const b = selectDrumBlueprint(freshDrumRng('repro-seed'), 'brightPop');
    expect(a.blueprintIndex).toBe(b.blueprintIndex);
    expect(a.styleName).toBe(b.styleName);
  });

  it('different seeds → distinct blueprint picks across a small sample (library bank has >1 blueprint)', () => {
    // Sample 16 seeds and assert at least two distinct indices land. `rock`
    // is a LIBRARY style (6 blueprints); a uniform draw across 16 trials has
    // overwhelming odds of producing variety. (brightPop is now an algo
    // style — its variety is in generated content, asserted below — so it
    // reports blueprintIndex -1 and can't exercise the index-draw contract.)
    const seeds = Array.from({ length: 16 }, (_, i) => `seed-${i}`);
    const picks = new Set(
      seeds.map((s) => selectDrumBlueprint(freshDrumRng(s), 'rock').blueprintIndex),
    );
    expect(picks.size).toBeGreaterThan(1);
  });

  it('algo styles report blueprintIndex -1 and produce varied content across seeds', () => {
    // docs/58 — brightPop resolves to the algorithmic `popTight` generator.
    // Algo styles have no library index (so blueprintIndex is -1), but the
    // generated blueprint must still vary across seeds.
    const seeds = Array.from({ length: 16 }, (_, i) => `algo-seed-${i}`);
    const sels = seeds.map((s) => selectDrumBlueprint(freshDrumRng(s), 'brightPop'));
    for (const sel of sels) expect(sel.blueprintIndex).toBe(-1);
    const contents = new Set(sels.map((s) => JSON.stringify(s.blueprint)));
    expect(contents.size).toBeGreaterThan(1);
  });

  it('blueprintBars >= 1 and matches the legacy ceil(lastHit/32)*32 rule', () => {
    const sel = selectDrumBlueprint(freshDrumRng('bars-check'), 'brightPop');
    expect(sel.blueprintBars).toBeGreaterThanOrEqual(1);
    let lastBeat = 0;
    for (const positions of Object.values(sel.blueprint)) {
      for (const p of positions) if (p > lastBeat) lastBeat = p;
    }
    const expectedBars = Math.max(1, Math.ceil((lastBeat * 8) / 32));
    expect(sel.blueprintBars).toBe(expectedBars);
  });
});

describe('generateDrumPattern × per-genre coverage', () => {
  // The brain's `selectInstruments` is still brightPop-only (a deferred
  // pre-req from earlier slice steps — see docs/53u "Selection coverage
  // dependency"). These tests target the bank + selector directly so we
  // can prove drum coverage for every canonical genre TODAY, even though
  // the end-to-end pipeline still gates on brightPop.
  for (const genre of GenreSchema.options) {
    it(`bank resolves a non-empty blueprint for genre "${genre}"`, () => {
      const sel = selectDrumBlueprint(freshDrumRng(`${genre}-coverage`), genre);
      expect(sel.styleName.length).toBeGreaterThan(0);
      const hitCount = Object.values(sel.blueprint)
        .flat()
        .filter((p) => p >= 0)
        .length;
      expect(hitCount).toBeGreaterThan(0);
    });
  }

  it('end-to-end pipeline runs for brightPop and emits drum events for every drums-active segment', () => {
    // The selection layer is brightPop-only; this is the one genre that
    // exercises the full pipeline end-to-end today.
    const ctx = makeCtx('end-to-end-coverage');
    const structure = generateChords(ctx, generateSongStructure(ctx));
    const selection = selectInstruments(ctx, structure);
    const patterns = generatePatterns(ctx, structure, selection);
    let drumEventCount = 0;
    let drumsActiveSegments = 0;
    for (const segment of patterns.segments) {
      const drums = segment.lanes.Drums;
      if (!drums) continue;
      drumsActiveSegments++;
      for (const bar of drums.bars) {
        for (const events of Object.values(bar.notes)) {
          drumEventCount += events.length;
        }
      }
    }
    expect(drumsActiveSegments).toBeGreaterThan(0);
    expect(drumEventCount).toBeGreaterThan(0);
  });

  it('every emitted drum event uses a beat position in [0, beatsPerBar()) regardless of segment length', () => {
    const beats = beatsPerBar();
    for (const seed of ['beat-range-1', 'beat-range-2', 'beat-range-3']) {
      const ctx = makeCtx(seed);
      const structure = generateChords(ctx, generateSongStructure(ctx));
      const selection = selectInstruments(ctx, structure);
      const patterns = generatePatterns(ctx, structure, selection);
      for (const segment of patterns.segments) {
        const drums = segment.lanes.Drums;
        if (!drums) continue;
        for (const bar of drums.bars) {
          for (const key of Object.keys(bar.notes)) {
            const b = parseBarBeat(key);
            expect(b).toBeGreaterThanOrEqual(0);
            expect(b).toBeLessThan(beats);
          }
        }
      }
    }
  });

  it('drum bar count matches structure bar count for every drums-active segment (no overflow / no truncation)', () => {
    const ctx = makeCtx('drum-bar-alignment');
    const structure = generateChords(ctx, generateSongStructure(ctx));
    const selection = selectInstruments(ctx, structure);
    const patterns = generatePatterns(ctx, structure, selection);
    const byName = new Map(structure.map((s) => [s.name, s.bars.length]));
    for (const segment of patterns.segments) {
      const drums = segment.lanes.Drums;
      if (!drums) continue;
      expect(drums.bars.length).toBe(byName.get(segment.segmentName));
    }
  });

  it('same seed → byte-identical drum pattern across two runs (canary against hidden Math.random use)', () => {
    function drumsFor(seed: string): string {
      const ctx = makeCtx(seed);
      const structure = generateChords(ctx, generateSongStructure(ctx));
      const selection = selectInstruments(ctx, structure);
      const patterns = generatePatterns(ctx, structure, selection);
      const drumsByName: Record<string, unknown> = {};
      for (const segment of patterns.segments) {
        if (segment.lanes.Drums) drumsByName[segment.segmentName] = segment.lanes.Drums;
      }
      return JSON.stringify(drumsByName);
    }
    expect(drumsFor('determinism-seed')).toBe(drumsFor('determinism-seed'));
  });

  it('different seeds produce different drum content somewhere across a multi-bar song', () => {
    function drumsFor(seed: string): string {
      const ctx = makeCtx(seed);
      const structure = generateChords(ctx, generateSongStructure(ctx));
      const selection = selectInstruments(ctx, structure);
      const patterns = generatePatterns(ctx, structure, selection);
      const out: string[] = [];
      for (const segment of patterns.segments) {
        const drums = segment.lanes.Drums;
        if (!drums) continue;
        out.push(`${segment.segmentName}:${JSON.stringify(drums)}`);
      }
      return out.join('|');
    }
    expect(drumsFor('variation-A')).not.toBe(drumsFor('variation-B'));
  });

  it('emitted BarBeat keys are normalised via formatBarBeat (no "2.5000000" trailing zeros)', () => {
    const ctx = makeCtx('keys-format');
    const structure = generateChords(ctx, generateSongStructure(ctx));
    const selection = selectInstruments(ctx, structure);
    const patterns = generatePatterns(ctx, structure, selection);
    for (const segment of patterns.segments) {
      const drums = segment.lanes.Drums;
      if (!drums) continue;
      for (const bar of drums.bars) {
        for (const key of Object.keys(bar.notes)) {
          expect(key).toBe(formatBarBeat(parseBarBeat(key)));
        }
      }
    }
  });
});
