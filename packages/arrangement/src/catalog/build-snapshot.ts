// Pure snapshot builder — sheets → `InstrumentCatalogSnapshot`.
//
// No I/O: the caller does the xlsx read (CLI uses sheetjs; future admin
// endpoint can use the same library or a different one). The builder
// applies forward-fill on the subcategory column, normalises every string,
// splits the comma-separated style list, computes per-row stable ids, and
// sorts entries deterministically. Same input → byte-identical output.

import { createHash } from 'node:crypto';

import { stableStringify } from '@casperaki/song-schema';

import {
  InstrumentCatalogSnapshotSchema,
  type AddStyle,
  type InstrumentCatalogSnapshot,
  type InstrumentEntry,
  type InstrumentSheetFamily,
  type MainStyle,
  type Vocabulary,
} from './types.js';

/** A single sheet as a 2D array (row 0 = header, like `xlsx.utils.sheet_to_json({header:1})`). */
export type SheetRows = readonly (readonly unknown[])[];

export interface BuildSnapshotInput {
  /** sheetName → rows; sheets not in this map are not imported. */
  readonly sheets: ReadonlyMap<string, SheetRows>;
  /** ISO date string. Embedded in `LEGACY_PROVENANCE.extractedAt`; does NOT
   *  feed into `contentHash`. */
  readonly extractedAt: string;
  /** SHA-256 hex of the source xlsx bytes. May be `null` if the caller
   *  doesn't have direct file bytes (e.g. browser admin upload). */
  readonly sourceSha256: string | null;
  /** Path-like label for the source file. Free-form provenance. */
  readonly sourcePath: string;
  /** Path-like label for the importer (CLI script, admin endpoint, etc.). */
  readonly importer: string;
}

// Columns of every sheet's header row, in order. The builder asserts this
// shape on every sheet; a header drift is a hard fail.
const EXPECTED_HEADER: readonly string[] = [
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

export const FAMILIES: readonly InstrumentSheetFamily[] = [
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
];

const MAIN_STYLES: readonly MainStyle[] = [
  '8bit', 'ballad', 'brightPop', 'edm', 'gospel', 'latin', 'rock', 'schlager', 'urban',
];
const MAIN_STYLE_SET: ReadonlySet<MainStyle> = new Set(MAIN_STYLES);

const ADD_STYLES: readonly AddStyle[] = [
  'ballad', 'brightPop', 'edm', 'latin', 'organicVibes', 'rock', 'schlager', 'urban',
];
const ADD_STYLE_SET: ReadonlySet<AddStyle> = new Set(ADD_STYLES);

const PROVENANCE_DESCRIPTION =
  'Per sheet: forward-fill column 1 (subcategory); trim every string; ' +
  'split `add. styles` on comma; coerce `bpm` to integer or null; pass ' +
  '`key`, `normalisation`, `status`, `legacyReplacement` through verbatim. ' +
  'Rows whose library AND preset are both blank are dropped (subcategory-' +
  'declaration rows) and reported in rowsSkipped.subcategoryHeaderOnly. ' +
  'Empty sheets are reported but not flagged.';

const SNAPSHOT_DESCRIPTION =
  'Frozen instrument catalog snapshot generated from Audio Library Master ' +
  'File.xlsx. The brain consumes only this file; the xlsx is the source ' +
  'of truth at import time but is never read at runtime. `contentHash` ' +
  'is a SHA-256 over the canonical bytes of `entries` and is verified on ' +
  'load — a hand-edited snapshot whose hash has not been recomputed will ' +
  'throw at the loader.';

function trimOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function parseBpm(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
  const s = String(v).trim();
  if (s === '') return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}

// One workbook row = one snapshot entry; the id is a stable hash of every
// field that distinguishes rows under the workbook's authoring policy:
//   - (family, lowLevel) — sheet + subcategory
//   - (library, preset)  — the addressable preset
//   - (key, bpm)         — chromatic / tempo variants (the workbook lists
//                          the same preset across all 12 keys for tonal
//                          fx, and per-bpm for percussion loops)
//   - (mainStyle, addStyles) — the workbook deliberately re-lists some
//                              presets (e.g. `basses` / `modoBass` /
//                              `Indi Pendent`) under different "primary
//                              style" sections; each listing is its own
//                              catalog row.
// Reordering xlsx rows does not change ids; adding or removing fields
// does. Stable enough to survive normal authoring edits.
export function deriveId(
  family: string,
  lowLevel: string,
  library: string | null,
  preset: string | null,
  key: string | null,
  bpm: number | null,
  mainStyle: string | null,
  addStyles: readonly string[],
): string {
  const h = createHash('sha256');
  h.update(
    `${family}|${lowLevel}|${library ?? ''}|${preset ?? ''}|` +
    `${key ?? ''}|${bpm === null ? '' : bpm}|` +
    `${mainStyle ?? ''}|${addStyles.join(',')}`,
  );
  return h.digest('hex').slice(0, 16);
}

interface ConvertedRow {
  entry: InstrumentEntry;
}

function convertSheet(
  family: InstrumentSheetFamily,
  rows: SheetRows,
  out: InstrumentEntry[],
  skipped: { subcategoryHeaderOnly: number; fullyBlank: number },
): void {
  if (rows.length === 0) return;
  const header = rows[0]!.map((c) => (c === null || c === undefined ? '' : String(c)));
  for (let i = 0; i < EXPECTED_HEADER.length; i++) {
    if (header[i] !== EXPECTED_HEADER[i]) {
      throw new Error(
        `sheet "${family}": header column ${i} is ${JSON.stringify(header[i])}, ` +
        `expected ${JSON.stringify(EXPECTED_HEADER[i])}`,
      );
    }
  }
  let currentLowLevel: string | null = null;
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]!;
    if (row.every((c) => c === null || c === undefined || c === '')) {
      skipped.fullyBlank++;
      continue;
    }
    const subcategory = trimOrNull(row[0]);
    if (subcategory) currentLowLevel = subcategory;
    const lowLevel = currentLowLevel;
    if (!lowLevel) {
      throw new Error(
        `sheet "${family}" row ${r + 1}: data row before any subcategory header`,
      );
    }
    const mainStyleRaw = trimOrNull(row[1]);
    const addStylesRaw = trimOrNull(row[2]);
    const library = trimOrNull(row[3]);
    const preset = trimOrNull(row[4]);
    const info = trimOrNull(row[5]);
    const addPlugins = trimOrNull(row[6]);
    const bpm = parseBpm(row[7]);
    const key = trimOrNull(row[8]);
    const normalisation = trimOrNull(row[9]);
    const status = trimOrNull(row[10]);
    const legacyReplacement = trimOrNull(row[11]);

    if (library === null && preset === null) {
      // Subcategory-declaration row (e.g. `vocals` sheet: only the
      // subcategory name is set). Track the subcategory in vocabulary
      // and skip — there is no concrete instrument to catalogue.
      skipped.subcategoryHeaderOnly++;
      continue;
    }

    const mainStyle: MainStyle | null =
      mainStyleRaw && MAIN_STYLE_SET.has(mainStyleRaw as MainStyle)
        ? (mainStyleRaw as MainStyle)
        : null;
    if (mainStyleRaw && mainStyle === null) {
      throw new Error(
        `sheet "${family}" row ${r + 1}: unknown main style "${mainStyleRaw}"`,
      );
    }

    const addStyles: AddStyle[] = [];
    if (addStylesRaw) {
      const seen = new Set<string>();
      for (const s of addStylesRaw.split(',')) {
        const t = s.trim();
        if (!t || seen.has(t)) continue;
        seen.add(t);
        if (!ADD_STYLE_SET.has(t as AddStyle)) {
          throw new Error(
            `sheet "${family}" row ${r + 1}: unknown add style "${t}"`,
          );
        }
        addStyles.push(t as AddStyle);
      }
      addStyles.sort();
    }

    out.push({
      id: deriveId(family, lowLevel, library, preset, key, bpm, mainStyle, addStyles),
      family,
      lowLevel,
      mainStyle,
      addStyles,
      library,
      preset,
      info,
      addPlugins,
      bpm,
      key,
      normalisation,
      status,
      legacyReplacement,
      sourceSheet: family,
      sourceRow: r + 1,
    });
  }
}

/** Deterministic in-place ordering shared by the xlsx snapshot builder
 *  and the union builder: (family in canonical FAMILIES order, lowLevel,
 *  library ?? '', preset ?? '', sourceRow). The union builder offsets
 *  disk-row `sourceRow` so disk additions sort after xlsx rows on a tie. */
export function sortCatalogEntries(entries: InstrumentEntry[]): void {
  const familyOrder = new Map(FAMILIES.map((f, i) => [f, i]));
  entries.sort((a, b) => {
    const fa = familyOrder.get(a.family)! - familyOrder.get(b.family)!;
    if (fa !== 0) return fa;
    if (a.lowLevel !== b.lowLevel) return a.lowLevel < b.lowLevel ? -1 : 1;
    const la = a.library ?? '';
    const lb = b.library ?? '';
    if (la !== lb) return la < lb ? -1 : 1;
    const pa = a.preset ?? '';
    const pb = b.preset ?? '';
    if (pa !== pb) return pa < pb ? -1 : 1;
    return a.sourceRow - b.sourceRow;
  });
}

export function buildVocabulary(entries: readonly InstrumentEntry[]): Vocabulary {
  const lowLevelByFamily: Partial<Record<InstrumentSheetFamily, Set<string>>> = {};
  const libraries = new Set<string>();
  const mainStyles = new Set<MainStyle>();
  const addStyles = new Set<AddStyle>();
  const families = new Set<InstrumentSheetFamily>();
  for (const e of entries) {
    families.add(e.family);
    (lowLevelByFamily[e.family] ??= new Set()).add(e.lowLevel);
    if (e.library) libraries.add(e.library);
    if (e.mainStyle) mainStyles.add(e.mainStyle);
    for (const s of e.addStyles) addStyles.add(s);
  }
  const sortedLowLevels: Record<string, string[]> = {};
  for (const family of FAMILIES) {
    if (lowLevelByFamily[family]) {
      sortedLowLevels[family] = [...lowLevelByFamily[family]!].sort();
    }
  }
  return {
    families: FAMILIES.filter((f) => families.has(f)),
    mainStyles: MAIN_STYLES.filter((s) => mainStyles.has(s)),
    addStyles: ADD_STYLES.filter((s) => addStyles.has(s)),
    lowLevelByFamily: sortedLowLevels as Vocabulary['lowLevelByFamily'],
    libraries: [...libraries].sort(),
  };
}

// docs/58e — Post-import reclassifications that recover legacy curation
// intent the xlsx authoring didn't preserve. Each rule is a closed-form
// (family, lowLevel, mainStyle, …) predicate over entries; matches get
// their lowLevel rewritten and their id re-derived.
//
// Currently:
//   fxOther + mainStyle=8bit → fx8bitArcade
//     Legacy effectsMetadata.json knew these 15 retro-arcade samples
//     (DonkeyKong / Frogger / MsPacMan / PacMan / nintendo) as the
//     `8bitArcade` subtype; the xlsx imports them under `fxOther` and
//     marks the style as `8bit`. Splitting them out as `fx8bitArcade`
//     lets `FX::getInstrumentTargetVolume` (and any future per-lowLevel
//     send-bus tuning) target the arcade samples independently of the
//     generic fxOther bucket. The disk files are the same.
function applyLegacyReclassifications(entries: InstrumentEntry[]): {
  reclassified: number;
} {
  let reclassified = 0;
  for (const e of entries) {
    if (e.family === 'fx' && e.lowLevel === 'fxOther' && e.mainStyle === '8bit') {
      e.lowLevel = 'fx8bitArcade';
      e.id = deriveId(
        e.family, e.lowLevel, e.library, e.preset,
        e.key, e.bpm, e.mainStyle, e.addStyles,
      );
      reclassified++;
    }
  }
  return { reclassified };
}

export function buildInstrumentCatalogSnapshot(
  input: BuildSnapshotInput,
): InstrumentCatalogSnapshot {
  const seenFamilies = new Set<string>();
  const entries: InstrumentEntry[] = [];
  const skipped = { subcategoryHeaderOnly: 0, fullyBlank: 0 };
  const sheetsImported: InstrumentSheetFamily[] = [];

  for (const family of FAMILIES) {
    const rows = input.sheets.get(family);
    if (!rows || rows.length <= 1) continue;
    seenFamilies.add(family);
    sheetsImported.push(family);
    convertSheet(family, rows, entries, skipped);
  }

  applyLegacyReclassifications(entries);

  sortCatalogEntries(entries);

  const contentHash = createHash('sha256')
    .update(stableStringify(entries, 0))
    .digest('hex');

  const snapshot: InstrumentCatalogSnapshot = {
    $schemaVersion: 1,
    $description: SNAPSHOT_DESCRIPTION,
    LEGACY_PROVENANCE: {
      source: 'Audio Library Master File.xlsx',
      sourcePath: input.sourcePath,
      sourceSha256: input.sourceSha256,
      extractedAt: input.extractedAt,
      importer: input.importer,
      sheetsImported,
      rowsImported: entries.length,
      rowsSkipped: skipped,
      transform: PROVENANCE_DESCRIPTION,
    },
    contentHash,
    vocabulary: buildVocabulary(entries),
    entries,
  };

  // Final defensive Zod parse — the builder's own type-level invariants
  // should make this a no-op, but the parse doubles as a regression net
  // against silent drift in either the builder or the schema.
  return InstrumentCatalogSnapshotSchema.parse(snapshot);
}

/** Recomputes the contentHash over `entries` using the same algorithm the
 *  builder uses. Exposed so the loader can verify on read. */
export function recomputeContentHash(entries: readonly InstrumentEntry[]): string {
  return createHash('sha256').update(stableStringify(entries, 0)).digest('hex');
}
