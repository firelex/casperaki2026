// Validated catalog — the runtime gate.
//
// The instrument catalog snapshot is the authority for what *should*
// exist; the sample-library audit verifies what *does* exist on disk.
// Brain runtime code (selectInstruments, the future engine resolver,
// the future admin UI) MUST consume only entries that pass both gates.
// This loader produces that intersection.
//
// Loaded eagerly at boot, never mutated, cached for the process lifetime.
// Audit staleness is checked: the audit's `catalogContentHash` must
// equal the snapshot's `contentHash`. A stale audit throws — the
// operator must re-run `audit-sample-library.mjs` after any catalog
// or disk change.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import { DataAssetError, type DataAssetMeta } from '../data/loader.js';

import {
  InstrumentEntrySchema,
  type InstrumentEntry,
} from './types.js';
import { loadEffectiveCatalogSnapshot } from './snapshot.js';
import {
  SampleLibraryAuditReportSchema,
  type SampleLibraryAuditReport,
} from './audit-sample-library.js';

/** One catalog row that passed the audit, with its resolved disk path
 *  and the join rule that produced the match. The brain's selection /
 *  engine-resolver code consumes only this. */
export const ValidatedCatalogEntrySchema = InstrumentEntrySchema.extend({
  matchedPath: z.string(),
  matchedRule: z.string(),
});
export type ValidatedCatalogEntry = z.infer<typeof ValidatedCatalogEntrySchema>;

export interface ValidatedCatalog {
  /** Audited entries, deterministic order (catalog snapshot order). */
  readonly entries: readonly ValidatedCatalogEntry[];
  /** Lookup by catalogId (entry.id). */
  readonly byId: ReadonlyMap<string, ValidatedCatalogEntry>;
  /** Lookup by matched relative path. */
  readonly byPath: ReadonlyMap<string, ValidatedCatalogEntry>;
  /** Pin both upstream identities so a downstream caller can record
   *  exactly which catalog + audit produced this validated set (e.g.
   *  for inclusion in Song.generator). */
  readonly catalogContentHash: string;
  readonly auditContentHash: string;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(HERE, '..', '..', 'data');

const AUDIT_META: DataAssetMeta = {
  filename: 'sample-library.audit.json',
  legacyPath: 'datigator-instruments/instruments (audited disk state)',
  extractedAt: '2026-06-06',
};

let cached: ValidatedCatalog | undefined;

export function loadValidatedCatalog(): ValidatedCatalog {
  if (cached) return cached;

  // docs/58h — the effective catalog is the union (xlsx ∪ disk) when
  // present, else the xlsx-only base snapshot. The audit must have been
  // computed against whichever this returns (staleness gate below).
  const snapshot = loadEffectiveCatalogSnapshot();

  // Audit file is in the same data/ directory as the snapshot. Loading
  // it via the same DataAssetError surface keeps error messages
  // consistent with the rest of the brain's data loaders.
  const auditPath = resolve(DATA_DIR, AUDIT_META.filename);
  let rawAudit: unknown;
  try {
    rawAudit = JSON.parse(readFileSync(auditPath, 'utf8'));
  } catch (err) {
    throw new DataAssetError(
      AUDIT_META,
      `failed to load (run scripts/audit-sample-library.mjs?): ${(err as Error).message}`,
      err,
    );
  }
  const parsed = SampleLibraryAuditReportSchema.safeParse(rawAudit);
  if (!parsed.success) {
    throw new DataAssetError(
      AUDIT_META,
      `schema validation failed: ${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
  }
  const audit: SampleLibraryAuditReport = parsed.data;

  // Staleness gate: the audit must have been computed against the
  // exact catalog snapshot we just loaded. If the snapshot was
  // regenerated, the audit must be regenerated too.
  if (audit.LEGACY_PROVENANCE.catalogContentHash !== snapshot.contentHash) {
    throw new DataAssetError(
      AUDIT_META,
      `stale audit: catalogContentHash=${audit.LEGACY_PROVENANCE.catalogContentHash} ` +
        `does not match current snapshot contentHash=${snapshot.contentHash}. ` +
        `Re-run scripts/audit-sample-library.mjs and commit the regenerated ` +
        `data/sample-library.audit.json.`,
    );
  }

  // Build the intersection. The catalog snapshot is the iteration
  // source so output order matches snapshot order — deterministic and
  // independent of the audit's own ordering.
  const matchedByCatalogId = new Map<string, { matchedPath: string; matchedRule: string }>();
  for (const m of audit.matched) {
    matchedByCatalogId.set(m.catalogId, { matchedPath: m.matchedPath, matchedRule: m.matchedRule });
  }

  const entries: ValidatedCatalogEntry[] = [];
  const byId = new Map<string, ValidatedCatalogEntry>();
  const byPath = new Map<string, ValidatedCatalogEntry>();
  for (const e of snapshot.entries) {
    const hit = matchedByCatalogId.get(e.id);
    if (!hit) continue; // catalog row not in audit's matched set → filtered out
    // docs/58h — `source` ('xlsx'|'disk') is union-catalog provenance and
    // lives in the catalog file only; it is intentionally NOT propagated
    // into the validated entry so selection / engine-adapter output (and
    // their goldens) stay byte-identical whether or not the union is live.
    // Auditability of disk additions lives in `unionProvenance` + the
    // `source` field on the committed instrument-catalog.union.json.
    const { source: _source, ...base } = e;
    const validated: ValidatedCatalogEntry = {
      ...base,
      matchedPath: hit.matchedPath,
      matchedRule: hit.matchedRule,
    };
    entries.push(validated);
    byId.set(validated.id, validated);
    // byPath may overwrite if the audit somehow listed duplicate paths;
    // duplicates are normally caught by the audit's `duplicateCandidates`
    // — last-write-wins keeps the loader defensive without crashing.
    byPath.set(validated.matchedPath, validated);
  }

  cached = {
    entries,
    byId,
    byPath,
    catalogContentHash: snapshot.contentHash,
    auditContentHash: audit.contentHash,
  };
  return cached;
}

/** Test-only cache reset. Not re-exported from the package barrel. */
export function _resetValidatedCatalogCache(): void {
  cached = undefined;
}
