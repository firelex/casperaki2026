#!/usr/bin/env node
// Sample-library audit CLI.
//
// Walks a sample-library directory two levels deep (`{family}/{lowLevel}/
// {filename}`), builds a `DiskIndex`, and calls the pure
// `auditSampleLibrary` core. Writes a machine-readable JSON report and a
// human-readable missing-list markdown alongside.
//
// Usage:
//   node packages/arrangement/scripts/audit-sample-library.mjs [<sample-root>]
//
// Default sample root: the dev-box Dropbox location at
// /mnt/d/Scissero Dropbox/Mathias Strasser/datigator-instruments/instruments

import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  auditSampleLibrary,
  loadEffectiveCatalogSnapshot,
} from '../dist/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, '..');
const DEFAULT_SRC = '/mnt/d/Scissero Dropbox/Mathias Strasser/datigator-instruments/instruments';
const OUT_JSON = resolve(PKG_ROOT, 'data/sample-library.audit.json');
const OUT_MD = resolve(PKG_ROOT, 'data/sample-library.missing.md');

// Disk-vs-catalog directory aliases. Disk uses one boundary for
// percussionLoops bpm bins; catalog uses another. Documented data
// inconsistency (the xlsx labels its bpm bins differently from how the
// rendered samples are organised on disk). Aliasing here lets the
// audit "see" matches without renaming either side. Each alias is
// surfaced in the report's `LEGACY_PROVENANCE.aliasesApplied`.
const DISK_TO_CATALOG_ALIASES = [
  {
    family: 'percussionLoops',
    diskLowLevel: 'percussionLoopsAcoustic_50-89bpm',
    catalogLowLevel: 'percussionLoopsAcoustic_60-89bpm',
    reason: 'Catalog labels this bin 60-89bpm; disk dir labels it 50-89bpm. Both contain files at 50..110bpm. Catalog name is authoritative until the xlsx is updated.',
  },
  {
    family: 'percussionLoops',
    diskLowLevel: 'percussionLoopsAcoustic_120-160bpm',
    catalogLowLevel: 'percussionLoopsAcoustic_120-150bpm',
    reason: 'Catalog labels this bin 120-150bpm; disk dir labels it 120-160bpm. Catalog name is authoritative until the xlsx is updated.',
  },
  {
    family: 'percussionLoops',
    diskLowLevel: 'percussionLoopsElectronic_50-89bpm',
    catalogLowLevel: 'percussionLoopsElectronic_60-89bpm',
    reason: 'Catalog labels this bin 60-89bpm; disk dir labels it 50-89bpm. Catalog name is authoritative until the xlsx is updated.',
  },
  {
    family: 'percussionLoops',
    diskLowLevel: 'percussionLoopsElectronic_120-160bpm',
    catalogLowLevel: 'percussionLoopsElectronic_120-150bpm',
    reason: 'Catalog labels this bin 120-150bpm; disk dir labels it 120-160bpm. Catalog name is authoritative until the xlsx is updated.',
  },
  {
    family: 'fx',
    diskLowLevel: 'fxOther',
    catalogLowLevel: 'fx8bitArcade',
    reason: 'docs/58e — build-snapshot.ts post-import reclassification rewrites fxOther+mainStyle=8bit rows to fx8bitArcade so per-lowLevelType volume tuning can target the 15 retro-arcade samples independently of generic fxOther. Disk keeps them under fxOther (where the user/Stefan filed them). Catalog name is authoritative until the disk is reorganised. Verified that fx/fxOther/ contains ONLY arcade content (15 files, all DonkeyKong/Frogger/MsPacMan/PacMan/nintendo).',
  },
];

function aliasMapFor(aliases) {
  const m = new Map();
  for (const a of aliases) m.set(`${a.family}/${a.diskLowLevel}`, `${a.family}/${a.catalogLowLevel}`);
  return m;
}

function walkSampleRoot(root, aliases) {
  // 2-deep walk: read `{family}` then `{family}/{lowLevel}`. When a
  // (family/lowLevel) pair has an alias, the index is keyed by the
  // catalog-canonical name AND the basenames inside have their
  // embedded disk-lowLevel substring rewritten to the catalog form.
  // That second rewrite is what lets a row's expected-path candidate
  // match a file that was authored with the disk's name baked in.
  const aliasMap = aliasMapFor(aliases);
  const index = new Map();
  const families = readdirSync(root, { withFileTypes: true });
  for (const fam of families) {
    if (!fam.isDirectory()) continue;
    const famPath = resolve(root, fam.name);
    const lowLevels = readdirSync(famPath, { withFileTypes: true });
    for (const ll of lowLevels) {
      if (!ll.isDirectory()) continue;
      const diskKey = `${fam.name}/${ll.name}`;
      const canonicalKey = aliasMap.get(diskKey) ?? diskKey;
      const canonicalLowLevel = canonicalKey.slice(fam.name.length + 1);
      const llPath = resolve(famPath, ll.name);
      const bucket = index.get(canonicalKey) ?? new Set();
      for (const f of readdirSync(llPath, { withFileTypes: true })) {
        if (!f.isFile()) continue;
        // Rewrite any embedded disk-lowLevel substring to its catalog
        // equivalent so the catalog-derived expected-path candidates
        // match the disk basename.
        const rewritten = canonicalLowLevel === ll.name
          ? f.name
          : f.name.split(ll.name).join(canonicalLowLevel);
        bucket.add(rewritten);
      }
      index.set(canonicalKey, bucket);
    }
  }
  return index;
}

function renderMissingMarkdown(report, src) {
  const lines = [];
  const w = (s = '') => lines.push(s);

  w('# Sample library audit — missing entries');
  w();
  w(`Generated by \`packages/arrangement/scripts/audit-sample-library.mjs\`.`);
  w(`Sample root (label only — not hashed): \`${src}\`.`);
  w(`Catalog content hash: \`${report.LEGACY_PROVENANCE.catalogContentHash}\`.`);
  w(`Audit content hash:   \`${report.contentHash}\`.`);
  w();
  w('## Summary');
  w();
  w(`- Catalog rows checked: **${report.summary.catalogRowsChecked}**`);
  w(`- Matched:              **${report.summary.matched}**`);
  w(`- Missing:              **${report.summary.missing}**`);
  w(`- Ambiguous:            **${report.summary.ambiguous}**`);
  w(`- Duplicate claims:     **${report.summary.duplicateCandidates}**`);
  w(`- Unmatched disk files: **${report.summary.unmatchedDiskFiles}**`);
  w();
  w('### Per-family breakdown');
  w();
  w('| Family | Rows | Matched | Missing | Ambiguous |');
  w('| ------ | ---: | ------: | ------: | --------: |');
  const families = Object.keys(report.summary.perFamily).sort();
  for (const fam of families) {
    const s = report.summary.perFamily[fam];
    w(`| \`${fam}\` | ${s.rowsChecked} | ${s.matched} | ${s.missing} | ${s.ambiguous} |`);
  }
  w();
  w('### Rules applied');
  w();
  for (const r of report.summary.rulesApplied) {
    w(`- **${r.rule}** (${r.matches} matches) — ${r.description}`);
  }
  w();

  // Per-family missing dump. Cap each family at MAX_PER_FAMILY for
  // readability, but report the full count.
  const MAX_PER_FAMILY = 50;
  const missingByFamily = new Map();
  for (const m of report.missing) {
    const arr = missingByFamily.get(m.family) ?? [];
    arr.push(m);
    missingByFamily.set(m.family, arr);
  }

  w('## Missing entries by family');
  w();
  for (const fam of [...missingByFamily.keys()].sort()) {
    const rows = missingByFamily.get(fam);
    w(`### \`${fam}\` (${rows.length} missing)`);
    w();
    const shown = rows.slice(0, MAX_PER_FAMILY);
    for (const m of shown) {
      const info = [
        m.library !== null ? `library=\`${m.library}\`` : null,
        m.preset !== null ? `preset=\`${m.preset}\`` : null,
        m.mainStyle !== null ? `style=\`${m.mainStyle}\`` : null,
        m.bpm !== null ? `bpm=${m.bpm}` : null,
        m.key !== null ? `key=\`${m.key}\`` : null,
      ].filter(Boolean).join(', ');
      const cands = m.expectedCandidates
        .map((c) => `\`${c.path}\` (rule: ${c.rule})`)
        .join('; ');
      w(`- \`${m.catalogId}\` — ${info}`);
      w(`    expected: ${cands}`);
    }
    if (rows.length > MAX_PER_FAMILY) {
      w();
      w(`*… ${rows.length - MAX_PER_FAMILY} more missing rows in \`${fam}\` (full list in JSON report).*`);
    }
    w();
  }

  if (report.ambiguous.length > 0) {
    w('## Ambiguous matches');
    w();
    for (const a of report.ambiguous.slice(0, 100)) {
      w(`- \`${a.catalogId}\` — preferred \`${a.preferredPath}\`; multiple disk hits:`);
      for (const p of a.matchingPaths) w(`    - \`${p}\``);
    }
    if (report.ambiguous.length > 100) {
      w();
      w(`*… ${report.ambiguous.length - 100} more ambiguous rows (full list in JSON report).*`);
    }
    w();
  }

  if (report.duplicateCandidates.length > 0) {
    w('## Duplicate catalog claims');
    w();
    w('Two or more catalog rows produce the same preferred path. Verify the catalog has not double-listed the same instrument.');
    w();
    for (const d of report.duplicateCandidates.slice(0, 100)) {
      w(`- \`${d.sharedPath}\` claimed by: ${d.catalogIds.map((id) => `\`${id}\``).join(', ')}`);
    }
    if (report.duplicateCandidates.length > 100) {
      w();
      w(`*… ${report.duplicateCandidates.length - 100} more duplicate-claim groups (full list in JSON report).*`);
    }
    w();
  }

  return lines.join('\n') + '\n';
}

async function main() {
  const argRoot = process.argv[2];
  const src = argRoot ? resolve(argRoot) : DEFAULT_SRC;

  process.stderr.write(`[audit] walking ${src}\n`);
  const diskIndex = walkSampleRoot(src, DISK_TO_CATALOG_ALIASES);
  const totalFiles = [...diskIndex.values()].reduce((n, s) => n + s.size, 0);
  process.stderr.write(`[audit]   ${diskIndex.size} family/lowLevel directories (after ${DISK_TO_CATALOG_ALIASES.length} aliases), ${totalFiles} files\n`);

  process.stderr.write(`[audit] loading effective catalog (union if present, else base snapshot)\n`);
  const catalogSnapshot = loadEffectiveCatalogSnapshot();
  process.stderr.write(`[audit]   ${catalogSnapshot.entries.length} catalog rows (hash ${catalogSnapshot.contentHash.slice(0, 12)}…)\n`);

  process.stderr.write(`[audit] running\n`);
  const report = auditSampleLibrary({
    catalogSnapshot,
    diskIndex,
    provenance: {
      sampleRootLabel: src,
      auditedAt: process.env.AUDIT_AT ?? new Date().toISOString(),
      auditor: 'packages/arrangement/scripts/audit-sample-library.mjs',
      aliasesApplied: DISK_TO_CATALOG_ALIASES,
    },
  });

  mkdirSync(dirname(OUT_JSON), { recursive: true });
  writeFileSync(OUT_JSON, JSON.stringify(report, null, 2) + '\n', 'utf8');
  writeFileSync(OUT_MD, renderMissingMarkdown(report, src), 'utf8');

  process.stderr.write(`[audit] wrote ${OUT_JSON}\n`);
  process.stderr.write(`[audit] wrote ${OUT_MD}\n`);
  process.stderr.write(
    `[audit] summary: matched=${report.summary.matched} missing=${report.summary.missing} ` +
    `ambiguous=${report.summary.ambiguous} unmatchedDisk=${report.summary.unmatchedDiskFiles} ` +
    `contentHash=${report.contentHash.slice(0, 12)}…\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`audit-sample-library: ${err.stack ?? err.message}\n`);
  process.exit(1);
});
