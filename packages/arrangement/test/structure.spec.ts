// Step 4 — per-style song-structure generator tests.
//
// Coverage:
// - Schema: output validates as @casperaki/song-schema SongStructure.
// - Determinism: same seed twice → byte-identical canonical JSON.
// - Cross-seed: different seeds produce different structures (the canary
//   flipped from "today identical, by design" to "different seeds →
//   different structures").
// - Golden: canonical output equals the committed fixture for the
//   `brightPop-vertical-slice` seed (Photograph precedent).
// - Per-style rules: schlager draws from the schlager pool; edm snaps
//   long bar counts.
// - Strict genre vocabulary: every legacy `SongStructureClass` genre is
//   accepted (8 canonical brain genres); `pop`, `8bit`, `gospel`, and
//   arbitrary unknown strings are rejected. No compatibility alias.

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { createRng } from '@casperaki/music-theory';
import { GenreSchema, SongStructureSchema, stableStringify } from '@casperaki/song-schema';

import { generateSongStructure, loadStructurePools } from '../src/structure/index.js';
import type { GenerateParams, GeneratorContext } from '../src/index.js';
import { structureGoldenPath } from './fixtures.js';

function makeCtx(seed: string | number, genre: string = 'brightPop'): GeneratorContext {
  const params: GenerateParams = { genre, key: 'C', bpm: 120, seed };
  return { rng: createRng(seed), params };
}

describe('generateSongStructure (brightPop slice)', () => {
  it('validates against SongStructureSchema', () => {
    const structure = generateSongStructure(makeCtx('schema-check'));
    expect(SongStructureSchema.safeParse(structure).success).toBe(true);
  });

  it('canonical brightPop-vertical-slice seed picks the Photograph precedent', () => {
    const structure = generateSongStructure(makeCtx('brightPop-vertical-slice'));
    expect(structure.map((s) => s.name)).toEqual([
      'intro', 'verse1', 'verse2', 'preChorus1', 'chorus1',
      'verse3', 'verse4', 'preChorus2', 'chorus2', 'chorus3',
      'break1', 'chorus4', 'chorus5', 'outro',
    ]);
    expect(structure[0]!.bars.length).toBe(8);   // intro
    expect(structure[10]!.bars.length).toBe(1);  // break1 — collapsed 2 → 1
    expect(structure[13]!.bars.length).toBe(8);  // outro
    for (const segment of structure) {
      for (const bar of segment.bars) {
        expect(bar.chords).toEqual([]);
      }
    }
  });

  it('is reproducible: same seed twice → byte-identical canonical JSON', () => {
    const a = stableStringify(generateSongStructure(makeCtx('repro')), 2);
    const b = stableStringify(generateSongStructure(makeCtx('repro')), 2);
    expect(a).toBe(b);
  });

  it('different seeds produce different structures (post-step-4 variation lands)', () => {
    const shapes = new Set<string>();
    for (let i = 0; i < 8; i++) {
      const structure = generateSongStructure(makeCtx(`seed-${i}`));
      shapes.add(structure.map((s) => `${s.name}:${s.bars.length}`).join('|'));
    }
    expect(shapes.size).toBeGreaterThan(1);
  });

  it('matches committed golden fixture (brightPop / brightPop-vertical-slice)', async () => {
    const seed = 'brightPop-vertical-slice';
    const generated = `${stableStringify(generateSongStructure(makeCtx(seed)), 2)}\n`;
    const golden = await readFile(structureGoldenPath('brightPop', seed), 'utf8');
    expect(generated).toBe(golden);
  });

  it('every segment has bars > 0 and a non-empty name', () => {
    const structure = generateSongStructure(makeCtx('properties'));
    expect(structure.length).toBeGreaterThan(0);
    for (const segment of structure) {
      expect(segment.name).not.toBe('');
      expect(segment.bars.length).toBeGreaterThan(0);
    }
  });
});

describe('generateSongStructure — per-style rules', () => {
  it('schlager draws from the schlager precedent pool', () => {
    const pools = loadStructurePools();
    const schlagerSegmentNames = new Set(
      pools.schlager.flatMap((p) => Object.keys(p.segments)),
    );
    const allowed = new Set<string>([...schlagerSegmentNames, 'intro', 'outro']);
    for (let i = 0; i < 5; i++) {
      const structure = generateSongStructure(makeCtx(`schlager-${i}`, 'schlager'));
      for (const seg of structure) expect(allowed.has(seg.name)).toBe(true);
    }
  });

  it('edm snaps bar counts > 4 to multiples of 4 / > 8 to multiples of 8', () => {
    for (let i = 0; i < 8; i++) {
      const structure = generateSongStructure(makeCtx(`edm-${i}`, 'edm'));
      for (const seg of structure) {
        const bars = seg.bars.length;
        // break*, intro, outro are exempt — set by other rules.
        if (seg.name.startsWith('break')) continue;
        if (seg.name === 'intro' || seg.name === 'outro') continue;
        if (bars > 8) expect(bars % 8).toBe(0);
        else if (bars > 4) expect(bars % 4).toBe(0);
      }
    }
  });

  it('break* segments collapse to 1 or 2 bars', () => {
    for (let i = 0; i < 12; i++) {
      const structure = generateSongStructure(makeCtx(`brk-${i}`));
      for (const seg of structure) {
        if (seg.name.startsWith('break')) {
          expect([1, 2]).toContain(seg.bars.length);
        }
      }
    }
  });

  it('default pool has 5 precedents; schlager pool has 8 precedents (legacy parity)', () => {
    const pools = loadStructurePools();
    expect(pools.default.length).toBe(5);
    expect(pools.schlager.length).toBe(8);
  });
});

describe('generateSongStructure — strict canonical genre vocabulary', () => {
  it('accepts every canonical brain genre (8: matches legacy SongStructureClass)', () => {
    // Every canonical genre produces a parseable structure; this asserts
    // the per-style rules don't crash on any supported value, and that
    // the published GenreSchema enum is authoritative.
    for (const genre of GenreSchema.options) {
      const structure = generateSongStructure(makeCtx(`canonical-${genre}`, genre));
      expect(SongStructureSchema.safeParse(structure).success).toBe(true);
    }
  });

  it('rejects `pop` — never a canonical brain genre, no alias to brightPop', () => {
    expect(() => generateSongStructure(makeCtx('genre-check', 'pop'))).toThrow(
      /unsupported genre "pop"/,
    );
  });

  it('rejects workbook main styles without per-style rules (8bit, gospel)', () => {
    expect(() => generateSongStructure(makeCtx('genre-check', '8bit'))).toThrow(
      /unsupported genre "8bit"/,
    );
    expect(() => generateSongStructure(makeCtx('genre-check', 'gospel'))).toThrow(
      /unsupported genre "gospel"/,
    );
  });

  it('rejects arbitrary unknown strings', () => {
    expect(() => generateSongStructure(makeCtx('genre-check', 'jazz'))).toThrow(
      /unsupported genre "jazz"/,
    );
    expect(() => generateSongStructure(makeCtx('genre-check', ''))).toThrow(
      /unsupported genre ""/,
    );
  });
});
