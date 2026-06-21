// Step 2 — instrument catalog snapshot tests.
//
// Coverage:
// - Load + content-hash verification on the committed snapshot.
// - Snapshot row count, vocabulary consistency, per-entry schema.
// - Builder determinism (synthetic sheet input → byte-identical bytes
//   across runs; same input → same contentHash).
// - Builder error paths: header drift, unknown style, orphan data row.
// - Slice canary: brightPop_default canonical Song bytes unchanged.

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { createRng } from '@casperaki/music-theory';
import { stableStringify } from '@casperaki/song-schema';

import {
  buildInstrumentCatalogSnapshot,
  recomputeContentHash,
  type SheetRows,
} from '../src/catalog/build-snapshot.js';
import {
  _resetCatalogSnapshotCache,
  loadInstrumentCatalogSnapshot,
} from '../src/catalog/snapshot.js';
import { InstrumentEntrySchema } from '../src/catalog/types.js';
import { generateChords } from '../src/chords/index.js';
import { generateSongStructure } from '../src/structure/index.js';
import type { GenerateParams, GeneratorContext } from '../src/index.js';
import { chordsGoldenPath } from './fixtures.js';

const HEADER: SheetRows[0] = [
  'subcategory (lowLevel)',
  'main style',
  'add. styles',
  'VSTi/Library used',
  'patch/preset name',
  'add. information',
  'add. plugins used',
  'bpm',
  'key',
  'normalisation',
  'Status',
  'Legacy Replacement Required?',
];

const COMMON_INPUT = {
  extractedAt: '2026-06-06',
  sourceSha256: 'a'.repeat(64),
  sourcePath: 'fixtures/test.xlsx',
  importer: 'test-suite',
};

function snapshot() {
  return loadInstrumentCatalogSnapshot();
}

describe('instrument catalog snapshot — committed snapshot loads', () => {
  it('loads, validates, and verifies content-hash', () => {
    _resetCatalogSnapshotCache();
    const snap = snapshot();
    expect(snap.entries.length).toBe(snap.LEGACY_PROVENANCE.rowsImported);
    expect(snap.entries.length).toBeGreaterThan(10_000);
    expect(recomputeContentHash(snap.entries)).toBe(snap.contentHash);
  });

  it('every entry validates against InstrumentEntrySchema', () => {
    for (const e of snapshot().entries) {
      const parsed = InstrumentEntrySchema.safeParse(e);
      expect(parsed.success, `id=${e.id}: ${parsed.success ? '' : parsed.error.message}`).toBe(true);
    }
  });

  it('every entry id is unique', () => {
    const ids = snapshot().entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('vocabulary is self-consistent: every entry field present in vocabulary', () => {
    const snap = snapshot();
    const families = new Set(snap.vocabulary.families);
    const mainStyles = new Set(snap.vocabulary.mainStyles);
    const addStyles = new Set(snap.vocabulary.addStyles);
    const libraries = new Set(snap.vocabulary.libraries);
    for (const e of snap.entries) {
      expect(families.has(e.family)).toBe(true);
      const llSet = snap.vocabulary.lowLevelByFamily[e.family];
      expect(llSet).toBeDefined();
      expect(llSet!.includes(e.lowLevel)).toBe(true);
      if (e.mainStyle) expect(mainStyles.has(e.mainStyle)).toBe(true);
      for (const s of e.addStyles) expect(addStyles.has(s)).toBe(true);
      if (e.library) expect(libraries.has(e.library)).toBe(true);
    }
  });

  it('entries are sorted by (family canonical-order, lowLevel, library, preset, sourceRow)', () => {
    const snap = snapshot();
    const familyOrder = new Map(snap.vocabulary.families.map((f, i) => [f, i]));
    for (let i = 1; i < snap.entries.length; i++) {
      const a = snap.entries[i - 1]!;
      const b = snap.entries[i]!;
      const fa = familyOrder.get(a.family) ?? -1;
      const fb = familyOrder.get(b.family) ?? -1;
      if (fa !== fb) {
        expect(fa).toBeLessThanOrEqual(fb);
        continue;
      }
      if (a.lowLevel !== b.lowLevel) {
        expect(a.lowLevel <= b.lowLevel).toBe(true);
        continue;
      }
      const la = a.library ?? '';
      const lb = b.library ?? '';
      if (la !== lb) {
        expect(la <= lb).toBe(true);
        continue;
      }
      const pa = a.preset ?? '';
      const pb = b.preset ?? '';
      if (pa !== pb) {
        expect(pa <= pb).toBe(true);
        continue;
      }
      expect(a.sourceRow).toBeLessThanOrEqual(b.sourceRow);
    }
  });
});

describe('instrument catalog snapshot — builder determinism', () => {
  function syntheticSheets(): Map<string, SheetRows> {
    return new Map<string, SheetRows>([
      [
        'kickDrums',
        [
          HEADER,
          ['kickDrumsAcoustic', 'ballad', 'rock', 'addictiveDrums', 'A Fair Ballad', null, null, null, null, '-18dB', null, null],
          [null,                 'ballad', 'rock', 'addictiveDrums', 'Big Ballad',    null, null, null, null, '-18dB', null, null],
          ['kickDrumsElectronic','edm',    null,    'oversampled',     'Kick 808',     null, null, 120,  null, '-24LUFS', null, null],
        ],
      ],
      [
        'basses',
        [
          HEADER,
          ['bassesAcoustic', 'ballad', null, 'trilian', 'Ac Sustain', null, null, null, null, '-24 LUVS', null, null],
        ],
      ],
    ]);
  }

  it('same sheets twice → byte-identical canonical bytes + same contentHash', () => {
    const a = buildInstrumentCatalogSnapshot({ ...COMMON_INPUT, sheets: syntheticSheets() });
    const b = buildInstrumentCatalogSnapshot({ ...COMMON_INPUT, sheets: syntheticSheets() });
    expect(stableStringify(a.entries, 0)).toBe(stableStringify(b.entries, 0));
    expect(a.contentHash).toBe(b.contentHash);
  });

  it('different extractedAt does NOT change contentHash', () => {
    const a = buildInstrumentCatalogSnapshot({ ...COMMON_INPUT, sheets: syntheticSheets() });
    const b = buildInstrumentCatalogSnapshot({
      ...COMMON_INPUT,
      extractedAt: '2099-12-31',
      sheets: syntheticSheets(),
    });
    expect(a.contentHash).toBe(b.contentHash);
  });

  it('skips subcategory-declaration rows but keeps entries with data', () => {
    const sheets = new Map<string, SheetRows>([
      [
        'vocals',
        [
          HEADER,
          ['vocalsLaSinger', null, null, null, null, null, null, null, null, null, null, null],
          ['vocalsNaSinger', null, null, null, null, null, null, null, null, null, null, null],
        ],
      ],
      [
        'keys',
        [
          HEADER,
          ['keysAcousticPiano', 'ballad', 'brightPop', 'addictiveKeys', 'Grand Mr Bright', null, null, null, null, '-24 LUVS', null, 'yes'],
        ],
      ],
    ]);
    const snap = buildInstrumentCatalogSnapshot({ ...COMMON_INPUT, sheets });
    expect(snap.entries.length).toBe(1);
    expect(snap.LEGACY_PROVENANCE.rowsSkipped.subcategoryHeaderOnly).toBe(2);
  });

  it('rejects an unknown main style', () => {
    const sheets = new Map<string, SheetRows>([
      [
        'keys',
        [
          HEADER,
          ['keysAcousticPiano', 'jazz', null, 'lib', 'preset', null, null, null, null, null, null, null],
        ],
      ],
    ]);
    expect(() => buildInstrumentCatalogSnapshot({ ...COMMON_INPUT, sheets }))
      .toThrow(/unknown main style "jazz"/);
  });

  it('rejects a header drift', () => {
    const badHeader = [...HEADER];
    badHeader[1] = 'genre';
    const sheets = new Map<string, SheetRows>([
      [
        'keys',
        [
          badHeader,
          ['keysAcousticPiano', 'ballad', null, 'lib', 'preset', null, null, null, null, null, null, null],
        ],
      ],
    ]);
    expect(() => buildInstrumentCatalogSnapshot({ ...COMMON_INPUT, sheets }))
      .toThrow(/header column 1 is "genre"/);
  });

  it('rejects a data row before any subcategory header', () => {
    const sheets = new Map<string, SheetRows>([
      [
        'keys',
        [
          HEADER,
          [null, 'ballad', null, 'lib', 'preset', null, null, null, null, null, null, null],
        ],
      ],
    ]);
    expect(() => buildInstrumentCatalogSnapshot({ ...COMMON_INPUT, sheets }))
      .toThrow(/data row before any subcategory header/);
  });
});

describe('instrument catalog snapshot — provenance', () => {
  it('LEGACY_PROVENANCE records the expected source-file label', () => {
    const snap = snapshot();
    expect(snap.LEGACY_PROVENANCE.source).toBe('Audio Library Master File.xlsx');
    expect(snap.LEGACY_PROVENANCE.sourcePath).toBe('datigator-instruments/Audio Library Master File.xlsx');
    expect(snap.LEGACY_PROVENANCE.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(snap.LEGACY_PROVENANCE.importer).toContain('import-instrument-catalog.mjs');
  });

  it('mainStyle vocabulary matches what was observed in the workbook (53k Open Q #4)', () => {
    expect(snapshot().vocabulary.mainStyles).toEqual(
      ['8bit', 'ballad', 'brightPop', 'edm', 'gospel', 'latin', 'rock', 'schlager', 'urban'],
    );
  });
});

describe('instrument catalog snapshot — vertical-slice golden untouched', () => {
  function makeCtx(seed: string, key = 'C', genre = 'brightPop'): GeneratorContext {
    const params: GenerateParams = { genre, key, bpm: 120, seed };
    return { rng: createRng(seed), params };
  }

  it('brightPop_default golden is byte-identical after the catalog snapshot lands', async () => {
    const seed = 'brightPop-vertical-slice';
    const ctx = makeCtx(seed);
    const out = generateChords(ctx, generateSongStructure(ctx));
    const generated = `${stableStringify(out, 2)}\n`;
    const golden = await readFile(chordsGoldenPath('brightPop', seed), 'utf8');
    expect(generated).toBe(golden);
  });
});
