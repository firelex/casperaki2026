#!/usr/bin/env node
// Catalog → XLSX exporter (the forward half of the two-way tool).
//
// Reads the runtime catalog "DB" (the union catalog the brain consumes),
// joins it with the sample-library audit for the on-disk file path of each
// sound, assigns every sound a stable artificial public name (alias layer),
// and writes a single workbook that is losslessly re-importable by
// import-catalog-xlsx.mjs.
//
// The XLSX I/O (sheetjs) lives ONLY in this file and its import sibling;
// the catalog⇄workbook conversion + name generation are pure modules under
// src/catalog/ (xlsx-roundtrip.ts, alias.ts).
//
// Usage:
//   node scripts/export-catalog-xlsx.mjs [out.xlsx] [--catalog <path>]
//
// Defaults: catalog = data/instrument-catalog.union.json (falls back to
// the xlsx-only snapshot), out = data/catalog-export/Casperaki Audio
// Library.xlsx.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ExcelJS from 'exceljs';

import {
  resolveAliases,
  buildAliasRegistry,
} from '../dist/catalog/alias.js';
import {
  catalogToWorkbook,
  META_SHEET_NAME,
} from '../dist/catalog/xlsx-roundtrip.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, '..');
const DATA = resolve(PKG_ROOT, 'data');

function parseArgs(argv) {
  const out = { outPath: undefined, catalogPath: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--catalog') out.catalogPath = argv[++i];
    else if (!a.startsWith('--') && out.outPath === undefined) out.outPath = a;
  }
  return out;
}

function loadJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

async function main() {
  const { outPath, catalogPath } = parseArgs(process.argv.slice(2));

  const catalogFile =
    catalogPath != null
      ? resolve(catalogPath)
      : existsSync(resolve(DATA, 'instrument-catalog.union.json'))
        ? resolve(DATA, 'instrument-catalog.union.json')
        : resolve(DATA, 'instrument-catalog.snapshot.json');
  const out = outPath
    ? resolve(outPath)
    : resolve(DATA, 'catalog-export', 'Casperaki Audio Library.xlsx');

  const catalog = loadJson(catalogFile);

  // Disk-path provenance: id → resolved relative path (audit matched set).
  const diskPathById = new Map();
  const auditPath = resolve(DATA, 'sample-library.audit.json');
  if (existsSync(auditPath)) {
    const audit = loadJson(auditPath);
    for (const m of audit.matched ?? []) diskPathById.set(m.catalogId, m.matchedPath);
  }

  // Existing alias registry (pinned — never regenerated, human edits kept).
  // Keyed by the style-free sound identity.
  const registryPath = resolve(DATA, 'instrument-aliases.json');
  const existing = existsSync(registryPath) ? loadJson(registryPath).aliases ?? {} : {};

  // One stable name per sound *identity* (family|lowLevel|library|preset|
  // bpm|key — no style), so re-tagging never renames a sound.
  const resolved = resolveAliases({ entries: catalog.entries, existing });

  // Persist the registry (pinned + freshly generated), identity-sorted for a
  // stable diff.
  const registry = buildAliasRegistry(resolved.byIdentity);
  writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n', 'utf8');

  // Build the workbook model and serialise via exceljs (so we can style:
  // bold headers, sensible column widths, a frozen/filtered header row).
  const wb = catalogToWorkbook(catalog, { aliasById: resolved.byId, diskPathById });
  const book = new ExcelJS.Workbook();
  book.creator = 'export-catalog-xlsx.mjs';

  for (const [name, rows] of wb) {
    const isMeta = name === META_SHEET_NAME;
    const ws = book.addWorksheet(name, {
      state: isMeta ? 'hidden' : 'visible',
      // Freeze the header row, and the first column (instrument name) on
      // data sheets so it stays visible when scrolling right.
      views: [{ state: 'frozen', xSplit: isMeta ? 0 : 1, ySplit: 1 }],
    });

    for (const r of rows) ws.addRow(r.map((c) => (c === null ? null : c)));

    // Column widths: fit content, clamped to a readable band.
    const ncols = rows.reduce((m, r) => Math.max(m, r.length), 0);
    for (let c = 0; c < ncols; c++) {
      let max = 0;
      for (const r of rows) {
        const v = r[c];
        if (v !== null && v !== undefined) max = Math.max(max, String(v).length);
      }
      ws.getColumn(c + 1).width = Math.min(60, Math.max(12, max + 2));
    }

    // Header styling (skip the machine-only _meta sheet).
    if (!isMeta) {
      const header = ws.getRow(1);
      header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF334155' } };
      header.alignment = { vertical: 'middle' };
      header.height = 20;
      ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: rows[0]?.length ?? 1 } };
    }
  }

  mkdirSync(dirname(out), { recursive: true });
  await book.xlsx.writeFile(out);

  const onDisk = catalog.entries.filter((e) => diskPathById.has(e.id)).length;
  process.stdout.write(
    `exported ${out}\n` +
    `  catalog:        ${catalogFile}\n` +
    `  entries:        ${catalog.entries.length}  (${onDisk} matched on disk, ${catalog.entries.length - onDisk} missing)\n` +
    `  family sheets:  ${[...wb.keys()].filter((n) => n !== META_SHEET_NAME).length}\n` +
    `  names:          ${resolved.byIdentity.size} sound identities → ${resolved.byId.size} rows` +
      ` (${resolved.kept} kept, ${resolved.generated} generated` +
      `${resolved.probed ? `, ${resolved.probed} probed` : ''})\n` +
    `  registry:       ${registryPath}\n` +
    `  contentHash:    ${catalog.contentHash}\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`export-catalog-xlsx: ${err.stack ?? err.message}\n`);
  process.exit(1);
});
