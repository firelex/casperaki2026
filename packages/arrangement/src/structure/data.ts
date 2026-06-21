// Typed loader for the legacy-derived structure precedent pools.
// See data/structures/song-structures.json for provenance.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DataAssetError, type DataAssetMeta } from '../data/loader.js';

/** Segment name (legacy lowercase camelCase: `intro`, `verse1`, `preChorus1`,
 *  `chorus1`, `break1`, `bridge1`, `outro`, ...) → bar count. Insertion
 *  order is performance order. */
export type StructurePrecedentSegments = Readonly<Record<string, number>>;

export interface StructurePrecedent {
  readonly precedent: string;
  readonly segments: StructurePrecedentSegments;
}

export interface StructurePools {
  readonly default: readonly StructurePrecedent[];
  readonly schlager: readonly StructurePrecedent[];
}

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(HERE, '..', '..', 'data', 'structures');

const META: DataAssetMeta = {
  filename: 'song-structures.json',
  legacyPath: 'casperaki2-engine-js/api/v1.0/services/classes/songStructures/{songStructures,schlagerSongStructures}.json',
  extractedAt: '2026-06-06',
};

let cached: StructurePools | undefined;

export function loadStructurePools(): StructurePools {
  if (cached) return cached;
  const path = resolve(DATA_DIR, META.filename);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new DataAssetError(META, `failed to load: ${(err as Error).message}`, err);
  }
  const obj = raw as Partial<StructurePools> & Record<string, unknown>;
  if (!Array.isArray(obj.default) || obj.default.length === 0)
    throw new DataAssetError(META, 'missing or empty `default` precedent pool');
  if (!Array.isArray(obj.schlager) || obj.schlager.length === 0)
    throw new DataAssetError(META, 'missing or empty `schlager` precedent pool');
  for (const pool of ['default', 'schlager'] as const) {
    for (const p of obj[pool] as readonly unknown[]) {
      const e = p as Partial<StructurePrecedent>;
      if (typeof e.precedent !== 'string' || !e.precedent)
        throw new DataAssetError(META, `${pool}: precedent missing name`);
      if (!e.segments || typeof e.segments !== 'object')
        throw new DataAssetError(META, `${pool}/${e.precedent}: missing segments`);
      for (const [name, bars] of Object.entries(e.segments)) {
        if (typeof bars !== 'number' || !Number.isInteger(bars) || bars <= 0)
          throw new DataAssetError(META, `${pool}/${e.precedent}: segment "${name}" has non-positive bars`);
      }
    }
  }
  cached = { default: obj.default, schlager: obj.schlager };
  return cached;
}

/** Test-only cache reset. */
export function _resetStructurePoolsCache(): void {
  cached = undefined;
}
