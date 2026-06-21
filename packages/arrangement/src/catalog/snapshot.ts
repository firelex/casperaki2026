// Loader for the frozen instrument-catalog snapshot.
//
// The brain reads only this file at runtime. The xlsx never escapes the
// CLI importer / admin endpoint. Loader verifies the embedded contentHash
// against a re-hash of the entries — a hand-edited snapshot whose hash
// has not been regenerated throws here.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DataAssetError, type DataAssetMeta } from '../data/loader.js';

import { recomputeContentHash } from './build-snapshot.js';
import {
  InstrumentCatalogSnapshotSchema,
  type InstrumentCatalogSnapshot,
} from './types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(HERE, '..', '..', 'data');

const SNAPSHOT_META: DataAssetMeta = {
  filename: 'instrument-catalog.snapshot.json',
  legacyPath: 'datigator-instruments/Audio Library Master File.xlsx',
  extractedAt: '2026-06-06',
};

// docs/58h — the union catalog (xlsx rows + disk-only presets). Built by
// scripts/build-union-catalog.mjs. When present it IS the effective
// catalog the brain consumes; otherwise the brain falls back to the
// xlsx-only base snapshot. Same schema, same on-load hash verification.
const UNION_META: DataAssetMeta = {
  filename: 'instrument-catalog.union.json',
  legacyPath: 'datigator-instruments (xlsx ∪ on-disk presets)',
  extractedAt: '2026-06-06',
};

/** Load + Zod-validate + hash-verify a snapshot-shaped catalog file. */
function loadAndVerify(meta: DataAssetMeta): InstrumentCatalogSnapshot {
  const path = resolve(DATA_DIR, meta.filename);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new DataAssetError(meta, `failed to load: ${(err as Error).message}`, err);
  }
  const parsed = InstrumentCatalogSnapshotSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DataAssetError(
      meta,
      `schema validation failed: ${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
  }
  const snapshot = parsed.data;
  const recomputed = recomputeContentHash(snapshot.entries);
  if (recomputed !== snapshot.contentHash) {
    throw new DataAssetError(
      meta,
      `contentHash mismatch (stored=${snapshot.contentHash}, recomputed=${recomputed}); ` +
      `the entries were edited without re-running the importer`,
    );
  }
  return snapshot;
}

let cached: InstrumentCatalogSnapshot | undefined;

/** The frozen xlsx-only base snapshot. Never reflects disk additions —
 *  the union builder reads this to compute the union, and provenance
 *  tests pin its master-file identity. Runtime consumers should use
 *  {@link loadEffectiveCatalogSnapshot} instead. */
export function loadInstrumentCatalogSnapshot(): InstrumentCatalogSnapshot {
  if (cached) return cached;
  cached = loadAndVerify(SNAPSHOT_META);
  return cached;
}

let cachedEffective: InstrumentCatalogSnapshot | undefined;

/** The effective catalog the brain consumes at runtime: the union
 *  catalog (docs/58h) when `instrument-catalog.union.json` is present,
 *  else the xlsx-only base snapshot. Both are hash-verified on load. */
export function loadEffectiveCatalogSnapshot(): InstrumentCatalogSnapshot {
  if (cachedEffective) return cachedEffective;
  const unionPath = resolve(DATA_DIR, UNION_META.filename);
  cachedEffective = existsSync(unionPath)
    ? loadAndVerify(UNION_META)
    : loadInstrumentCatalogSnapshot();
  return cachedEffective;
}

/** Test-only cache reset; not re-exported from the package barrel. */
export function _resetCatalogSnapshotCache(): void {
  cached = undefined;
  cachedEffective = undefined;
}
