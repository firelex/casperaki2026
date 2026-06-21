#!/usr/bin/env node
// Union catalog export — writes data/instrument-catalog.union.json.
//
// docs/58h. Forms the effective catalog as the UNION of the frozen xlsx
// snapshot and the disk-only presets the workbook never listed (recovered
// from the committed sample-library audit's `unmatchedDiskFiles`). The
// brain's runtime gate (`loadEffectiveCatalogSnapshot` → `loadValidatedCatalog`)
// consumes this file when present, falling back to the base snapshot
// otherwise.
//
// Pure transform of two committed files — no disk walk (the audit already
// walked; the Dropbox mount is slow). Deterministic: same inputs →
// byte-identical output.
//
// AFTER running this, RE-RUN the audit so the disk additions land in
// `sample-library.audit.json`'s `matched` set (the runtime gate filters
// to audited rows):
//   node scripts/build-union-catalog.mjs
//   node scripts/audit-sample-library.mjs
//
// Usage:
//   node packages/arrangement/scripts/build-union-catalog.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildUnionCatalog,
  loadInstrumentCatalogSnapshot,
  SampleLibraryAuditReportSchema,
} from '../dist/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, '..');
const AUDIT_PATH = resolve(PKG_ROOT, 'data/sample-library.audit.json');
const OUT_PATH = resolve(PKG_ROOT, 'data/instrument-catalog.union.json');

function main() {
  process.stderr.write('[union] loading base xlsx snapshot\n');
  const base = loadInstrumentCatalogSnapshot();
  process.stderr.write(
    `[union]   ${base.entries.length} xlsx rows (hash ${base.contentHash.slice(0, 12)}…)\n`,
  );

  process.stderr.write('[union] loading committed audit\n');
  const audit = SampleLibraryAuditReportSchema.parse(
    JSON.parse(readFileSync(AUDIT_PATH, 'utf8')),
  );
  if (audit.LEGACY_PROVENANCE.catalogContentHash !== base.contentHash) {
    process.stderr.write(
      `[union] WARNING: audit was computed against catalog ` +
        `${audit.LEGACY_PROVENANCE.catalogContentHash.slice(0, 12)}…, ` +
        `not the base snapshot ${base.contentHash.slice(0, 12)}…. ` +
        `If you already have a union committed, re-run audit against the ` +
        `BASE snapshot first (or this is the steady state — disk additions ` +
        `already in the catalog are simply not re-listed).\n`,
    );
  }
  process.stderr.write(
    `[union]   ${audit.unmatchedDiskFiles.length} unmatched disk files (hash ${audit.contentHash.slice(0, 12)}…)\n`,
  );

  const result = buildUnionCatalog({
    base,
    audit,
    builder: 'packages/arrangement/scripts/build-union-catalog.mjs',
  });

  writeFileSync(OUT_PATH, JSON.stringify(result.snapshot, null, 2) + '\n', 'utf8');

  const byFam = result.snapshot.unionProvenance.additionsByFamily;
  process.stderr.write(`[union] wrote ${OUT_PATH}\n`);
  process.stderr.write(
    `[union] union rows: ${result.snapshot.entries.length} ` +
      `(xlsx ${base.entries.length} + disk ${result.additions.length}); ` +
      `contentHash=${result.snapshot.contentHash.slice(0, 12)}…\n`,
  );
  process.stderr.write(`[union] disk additions by family: ${JSON.stringify(byFam)}\n`);
  process.stderr.write(
    `[union] skipped: variants/loops=${result.skippedVariants}, ` +
      `non-reconstructable=${result.skippedNonReconstructable.length}\n`,
  );
  for (const p of result.skippedNonReconstructable) {
    process.stderr.write(`[union]   non-reconstructable: ${p}\n`);
  }
  process.stderr.write(
    `[union] NEXT: re-run audit so additions are matched: ` +
      `node packages/arrangement/scripts/audit-sample-library.mjs\n`,
  );
}

main();
