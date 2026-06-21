// Deterministic asset resolver — first pass.
//
// Two layers exist in the sample-library pipeline (53p):
//
//   1. Availability gate: `loadValidatedCatalog()` answers whether a
//      catalog preset is usable at all (its canonical file exists on disk).
//   2. Asset resolution: given a validated entry plus a runtime target
//      `(key, bpm)`, return the actual sample-library file path the
//      renderer should load.
//
// This module is the second layer. It indexes the committed catalog
// snapshot + audit report once (no live filesystem access at any point)
// and answers `resolveAssetPath({ entry, target })` deterministically.
//
// The audit's `unmatchedDiskFiles` list is NOT a bag of orphan files —
// it is the runtime variant pool. The catalog deliberately stores one
// row per preset; the pre-rendered chromatic / bpm variants of each
// preset live on disk alongside the canonical file. The variant index
// is built from `audit.unmatchedDiskFiles` so the resolver can pick a
// matching `_modified` variant for off-canonical `(key, bpm)` targets.
//
// First-pass scope is deliberately narrow — only filename conventions
// directly demonstrated by the audit report are honoured:
//
//   * canonical: target (key, bpm) is compatible with the entry's own
//     (key, bpm) — return `entry.matchedPath` verbatim.
//   * exact-key-bpm-variant: the entry was matched via the audit's
//     `fx-key-bpm` (or its enharmonic-sharp twin) rule. Variants follow
//     the pattern
//       `{prefix} - {KEY} {BPM}bpm_modified.mp3`
//     and live in the same family/lowLevel directory as the canonical
//     file (the disk has 12 keys × ~ 40 bpms per preset stem). If a
//     variant for the target exists in `audit.unmatchedDiskFiles`, that
//     path is returned.
//
// Everything else (nearest-bpm heuristics, key transposition, bass-bpm
// trailer variants without `_modified`, per-library oddities) is
// **deferred**. Unresolved is the conservative, correct answer when the
// resolver cannot confidently identify a path — see the `diagnostics`
// payload for what was tried + what variants ARE indexed for the entry.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { DataAssetError, type DataAssetMeta } from '../data/loader.js';

import {
  SampleLibraryAuditReportSchema,
  type UnmatchedFile,
} from './audit-sample-library.js';
import {
  loadValidatedCatalog,
  type ValidatedCatalog,
  type ValidatedCatalogEntry,
} from './validated-catalog.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AssetResolverInput {
  readonly entry: ValidatedCatalogEntry;
  readonly target: {
    readonly key: string;
    readonly bpm: number;
  };
}

/** Which join rule the resolver used. */
export const MatchKindSchema = z.enum(['canonical', 'exact-key-bpm-variant']);
export type MatchKind = z.infer<typeof MatchKindSchema>;

/** Provenance pinning the catalog + audit identities that produced the
 *  index used to resolve this asset. Lets callers (e.g. the future
 *  engine adapter) record exact upstream hashes against the resolved
 *  asset for replay-drift detection. */
export const AssetResolutionProvenanceSchema = z
  .object({
    catalogContentHash: z.string().regex(/^[0-9a-f]{64}$/u),
    auditContentHash: z.string().regex(/^[0-9a-f]{64}$/u),
  })
  .strict();
export type AssetResolutionProvenance = z.infer<typeof AssetResolutionProvenanceSchema>;

export const ResolvedAssetSchema = z
  .object({
    status: z.literal('resolved'),
    relativePath: z.string().min(1),
    matchKind: MatchKindSchema,
    provenance: AssetResolutionProvenanceSchema,
  })
  .strict();
export type ResolvedAsset = z.infer<typeof ResolvedAssetSchema>;

export const UnresolvedAssetDiagnosticsSchema = z
  .object({
    reason: z.string().min(1),
    entryId: z.string(),
    entryKey: z.string().nullable(),
    entryBpm: z.number().int().nullable(),
    targetKey: z.string(),
    targetBpm: z.number().int(),
    /** Every candidate relative path the resolver considered. */
    candidatePathsTried: z.array(z.string()),
    /** Total number of indexed variants for this entry's group (may be
     *  0 — most catalog rows have no pre-rendered variant pool). */
    indexedVariantCount: z.number().int().nonnegative(),
    /** Sample of variant `(key, bpm)` tuples available for this entry's
     *  group, sorted by key then bpm. Capped to keep diagnostics small. */
    availableVariantsSample: z.array(
      z.object({ key: z.string(), bpm: z.number().int() }).strict(),
    ),
  })
  .strict();
export type UnresolvedAssetDiagnostics = z.infer<typeof UnresolvedAssetDiagnosticsSchema>;

export const UnresolvedAssetSchema = z
  .object({
    status: z.literal('unresolved'),
    diagnostics: UnresolvedAssetDiagnosticsSchema,
    provenance: AssetResolutionProvenanceSchema,
  })
  .strict();
export type UnresolvedAsset = z.infer<typeof UnresolvedAssetSchema>;

export const AssetResolutionSchema = z.discriminatedUnion('status', [
  ResolvedAssetSchema,
  UnresolvedAssetSchema,
]);
export type AssetResolution = z.infer<typeof AssetResolutionSchema>;

// ---------------------------------------------------------------------------
// Variant index
// ---------------------------------------------------------------------------

/** A single indexed variant entry. */
interface IndexedVariant {
  readonly key: string;
  readonly bpm: number;
  readonly relativePath: string;
}

/** Internal: index keyed by the entry's catalogId. Each entry's group
 *  is a set of pre-rendered variants discovered in `unmatchedDiskFiles`
 *  that share the canonical path's directory + filename prefix. */
interface VariantIndex {
  readonly byCatalogId: ReadonlyMap<string, IndexedVariant[]>;
  /** Per-`(catalogId, key, bpm)` direct-hit lookup (cheap, deterministic). */
  readonly lookup: ReadonlyMap<string, string>;
}

/** Resolver bound to a specific validated catalog + a precomputed
 *  variant index. Constructed lazily for the package's default catalog;
 *  also constructable explicitly in tests (e.g. against a synthetic
 *  catalog + audit pair). */
export interface AssetResolver {
  readonly catalogContentHash: string;
  readonly auditContentHash: string;
  resolve(input: AssetResolverInput): AssetResolution;
}

// Filename parsing — anchored on the audit's `fx-key-bpm` rule:
//   `{prefix} - {KEY} {BPM}bpm[_modified].mp3`
// where `{prefix}` is the rest of the basename (already includes
// family/lowLevel/mainStyle/library/presetStem from the audit's join).
const FX_KEY_BPM_FILENAME_RE =
  /^(?<prefix>.+) - (?<keyName>[A-G][#b]?) (?<bpm>\d+)bpm(?<modified>_modified)?\.mp3$/u;

interface ParsedVariantFilename {
  readonly prefix: string;
  readonly key: string;
  readonly bpm: number;
  readonly modified: boolean;
}

function parseFxKeyBpmFilename(basename: string): ParsedVariantFilename | null {
  const m = FX_KEY_BPM_FILENAME_RE.exec(basename);
  if (!m || !m.groups) return null;
  const bpm = Number.parseInt(m.groups.bpm!, 10);
  if (!Number.isFinite(bpm)) return null;
  return {
    prefix: m.groups.prefix!,
    key: m.groups.keyName!,
    bpm,
    modified: m.groups.modified === '_modified',
  };
}

function dirnameOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

function basenameOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

/** Per-entry filename prefix used to group variants. Only defined for
 *  entries whose canonical match was the fx-key-bpm rule (or its
 *  enharmonic-sharp twin); other entries have no demonstrated variant
 *  pool in the audit and are left without a prefix. */
function variantPrefixFor(entry: ValidatedCatalogEntry): string | null {
  if (entry.matchedRule !== 'fx-key-bpm' && entry.matchedRule !== 'fx-key-bpm-enharmonic') {
    return null;
  }
  const base = basenameOf(entry.matchedPath);
  const parsed = parseFxKeyBpmFilename(base);
  return parsed?.prefix ?? null;
}

interface IndexBuildInput {
  readonly entries: readonly ValidatedCatalogEntry[];
  readonly unmatchedDiskFiles: readonly { readonly family: string; readonly relativePath: string }[];
}

/** Build the variant index from validated entries + audit unmatched
 *  files. Pure; sorted output; deterministic. */
function buildVariantIndex(input: IndexBuildInput): VariantIndex {
  // Group entries by their canonical (dir, prefix) so an unmatched disk
  // file with the same shape can be assigned in O(1).
  type GroupAnchor = { catalogIds: string[] };
  const anchorsByDirPrefix = new Map<string, GroupAnchor>();
  for (const entry of input.entries) {
    const prefix = variantPrefixFor(entry);
    if (prefix === null) continue;
    const dir = dirnameOf(entry.matchedPath);
    const key = `${dir} ${prefix}`;
    let anchor = anchorsByDirPrefix.get(key);
    if (!anchor) {
      anchor = { catalogIds: [] };
      anchorsByDirPrefix.set(key, anchor);
    }
    anchor.catalogIds.push(entry.id);
  }

  // For each unmatched disk file in a directory we know about, parse it
  // and assign it to every catalog entry that shares its (dir, prefix).
  const variantsByCatalogId = new Map<string, IndexedVariant[]>();
  for (const f of input.unmatchedDiskFiles) {
    const dir = dirnameOf(f.relativePath);
    const base = basenameOf(f.relativePath);
    const parsed = parseFxKeyBpmFilename(base);
    if (!parsed) continue;
    const key = `${dir} ${parsed.prefix}`;
    const anchor = anchorsByDirPrefix.get(key);
    if (!anchor) continue;
    const variant: IndexedVariant = {
      key: parsed.key,
      bpm: parsed.bpm,
      relativePath: f.relativePath,
    };
    for (const catalogId of anchor.catalogIds) {
      const list = variantsByCatalogId.get(catalogId);
      if (list) list.push(variant);
      else variantsByCatalogId.set(catalogId, [variant]);
    }
  }

  // Deterministic ordering: by key (lex), then bpm.
  for (const list of variantsByCatalogId.values()) {
    list.sort((a, b) => {
      if (a.key !== b.key) return a.key < b.key ? -1 : 1;
      return a.bpm - b.bpm;
    });
  }

  // Build the direct-hit lookup map. Key shape: `${catalogId}|${key}|${bpm}`.
  const lookup = new Map<string, string>();
  for (const [catalogId, variants] of variantsByCatalogId) {
    for (const v of variants) {
      const k = `${catalogId}|${v.key}|${v.bpm}`;
      // First-write-wins keeps the resolver deterministic if (rare)
      // multiple files map to the same tuple. The audit's own
      // `duplicateCandidates` already flags these upstream; we don't
      // re-flag here.
      if (!lookup.has(k)) lookup.set(k, v.relativePath);
    }
  }

  return { byCatalogId: variantsByCatalogId, lookup };
}

// ---------------------------------------------------------------------------
// Canonical-vs-target predicate
// ---------------------------------------------------------------------------

/** Whether the entry's canonical disk file is the right choice for the
 *  given target. A canonical match occurs when the entry's own key/bpm
 *  are compatible with the target — either equal or absent (a null
 *  catalog field is the canonical author's signal that the dimension is
 *  not a path component for this preset). */
function isCanonicalMatch(
  entry: ValidatedCatalogEntry,
  target: { key: string; bpm: number },
): boolean {
  if (entry.key !== null && entry.key !== target.key) return false;
  if (entry.bpm !== null && entry.bpm !== target.bpm) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Resolver construction + public API
// ---------------------------------------------------------------------------

/** Build a resolver bound to a specific validated catalog. Caller may
 *  pass the audit's `unmatchedDiskFiles` (the variant pool) explicitly;
 *  the package's default resolver wires this for the committed catalog. */
export function buildAssetResolver(input: {
  readonly catalog: ValidatedCatalog;
  readonly unmatchedDiskFiles: readonly { readonly family: string; readonly relativePath: string }[];
}): AssetResolver {
  const index = buildVariantIndex({
    entries: input.catalog.entries,
    unmatchedDiskFiles: input.unmatchedDiskFiles,
  });
  const provenance: AssetResolutionProvenance = {
    catalogContentHash: input.catalog.catalogContentHash,
    auditContentHash: input.catalog.auditContentHash,
  };

  return {
    catalogContentHash: provenance.catalogContentHash,
    auditContentHash: provenance.auditContentHash,
    resolve(req: AssetResolverInput): AssetResolution {
      const { entry, target } = req;

      if (isCanonicalMatch(entry, target)) {
        return {
          status: 'resolved',
          relativePath: entry.matchedPath,
          matchKind: 'canonical',
          provenance,
        };
      }

      const variantHit = index.lookup.get(`${entry.id}|${target.key}|${target.bpm}`);
      if (variantHit !== undefined) {
        return {
          status: 'resolved',
          relativePath: variantHit,
          matchKind: 'exact-key-bpm-variant',
          provenance,
        };
      }

      const indexedVariants = index.byCatalogId.get(entry.id) ?? [];
      const candidatePathsTried: string[] = [entry.matchedPath];
      if (variantPrefixFor(entry) !== null) {
        const dir = dirnameOf(entry.matchedPath);
        const prefix = variantPrefixFor(entry)!;
        candidatePathsTried.push(
          `${dir}/${prefix} - ${target.key} ${target.bpm}bpm_modified.mp3`,
        );
      }
      const reason =
        indexedVariants.length === 0
          ? 'no variant pool indexed for this entry; canonical is incompatible with target'
          : `target (key=${target.key}, bpm=${target.bpm}) not present in this entry's ${indexedVariants.length}-variant pool`;

      return {
        status: 'unresolved',
        provenance,
        diagnostics: {
          reason,
          entryId: entry.id,
          entryKey: entry.key,
          entryBpm: entry.bpm,
          targetKey: target.key,
          targetBpm: target.bpm,
          candidatePathsTried,
          indexedVariantCount: indexedVariants.length,
          availableVariantsSample: indexedVariants
            .slice(0, 8)
            .map((v) => ({ key: v.key, bpm: v.bpm })),
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Default resolver bound to the committed validated catalog + audit
// ---------------------------------------------------------------------------

let cachedDefault: AssetResolver | undefined;

/** Default resolver: bound to the committed catalog snapshot + audit.
 *  Constructed once per process; subsequent calls return the cached
 *  resolver. Tests can reset the cache via `_resetAssetResolverCache`. */
export function getDefaultAssetResolver(): AssetResolver {
  if (cachedDefault) return cachedDefault;
  const catalog = loadValidatedCatalog();
  // Loading the audit JSON again (rather than threading it through the
  // ValidatedCatalog shape) keeps the validated-catalog surface frozen
  // per 53q. The reads are cheap relative to the index build.
  const unmatched = loadCommittedUnmatchedDiskFiles();
  cachedDefault = buildAssetResolver({
    catalog,
    unmatchedDiskFiles: unmatched,
  });
  return cachedDefault;
}

/** Convenience wrapper using the default resolver. */
export function resolveAssetPath(input: AssetResolverInput): AssetResolution {
  return getDefaultAssetResolver().resolve(input);
}

/** Test-only cache reset. Not re-exported from the package barrel. */
export function _resetAssetResolverCache(): void {
  cachedDefault = undefined;
}

// ---------------------------------------------------------------------------
// Audit loader (committed file only — no live filesystem walk)
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(HERE, '..', '..', 'data');

const AUDIT_META: DataAssetMeta = {
  filename: 'sample-library.audit.json',
  legacyPath: 'datigator-instruments/instruments (audited disk state)',
  extractedAt: '2026-06-06',
};

function loadCommittedUnmatchedDiskFiles(): readonly UnmatchedFile[] {
  const path = resolve(DATA_DIR, AUDIT_META.filename);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new DataAssetError(
      AUDIT_META,
      `failed to load (run scripts/audit-sample-library.mjs?): ${(err as Error).message}`,
      err,
    );
  }
  const parsed = SampleLibraryAuditReportSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DataAssetError(
      AUDIT_META,
      `schema validation failed: ${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
  }
  return parsed.data.unmatchedDiskFiles;
}
