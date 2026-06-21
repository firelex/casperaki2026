// Lossless catalog ⇄ workbook-model conversion.
//
// This module is pure: it converts an `InstrumentCatalogSnapshot` (the
// runtime "DB" — the union catalog the brain consumes) to an in-memory
// workbook model and back, with NO xlsx I/O. The CLI scripts
// (export/import-catalog-xlsx.mjs) wrap it with sheetjs; a future admin
// endpoint can reuse the same converters with a browser xlsx lib.
//
// Lossless means: catalog → workbook model → catalog reproduces the
// original `entries` byte-for-byte (verified via `contentHash`). The
// whole non-entries envelope (provenance, vocabulary, schema version) is
// carried verbatim through a hidden `_meta` sheet, so the round-trip is
// lossless at the *file* level, not just the entry level.
//
// Faithfulness to disk: the export also writes, per row, the resolved
// on-disk file path and an `on disk` flag (from the sample-library
// audit). Those are read-only provenance columns — they are NOT used to
// reconstruct entries, so editing them in Excel can't corrupt the
// catalog.
//
// The artificial public name (`instrument name`, column A) is the alias
// layer (see alias.ts). It round-trips through its own registry, not the
// catalog hash.

import { familyClassWord, deriveSoundIdentity } from './alias.js';
import {
  FAMILIES,
  recomputeContentHash,
  sortCatalogEntries,
} from './build-snapshot.js';
import {
  InstrumentCatalogSnapshotSchema,
  type InstrumentCatalogSnapshot,
  type InstrumentEntry,
  type InstrumentSheetFamily,
} from './types.js';

/** A single cell value as carried in the workbook model. */
export type Cell = string | number | null;
/** One sheet: row 0 is the header, the rest are data rows. */
export type WorkbookSheetRows = Cell[][];
/** sheetName → rows. Insertion order = workbook sheet order. */
export type WorkbookModel = Map<string, WorkbookSheetRows>;

export const META_SHEET_NAME = '_meta';

/** Max chars per envelope chunk cell — comfortably under Excel's 32,767. */
const ENVELOPE_CHUNK = 30000;

// Per-row column headers, in display order. Column A is the public name;
// columns B..M mirror the legacy "Audio Library Master File" layout so the
// sheet is familiar; the trailing columns carry disk provenance and the
// catalog identity needed to reconstruct an entry exactly. Reconstruction
// reads BY HEADER NAME, so column order may be changed in Excel freely.
export const ALIAS_HEADER = 'instrument name';
export const ROLE_CLASS_HEADER = 'role class';
export const DISK_PATH_HEADER = 'disk path';
export const ON_DISK_HEADER = 'on disk';
export const SOUND_IDENTITY_HEADER = 'sound identity';

const HEADERS = [
  ALIAS_HEADER, // A — artificial public name (alias layer)
  ROLE_CLASS_HEADER, // B — public instrument role (Bass/Lead/…); derived from family
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
  DISK_PATH_HEADER, // resolved file on disk (read-only provenance)
  ON_DISK_HEADER, // 'yes' | 'no'
  'catalog id', // entry.id — anchors the row + integrity check
  SOUND_IDENTITY_HEADER, // style-free identity the public name is keyed on (derived)
  'source', // 'xlsx' | 'disk' (union provenance) — '' when absent
  'source row', // entry.sourceRow — needed to reproduce contentHash
] as const;

export interface CatalogToWorkbookOptions {
  /** id → public artificial name (from the alias layer). */
  readonly aliasById: ReadonlyMap<string, string>;
  /** id → resolved on-disk relative path (from the audit). Absent = the
   *  catalog row has no matched file on disk. */
  readonly diskPathById?: ReadonlyMap<string, string>;
}

function styleCell(addStyles: readonly string[]): Cell {
  return addStyles.length ? addStyles.join(', ') : null;
}

function entryToRow(
  entry: InstrumentEntry,
  opts: CatalogToWorkbookOptions,
): Cell[] {
  const diskPath = opts.diskPathById?.get(entry.id) ?? null;
  return [
    opts.aliasById.get(entry.id) ?? '', // instrument name
    familyClassWord(entry.family), // role class (derived; not read back on import)
    entry.lowLevel, // subcategory written on EVERY row (forward-fill is idempotent)
    entry.mainStyle, // main style
    styleCell(entry.addStyles), // add. styles
    entry.library, // VSTi/Library used
    entry.preset, // patch/preset name
    entry.info, // add. information
    entry.addPlugins, // add. plugins used
    entry.bpm, // bpm
    entry.key, // key
    entry.normalisation, // normalisation
    entry.status, // Status
    entry.legacyReplacement, // Legacy Replacement Required?
    diskPath, // disk path
    diskPath ? 'yes' : 'no', // on disk
    entry.id, // catalog id
    deriveSoundIdentity(entry), // sound identity (derived; name registry key)
    entry.source ?? '', // source
    entry.sourceRow, // source row
  ];
}

/**
 * Convert a catalog snapshot into a workbook model: one sheet per family
 * (in canonical FAMILIES order), plus a `_meta` sheet carrying the whole
 * non-entries envelope so the file is losslessly reversible.
 */
export function catalogToWorkbook(
  snapshot: InstrumentCatalogSnapshot,
  opts: CatalogToWorkbookOptions,
): WorkbookModel {
  const wb: WorkbookModel = new Map();

  // _meta first. The envelope is the snapshot minus `entries` (which the
  // family sheets carry). Stored as one JSON blob cell so import can
  // rebuild the exact original file.
  const { entries: _entries, ...envelope } = snapshot;
  // Excel caps a cell at 32,767 chars; chunk the envelope JSON so the file
  // stays valid even if the catalog vocabulary/provenance grows large.
  const envelopeJson = JSON.stringify(envelope);
  const envelopeRows: WorkbookSheetRows = [];
  for (let i = 0, n = 0; i < envelopeJson.length; i += ENVELOPE_CHUNK, n++) {
    envelopeRows.push([`envelope:${n}`, envelopeJson.slice(i, i + ENVELOPE_CHUNK)]);
  }
  const meta: WorkbookSheetRows = [
    ['key', 'value'],
    ...envelopeRows,
    ['contentHash', snapshot.contentHash],
    ['entryCount', snapshot.entries.length],
    ['', ''],
    ['# legend', 'This file is a lossless two-way export of the instrument catalog.'],
    ['# instrument name', 'Artificial public name (real-word Adjective + Noun) — never reveals the source plugin. Edit to rename; the importer persists it.'],
    ['# role class', 'Public instrument role (Bass/Lead/Keys…), derived from the family. Read-only; ignored on import.'],
    ['# sound identity', 'Style-free hash the public name is keyed on (family|lowLevel|library|preset|bpm|key). Derived; rows sharing it share a name. Read-only.'],
    ['# disk path / on disk', 'Read-only provenance from the sample-library audit. Ignored on import.'],
    ['# catalog id / source / source row', 'Catalog identity — do not edit; required to reconstruct the row.'],
    ['# _meta', 'Do not edit. Carries the catalog envelope used to rebuild the JSON.'],
  ];
  wb.set(META_SHEET_NAME, meta);

  // Group entries by family, preserving snapshot order within each.
  const byFamily = new Map<InstrumentSheetFamily, InstrumentEntry[]>();
  for (const e of snapshot.entries) {
    let arr = byFamily.get(e.family);
    if (!arr) byFamily.set(e.family, (arr = []));
    arr.push(e);
  }

  for (const family of FAMILIES) {
    const arr = byFamily.get(family);
    if (!arr || arr.length === 0) continue;
    const rows: WorkbookSheetRows = [HEADERS.slice() as Cell[]];
    for (const e of arr) rows.push(entryToRow(e, opts));
    wb.set(family, rows);
  }

  return wb;
}

// ---------------------------------------------------------------------------
// Reverse direction: workbook model → catalog snapshot + extracted aliases.
// ---------------------------------------------------------------------------

function cellToStr(v: Cell): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function cellToBpm(v: Cell): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? Math.round(n) : null;
}

function splitStyles(v: Cell): string[] {
  const s = cellToStr(v);
  if (!s) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of s.split(',')) {
    const t = part.trim();
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

export interface WorkbookToCatalogResult {
  readonly snapshot: InstrumentCatalogSnapshot;
  /** soundIdentity → public name read from the name column. Feeds the
   *  registry. Keyed by the style-free identity (recomputed from each row's
   *  reconstructed fields), not the catalog id, so human renames persist
   *  across style re-tagging. */
  readonly aliasByIdentity: Map<string, string>;
  /** True when the rebuilt entries hash to the envelope's stored
   *  contentHash — i.e. the round-trip was lossless. */
  readonly contentHashMatches: boolean;
  readonly recomputedContentHash: string;
  readonly storedContentHash: string;
}

/** Map a header row to header→column index, trimming header strings. */
function indexHeaders(headerRow: Cell[]): Map<string, number> {
  const idx = new Map<string, number>();
  headerRow.forEach((h, i) => {
    const name = cellToStr(h);
    if (name && !idx.has(name)) idx.set(name, i);
  });
  return idx;
}

/**
 * Rebuild a catalog snapshot from a workbook model produced by
 * {@link catalogToWorkbook}.
 *
 * Entries are read by header name (robust to column reordering), re-sorted
 * into canonical order, and re-hashed. The non-entries envelope comes from
 * the `_meta` sheet, so the returned snapshot equals the original file.
 * The Zod schema is the validation gate (enum checks etc.).
 */
export function workbookToCatalog(wb: WorkbookModel): WorkbookToCatalogResult {
  const meta = wb.get(META_SHEET_NAME);
  if (!meta) throw new Error(`workbook is missing the "${META_SHEET_NAME}" sheet`);
  const metaMap = new Map<string, Cell>();
  for (const row of meta) {
    const k = cellToStr(row[0]);
    if (k) metaMap.set(k, row[1] ?? null);
  }
  // Reassemble the (possibly chunked) envelope: prefer `envelope:N` chunks
  // in order, fall back to a single legacy `envelope` cell.
  let envelopeJson = '';
  for (let n = 0; ; n++) {
    const chunk = metaMap.get(`envelope:${n}`);
    if (chunk === undefined || chunk === null) break;
    envelopeJson += String(chunk);
  }
  if (envelopeJson === '') {
    const single = metaMap.get('envelope');
    if (typeof single !== 'string') {
      throw new Error('_meta sheet has no "envelope" cell(s)');
    }
    envelopeJson = single;
  }
  const envelope = JSON.parse(envelopeJson) as Record<string, unknown>;

  const familySet = new Set<string>(FAMILIES);
  const entries: InstrumentEntry[] = [];
  const aliasByIdentity = new Map<string, string>();

  for (const [sheetName, rows] of wb) {
    if (sheetName === META_SHEET_NAME) continue;
    if (!familySet.has(sheetName)) continue; // ignore stray sheets
    const family = sheetName as InstrumentSheetFamily;
    if (rows.length < 1) continue;
    const cols = indexHeaders(rows[0]!);
    const need = (h: string): number => {
      const i = cols.get(h);
      if (i === undefined) {
        throw new Error(`sheet "${sheetName}" is missing required column "${h}"`);
      }
      return i;
    };
    const cId = need('catalog id');
    const cLow = need('subcategory (lowLevel)');
    const cMain = need('main style');
    const cAdd = need('add. styles');
    const cLib = need('VSTi/Library used');
    const cPreset = need('patch/preset name');
    const cInfo = need('add. information');
    const cPlugins = need('add. plugins used');
    const cBpm = need('bpm');
    const cKey = need('key');
    const cNorm = need('normalisation');
    const cStatus = need('Status');
    const cLegacy = need('Legacy Replacement Required?');
    const cSource = need('source');
    const cSourceRow = need('source row');
    const cAlias = cols.get(ALIAS_HEADER);

    for (let r = 1; r < rows.length; r++) {
      const row = rows[r]!;
      // Skip fully-blank rows (cosmetic spacer rows are tolerated).
      if (row.every((c) => c === null || c === undefined || c === '')) continue;
      const id = cellToStr(row[cId]);
      if (!id) {
        throw new Error(`sheet "${sheetName}" row ${r + 1}: missing catalog id`);
      }
      const sourceRowRaw = cellToStr(row[cSourceRow]);
      const sourceRow = sourceRowRaw === null ? NaN : Number(sourceRowRaw);
      if (!Number.isInteger(sourceRow) || sourceRow <= 0) {
        throw new Error(`sheet "${sheetName}" row ${r + 1}: invalid source row "${sourceRowRaw}"`);
      }
      const source = cellToStr(row[cSource]);
      const entry: InstrumentEntry = {
        id,
        family,
        lowLevel: cellToStr(row[cLow]) ?? '',
        mainStyle: cellToStr(row[cMain]) as InstrumentEntry['mainStyle'],
        addStyles: splitStyles(row[cAdd]) as InstrumentEntry['addStyles'],
        library: cellToStr(row[cLib]),
        preset: cellToStr(row[cPreset]),
        info: cellToStr(row[cInfo]),
        addPlugins: cellToStr(row[cPlugins]),
        bpm: cellToBpm(row[cBpm]),
        key: cellToStr(row[cKey]),
        normalisation: cellToStr(row[cNorm]),
        status: cellToStr(row[cStatus]),
        legacyReplacement: cellToStr(row[cLegacy]),
        sourceSheet: family,
        sourceRow,
        ...(source === 'xlsx' || source === 'disk' ? { source } : {}),
      };
      entries.push(entry);

      if (cAlias !== undefined) {
        const alias = cellToStr(row[cAlias]);
        // Key by the recomputed style-free identity (authoritative), not the
        // 'sound identity' cell — so a human can't desync the registry by
        // editing that derived column.
        if (alias) aliasByIdentity.set(deriveSoundIdentity(entry), alias);
      }
    }
  }

  // Canonical ordering, then re-hash — must reproduce the original.
  sortCatalogEntries(entries);
  const recomputedContentHash = recomputeContentHash(entries);
  const storedContentHash = String(metaMap.get('contentHash') ?? envelope.contentHash ?? '');

  const snapshot = InstrumentCatalogSnapshotSchema.parse({ ...envelope, entries });

  return {
    snapshot,
    aliasByIdentity,
    contentHashMatches: recomputedContentHash === storedContentHash,
    recomputedContentHash,
    storedContentHash,
  };
}
