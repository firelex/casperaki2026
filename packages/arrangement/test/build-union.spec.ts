// Union catalog builder tests (docs/58h).
//
// Coverage:
// - isVariantRender classifies modified / key-bpm / bpm-trailer renders.
// - parseDiskFilename inverts RULE_SIMPLE and rejects mis-filed / unknown.
// - buildUnionCatalog: adds disk-only presets, tags source, skips variants
//   + percussionLoops + non-reconstructable, round-trips each addition,
//   rebuilds vocabulary/hash, and is deterministic + order-independent
//   (audit-against-base vs audit-against-union produce the same union).

import { describe, expect, it } from 'vitest';

import { stableStringify } from '@casperaki/song-schema';

import {
  buildInstrumentCatalogSnapshot,
  recomputeContentHash,
  type SheetRows,
} from '../src/catalog/build-snapshot.js';
import {
  auditSampleLibrary,
  preferredExpectedPath,
  type DiskIndex,
} from '../src/catalog/audit-sample-library.js';
import {
  buildUnionCatalog,
  isVariantRender,
  parseDiskFilename,
} from '../src/catalog/build-union.js';
import { InstrumentCatalogSnapshotSchema } from '../src/catalog/types.js';

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

// A base snapshot with ONE keys row that matches a disk file, and no
// synths rows at all (the union must discover the synth pads on disk).
function baseSnapshot() {
  const sheets = new Map<string, SheetRows>([
    [
      'keys',
      [
        HEADER,
        ['keysAcousticPiano', 'brightPop', null, 'triton', 'Acoustic Piano', null, null, null, null, null, null, null],
      ],
    ],
  ]);
  return buildInstrumentCatalogSnapshot({ ...COMMON_INPUT, sheets });
}

// Disk listing: the matched keys file, two genuine synth-pad presets,
// three variant/loop renders that MUST stay unmatched, and one mis-filed
// file whose embedded lowLevel disagrees with its directory.
const KEYS_FILE = 'keys - keysAcousticPiano - brightPop - triton - Acoustic Piano.mp3';
const PAD1 = 'synths - synthsSoftPad - brightPop - omnisphere - Warm Pad.mp3';
const PAD2 = 'synths - synthsSoftPad - edm - nexus - Glass Pad.mp3';
const FX_KEY_BPM = 'fx - fxAtmosphere - edm - bigZ - Stem - C 120bpm.mp3';
const PERC_MOD = 'percussionLoops - percussionLoopsAcoustic_60-89bpm - ballad - Pop Shaker 03 75bpm_modified.mp3';
const BASS_BPM = 'basses - bassesSynthWobble - edm - massive - Classic Wobble - 123.mp3';
const MISFILED = 'synths - synthsBrightPad - edm - lib - Strange.mp3'; // in synthsSoftPad dir

function diskIndex(): DiskIndex {
  return new Map<string, ReadonlySet<string>>([
    ['keys/keysAcousticPiano', new Set([KEYS_FILE])],
    ['synths/synthsSoftPad', new Set([PAD1, PAD2, MISFILED])],
    ['fx/fxAtmosphere', new Set([FX_KEY_BPM])],
    ['percussionLoops/percussionLoopsAcoustic_60-89bpm', new Set([PERC_MOD])],
    ['basses/bassesSynthWobble', new Set([BASS_BPM])],
  ]);
}

function auditOf(catalog: ReturnType<typeof baseSnapshot>) {
  return auditSampleLibrary({
    catalogSnapshot: catalog,
    diskIndex: diskIndex(),
    provenance: {
      sampleRootLabel: 'test',
      auditedAt: '2026-06-14',
      auditor: 'test',
      aliasesApplied: [],
    },
  });
}

describe('isVariantRender', () => {
  it('flags _modified, key-bpm and bpm-trailer renders', () => {
    expect(isVariantRender(PERC_MOD)).toBe(true);
    expect(isVariantRender(FX_KEY_BPM)).toBe(true);
    expect(isVariantRender('… baarp A 70bpm.mp3')).toBe(true);
    expect(isVariantRender(BASS_BPM)).toBe(true);
  });
  it('does not flag clean preset basenames', () => {
    expect(isVariantRender(PAD1)).toBe(false);
    expect(isVariantRender(KEYS_FILE)).toBe(false);
    // a preset whose name ends in a number but not a " - <bpm>" trailer
    expect(isVariantRender('fx - fxLowImpact - edm - vengeance - VEH4 Impacts Low 34.mp3')).toBe(false);
  });
});

describe('parseDiskFilename', () => {
  it('inverts RULE_SIMPLE: library is first post-style token, preset is the rest', () => {
    const p = parseDiskFilename('orchestral/orchestralCelloSolo/orchestral - orchestralCelloSolo - ballad - kontakt - cineSamples - TinaGuo Legato.mp3');
    expect(p).toEqual({
      family: 'orchestral',
      lowLevel: 'orchestralCelloSolo',
      mainStyle: 'ballad',
      library: 'kontakt',
      preset: 'cineSamples - TinaGuo Legato',
    });
  });
  it('treats a lone post-style token as preset (no library)', () => {
    const p = parseDiskFilename('popBrass/popBrassX/popBrass - popBrassX - urban - aggressive-brass.mp3');
    expect(p).toMatchObject({ mainStyle: 'urban', library: null, preset: 'aggressive-brass' });
  });
  it('returns null for an unknown family or a mis-filed embedded lowLevel', () => {
    expect(parseDiskFilename('notAFamily/x/notAFamily - x - edm - lib - p.mp3')).toBeNull();
    expect(parseDiskFilename(`synths/synthsSoftPad/${MISFILED}`)).toBeNull();
  });
});

describe('buildUnionCatalog', () => {
  it('adds disk-only presets, tags source, skips variants/loops/mis-filed', () => {
    const base = baseSnapshot();
    const result = buildUnionCatalog({ base, audit: auditOf(base) });

    expect(result.additions.map((e) => e.preset).sort()).toEqual(['Glass Pad', 'Warm Pad']);
    for (const e of result.additions) {
      expect(e.source).toBe('disk');
      expect(e.family).toBe('synths');
      expect(e.lowLevel).toBe('synthsSoftPad');
      expect(e.bpm).toBeNull();
      expect(e.key).toBeNull();
    }
    // FX key-bpm + percussionLoops + bass bpm-trailer all skipped as variants.
    expect(result.skippedVariants).toBe(3);
    expect(result.skippedNonReconstructable).toContain(`synths/synthsSoftPad/${MISFILED}`);

    // xlsx rows preserved and tagged.
    const xlsx = result.snapshot.entries.filter((e) => e.source === 'xlsx');
    expect(xlsx.length).toBe(base.entries.length);
    expect(result.snapshot.entries.length).toBe(base.entries.length + 2);

    // vocabulary picks up the new family + lowLevel.
    expect(result.snapshot.vocabulary.families).toContain('synths');
    expect(result.snapshot.vocabulary.lowLevelByFamily.synths).toContain('synthsSoftPad');

    // hash + schema integrity.
    expect(recomputeContentHash(result.snapshot.entries)).toBe(result.snapshot.contentHash);
    expect(() => InstrumentCatalogSnapshotSchema.parse(result.snapshot)).not.toThrow();
    expect(result.snapshot.unionProvenance?.additions).toBe(2);
  });

  it('every disk addition round-trips to its exact disk path', () => {
    const base = baseSnapshot();
    const result = buildUnionCatalog({ base, audit: auditOf(base) });
    for (const e of result.additions) {
      const path = preferredExpectedPath(e)!;
      const [, lowLevel] = path.split('/');
      const baseName = path.slice(path.lastIndexOf('/') + 1);
      expect(diskIndex().get(`synths/${lowLevel}`)?.has(baseName)).toBe(true);
    }
  });

  it('is deterministic: same inputs → byte-identical entries', () => {
    const base = baseSnapshot();
    const a = buildUnionCatalog({ base, audit: auditOf(base) });
    const b = buildUnionCatalog({ base, audit: auditOf(base) });
    expect(stableStringify(a.snapshot.entries, 0)).toBe(stableStringify(b.snapshot.entries, 0));
    expect(a.snapshot.contentHash).toBe(b.snapshot.contentHash);
  });

  it('is order-independent: an audit run against the UNION reproduces the same union', () => {
    const base = baseSnapshot();
    const first = buildUnionCatalog({ base, audit: auditOf(base) });
    // Re-audit the SAME disk against the union (additions now matched, not
    // unmatched), then rebuild — must still recover the disk additions.
    const reAudit = auditSampleLibrary({
      catalogSnapshot: first.snapshot,
      diskIndex: diskIndex(),
      provenance: { sampleRootLabel: 'test', auditedAt: '2026-06-14', auditor: 'test', aliasesApplied: [] },
    });
    const second = buildUnionCatalog({ base, audit: reAudit });
    expect(second.snapshot.contentHash).toBe(first.snapshot.contentHash);
    expect(second.additions.length).toBe(2);
  });
});
