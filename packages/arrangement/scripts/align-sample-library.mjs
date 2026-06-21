#!/usr/bin/env node
// Sample-library alignment CLI.
//
// Reads `data/sample-library.audit.json`, walks the `missing` list, and
// for each row tries to find a disk file in the row's expected directory
// whose filename contains the catalog's library + preset. When exactly
// one such file exists, the file is renamed to the catalog-canonical
// path the audit's `simple` join rule expects. Cases with 0 or >1
// matches are skipped (still reported as missing by the next audit).
//
// Usage:
//   node packages/arrangement/scripts/align-sample-library.mjs [<sample-root>] [--apply]
//
// Default sample root: same as the audit CLI. `--apply` actually
// renames files; without it, the script prints the proposed renames
// and exits.

import { readFileSync, readdirSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, '..');
const AUDIT_PATH = resolve(PKG_ROOT, 'data/sample-library.audit.json');
const DEFAULT_SRC = '/mnt/d/Scissero Dropbox/Mathias Strasser/datigator-instruments/instruments';

function args() {
  const a = process.argv.slice(2);
  let apply = false;
  const positional = [];
  for (const x of a) {
    if (x === '--apply') apply = true;
    else positional.push(x);
  }
  return { apply, root: positional[0] ? resolve(positional[0]) : DEFAULT_SRC };
}

// catalog → disk directory aliases — inverse of the audit's alias map.
// When the audit treats a disk dir as if it were the catalog name (e.g.
// `_50-89bpm` ↔ `_60-89bpm`), this script must look under the disk name
// when locating files to rename.
const CATALOG_TO_DISK_DIR = {
  'percussionLoops/percussionLoopsAcoustic_60-89bpm':   'percussionLoops/percussionLoopsAcoustic_50-89bpm',
  'percussionLoops/percussionLoopsAcoustic_120-150bpm': 'percussionLoops/percussionLoopsAcoustic_120-160bpm',
  'percussionLoops/percussionLoopsElectronic_60-89bpm':   'percussionLoops/percussionLoopsElectronic_50-89bpm',
  'percussionLoops/percussionLoopsElectronic_120-150bpm': 'percussionLoops/percussionLoopsElectronic_120-160bpm',
};

function diskDirFor(row) {
  const key = `${row.family}/${row.lowLevel}`;
  return CATALOG_TO_DISK_DIR[key] ?? key;
}

function findCandidate(row, root) {
  const dir = resolve(root, diskDirFor(row));
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.mp3'));
  } catch {
    return { kind: 'no-dir' };
  }
  // Pass 1 — case-insensitive contains for library + preset. Catches
  // authoring case differences (`albionONE` vs `albionOne`, `In` vs
  // `in`, `BPM` vs `bpm`). The rename target preserves the catalog's
  // spelling, so this never introduces typos from disk into catalog
  // canonical names.
  const ciContains = (h, n) => h.toLowerCase().includes(n.toLowerCase());
  const wantLib = row.library;
  const wantPreset = row.preset ?? '';
  const directMatches = files.filter((f) => {
    if (wantLib !== null && !ciContains(f, wantLib)) return false;
    if (wantPreset !== '' && !ciContains(f, wantPreset)) return false;
    return true;
  });
  // When the loose substring catches multiple candidates (e.g. preset
  // `FLP_CONGAS_130BPM_25` matches both `…_25.mp3` and `…_25_modified.mp3`),
  // tighten to files where the preset is exactly the tail before `.mp3`.
  if (directMatches.length > 1 && wantPreset !== '') {
    const tail = `${wantPreset}.mp3`.toLowerCase();
    const tailMatches = directMatches.filter((f) => f.toLowerCase().endsWith(tail));
    if (tailMatches.length === 1) return { kind: 'single', match: tailMatches[0], dir, via: 'direct' };
    if (tailMatches.length > 1) return { kind: 'ambiguous', matches: tailMatches };
  }
  if (directMatches.length === 1) return { kind: 'single', match: directMatches[0], dir, via: 'direct' };
  if (directMatches.length > 1) return { kind: 'ambiguous', matches: directMatches };

  // Pass 2 — fx variant: catalog uses underscores in the preset stem
  // and ` - {bpm}` trailer; disk replaces the LAST `_` with a space and
  // formats as `{stem} {key} {bpm}bpm[_modified].mp3` without the
  // ` - ` separator before key. Library is typically sampleMagic in
  // the wild. We try BOTH catalog's key spelling and its enharmonic
  // sharp (catalog flat → disk sharp: Db→C#, Eb→D#, …).
  if (row.family === 'fx' && wantLib !== null && wantPreset !== '' && row.bpm !== null && row.key !== null) {
    const trailer = ` - ${row.bpm}`;
    if (wantPreset.endsWith(trailer)) {
      const stem = wantPreset.slice(0, -trailer.length);
      const lastUnderscore = stem.lastIndexOf('_');
      if (lastUnderscore !== -1) {
        const spacedStem = stem.slice(0, lastUnderscore) + ' ' + stem.slice(lastUnderscore + 1);
        const keyVariants = [row.key];
        const sharp = enharmonicSharpOf(row.key);
        if (sharp !== null) keyVariants.push(sharp);
        for (const k of keyVariants) {
          // Search for the full contiguous substring "{stem} {k} {bpm}bpm"
          // — using just the stem can over-match when one preset is a
          // prefix of another (e.g. `ds_mus drama` vs `ds_mus dramastabs`).
          const tail = `${spacedStem} ${k} ${row.bpm}bpm`;
          const fxMatches = files.filter((f) => {
            if (!ciContains(f, wantLib)) return false;
            return ciContains(f, tail);
          });
          if (fxMatches.length === 1) return { kind: 'single', match: fxMatches[0], dir, via: 'fx-variant', matchedKey: k };
          if (fxMatches.length > 1) return { kind: 'ambiguous', matches: fxMatches };
        }
      }
    }
  }

  return { kind: 'no-match' };
}

function enharmonicSharpOf(key) {
  switch (key) {
    case 'Db': return 'C#';
    case 'Eb': return 'D#';
    case 'Gb': return 'F#';
    case 'Ab': return 'G#';
    case 'Bb': return 'A#';
    default:   return null;
  }
}

/** Compute the rename target for a row. For pass-1 (direct) matches we
 *  use the simple-rule canonical; for pass-2 (fx-variant) matches we
 *  use the fx-key-bpm[-enharmonic] canonical. The audit's existing
 *  rules pick up the renamed file without any new rule. */
function renameTargetFor(row, via, matchedKey) {
  if (via === 'fx-variant') {
    const trailer = ` - ${row.bpm}`;
    const stem = row.preset.slice(0, -trailer.length);
    const prefix = [row.family, row.lowLevel, row.mainStyle, row.library, stem]
      .filter((x) => typeof x === 'string' && x.length > 0)
      .join(' - ');
    // Use the matched key spelling (catalog's or its enharmonic sharp).
    const k = matchedKey ?? row.key;
    return `${prefix} - ${k} ${row.bpm}bpm.mp3`;
  }
  const parts = [row.family, row.lowLevel, row.mainStyle, row.library, row.preset]
    .filter((x) => typeof x === 'string' && x.length > 0);
  let canonical = parts.join(' - ');
  if (row.key !== null) canonical += ` - ${row.key}`;
  canonical += '.mp3';
  return canonical;
}

async function main() {
  const { apply, root } = args();

  const audit = JSON.parse(readFileSync(AUDIT_PATH, 'utf8'));
  const proposals = []; // { fromAbs, toAbs, fromRel, toRel, row }

  for (const row of audit.missing) {
    const found = findCandidate(row, root);
    if (found.kind !== 'single') continue;

    const canonical = renameTargetFor(row, found.via, found.matchedKey);
    if (found.match === canonical) continue; // already correctly named (defensive)

    const diskRel = diskDirFor(row);
    proposals.push({
      fromAbs: resolve(found.dir, found.match),
      toAbs: resolve(found.dir, canonical),
      fromRel: `${diskRel}/${found.match}`,
      toRel: `${diskRel}/${canonical}`,
      via: found.via,
      row,
    });
  }

  process.stderr.write(
    `[align] ${proposals.length} confident renames found across ${audit.missing.length} missing rows.\n`,
  );

  // Group + print proposals by family for review.
  const byFamily = new Map();
  for (const p of proposals) {
    if (!byFamily.has(p.row.family)) byFamily.set(p.row.family, []);
    byFamily.get(p.row.family).push(p);
  }
  for (const [fam, list] of [...byFamily.entries()].sort()) {
    process.stderr.write(`\n  ${fam} (${list.length}):\n`);
    for (const p of list) {
      process.stderr.write(`    - ${p.fromRel}\n`);
      process.stderr.write(`      → ${p.toRel}\n`);
    }
  }

  if (!apply) {
    process.stderr.write(`\n[align] dry-run — pass --apply to execute.\n`);
    return;
  }

  let renamed = 0;
  let failed = 0;
  for (const p of proposals) {
    try {
      renameSync(p.fromAbs, p.toAbs);
      renamed++;
    } catch (err) {
      failed++;
      process.stderr.write(`[align] FAILED ${p.fromRel}: ${err.message}\n`);
    }
  }
  process.stderr.write(`\n[align] renamed=${renamed} failed=${failed}\n`);
}

main().catch((err) => {
  process.stderr.write(`align-sample-library: ${err.stack ?? err.message}\n`);
  process.exit(1);
});
