// Union catalog builder — pure (no I/O).
//
// docs/58h. The frozen xlsx snapshot (`build-snapshot.ts`) catalogs only
// the rows the master workbook authored. The sample library on disk holds
// MANY presets the workbook never listed — whole subcategories like
// `synths/synthsSoftPad` (54), `synths/synthsBrightPad` (19), extra
// `synths/synthsPlucked`, plus stray keys / orchestral / guitar / brass /
// vocal presets. They are invisible to selection because no catalog row
// points at them.
//
// This builder forms the *effective* catalog: the UNION of
//   (a) every xlsx snapshot row (tagged `source: 'xlsx'`), and
//   (b) one row per disk file that no xlsx row claimed AND that is a
//       genuine new preset (tagged `source: 'disk'`).
//
// The disk-only additions are read from a sample-library audit report's
// `unmatchedDiskFiles` (every disk file no catalog row matched). We do NOT
// walk the disk here — the audit already did, and re-deriving from its
// committed output keeps the build pure, fast, and deterministic (the
// Dropbox mount is slow; see the audit CLI).
//
// Two classes of unmatched file are deliberately EXCLUDED so they stay in
// the audit's `unmatchedDiskFiles` for the asset resolver's variant pool:
//   * tonal / tempo *variant renders* — pre-rendered per-key / per-bpm
//     siblings of a catalogued preset (`… - C# 122bpm.mp3`,
//     `… 75bpm_modified.mp3`, `Classic Wobble - 123.mp3`). These are not
//     new presets; the resolver picks them for off-canonical targets.
//   * `percussionLoops` — the loop domain is bpm-binned and resolved by
//     `engine-adapter` `loops.ts`, not by the per-preset catalog.
//
// Each surviving file is parsed back into catalog fields by inverting the
// audit's `RULE_SIMPLE` join. As a hard correctness gate, the parsed entry
// is fed through `preferredExpectedPath` and the result MUST reproduce the
// exact disk path — otherwise the file is mis-filed on disk (e.g. a file
// whose embedded lowLevel disagrees with its directory) and could never be
// audited-matched, so it is skipped rather than added as a permanently
// `missing` row.
//
// Determinism: same (base snapshot, audit) in → byte-identical union out.
// Disk `sourceRow`s are assigned from a fixed base offset in the audit's
// (already sorted) `unmatchedDiskFiles` order, then `sortCatalogEntries`
// imposes the canonical ordering; `recomputeContentHash` hashes the result.

import {
  buildVocabulary,
  deriveId,
  FAMILIES,
  recomputeContentHash,
  sortCatalogEntries,
} from './build-snapshot.js';
import { auditSampleLibrary, preferredExpectedPath } from './audit-sample-library.js';
import type { DiskIndex, SampleLibraryAuditReport } from './audit-sample-library.js';
import {
  MainStyleSchema,
  type InstrumentCatalogSnapshot,
  type InstrumentEntry,
  type InstrumentSheetFamily,
  type MainStyle,
  type UnionProvenance,
} from './types.js';

const FAMILY_SET: ReadonlySet<string> = new Set(FAMILIES);
const MAIN_STYLE_SET: ReadonlySet<string> = new Set(MainStyleSchema.options);

// Disk-row sourceRow base offset. Disk additions have no workbook row; we
// give them synthetic, deterministic `sourceRow`s well above any real
// xlsx row so that on a sort tie (same family/lowLevel/library/preset)
// disk rows order *after* xlsx rows. Assigned in audit `unmatchedDiskFiles`
// order (which the audit emits sorted by relativePath).
const DISK_SOURCE_ROW_BASE = 1_000_000;

// A basename that is a per-key / per-bpm *variant render* of a catalogued
// preset, NOT a distinct preset. These belong to the asset-resolver's
// variant pool and must remain in the audit's `unmatchedDiskFiles`.
//   * `_modified.mp3`            — any pitch/tempo-shifted render
//   * `… <KEY> <BPM>bpm.mp3`     — fx chromatic render (with or without a
//                                  preceding " - "), e.g. `… baarp A 70bpm`
//   * `… - <BPM>.mp3`            — bass bpm trailer, e.g. `Classic Wobble - 123`
const VARIANT_MODIFIED_RE = /_modified\.mp3$/u;
const VARIANT_KEY_BPM_RE = / [A-G][#b]? \d+bpm(?:_modified)?\.mp3$/u;
const VARIANT_BPM_TRAILER_RE = / - \d+\.mp3$/u;

/** Whether a disk basename is a variant render (excluded from the union). */
export function isVariantRender(basename: string): boolean {
  return (
    VARIANT_MODIFIED_RE.test(basename) ||
    VARIANT_KEY_BPM_RE.test(basename) ||
    VARIANT_BPM_TRAILER_RE.test(basename)
  );
}

export interface ParsedDiskFields {
  readonly family: InstrumentSheetFamily;
  readonly lowLevel: string;
  readonly mainStyle: MainStyle | null;
  readonly library: string | null;
  readonly preset: string | null;
}

/** Invert the audit's `RULE_SIMPLE` join on a `{family}/{lowLevel}/{base}`
 *  relative path. Returns `null` when the path can't be a clean preset
 *  (unknown family, or its embedded family/lowLevel disagrees with its
 *  directory — a mis-filed disk file). Field *boundaries* mirror
 *  `RULE_SIMPLE` exactly: tokens after `mainStyle` are `library` (first)
 *  then `preset` (rest), so the parse round-trips through
 *  `preferredExpectedPath`. */
export function parseDiskFilename(relativePath: string): ParsedDiskFields | null {
  const segs = relativePath.split('/');
  if (segs.length < 3) return null;
  const family = segs[0]!;
  const lowLevel = segs[1]!;
  if (!FAMILY_SET.has(family)) return null;
  const base = segs.slice(2).join('/');
  if (!base.endsWith('.mp3')) return null;
  const stem = base.slice(0, -'.mp3'.length);
  const tok = stem.split(' - ');
  // The audit's RULE_SIMPLE always prefixes the basename with the row's
  // own family + lowLevel. A mismatch means the file is mis-filed.
  if (tok[0] !== family || tok[1] !== lowLevel) return null;
  let rem = tok.slice(2);
  let mainStyle: MainStyle | null = null;
  if (rem.length > 0 && MAIN_STYLE_SET.has(rem[0]!)) {
    mainStyle = rem[0] as MainStyle;
    rem = rem.slice(1);
  }
  let library: string | null = null;
  let preset: string | null = null;
  if (rem.length === 1) {
    preset = rem[0]!;
  } else if (rem.length >= 2) {
    library = rem[0]!;
    preset = rem.slice(1).join(' - ');
  }
  return {
    family: family as InstrumentSheetFamily,
    lowLevel,
    mainStyle,
    library,
    preset,
  };
}

export interface UnionBuildInput {
  readonly base: InstrumentCatalogSnapshot;
  readonly audit: SampleLibraryAuditReport;
  /** ISO label embedded in provenance (outside the hashed region). When
   *  omitted, the source audit's `auditedAt` is used so the build stays
   *  deterministic from committed inputs. */
  readonly builtAt?: string;
  /** Provenance label for the builder (CLI script path / endpoint id). */
  readonly builder?: string;
}

export interface UnionBuildResult {
  readonly snapshot: InstrumentCatalogSnapshot;
  readonly additions: readonly InstrumentEntry[];
  readonly skippedVariants: number;
  readonly skippedNonReconstructable: readonly string[];
}

const UNION_DESCRIPTION =
  'Union instrument catalog (docs/58h): the frozen xlsx snapshot plus one ' +
  'row per disk file the xlsx never listed. The brain consumes this file ' +
  'as the effective catalog; `source` on each entry marks xlsx vs disk ' +
  'origin. `contentHash` is a SHA-256 over the canonical bytes of ' +
  '`entries` and is verified on load.';

const UNION_TRANSFORM =
  'From the source audit `unmatchedDiskFiles`, drop variant renders ' +
  '(`_modified`, `<KEY> <BPM>bpm`, ` - <BPM>` trailers) and the ' +
  '`percussionLoops` loop domain; invert RULE_SIMPLE on each survivor to ' +
  'recover (family, lowLevel, mainStyle, library, preset); keep only files ' +
  'whose parsed entry round-trips back to the exact disk path via ' +
  'preferredExpectedPath; assign deterministic disk sourceRows; union with ' +
  'the xlsx rows; re-sort and re-hash exactly as build-snapshot does.';

/** Reconstruct the disk-file listing the audit observed, from its own
 *  output: every disk basename appears as a `matched.matchedPath`, an
 *  `ambiguous.matchingPaths` entry, or an `unmatchedDiskFiles.relativePath`
 *  (the audit's pass 3 lists every walked file not otherwise claimed).
 *  Paths are already catalog-canonical (aliases applied during the walk),
 *  so they can be re-audited against any catalog directly. */
function reconstructDiskIndex(audit: SampleLibraryAuditReport): DiskIndex {
  const index = new Map<string, Set<string>>();
  const add = (relPath: string): void => {
    const slash = relPath.lastIndexOf('/');
    if (slash === -1) return;
    const dir = relPath.slice(0, slash);
    const base = relPath.slice(slash + 1);
    let bucket = index.get(dir);
    if (!bucket) {
      bucket = new Set();
      index.set(dir, bucket);
    }
    bucket.add(base);
  };
  for (const m of audit.matched) add(m.matchedPath);
  for (const a of audit.ambiguous) for (const p of a.matchingPaths) add(p);
  for (const u of audit.unmatchedDiskFiles) add(u.relativePath);
  return index;
}

/** Build the union catalog from a base xlsx snapshot + a sample-library
 *  audit. Pure; deterministic; ORDER-INDEPENDENT: the disk additions are
 *  re-derived as the files unmatched by the BASE catalog (not by whatever
 *  catalog the audit happened to run against), so re-running this after
 *  the audit has been re-run against the union still reproduces the same
 *  additions. */
export function buildUnionCatalog(input: UnionBuildInput): UnionBuildResult {
  const { base, audit } = input;

  // Re-audit the observed disk listing against the BASE catalog so the
  // candidate set is "files no xlsx row claims" regardless of which
  // catalog `audit` was computed against. Pure — no disk access.
  const baseAudit = auditSampleLibrary({
    catalogSnapshot: base,
    diskIndex: reconstructDiskIndex(audit),
    provenance: {
      sampleRootLabel: '',
      auditedAt: '',
      auditor: 'buildUnionCatalog/base-reaudit',
      aliasesApplied: [],
    },
  });
  const unmatchedVsBase = baseAudit.unmatchedDiskFiles;

  // (a) every xlsx row, explicitly tagged.
  const entries: InstrumentEntry[] = base.entries.map((e) => ({
    ...e,
    source: 'xlsx' as const,
  }));
  const seenIds = new Set(entries.map((e) => e.id));

  // (b) disk-only additions.
  const additions: InstrumentEntry[] = [];
  const skippedNonReconstructable: string[] = [];
  let skippedVariants = 0;
  let diskRow = 0;

  for (const f of unmatchedVsBase) {
    const basename = f.relativePath.slice(f.relativePath.lastIndexOf('/') + 1);
    if (f.family === 'percussionLoops' || isVariantRender(basename)) {
      skippedVariants++;
      continue;
    }
    const parsed = parseDiskFilename(f.relativePath);
    if (parsed === null) {
      skippedNonReconstructable.push(f.relativePath);
      continue;
    }
    const id = deriveId(
      parsed.family,
      parsed.lowLevel,
      parsed.library,
      parsed.preset,
      null,
      null,
      parsed.mainStyle,
      [],
    );
    const entry: InstrumentEntry = {
      id,
      family: parsed.family,
      lowLevel: parsed.lowLevel,
      mainStyle: parsed.mainStyle,
      addStyles: [],
      library: parsed.library,
      preset: parsed.preset,
      info: null,
      addPlugins: null,
      bpm: null,
      key: null,
      normalisation: null,
      status: null,
      legacyReplacement: null,
      sourceSheet: parsed.family,
      sourceRow: DISK_SOURCE_ROW_BASE + diskRow,
      source: 'disk',
    };
    // Hard gate: the parsed entry must reproduce the exact disk path under
    // the audit's own RULE_SIMPLE, or it can never be audited-matched.
    if (preferredExpectedPath(entry) !== f.relativePath) {
      skippedNonReconstructable.push(f.relativePath);
      continue;
    }
    // Defensive: an id that already exists would mean the xlsx already
    // authored this exact (family,lowLevel,library,preset,…) — in which
    // case the file would have matched and not be unmatched. Skip rather
    // than shadow an xlsx row.
    if (seenIds.has(id)) {
      skippedNonReconstructable.push(f.relativePath);
      continue;
    }
    seenIds.add(id);
    diskRow++;
    additions.push(entry);
    entries.push(entry);
  }

  sortCatalogEntries(entries);
  const contentHash = recomputeContentHash(entries);

  const additionsByFamily: Record<string, number> = {};
  for (const e of additions) {
    additionsByFamily[e.family] = (additionsByFamily[e.family] ?? 0) + 1;
  }

  const unionProvenance: UnionProvenance = {
    base: {
      contentHash: base.contentHash,
      source: base.LEGACY_PROVENANCE.source,
      importer: base.LEGACY_PROVENANCE.importer,
    },
    sourceAudit: {
      contentHash: audit.contentHash,
      auditedAt: audit.LEGACY_PROVENANCE.auditedAt,
    },
    builder: input.builder ?? 'buildUnionCatalog',
    builtAt: input.builtAt ?? audit.LEGACY_PROVENANCE.auditedAt,
    additions: additions.length,
    additionsByFamily,
    skippedVariants,
    skippedNonReconstructable: [...skippedNonReconstructable].sort(),
    transform: UNION_TRANSFORM,
  };

  const snapshot: InstrumentCatalogSnapshot = {
    $schemaVersion: 1,
    $description: UNION_DESCRIPTION,
    LEGACY_PROVENANCE: {
      ...base.LEGACY_PROVENANCE,
      rowsImported: entries.length,
    },
    unionProvenance,
    contentHash,
    vocabulary: buildVocabulary(entries),
    entries,
  };

  return {
    snapshot,
    additions,
    skippedVariants,
    skippedNonReconstructable,
  };
}
