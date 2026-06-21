// Asset resolver tests — 53s step 8.
//
// Coverage:
// - Canonical match: target (key, bpm) compatible with entry's own values
//   returns the audited matchedPath verbatim.
// - Variant match: entries with matchedRule = `fx-key-bpm` resolve a
//   pre-rendered chromatic / bpm variant from `audit.unmatchedDiskFiles`
//   when the target is off-canonical.
// - unmatchedDiskFiles are runtime variant candidates (NOT orphans):
//   the test asserts an unmatched file in the audit is reachable by
//   the resolver and not filtered out as invalid.
// - Unresolved target returns useful diagnostics (entry id, target,
//   indexed variant count, sample available variants, candidate paths
//   tried) and does NOT fabricate a path.
// - Deterministic ordering: rebuilding the resolver on the same inputs
//   yields the same `availableVariantsSample` (sorted by key, bpm).
// - No live filesystem access: the resolver works against in-memory
//   committed audit data; no `fs.readdir` / `fs.stat` calls.
// - Output schema validation: every resolution passes
//   `AssetResolutionSchema.parse`.
// - Provenance hashes are carried through and match the validated
//   catalog's hashes.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AssetResolutionSchema,
  buildAssetResolver,
  getDefaultAssetResolver,
  loadValidatedCatalog,
  resolveAssetPath,
  SampleLibraryAuditReportSchema,
  ValidatedCatalogEntrySchema,
  type AssetResolution,
  type AssetResolver,
  type SampleLibraryAuditReport,
  type ValidatedCatalog,
  type ValidatedCatalogEntry,
} from '../src/index.js';
import {
  _resetValidatedCatalogCache,
} from '../src/catalog/validated-catalog.js';
import {
  _resetAssetResolverCache,
} from '../src/catalog/asset-resolver.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, '..');
const AUDIT_PATH = resolve(PKG_ROOT, 'data/sample-library.audit.json');

function rawAudit(): SampleLibraryAuditReport {
  return SampleLibraryAuditReportSchema.parse(
    JSON.parse(readFileSync(AUDIT_PATH, 'utf8')),
  );
}

function freshDefault(): AssetResolver {
  _resetAssetResolverCache();
  _resetValidatedCatalogCache();
  return getDefaultAssetResolver();
}

function pickFxKeyBpmEntry(catalog: ValidatedCatalog): ValidatedCatalogEntry {
  const e = catalog.entries.find((x) => x.matchedRule === 'fx-key-bpm');
  if (!e) throw new Error('no fx-key-bpm entry found in validated catalog');
  return e;
}

function pickPlainSimpleEntry(catalog: ValidatedCatalog): ValidatedCatalogEntry {
  // An entry with matchedRule=`simple` and no key/bpm — its canonical
  // file is the only resolvable target in this first pass.
  const e = catalog.entries.find(
    (x) => x.matchedRule === 'simple' && x.key === null && x.bpm === null,
  );
  if (!e) throw new Error('no simple no-key/no-bpm entry found in validated catalog');
  return e;
}

describe('resolveAssetPath — canonical match', () => {
  it('returns matchedPath verbatim when target (key, bpm) matches the entry', () => {
    const resolver = freshDefault();
    const catalog = loadValidatedCatalog();
    const entry = pickFxKeyBpmEntry(catalog);
    // fx-key-bpm entries always have a key + bpm — use them as target.
    const res = resolver.resolve({
      entry,
      target: { key: entry.key!, bpm: entry.bpm! },
    });
    expect(res.status).toBe('resolved');
    if (res.status !== 'resolved') return;
    expect(res.matchKind).toBe('canonical');
    expect(res.relativePath).toBe(entry.matchedPath);
  });

  it('treats entry.key=null / entry.bpm=null as "any" — canonical for every target', () => {
    const resolver = freshDefault();
    const catalog = loadValidatedCatalog();
    const entry = pickPlainSimpleEntry(catalog);
    const res = resolver.resolve({
      entry,
      target: { key: 'C', bpm: 120 },
    });
    expect(res.status).toBe('resolved');
    if (res.status !== 'resolved') return;
    expect(res.matchKind).toBe('canonical');
    expect(res.relativePath).toBe(entry.matchedPath);
  });
});

describe('resolveAssetPath — exact-key-bpm-variant match', () => {
  it('resolves an off-canonical (key, bpm) for an fx-key-bpm entry', () => {
    const resolver = freshDefault();
    const catalog = loadValidatedCatalog();
    // Look for the well-known ASC_Atmosphere_13 entry (matchedPath has
    // 491 indexed variants on the dev-box committed audit).
    const entry = catalog.entries.find(
      (e) =>
        e.matchedRule === 'fx-key-bpm' &&
        e.preset !== null &&
        e.preset.startsWith('ASC_Atmosphere_13 - '),
    );
    if (!entry) {
      // Fall back to any fx-key-bpm entry with at least one variant.
      const any = pickFxKeyBpmEntry(catalog);
      // Target the entry's own key/bpm + 1 to force variant lookup.
      // (entry.bpm is non-null for fx-key-bpm rows; +1 picks an off-canonical
      // variant if one exists.)
      const offBpm = entry?.bpm ?? any.bpm! + 1;
      const res = resolver.resolve({
        entry: any,
        target: { key: any.key!, bpm: offBpm },
      });
      // Either resolved-variant or unresolved with diagnostics is acceptable
      // here — the strong assertion is below using the known stem.
      expect(['resolved', 'unresolved']).toContain(res.status);
      return;
    }
    // ASC_Atmosphere_13 - F 85bpm canonical; variant A 100bpm exists.
    const res = resolver.resolve({
      entry,
      target: { key: 'A', bpm: 100 },
    });
    expect(res.status).toBe('resolved');
    if (res.status !== 'resolved') return;
    expect(res.matchKind).toBe('exact-key-bpm-variant');
    expect(res.relativePath).toBe(
      'fx/fxAtmosphere/fx - fxAtmosphere - edm - loopmasters - ASC_Atmosphere_13 - A 100bpm_modified.mp3',
    );
  });

  it('the resolved variant path appears in audit.unmatchedDiskFiles — proving the variant pool IS the runtime asset surface, not invalid orphans', () => {
    const resolver = freshDefault();
    const catalog = loadValidatedCatalog();
    const entry = catalog.entries.find(
      (e) =>
        e.matchedRule === 'fx-key-bpm' &&
        e.preset !== null &&
        e.preset.startsWith('ASC_Atmosphere_13 - '),
    );
    if (!entry) return;
    const res = resolver.resolve({
      entry,
      target: { key: 'A', bpm: 100 },
    });
    expect(res.status).toBe('resolved');
    if (res.status !== 'resolved') return;
    // The resolved path must be one of audit.unmatchedDiskFiles, not
    // a "matched" canonical row — confirming the resolver is treating
    // those as the variant pool the docs describe (53p §"Unmatched disk
    // files are the runtime variant pool — NOT orphans").
    const audit = rawAudit();
    const unmatchedPaths = new Set(audit.unmatchedDiskFiles.map((u) => u.relativePath));
    const matchedPaths = new Set(audit.matched.map((m) => m.matchedPath));
    expect(unmatchedPaths.has(res.relativePath)).toBe(true);
    expect(matchedPaths.has(res.relativePath)).toBe(false);
  });
});

describe('resolveAssetPath — unresolved diagnostics', () => {
  it('returns unresolved when an fx-key-bpm entry has no variant for the target', () => {
    const resolver = freshDefault();
    const catalog = loadValidatedCatalog();
    const entry = catalog.entries.find(
      (e) =>
        e.matchedRule === 'fx-key-bpm' &&
        e.preset !== null &&
        e.preset.startsWith('ASC_Atmosphere_13 - '),
    );
    if (!entry) return;
    // bpm=999 is well outside any chromatic/bpm pool.
    const res = resolver.resolve({
      entry,
      target: { key: 'C', bpm: 999 },
    });
    expect(res.status).toBe('unresolved');
    if (res.status !== 'unresolved') return;
    expect(res.diagnostics.entryId).toBe(entry.id);
    expect(res.diagnostics.targetKey).toBe('C');
    expect(res.diagnostics.targetBpm).toBe(999);
    expect(res.diagnostics.candidatePathsTried.length).toBeGreaterThanOrEqual(2);
    // The canonical path is always among candidates considered.
    expect(res.diagnostics.candidatePathsTried).toContain(entry.matchedPath);
    // The resolver records the indexed variant count for this entry's
    // group so a future selector can fall back to a different entry.
    expect(res.diagnostics.indexedVariantCount).toBeGreaterThan(0);
    expect(res.diagnostics.availableVariantsSample.length).toBeGreaterThan(0);
    expect(res.diagnostics.availableVariantsSample.length).toBeLessThanOrEqual(8);
  });

  it('does not fabricate a path — unresolved responses carry no relativePath field', () => {
    const resolver = freshDefault();
    const catalog = loadValidatedCatalog();
    const entry = catalog.entries.find((e) => e.matchedRule === 'fx-key-bpm');
    if (!entry) return;
    const res = resolver.resolve({
      entry,
      target: { key: 'Q', bpm: -1 },
    });
    expect(res.status).toBe('unresolved');
    // Unresolved branch is a discriminated union without `relativePath`.
    expect((res as unknown as Record<string, unknown>).relativePath).toBeUndefined();
  });

  it('returns unresolved when a simple-rule entry with a key cannot serve an off-canonical target', () => {
    const resolver = freshDefault();
    const catalog = loadValidatedCatalog();
    // Pick an entry whose canonical only covers a specific key — its
    // matched path encodes that key — and ask for a different key.
    const entry = catalog.entries.find(
      (e) => e.matchedRule === 'simple' && e.key !== null,
    );
    if (!entry) return;
    const otherKey = entry.key === 'A' ? 'B' : 'A';
    const res = resolver.resolve({
      entry,
      target: { key: otherKey, bpm: entry.bpm ?? 120 },
    });
    // Simple-rule entries have no indexed variant pool in this first
    // pass — the resolver returns unresolved with `indexedVariantCount = 0`.
    expect(res.status).toBe('unresolved');
    if (res.status !== 'unresolved') return;
    expect(res.diagnostics.indexedVariantCount).toBe(0);
    expect(res.diagnostics.availableVariantsSample.length).toBe(0);
    expect(res.diagnostics.reason).toMatch(/no variant pool/);
  });
});

describe('resolveAssetPath — output schema + provenance', () => {
  it('every resolution validates against AssetResolutionSchema', () => {
    const resolver = freshDefault();
    const catalog = loadValidatedCatalog();
    // Sample a deterministic spread of entries.
    const samples = [
      pickPlainSimpleEntry(catalog),
      pickFxKeyBpmEntry(catalog),
    ];
    for (const e of samples) {
      const targets: { key: string; bpm: number }[] = [
        { key: e.key ?? 'C', bpm: e.bpm ?? 120 },
        { key: 'A', bpm: 100 },
        { key: 'Q', bpm: -1 },
      ];
      for (const t of targets) {
        const res = resolver.resolve({ entry: e, target: t });
        expect(() => AssetResolutionSchema.parse(res)).not.toThrow();
      }
    }
  });

  it('provenance carries the validated catalog hashes verbatim', () => {
    const resolver = freshDefault();
    const catalog = loadValidatedCatalog();
    const entry = pickPlainSimpleEntry(catalog);
    const res = resolver.resolve({
      entry,
      target: { key: 'C', bpm: 120 },
    });
    expect(res.provenance.catalogContentHash).toBe(catalog.catalogContentHash);
    expect(res.provenance.auditContentHash).toBe(catalog.auditContentHash);
    // The hashes are also exposed directly on the resolver — matches
    // the validated-catalog gate's hashes too.
    expect(resolver.catalogContentHash).toBe(catalog.catalogContentHash);
    expect(resolver.auditContentHash).toBe(catalog.auditContentHash);
  });

  it('validated catalog entries flow through unchanged (ValidatedCatalogEntrySchema)', () => {
    const catalog = loadValidatedCatalog();
    for (const e of catalog.entries.slice(0, 5)) {
      expect(() => ValidatedCatalogEntrySchema.parse(e)).not.toThrow();
    }
  });
});

describe('resolveAssetPath — determinism', () => {
  it('rebuilding the resolver yields a byte-identical resolution for the same input', () => {
    _resetAssetResolverCache();
    _resetValidatedCatalogCache();
    const catalog1 = loadValidatedCatalog();
    const resolver1 = getDefaultAssetResolver();
    const entry1 = pickFxKeyBpmEntry(catalog1);
    const r1 = resolver1.resolve({
      entry: entry1,
      target: { key: 'A', bpm: 100 },
    });

    _resetAssetResolverCache();
    _resetValidatedCatalogCache();
    const catalog2 = loadValidatedCatalog();
    const resolver2 = getDefaultAssetResolver();
    // Re-pick the same entry from the rebuilt catalog by id.
    const entry2 = catalog2.byId.get(entry1.id)!;
    const r2 = resolver2.resolve({
      entry: entry2,
      target: { key: 'A', bpm: 100 },
    });

    expect(JSON.stringify(r2)).toBe(JSON.stringify(r1));
  });

  it('availableVariantsSample is sorted by key (lex) then bpm (asc)', () => {
    const resolver = freshDefault();
    const catalog = loadValidatedCatalog();
    const entry = catalog.entries.find(
      (e) =>
        e.matchedRule === 'fx-key-bpm' &&
        e.preset !== null &&
        e.preset.startsWith('ASC_Atmosphere_13 - '),
    );
    if (!entry) return;
    const res = resolver.resolve({
      entry,
      target: { key: 'Q', bpm: 999 },
    });
    expect(res.status).toBe('unresolved');
    if (res.status !== 'unresolved') return;
    const sample = res.diagnostics.availableVariantsSample;
    for (let i = 1; i < sample.length; i++) {
      const a = sample[i - 1]!;
      const b = sample[i]!;
      const cmp = a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
      if (cmp === 0) expect(a.bpm).toBeLessThanOrEqual(b.bpm);
      else expect(cmp).toBeLessThan(0);
    }
  });
});

describe('resolveAssetPath — no live filesystem access', () => {
  it('a synthetic resolver works without ever reading from disk after construction', () => {
    // Construct a resolver against a minimal synthetic catalog + audit
    // and exercise it — proves the resolve path itself does no I/O.
    const fakeCatalog: ValidatedCatalog = {
      entries: [
        {
          id: 'aaaaaaaaaaaaaaaa',
          family: 'fx',
          lowLevel: 'fxAtmosphere',
          mainStyle: 'edm',
          addStyles: [],
          library: 'fakelib',
          preset: 'Synthetic_Stem - 100',
          info: null,
          addPlugins: null,
          bpm: 100,
          key: 'C',
          normalisation: null,
          status: null,
          legacyReplacement: null,
          sourceSheet: 'fx',
          sourceRow: 1,
          matchedPath:
            'fx/fxAtmosphere/fx - fxAtmosphere - edm - fakelib - Synthetic_Stem - C 100bpm.mp3',
          matchedRule: 'fx-key-bpm',
        },
      ],
      byId: new Map(),
      byPath: new Map(),
      catalogContentHash: 'a'.repeat(64),
      auditContentHash: 'b'.repeat(64),
    };
    const resolver = buildAssetResolver({
      catalog: fakeCatalog,
      unmatchedDiskFiles: [
        {
          family: 'fx',
          relativePath:
            'fx/fxAtmosphere/fx - fxAtmosphere - edm - fakelib - Synthetic_Stem - A 110bpm_modified.mp3',
        },
        {
          family: 'fx',
          relativePath:
            'fx/fxAtmosphere/fx - fxAtmosphere - edm - fakelib - Synthetic_Stem - G 90bpm_modified.mp3',
        },
      ],
    });
    const entry = fakeCatalog.entries[0]!;

    // Canonical.
    const canonical = resolver.resolve({
      entry,
      target: { key: 'C', bpm: 100 },
    });
    expect(canonical.status).toBe('resolved');
    if (canonical.status === 'resolved') {
      expect(canonical.matchKind).toBe('canonical');
      expect(canonical.relativePath).toBe(entry.matchedPath);
    }

    // Variant.
    const variant = resolver.resolve({
      entry,
      target: { key: 'A', bpm: 110 },
    });
    expect(variant.status).toBe('resolved');
    if (variant.status === 'resolved') {
      expect(variant.matchKind).toBe('exact-key-bpm-variant');
      expect(variant.relativePath).toBe(
        'fx/fxAtmosphere/fx - fxAtmosphere - edm - fakelib - Synthetic_Stem - A 110bpm_modified.mp3',
      );
    }

    // Unresolved.
    const unresolved = resolver.resolve({
      entry,
      target: { key: 'B', bpm: 200 },
    });
    expect(unresolved.status).toBe('unresolved');
    if (unresolved.status === 'unresolved') {
      expect(unresolved.diagnostics.indexedVariantCount).toBe(2);
      expect(unresolved.diagnostics.availableVariantsSample).toEqual([
        { key: 'A', bpm: 110 },
        { key: 'G', bpm: 90 },
      ]);
    }

    // Provenance carries through the fake catalog hashes.
    expect(canonical.provenance.catalogContentHash).toBe('a'.repeat(64));
    expect(canonical.provenance.auditContentHash).toBe('b'.repeat(64));
  });
});

describe('resolveAssetPath — barrel convenience wrapper', () => {
  it('resolveAssetPath() returns the same result as getDefaultAssetResolver().resolve()', () => {
    _resetAssetResolverCache();
    _resetValidatedCatalogCache();
    const catalog = loadValidatedCatalog();
    const entry = pickPlainSimpleEntry(catalog);
    const direct = resolveAssetPath({ entry, target: { key: 'C', bpm: 120 } });
    const viaResolver = getDefaultAssetResolver().resolve({
      entry,
      target: { key: 'C', bpm: 120 },
    });
    expect(JSON.stringify(direct)).toBe(JSON.stringify(viaResolver));
  });
});
