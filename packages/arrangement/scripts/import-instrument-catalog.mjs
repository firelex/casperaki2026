#!/usr/bin/env node
// Catalog importer: Audio Library Master File.xlsx → frozen
// `data/instrument-catalog.snapshot.json`.
//
// This script is the CLI wrapper around the pure builder
// (src/catalog/build-snapshot.ts). The same builder is the contract a
// future brain admin endpoint will reuse — keep the xlsx I/O confined to
// this file.
//
// Usage:
//   node packages/arrangement/scripts/import-instrument-catalog.mjs <path-to-xlsx>
//
// Defaults to the Dropbox path the workbook lives at when run on the dev
// box; pass an explicit path to override.

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as XLSX from 'xlsx';

import { buildInstrumentCatalogSnapshot } from '../dist/catalog/build-snapshot.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, '..');
const DEFAULT_SRC = '/mnt/d/Scissero Dropbox/Mathias Strasser/datigator-instruments/Audio Library Master File.xlsx';
const OUT_PATH = resolve(PKG_ROOT, 'data/instrument-catalog.snapshot.json');

async function main() {
  const argPath = process.argv[2];
  const src = argPath ? resolve(argPath) : DEFAULT_SRC;
  const buf = await readFile(src);
  const sourceSha256 = createHash('sha256').update(buf).digest('hex');

  const wb = XLSX.read(buf, { type: 'buffer', cellDates: false });

  // sheetjs returns column-keyed objects by default. We want a 2D array
  // (row 0 = header) per sheet — the builder's contract.
  const sheets = new Map();
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, blankrows: false });
    sheets.set(name, rows);
  }

  // We embed the absolute path verbatim into provenance (it's the actual
  // dev-box location). If the importer runs in CI later we'd switch to a
  // workspace-relative label; today this is the most faithful record.
  const snapshot = buildInstrumentCatalogSnapshot({
    sheets,
    extractedAt: process.env.CATALOG_EXTRACTED_AT ?? '2026-06-06',
    sourceSha256,
    sourcePath: 'datigator-instruments/Audio Library Master File.xlsx',
    importer: 'packages/arrangement/scripts/import-instrument-catalog.mjs',
  });

  // Stable-pretty-printed JSON, trailing newline. We use plain
  // JSON.stringify with 2-space indent here because the builder already
  // canonical-sorted `entries` (and contentHash hashes the canonical
  // form independently). The on-disk file is for human review and diff,
  // not for re-hashing.
  await writeFile(OUT_PATH, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');

  process.stdout.write(
    `wrote ${OUT_PATH}\n` +
    `  source:        ${src}\n` +
    `  sourceSha256:  ${sourceSha256}\n` +
    `  sheets:        ${snapshot.LEGACY_PROVENANCE.sheetsImported.length}\n` +
    `  rowsImported:  ${snapshot.LEGACY_PROVENANCE.rowsImported}\n` +
    `  rowsSkipped:   ${JSON.stringify(snapshot.LEGACY_PROVENANCE.rowsSkipped)}\n` +
    `  contentHash:   ${snapshot.contentHash}\n` +
    `  vocab.families:${snapshot.vocabulary.families.length}, ` +
      `mainStyles:${snapshot.vocabulary.mainStyles.length}, ` +
      `addStyles:${snapshot.vocabulary.addStyles.length}, ` +
      `libraries:${snapshot.vocabulary.libraries.length}\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`import-instrument-catalog: ${err.stack ?? err.message}\n`);
  process.exit(1);
});
