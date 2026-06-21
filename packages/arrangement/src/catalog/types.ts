// Frozen instrument catalog — Step 2 snapshot schema.
//
// The brain reads only this snapshot (never the live Dropbox library or the
// authoring xlsx). The xlsx is the source of truth at *import* time; at
// *runtime* the contract is `InstrumentCatalogSnapshot` below, validated by
// Zod on load and identified by a deterministic `contentHash` over the
// canonical bytes of `entries`.
//
// See docs/53n-step2-catalog-snapshot.md for the column→field provenance
// table and 53k §D3 for the policy.

import { z } from 'zod';

/** The 23 sheets in the legacy workbook are the canonical family enum. */
export const InstrumentSheetFamilySchema = z.enum([
  'fx',
  'drumKits',
  'kickDrums',
  'snareDrums',
  'clapsSnaps',
  'hiHatsClosed',
  'hiHatsOpen',
  'toms',
  'cymbals',
  'shakers',
  'percussionBreaks',
  'percussionLoops',
  'percussionMisc',
  'basses',
  'keys',
  'synths',
  'leadSynths',
  'orchestral',
  'popBrass',
  'popStrings',
  'acousticGuitars',
  'electricGuitars',
  'vocals',
]);
export type InstrumentSheetFamily = z.infer<typeof InstrumentSheetFamilySchema>;

/** Genre/style vocabulary observed in the workbook (resolves 53k Open Q #4). */
export const MainStyleSchema = z.enum([
  '8bit',
  'ballad',
  'brightPop',
  'edm',
  'gospel',
  'latin',
  'rock',
  'schlager',
  'urban',
]);
export type MainStyle = z.infer<typeof MainStyleSchema>;

export const AddStyleSchema = z.enum([
  'ballad',
  'brightPop',
  'edm',
  'latin',
  'organicVibes',
  'rock',
  'schlager',
  'urban',
]);
export type AddStyle = z.infer<typeof AddStyleSchema>;

export const InstrumentEntrySchema = z
  .object({
    /** Stable id: first 16 hex of sha256(family|lowLevel|library|preset). */
    id: z.string().regex(/^[0-9a-f]{16}$/u),
    family: InstrumentSheetFamilySchema,
    /** Forward-filled `subcategory (lowLevel)` column. */
    lowLevel: z.string().min(1),
    mainStyle: MainStyleSchema.nullable(),
    addStyles: z.array(AddStyleSchema),
    library: z.string().nullable(),
    preset: z.string().nullable(),
    info: z.string().nullable(),
    addPlugins: z.string().nullable(),
    bpm: z.number().int().nullable(),
    key: z.string().nullable(),
    normalisation: z.string().nullable(),
    status: z.string().nullable(),
    legacyReplacement: z.string().nullable(),
    /** Row-level provenance: lets a debugger jump back to a specific cell. */
    sourceSheet: InstrumentSheetFamilySchema,
    sourceRow: z.number().int().positive(),
    /** Provenance of where this entry came from. Absent in the frozen
     *  xlsx-only snapshot (treated as 'xlsx'); set explicitly in the
     *  union catalog: 'xlsx' for master-file rows, 'disk' for rows
     *  recovered from sample-library files absent from the xlsx
     *  (docs/58h union catalog). Optional so the base snapshot validates
     *  unchanged. */
    source: z.enum(['xlsx', 'disk']).optional(),
  })
  .strict();
export type InstrumentEntry = z.infer<typeof InstrumentEntrySchema>;

export const VocabularySchema = z
  .object({
    families: z.array(InstrumentSheetFamilySchema),
    mainStyles: z.array(MainStyleSchema),
    addStyles: z.array(AddStyleSchema),
    lowLevelByFamily: z.record(InstrumentSheetFamilySchema, z.array(z.string())),
    libraries: z.array(z.string()),
  })
  .strict();
export type Vocabulary = z.infer<typeof VocabularySchema>;

export const LegacyProvenanceSchema = z
  .object({
    source: z.string(),
    sourcePath: z.string(),
    sourceSha256: z.string().regex(/^[0-9a-f]{64}$/u).nullable(),
    extractedAt: z.string(),
    importer: z.string(),
    sheetsImported: z.array(z.string()),
    rowsImported: z.number().int().nonnegative(),
    rowsSkipped: z.object({
      subcategoryHeaderOnly: z.number().int().nonnegative(),
      fullyBlank: z.number().int().nonnegative(),
    }),
    transform: z.string(),
  })
  .strict();
export type LegacyProvenance = z.infer<typeof LegacyProvenanceSchema>;

/** docs/58h — union-catalog provenance. Present only in
 *  `instrument-catalog.union.json`: records how the disk-only additions
 *  were derived (which base snapshot + which audit) so the union is
 *  auditable. Lives outside the hashed `entries` region, so `builtAt`
 *  does not perturb `contentHash`. Optional so the base snapshot
 *  validates unchanged. */
export const UnionProvenanceSchema = z
  .object({
    base: z
      .object({
        contentHash: z.string().regex(/^[0-9a-f]{64}$/u),
        source: z.string(),
        importer: z.string(),
      })
      .strict(),
    sourceAudit: z
      .object({
        contentHash: z.string().regex(/^[0-9a-f]{64}$/u),
        auditedAt: z.string(),
      })
      .strict(),
    builder: z.string(),
    builtAt: z.string(),
    additions: z.number().int().nonnegative(),
    additionsByFamily: z.record(z.string(), z.number().int().nonnegative()),
    skippedVariants: z.number().int().nonnegative(),
    skippedNonReconstructable: z.array(z.string()),
    transform: z.string(),
  })
  .strict();
export type UnionProvenance = z.infer<typeof UnionProvenanceSchema>;

export const InstrumentCatalogSnapshotSchema = z
  .object({
    $schemaVersion: z.literal(1),
    $description: z.string(),
    LEGACY_PROVENANCE: LegacyProvenanceSchema,
    /** Present only in the union catalog (docs/58h). */
    unionProvenance: UnionProvenanceSchema.optional(),
    /** sha256 over canonicalStringify(entries). Verified on load. */
    contentHash: z.string().regex(/^[0-9a-f]{64}$/u),
    vocabulary: VocabularySchema,
    entries: z.array(InstrumentEntrySchema),
  })
  .strict();
export type InstrumentCatalogSnapshot = z.infer<typeof InstrumentCatalogSnapshotSchema>;
