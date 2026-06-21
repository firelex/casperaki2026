// Sample-library audit — pure function comparing the frozen catalog
// snapshot against an observed disk index.
//
// The catalog snapshot (see docs/53n) is the authority for what *should*
// exist; the disk index reflects observed state. The audit:
//   - resolves every catalog row against a list of candidate expected
//     file paths (deterministic; no fuzzy matching),
//   - classifies each row as matched / missing / ambiguous,
//   - flags catalog rows that compete for the same disk path
//     (duplicateCandidates),
//   - reports disk files that no catalog row claimed (unmatchedDiskFiles).
//
// Filesystem walking is NOT done here — the caller supplies a `DiskIndex`
// (a typed snapshot of basenames per `family/lowLevel` directory). The
// CLI in `scripts/audit-sample-library.mjs` does the walk; a future brain
// admin endpoint can build the index from any other source.
//
// Determinism: `contentHash` covers the canonical bytes of {summary,
// matched, missing, ambiguous, duplicateCandidates, unmatchedDiskFiles}.
// `auditedAt` / `sampleRoot` live outside the hashed region so the
// audit's identity depends only on the catalog state and the disk state.

import { createHash } from 'node:crypto';
import { z } from 'zod';

import { stableStringify } from '@casperaki/song-schema';

import {
  type InstrumentCatalogSnapshot,
  type InstrumentEntry,
  type InstrumentSheetFamily,
} from './types.js';

/** Per-`family/lowLevel` directory index of basenames present on disk.
 *  Constructed by the CLI's filesystem walk (or any other source — the
 *  pure audit doesn't care where it came from). Keys are
 *  catalog-canonical paths (i.e. any aliasing has already been applied;
 *  see `aliases` parameter on `auditSampleLibrary`). */
export type DiskIndex = ReadonlyMap<string, ReadonlySet<string>>;

/** A `disk → catalog` directory-name alias. When the disk uses one
 *  spelling and the catalog uses another (e.g. percussionLoops bpm-bin
 *  boundary differences), the CLI applies this alias during the walk so
 *  matches succeed. Each alias is recorded in the audit report so the
 *  human can see what we papered over. */
export interface LowLevelAlias {
  readonly family: string;
  readonly diskLowLevel: string;
  readonly catalogLowLevel: string;
  readonly reason: string;
}

export interface AuditProvenance {
  /** Free-form label (e.g. the absolute D:\… path on the dev box). NOT
   *  used for determinism; exists for traceability. */
  readonly sampleRootLabel: string;
  /** ISO-8601 timestamp. Lives outside the hashed region. */
  readonly auditedAt: string;
  /** Free-form label for the caller (CLI script path, admin endpoint id). */
  readonly auditor: string;
  /** Disk → catalog directory aliases used during the walk. Surfaced in
   *  the report and IS part of the hashed identity so different alias
   *  policies produce different audit hashes. */
  readonly aliasesApplied: readonly LowLevelAlias[];
}

// --- Match-rule registry -----------------------------------------------

/** One join strategy producing a candidate relative path. Pure;
 *  deterministic. Rules are tried in the order they're listed in
 *  `MATCH_RULES` below. */
interface MatchRule {
  readonly id: string;
  readonly description: string;
  readonly apply: (entry: InstrumentEntry) => string | null;
}

function joinFamilyDir(family: string, lowLevel: string): string {
  return `${family}/${lowLevel}`;
}

/** Flat → sharp enharmonic equivalents. The catalog uses both
 *  spellings; the disk uses sharps only for the fx chromatic-key
 *  renders. Returns `null` when the input has no flat spelling.
 *  Idempotent: calling on a sharp-spelled key returns null. */
function enharmonicSharpOf(key: string): string | null {
  switch (key) {
    case 'Db': return 'C#';
    case 'Eb': return 'D#';
    case 'Gb': return 'F#';
    case 'Ab': return 'G#';
    case 'Bb': return 'A#';
    default:   return null;
  }
}

// Rule 1 — simple canonical join. Covers the bulk of catalog rows
// (kicks, snares, basses, keys, orchestral, vocals, etc.).
//   {family} - {lowLevel} - {mainStyle} - [{library} - ]{preset}[ - {key}].mp3
const RULE_SIMPLE: MatchRule = {
  id: 'simple',
  description:
    '{family} - {lowLevel} - {mainStyle} - [{library} - ]{preset}[ - {key}].mp3 — ' +
    'nulls skipped; key appended only when present.',
  apply(e: InstrumentEntry) {
    const parts = [e.family, e.lowLevel, e.mainStyle, e.library, e.preset]
      .filter((x): x is string => typeof x === 'string' && x.length > 0);
    if (parts.length < 2) return null;
    let base = parts.join(' - ');
    if (e.key !== null) base += ` - ${e.key}`;
    return `${joinFamilyDir(e.family, e.lowLevel)}/${base}.mp3`;
  },
};

// Rule 2 — fx with key+bpm where the preset embeds " - {bpm}" at the
// end. Disk convention: `… - {presetStem} - {key} {bpm}bpm.mp3`.
//   catalog row: preset='Atmosphere_Bell_Arp - 123', key='F', bpm=123
//   disk file:   'fx - fxAtmosphere - edm - bigZ - Atmosphere_Bell_Arp - F 123bpm.mp3'
// Only kicks in when (family === 'fx') AND key AND bpm AND library are
// set AND the preset ends with ` - {bpm}`. Otherwise yields no candidate.
const RULE_FX_KEY_BPM: MatchRule = {
  id: 'fx-key-bpm',
  description:
    'fx rows where the catalog preset ends with " - {bpm}": strip that ' +
    'suffix and format the file as "{prefix} - {presetStem} - {key} {bpm}bpm.mp3".',
  apply(e: InstrumentEntry) {
    if (e.family !== 'fx') return null;
    if (e.bpm === null || e.key === null) return null;
    if (e.library === null || e.preset === null) return null;
    const trailer = ` - ${e.bpm}`;
    if (!e.preset.endsWith(trailer)) return null;
    const stem = e.preset.slice(0, -trailer.length);
    if (stem.length === 0) return null;
    const mid = [e.family, e.lowLevel, e.mainStyle, e.library, stem]
      .filter((x): x is string => typeof x === 'string' && x.length > 0)
      .join(' - ');
    return `${joinFamilyDir(e.family, e.lowLevel)}/${mid} - ${e.key} ${e.bpm}bpm.mp3`;
  },
};

// Rule 3 — simple, with enharmonic-sharp key substitution. Catalog
// uses flats (Eb, Bb, …) for some rows; disk uses sharps (D#, A#, …)
// consistently for the chromatic-key renders. Same shape as simple,
// only the trailing key suffix swaps spelling.
const RULE_SIMPLE_ENHARMONIC: MatchRule = {
  id: 'simple-enharmonic',
  description:
    'Simple rule with enharmonic-sharp key spelling (catalog flat → ' +
    'disk sharp: Eb→D#, Bb→A#, Db→C#, Gb→F#, Ab→G#). Only emits a ' +
    'candidate when the catalog key is flat-spelled.',
  apply(e: InstrumentEntry) {
    if (e.key === null) return null;
    const sharp = enharmonicSharpOf(e.key);
    if (sharp === null) return null;
    const parts = [e.family, e.lowLevel, e.mainStyle, e.library, e.preset]
      .filter((x): x is string => typeof x === 'string' && x.length > 0);
    if (parts.length < 2) return null;
    return `${joinFamilyDir(e.family, e.lowLevel)}/${parts.join(' - ')} - ${sharp}.mp3`;
  },
};

// Rule 4 — fx-key-bpm, with enharmonic-sharp key substitution. Same
// rationale as Rule 3 for the fx-key-bpm shape.
const RULE_FX_KEY_BPM_ENHARMONIC: MatchRule = {
  id: 'fx-key-bpm-enharmonic',
  description:
    'fx-key-bpm rule with enharmonic-sharp key spelling. Only fires ' +
    'when the catalog key is flat-spelled.',
  apply(e: InstrumentEntry) {
    if (e.family !== 'fx') return null;
    if (e.bpm === null || e.key === null) return null;
    if (e.library === null || e.preset === null) return null;
    const sharp = enharmonicSharpOf(e.key);
    if (sharp === null) return null;
    const trailer = ` - ${e.bpm}`;
    if (!e.preset.endsWith(trailer)) return null;
    const stem = e.preset.slice(0, -trailer.length);
    if (stem.length === 0) return null;
    const mid = [e.family, e.lowLevel, e.mainStyle, e.library, stem]
      .filter((x): x is string => typeof x === 'string' && x.length > 0)
      .join(' - ');
    return `${joinFamilyDir(e.family, e.lowLevel)}/${mid} - ${sharp} ${e.bpm}bpm.mp3`;
  },
};

// IMPORTANT: not every catalog column is a path component. Per the
// catalog author, some columns (notably `bpm` and `key`) are internal
// attributes describing the *recorded* instrument, not always present in
// the disk filename. Beyond the rules above (all confirmed by direct
// disk inspection), the audit avoids speculative key/bpm inflection.
// Unmatched rows are reported faithfully so a human can decide whether
// the catalog or the disk needs adjusting.

const MATCH_RULES: readonly MatchRule[] = [
  RULE_SIMPLE,
  RULE_FX_KEY_BPM,
  RULE_SIMPLE_ENHARMONIC,
  RULE_FX_KEY_BPM_ENHARMONIC,
];

/** All deterministic candidate paths the audit considers for a row.
 *  Ordered by rule precedence. Exposed for tests + diagnostics. */
export function expectedRelativePaths(
  entry: InstrumentEntry,
): readonly { rule: string; path: string }[] {
  const out: { rule: string; path: string }[] = [];
  for (const r of MATCH_RULES) {
    const p = r.apply(entry);
    if (p !== null) out.push({ rule: r.id, path: p });
  }
  return out;
}

/** Convenience: the preferred (first) candidate path; surfaced into the
 *  report when a row is missing so the human writeup is self-contained. */
export function preferredExpectedPath(entry: InstrumentEntry): string | null {
  const cands = expectedRelativePaths(entry);
  return cands[0]?.path ?? null;
}

// --- Report schema -----------------------------------------------------

export const MatchedRowSchema = z
  .object({
    catalogId: z.string(),
    matchedPath: z.string(),
    matchedRule: z.string(),
  })
  .strict();
export type MatchedRow = z.infer<typeof MatchedRowSchema>;

export const MissingRowSchema = z
  .object({
    catalogId: z.string(),
    family: z.string(),
    lowLevel: z.string(),
    mainStyle: z.string().nullable(),
    library: z.string().nullable(),
    preset: z.string().nullable(),
    bpm: z.number().int().nullable(),
    key: z.string().nullable(),
    /** Every join-rule candidate we tried (none of them existed on disk). */
    expectedCandidates: z.array(
      z.object({ rule: z.string(), path: z.string() }).strict(),
    ),
  })
  .strict();
export type MissingRow = z.infer<typeof MissingRowSchema>;

export const AmbiguousRowSchema = z
  .object({
    catalogId: z.string(),
    preferredPath: z.string(),
    /** Multiple candidate-rule paths exist on disk. */
    matchingPaths: z.array(z.string()).min(2),
  })
  .strict();
export type AmbiguousRow = z.infer<typeof AmbiguousRowSchema>;

export const DuplicateCandidateSchema = z
  .object({
    sharedPath: z.string(),
    catalogIds: z.array(z.string()).min(2),
  })
  .strict();
export type DuplicateCandidate = z.infer<typeof DuplicateCandidateSchema>;

export const UnmatchedFileSchema = z
  .object({
    family: z.string(),
    relativePath: z.string(),
  })
  .strict();
export type UnmatchedFile = z.infer<typeof UnmatchedFileSchema>;

export const FamilySummarySchema = z
  .object({
    rowsChecked: z.number().int().nonnegative(),
    matched: z.number().int().nonnegative(),
    missing: z.number().int().nonnegative(),
    ambiguous: z.number().int().nonnegative(),
  })
  .strict();
export type FamilySummary = z.infer<typeof FamilySummarySchema>;

export const AuditSummarySchema = z
  .object({
    catalogRowsChecked: z.number().int().nonnegative(),
    matched: z.number().int().nonnegative(),
    missing: z.number().int().nonnegative(),
    ambiguous: z.number().int().nonnegative(),
    duplicateCandidates: z.number().int().nonnegative(),
    unmatchedDiskFiles: z.number().int().nonnegative(),
    perFamily: z.record(z.string(), FamilySummarySchema),
    rulesApplied: z.array(
      z.object({
        rule: z.string(),
        matches: z.number().int().nonnegative(),
        description: z.string(),
      }).strict(),
    ),
  })
  .strict();
export type AuditSummary = z.infer<typeof AuditSummarySchema>;

export const LowLevelAliasSchema = z
  .object({
    family: z.string(),
    diskLowLevel: z.string(),
    catalogLowLevel: z.string(),
    reason: z.string(),
  })
  .strict();

export const AuditProvenanceSchema = z
  .object({
    catalogContentHash: z.string().regex(/^[0-9a-f]{64}$/u),
    sampleRoot: z.string(),
    auditedAt: z.string(),
    auditor: z.string(),
    rules: z.string(),
    aliasesApplied: z.array(LowLevelAliasSchema),
  })
  .strict();

export const SampleLibraryAuditReportSchema = z
  .object({
    $schemaVersion: z.literal(1),
    $description: z.string(),
    LEGACY_PROVENANCE: AuditProvenanceSchema,
    contentHash: z.string().regex(/^[0-9a-f]{64}$/u),
    summary: AuditSummarySchema,
    matched: z.array(MatchedRowSchema),
    missing: z.array(MissingRowSchema),
    ambiguous: z.array(AmbiguousRowSchema),
    duplicateCandidates: z.array(DuplicateCandidateSchema),
    unmatchedDiskFiles: z.array(UnmatchedFileSchema),
  })
  .strict();
export type SampleLibraryAuditReport = z.infer<typeof SampleLibraryAuditReportSchema>;

// --- Core audit --------------------------------------------------------

const RULES_DESCRIPTION =
  'Each catalog row is resolved against an ordered list of candidate ' +
  'relative paths produced by named join rules. The first rule whose path ' +
  'exists on disk wins; if none match, the row is reported missing with ' +
  'every candidate listed. Rules in order: ' +
  MATCH_RULES.map((r) => `[${r.id}] ${r.description}`).join('  |  ');

const REPORT_DESCRIPTION =
  'Catalog-vs-disk audit. Compares each entry in the frozen instrument ' +
  'catalog snapshot against an observed sample-library disk index, ' +
  'classifying matched / missing / ambiguous rows + duplicate-claim and ' +
  'unmatched-file diagnostics. `contentHash` is a SHA-256 over the canonical ' +
  'bytes of summary + matched + missing + ambiguous + duplicateCandidates + ' +
  'unmatchedDiskFiles; auditedAt and sampleRoot are outside the hashed ' +
  'region so the audit identity depends only on (catalog state, disk state).';

export function auditSampleLibrary(input: {
  readonly catalogSnapshot: InstrumentCatalogSnapshot;
  readonly diskIndex: DiskIndex;
  readonly provenance: AuditProvenance;
}): SampleLibraryAuditReport {
  const { catalogSnapshot, diskIndex, provenance } = input;

  // Pass 1: resolve every catalog row.
  const matched: MatchedRow[] = [];
  const missing: MissingRow[] = [];
  const ambiguous: AmbiguousRow[] = [];
  // Tracks which disk paths have been "claimed" by at least one catalog
  // row. Used to compute unmatchedDiskFiles in pass 2.
  const claimedPaths = new Set<string>();
  // Tracks which catalog rows claim each preferred path — used to surface
  // duplicate-claim diagnostics.
  const preferredPathToCatalogIds = new Map<string, string[]>();
  // Per-rule match counts for the summary.
  const ruleMatches = new Map<string, number>(MATCH_RULES.map((r) => [r.id, 0]));

  for (const entry of catalogSnapshot.entries) {
    const candidates = expectedRelativePaths(entry);
    if (candidates.length === 0) {
      // No join rule could produce a path — record as missing with empty
      // candidate list. (Should not happen with current rules + the
      // snapshot's strict Zod parse, but defensive.)
      missing.push(missingRow(entry, []));
      continue;
    }

    const preferred = candidates[0]!.path;
    const dup = preferredPathToCatalogIds.get(preferred) ?? [];
    dup.push(entry.id);
    preferredPathToCatalogIds.set(preferred, dup);

    // Try each candidate; collect the matches that exist on disk.
    const hits: { rule: string; path: string }[] = [];
    for (const c of candidates) {
      const dir = dirnameOf(c.path);
      const base = basenameOf(c.path);
      if (diskIndex.get(dir)?.has(base)) hits.push(c);
    }

    if (hits.length === 0) {
      missing.push(missingRow(entry, candidates));
    } else if (hits.length === 1) {
      matched.push({
        catalogId: entry.id,
        matchedPath: hits[0]!.path,
        matchedRule: hits[0]!.rule,
      });
      claimedPaths.add(hits[0]!.path);
      ruleMatches.set(hits[0]!.rule, (ruleMatches.get(hits[0]!.rule) ?? 0) + 1);
    } else {
      ambiguous.push({
        catalogId: entry.id,
        preferredPath: preferred,
        matchingPaths: hits.map((h) => h.path).sort(),
      });
      // Claim every ambiguous hit so we don't double-count them as
      // "unmatched disk files".
      for (const h of hits) claimedPaths.add(h.path);
    }
  }

  // Pass 2: duplicate claims (multiple catalog rows targeting same preferred path).
  const duplicateCandidates: DuplicateCandidate[] = [];
  for (const [sharedPath, ids] of preferredPathToCatalogIds) {
    if (ids.length > 1) {
      duplicateCandidates.push({ sharedPath, catalogIds: [...ids].sort() });
    }
  }

  // Pass 3: unmatched disk files (every basename in diskIndex not claimed).
  const unmatchedDiskFiles: UnmatchedFile[] = [];
  for (const [dir, basenames] of diskIndex) {
    const family = dir.split('/')[0]!;
    for (const b of basenames) {
      const full = `${dir}/${b}`;
      if (!claimedPaths.has(full)) {
        unmatchedDiskFiles.push({ family, relativePath: full });
      }
    }
  }

  // Deterministic ordering for every section.
  matched.sort(byCatalogId);
  missing.sort(byCatalogId);
  ambiguous.sort(byCatalogId);
  duplicateCandidates.sort((a, b) => cmp(a.sharedPath, b.sharedPath));
  unmatchedDiskFiles.sort((a, b) => cmp(a.relativePath, b.relativePath));

  // Per-family summary.
  const perFamily: Record<string, FamilySummary> = {};
  for (const fam of catalogSnapshot.vocabulary.families) {
    perFamily[fam] = { rowsChecked: 0, matched: 0, missing: 0, ambiguous: 0 };
  }
  for (const e of catalogSnapshot.entries) {
    (perFamily[e.family] ??= { rowsChecked: 0, matched: 0, missing: 0, ambiguous: 0 }).rowsChecked++;
  }
  for (const m of matched) {
    const fam = familyOf(m.matchedPath);
    if (perFamily[fam]) perFamily[fam].matched++;
  }
  for (const m of missing) perFamily[m.family]!.missing++;
  for (const a of ambiguous) {
    const fam = familyOf(a.preferredPath);
    if (perFamily[fam]) perFamily[fam].ambiguous++;
  }

  const summary: AuditSummary = {
    catalogRowsChecked: catalogSnapshot.entries.length,
    matched: matched.length,
    missing: missing.length,
    ambiguous: ambiguous.length,
    duplicateCandidates: duplicateCandidates.length,
    unmatchedDiskFiles: unmatchedDiskFiles.length,
    perFamily,
    rulesApplied: MATCH_RULES.map((r) => ({
      rule: r.id,
      matches: ruleMatches.get(r.id) ?? 0,
      description: r.description,
    })),
  };

  // contentHash over the determinism-bearing slice of the report. The
  // alias list is part of the hash so different alias policies produce
  // distinguishable audit identities even if the matched/missing sets
  // happen to coincide.
  const aliasesSorted = [...provenance.aliasesApplied].sort((a, b) =>
    cmp(`${a.family}/${a.diskLowLevel}`, `${b.family}/${b.diskLowLevel}`),
  );
  const hashed = {
    summary,
    matched,
    missing,
    ambiguous,
    duplicateCandidates,
    unmatchedDiskFiles,
    aliasesApplied: aliasesSorted,
  };
  const contentHash = createHash('sha256').update(stableStringify(hashed, 0)).digest('hex');

  return {
    $schemaVersion: 1,
    $description: REPORT_DESCRIPTION,
    LEGACY_PROVENANCE: {
      catalogContentHash: catalogSnapshot.contentHash,
      sampleRoot: provenance.sampleRootLabel,
      auditedAt: provenance.auditedAt,
      auditor: provenance.auditor,
      rules: RULES_DESCRIPTION,
      aliasesApplied: [...provenance.aliasesApplied]
        .sort((a, b) => cmp(`${a.family}/${a.diskLowLevel}`, `${b.family}/${b.diskLowLevel}`)),
    },
    contentHash,
    summary,
    matched,
    missing,
    ambiguous,
    duplicateCandidates,
    unmatchedDiskFiles,
  };
}

// --- helpers -----------------------------------------------------------

function missingRow(
  entry: InstrumentEntry,
  candidates: readonly { rule: string; path: string }[],
): MissingRow {
  return {
    catalogId: entry.id,
    family: entry.family,
    lowLevel: entry.lowLevel,
    mainStyle: entry.mainStyle,
    library: entry.library,
    preset: entry.preset,
    bpm: entry.bpm,
    key: entry.key,
    expectedCandidates: candidates.map((c) => ({ rule: c.rule, path: c.path })),
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

function familyOf(p: string): InstrumentSheetFamily | string {
  return p.split('/')[0]!;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const byCatalogId = (a: { catalogId: string }, b: { catalogId: string }): number =>
  cmp(a.catalogId, b.catalogId);
