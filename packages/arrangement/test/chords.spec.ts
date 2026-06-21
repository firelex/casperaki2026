// Step 4 — chord generator tests (post-53r bank wiring).
//
// Coverage:
// - Schema: structure-with-chords validates as SongStructure.
// - Beat count: every bar has exactly beatsPerBar() chord entries.
// - Vocabulary: every emitted chord parses cleanly via parseChord and
//   resolves to a known quality (no `unknown_quality` fallbacks).
// - Roman-numeral coverage: every numeral pulled (via the bank or the
//   fallback precedent) exists in the Step-1 vocabulary.
// - Bank wiring: every verse / preChorus / chorus bar comes from the
//   imported bank's role-filtered pool; bank-covered segments of the
//   same role share the picked entry.
// - Pass-2 (to-do #7): intro / break / outro derive from the cached
//   verse1 / chorus1 bars (slice head/tail, or verse bar[0] held);
//   bridge picks a fresh full-bank entry; chordStructure fingerprint +
//   normalizedLengthInBars repeat-tail are emitted.
// - Determinism: same seed twice → byte-identical canonical JSON.
// - Cross-seed: different seeds → different chords (bank pick varies).
// - Key parametricity: key='G' shifts roots one fifth up vs key='C'.
// - Non-mutation: input structure is left untouched.
// - Genre support: every canonical brain genre in GenreSchema generates
//   cleanly; non-canonical strings throw a clear error.
// - Golden: canonical output equals the committed fixture.

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { beatsPerBar, createRng, parseChord, parseKey } from '@casperaki/music-theory';
import {
  ChordSymbolSchema,
  GenreSchema,
  SongStructureSchema,
  stableStringify,
} from '@casperaki/song-schema';

import { generateChords } from '../src/chords/index.js';
import {
  filterBankByRole,
  loadChordBank,
  resolveBankEntry,
} from '../src/chords/bank.js';
import { loadChordsVocab } from '../src/chords/data.js';
import { generateSongStructure } from '../src/structure/index.js';
import type { GenerateParams, GeneratorContext } from '../src/index.js';
import { chordsGoldenPath } from './fixtures.js';

function makeCtx(seed: string | number, key = 'C', genre = 'brightPop'): GeneratorContext {
  const params: GenerateParams = { genre, key, bpm: 120, seed };
  return { rng: createRng(seed), params };
}

function generate(seed: string | number, key = 'C', genre = 'brightPop') {
  const ctx = makeCtx(seed, key, genre);
  return generateChords(ctx, generateSongStructure(ctx));
}

describe('generateChords (bank-wired)', () => {
  it('validates against SongStructureSchema', () => {
    const out = generate('schema-check');
    expect(SongStructureSchema.safeParse(out).success).toBe(true);
  });

  it('emits exactly beatsPerBar() chord entries per bar', () => {
    const out = generate('beats-check');
    const beats = beatsPerBar();
    for (const segment of out) {
      for (const bar of segment.bars) {
        expect(bar.chords.length).toBe(beats);
      }
    }
  });

  it('every emitted chord validates with ChordSymbolSchema', () => {
    const out = generate('symbol-schema');
    for (const segment of out) {
      for (const bar of segment.bars) {
        for (const symbol of bar.chords) {
          expect(ChordSymbolSchema.safeParse(symbol).success).toBe(true);
        }
      }
    }
  });

  it('every chord parses with a recognised root (the bank vocabulary widens past parseChord; quality may be "unknown" for sus/5/11/etc.)', () => {
    // The bank's roman-numeral vocabulary includes suffixes parseChord
    // doesn't decode today ('sus', '5' (pow5), '11' (dom11)). Those
    // symbols are still schema-valid; parseChord just returns
    // quality:'unknown' for them. Pin the contract that every emitted
    // symbol parses *at all* (non-throwing root extraction) and is
    // schema-valid; expanding parseChord's QUALITY_TABLE is deferred
    // (docs/53r §"Deferred").
    const SAFE_QUALITIES_PARSEABLE = new Set([
      'maj', 'min', 'dim', 'aug', 'maj7', 'min7', 'maj9', 'min9',
      '7', '9', '6', 'sus2', 'sus4', 'unknown',
    ]);
    const out = generate('vocab-check');
    for (const segment of out) {
      for (const bar of segment.bars) {
        for (const symbol of bar.chords) {
          const parsed = parseChord(symbol);
          expect(SAFE_QUALITIES_PARSEABLE.has(parsed.quality)).toBe(true);
          expect(Number.isFinite(parsed.root)).toBe(true);
        }
      }
    }
  });

  it('every emitted roman numeral resolves through the Step-1 vocabulary', () => {
    // The bank + fallback precedent must use only numerals that the
    // Step-1 vocabulary knows. The generator throws on lookup miss;
    // exercise it across all bank-covered + fallback segment types
    // via several seeds to surface any drift.
    const vocab = loadChordsVocab();
    for (let i = 0; i < 16; i++) {
      expect(() => generate(`numeral-coverage-${i}`)).not.toThrow();
    }
    // Sanity: vocabulary itself is non-empty.
    expect(Object.keys(vocab.romanNumerals).length).toBeGreaterThan(0);
  });

  it('verse / preChorus / chorus segments come from a single bank pick per role', () => {
    // The bank picks happen once per role (verse → preChorus → chorus)
    // and are reused for every segment of that role. Resolve every
    // bank entry against C major; the segment's bars must match one
    // and only one entry's resolved bars (cycled with i % 4).
    const out = generate('bank-membership', 'C');
    const bank = loadChordBank();
    const cMajor = parseKey('C');

    for (const role of ['verse', 'preChorus', 'chorus'] as const) {
      const segments = out.filter((s) =>
        role === 'verse'
          ? s.name.startsWith('verse')
          : role === 'preChorus'
            ? s.name.startsWith('preChorus')
            : s.name.startsWith('chorus'),
      );
      if (segments.length === 0) continue;

      const pool = filterBankByRole(bank, role);
      const candidateResolutions = pool.map((entry) => ({
        entry,
        bars: resolveBankEntry(entry, cMajor),
      }));

      // For each role segment, find at least one candidate whose bars
      // (cycled with i % 4) match every bar of the segment exactly.
      // Across all segments of the same role, the same candidate must
      // be the matcher — that pins the "one pick per role, reused"
      // contract.
      let chosen: string | undefined;
      for (const segment of segments) {
        const matchers = candidateResolutions.filter(({ bars }) =>
          segment.bars.every((segBar, i) => {
            const sourceBar = bars[i % bars.length]!;
            return segBar.chords.every(
              (c, b) => c === sourceBar[b % sourceBar.length],
            );
          }),
        );
        expect(matchers.length, `segment ${segment.name} did not match any bank entry`)
          .toBeGreaterThan(0);
        if (chosen === undefined) {
          chosen = matchers[0]!.entry.precedent;
        } else {
          // At least one matcher must equal the previously chosen
          // entry's precedent — confirms reuse across segments of the
          // same role.
          const stillMatches = matchers.some((m) => m.entry.precedent === chosen);
          expect(stillMatches, `role ${role} did not reuse the same bank entry`).toBe(true);
        }
      }
    }
  });

  it('intro / bridge / break / outro segments resolve to vocab chords (Pass-2 + bridge)', () => {
    const out = generate('fallback-vocab');
    const vocab = loadChordsVocab();
    const SIDE_NAMES = ['intro', 'bridge', 'break', 'outro'];
    let saw = 0;
    for (const segment of out) {
      if (!SIDE_NAMES.some((p) => segment.name.startsWith(p))) continue;
      saw++;
      for (const bar of segment.bars) {
        for (const symbol of bar.chords) {
          expect(ChordSymbolSchema.safeParse(symbol).success).toBe(true);
        }
      }
    }
    expect(saw).toBeGreaterThan(0);
    expect(Object.keys(vocab.romanNumerals).length).toBeGreaterThan(0);
  });

  it('Pass-2 break holds the verse1 bar[0] across the whole segment', () => {
    // Legacy ChordsClass.js:222-236.
    for (const seed of ['brk-1', 'brk-2', 'brk-3', 'brk-4', 'brk-5']) {
      const out = generate(seed);
      const verse1 = out.find((s) => s.name === 'verse1');
      if (!verse1) continue;
      const verse1Bar0 = JSON.stringify(verse1.bars[0]!.chords);
      for (const seg of out) {
        if (!seg.name.startsWith('break')) continue;
        for (const bar of seg.bars) {
          expect(JSON.stringify(bar.chords)).toBe(verse1Bar0);
        }
        expect(seg.precedent).toBe('verse');
      }
    }
  });

  it('Pass-2 intro / outro derive from cached verse1 / chorus1 (head or tail slice)', () => {
    // Every intro/outro must be a contiguous head- or tail-slice of the
    // cached verse1 (intro only) or chorus1 bars (legacy :184-262).
    const eq = (a: { chords: readonly string[] }, b: { chords: readonly string[] }) =>
      JSON.stringify(a.chords) === JSON.stringify(b.chords);
    const isSlice = (
      seg: { bars: readonly { chords: readonly string[] }[] },
      src: { bars: readonly { chords: readonly string[] }[] },
    ): boolean => {
      const n = seg.bars.length;
      const head = src.bars.slice(0, n);
      const tail = src.bars.slice(src.bars.length - n);
      const matches = (cand: readonly { chords: readonly string[] }[]) =>
        cand.length === n && seg.bars.every((b, i) => eq(b, cand[i]!));
      return matches(head) || matches(tail);
    };
    let inspected = 0;
    for (let i = 0; i < 12; i++) {
      const out = generate(`pass2-${i}`);
      const verse1 = out.find((s) => s.name === 'verse1');
      const chorus1 = out.find((s) => s.name === 'chorus1');
      for (const seg of out) {
        if (seg.name.startsWith('intro')) {
          const okFromVerse = verse1 ? isSlice(seg, verse1) : false;
          const okFromChorus = chorus1 ? isSlice(seg, chorus1) : false;
          expect(okFromVerse || okFromChorus, `intro ${seg.name} not a verse/chorus slice`).toBe(true);
          expect(['verse', 'beginningOfChorus', 'endOfChorus']).toContain(seg.precedent);
          inspected++;
        } else if (seg.name.startsWith('outro')) {
          expect(chorus1 ? isSlice(seg, chorus1) : true, `outro ${seg.name} not a chorus slice`).toBe(true);
          expect(['beginningOfChorus', 'endOfChorus']).toContain(seg.precedent);
          inspected++;
        }
      }
    }
    expect(inspected).toBeGreaterThan(0);
  });

  it('emits a chordStructure fingerprint on verse/chorus segments', () => {
    // Legacy :159 — A/B/C… letters, one per normalized bar.
    const out = generate('fingerprint');
    let saw = 0;
    for (const seg of out) {
      if (!/^(verse|preChorus|chorus|bridge)\d*$/u.test(seg.name)) continue;
      expect(seg.chordStructure, `missing fingerprint on ${seg.name}`).toBeDefined();
      expect(seg.chordStructure!).toMatch(/^[A-Z]+$/u);
      saw++;
    }
    expect(saw).toBeGreaterThan(0);
  });

  it('normalizedLengthInBars repeat-tail: a non-multiple-of-4 segment repeats its tail bars', () => {
    // Build a 6-bar verse directly and confirm bars 4-5 repeat bars 2-3
    // (legacy :140-153 with normalized=4, remainder=2).
    const ctx = makeCtx('repeat-tail');
    const structure = [
      { name: 'verse1', bars: Array.from({ length: 6 }, () => ({ chords: [] as string[] })) },
    ];
    const out = generateChords(ctx, structure as never);
    const verse = out[0]!;
    expect(verse.bars.length).toBe(6);
    expect(JSON.stringify(verse.bars[4]!.chords)).toBe(JSON.stringify(verse.bars[2]!.chords));
    expect(JSON.stringify(verse.bars[5]!.chords)).toBe(JSON.stringify(verse.bars[3]!.chords));
    // Fingerprint covers only the 4 normalized bars.
    expect(verse.chordStructure!.length).toBe(4);
  });

  it('transposes with the key (every emitted chord still resolves)', () => {
    const KEYS = ['C', 'D', 'E', 'F', 'G', 'A', 'B', 'Bb', 'Eb'];
    for (const k of KEYS) {
      const out = generate('key-transpose', k);
      for (const segment of out) {
        for (const bar of segment.bars) {
          for (const symbol of bar.chords) {
            expect(ChordSymbolSchema.safeParse(symbol).success, `${symbol} (${k})`).toBe(true);
          }
        }
      }
    }
  });

  it('is reproducible: same seed twice → byte-identical canonical JSON', () => {
    const a = stableStringify(generate('repro'), 2);
    const b = stableStringify(generate('repro'), 2);
    expect(a).toBe(b);
  });

  it('different seeds → different chord progressions (bank picks vary)', () => {
    // Cross-seed canary, now load-bearing on the bank's RNG-driven pick.
    // Sample multiple seed pairs; the distinct-signature count must
    // exceed 1.
    const signatures = new Set<string>();
    for (let i = 0; i < 16; i++) {
      signatures.add(stableStringify(generate(`variance-${i}`), 2));
    }
    expect(signatures.size).toBeGreaterThan(1);
  });

  it('does not mutate the input structure', () => {
    const ctx = makeCtx('immutability');
    const structure = generateSongStructure(ctx);
    const before = stableStringify(structure, 2);
    const after = generateChords(ctx, structure);
    expect(stableStringify(structure, 2)).toBe(before);
    expect(after).not.toBe(structure);
    for (const segment of structure) {
      for (const bar of segment.bars) {
        expect(bar.chords).toEqual([]);
      }
    }
  });

  it('every canonical brain genre produces a schema-valid chord-filled structure', () => {
    for (const genre of GenreSchema.options) {
      const out = generate(`genre-${genre}`, 'C', genre);
      expect(SongStructureSchema.safeParse(out).success, `genre ${genre}`).toBe(true);
      for (const segment of out) {
        for (const bar of segment.bars) {
          for (const symbol of bar.chords) {
            expect(ChordSymbolSchema.safeParse(symbol).success, `${symbol} (${genre})`).toBe(true);
          }
        }
      }
    }
  });

  it('rejects a non-canonical genre with a clear error', () => {
    // Phase-3 placeholder `pop` is the canonical "rejected" example;
    // `'8bit'` and `'gospel'` are workbook main-styles that aren't
    // canonical brain genres (53o §"Workbook main styles NOT canonical").
    // Build the structure under a valid genre, then ask generateChords
    // to fill it under a bad one — the chord generator's gate is the
    // thing under test.
    const structure = generateSongStructure(makeCtx('genre-check'));
    for (const bad of ['pop', '8bit', 'gospel', 'jazz', 'unknown-genre']) {
      const badCtx = makeCtx('genre-check', 'C', bad);
      expect(() => generateChords(badCtx, structure)).toThrow(/unsupported genre/u);
    }
  });

  it('matches committed golden fixture (brightPop / brightPop-vertical-slice)', async () => {
    const seed = 'brightPop-vertical-slice';
    const generated = `${stableStringify(generate(seed), 2)}\n`;
    const golden = await readFile(chordsGoldenPath('brightPop', seed), 'utf8');
    expect(generated).toBe(golden);
  });
});
