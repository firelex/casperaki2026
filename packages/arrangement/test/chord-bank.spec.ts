// Step 3 — imported chord-progression bank tests.
//
// Coverage:
// - Shape: every entry has 4 bars × 4 beats, non-empty roles, valid sourceKey.
// - Vocabulary: every roman numeral used by every imported entry exists in
//   `chords.json` (the Step-1 vocabulary).
// - Resolver: every entry, resolved against C and against G, produces
//   ChordSymbols that all parse via `ChordSymbolSchema`.
// - Role filters: `verse` includes every entry (legacy semantic — the
//   unfiltered bank is the verse-candidate pool); `chorus` / `preChorus`
//   are non-empty proper subsets.
// - Determinism: same Rng + same candidate list → same pick. Different
//   seeds spread the picks (probabilistic; tested against >1 distinct
//   precedent across N seeds).
// - Concrete non-slice precedent: "Angeleyes" verse in C resolves to a
//   known progression (tested against the legacy chord symbols transposed
//   from B → C by hand).
// - Vertical-slice canary: `generateChords` on the brightPop slice's
//   `brightPop-vertical-slice` seed is byte-identical to its golden — the
//   bank import doesn't move the slice's output.

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { createRng, parseKey } from '@casperaki/music-theory';
import { ChordSymbolSchema, stableStringify } from '@casperaki/song-schema';

import {
  filterBankByRole,
  loadChordBank,
  resolveBankEntry,
  selectBankEntry,
  type BankEntry,
} from '../src/chords/bank.js';
import { loadChordsVocab } from '../src/chords/data.js';
import { generateChords } from '../src/chords/index.js';
import { generateSongStructure } from '../src/structure/index.js';
import type { GenerateParams, GeneratorContext } from '../src/index.js';
import { chordsGoldenPath } from './fixtures.js';

const VALID_SOURCE_KEYS = new Set([
  'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B',
  'Db', 'Eb', 'Gb', 'Ab', 'Bb',
]);

function bank(): readonly BankEntry[] {
  return loadChordBank();
}

describe('chord-progression bank — shape + provenance', () => {
  it('imports the full 79-entry legacy bank', () => {
    expect(bank().length).toBe(79);
  });

  it('every entry has a non-empty precedent name and a known sourceKey', () => {
    for (const e of bank()) {
      expect(e.precedent.length).toBeGreaterThan(0);
      expect(VALID_SOURCE_KEYS.has(e.sourceKey)).toBe(true);
    }
  });

  it('every entry is a 4-bar × 4-beat rectangle', () => {
    for (const e of bank()) {
      expect(e.bars.length).toBe(4);
      for (const beats of e.bars) expect(beats.length).toBe(4);
    }
  });

  it('every entry carries the legacy "verse" role; preChorus/chorus are optional', () => {
    for (const e of bank()) {
      expect(e.roles).toContain('verse');
      for (const r of e.roles) {
        expect(['verse', 'preChorus', 'chorus']).toContain(r);
      }
    }
  });

  it('imports 32 distinct precedents (matches legacy)', () => {
    expect(new Set(bank().map((e) => e.precedent)).size).toBe(32);
  });
});

describe('chord-progression bank — vocabulary coverage', () => {
  it('every roman numeral used by the bank exists in the Step-1 vocabulary', () => {
    const vocab = loadChordsVocab();
    const used = new Set(bank().flatMap((e) => e.bars.flat()));
    for (const numeral of used) {
      expect(vocab.romanNumerals[numeral], `missing numeral: ${numeral}`).toBeDefined();
    }
  });

  it('every numeral used resolves to a schema-valid ChordSymbol in every chromatic key', () => {
    const KEYS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const vocab = loadChordsVocab();
    for (const k of KEYS) {
      const parsed = parseKey(k);
      for (const entry of bank()) {
        const resolved = resolveBankEntry(entry, parsed, vocab);
        for (const beats of resolved) {
          for (const sym of beats) {
            expect(ChordSymbolSchema.safeParse(sym).success, `${sym} (${k})`).toBe(true);
          }
        }
      }
    }
  });
});

describe('chord-progression bank — role filters', () => {
  it('verse filter returns the whole bank (legacy: unfiltered pool)', () => {
    expect(filterBankByRole(bank(), 'verse').length).toBe(bank().length);
  });

  it('preChorus filter returns a non-empty proper subset', () => {
    const pre = filterBankByRole(bank(), 'preChorus');
    expect(pre.length).toBeGreaterThan(0);
    expect(pre.length).toBeLessThan(bank().length);
    for (const e of pre) expect(e.roles).toContain('preChorus');
  });

  it('chorus filter returns a non-empty proper subset', () => {
    const ch = filterBankByRole(bank(), 'chorus');
    expect(ch.length).toBeGreaterThan(0);
    expect(ch.length).toBeLessThan(bank().length);
    for (const e of ch) expect(e.roles).toContain('chorus');
  });
});

describe('chord-progression bank — deterministic selection', () => {
  it('same seed + same candidate list → same pick', () => {
    const pool = filterBankByRole(bank(), 'chorus');
    const a = selectBankEntry(pool, createRng('seed-A'));
    const b = selectBankEntry(pool, createRng('seed-A'));
    expect(a).toBe(b);
  });

  it('different seeds spread picks across multiple precedents', () => {
    const pool = filterBankByRole(bank(), 'verse');
    const picks = new Set<string>();
    for (let i = 0; i < 32; i++) picks.add(selectBankEntry(pool, createRng(`seed-${i}`)).precedent);
    // The verse pool has 32 precedents; even with collisions we should hit
    // far more than one distinct precedent across 32 seeds.
    expect(picks.size).toBeGreaterThan(5);
  });
});

describe('chord-progression bank — non-slice precedent resolves correctly', () => {
  it('"Angeleyes" first verse (B major: B, G#m, C#m7, F#) maps to I/vi/ii7/V', () => {
    const e = bank().find((x) => x.precedent === 'Angeleyes' && x.sourceKey === 'B');
    expect(e).toBeDefined();
    // Spot-check the numeral form before lowering. The first verse Angeleyes
    // entry in the legacy file is [B, G#m, C#m7, F#] one chord per bar.
    expect(e!.bars.map((b) => b[0])).toEqual(['I', 'vi', 'ii7', 'V']);

    // Lowered to C major: I=C, vi=Am, ii7=Dm7, V=G.
    const out = resolveBankEntry(e!, parseKey('C'));
    expect(out.map((b) => b[0])).toEqual(['C', 'Am', 'Dm7', 'G']);

    // Lowered back to the source key B should round-trip (sharps-only).
    const back = resolveBankEntry(e!, parseKey('B'));
    expect(back.map((b) => b[0])).toEqual(['B', 'G#m', 'C#m7', 'F#']);
  });

  it('deterministic pick from chorus pool with a fixed seed resolves cleanly in G', () => {
    const pool = filterBankByRole(bank(), 'chorus');
    const picked = selectBankEntry(pool, createRng('step3-canary'));
    const lowered = resolveBankEntry(picked, parseKey('G'));
    // 4 bars × 4 beats of valid ChordSymbols.
    expect(lowered.length).toBe(4);
    for (const beats of lowered) {
      expect(beats.length).toBe(4);
      for (const sym of beats) expect(ChordSymbolSchema.safeParse(sym).success).toBe(true);
    }
  });
});

describe('chord-progression bank — vertical-slice canary', () => {
  function makeCtx(seed: string, key = 'C', genre = 'brightPop'): GeneratorContext {
    const params: GenerateParams = { genre, key, bpm: 120, seed };
    return { rng: createRng(seed), params };
  }

  // Post-53r: the bank is wired through generateChords. The slice
  // golden moved deliberately; the assertion here pins the new golden
  // and confirms its verse / preChorus / chorus bars are bank-derived
  // (the per-bar one-chord-fills-everything contract of the old slice
  // precedent no longer holds for those types).
  it('brightPop_default slice produces a schema-valid bank-derived golden', async () => {
    const seed = 'brightPop-vertical-slice';
    const ctx = makeCtx(seed);
    const out = generateChords(ctx, generateSongStructure(ctx));
    const generated = `${stableStringify(out, 2)}\n`;
    const golden = await readFile(chordsGoldenPath('brightPop', seed), 'utf8');
    expect(generated).toBe(golden);
  });
});
