#!/usr/bin/env node
// XLSX → catalog importer (the reverse half of the two-way tool).
//
// Reads a workbook produced by export-catalog-xlsx.mjs, rebuilds the exact
// catalog snapshot (verified by re-hashing `entries` against the embedded
// contentHash), and writes any edited artificial names back into the alias
// registry. The rebuilt catalog is byte-identical to the source unless a
// human changed a catalog cell — in which case the round-trip gate reports
// a contentHash mismatch loudly rather than silently accepting drift.
//
// Usage:
//   node scripts/import-catalog-xlsx.mjs <in.xlsx> [--write [out.json]]
//
// --write emits the reconstructed catalog JSON (default:
// data/instrument-catalog.reimported.json). Without it the script only
// verifies the round-trip and refreshes the alias registry.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as XLSX from 'xlsx';

import { buildAliasRegistry } from '../dist/catalog/alias.js';
import { workbookToCatalog } from '../dist/catalog/xlsx-roundtrip.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, '..');
const DATA = resolve(PKG_ROOT, 'data');

function parseArgs(argv) {
  const out = { inPath: undefined, write: false, outPath: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--write') {
      out.write = true;
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) out.outPath = argv[++i];
    } else if (!a.startsWith('--') && out.inPath === undefined) {
      out.inPath = a;
    }
  }
  return out;
}

async function main() {
  const { inPath, write, outPath } = parseArgs(process.argv.slice(2));
  if (!inPath) {
    process.stderr.write('usage: import-catalog-xlsx.mjs <in.xlsx> [--write [out.json]]\n');
    process.exit(2);
  }
  const src = resolve(inPath);

  // Read the workbook into the pure WorkbookModel (Map<sheet, rows>).
  const book = XLSX.read(readFileSync(src), { type: 'buffer', cellDates: false });
  const wb = new Map();
  for (const name of book.SheetNames) {
    const ws = book.Sheets[name];
    if (!ws) continue;
    wb.set(name, XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, blankrows: false }));
  }

  const result = workbookToCatalog(wb);

  // Refresh the alias registry (keyed by style-free sound identity) from the
  // name column so human renames persist.
  const registryPath = resolve(DATA, 'instrument-aliases.json');
  const registry = buildAliasRegistry(result.aliasByIdentity);
  writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n', 'utf8');

  if (write) {
    const out = outPath ? resolve(outPath) : resolve(DATA, 'instrument-catalog.reimported.json');
    writeFileSync(out, JSON.stringify(result.snapshot, null, 2) + '\n', 'utf8');
    process.stdout.write(`  wrote catalog:  ${out}\n`);
  }

  const ok = result.contentHashMatches;
  process.stdout.write(
    `imported ${src}\n` +
    `  entries:        ${result.snapshot.entries.length}\n` +
    `  names read:     ${result.aliasByIdentity.size} (by sound identity)\n` +
    `  registry:       ${registryPath}\n` +
    `  stored hash:    ${result.storedContentHash}\n` +
    `  rebuilt hash:   ${result.recomputedContentHash}\n` +
    `  round-trip:     ${ok ? 'PASS — lossless ✓' : 'FAIL — catalog cells were edited (drift detected) ✗'}\n`,
  );
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`import-catalog-xlsx: ${err.stack ?? err.message}\n`);
  process.exit(1);
});
