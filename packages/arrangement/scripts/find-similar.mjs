#!/usr/bin/env node
// Similarity finder for residual missing entries.
//
// For each missing row in `data/sample-library.audit.json`, finds the
// closest disk file in the row's expected directory by Levenshtein
// edit distance on the basename. Surfaces the top-K candidates so a
// human can decide which side (catalog or disk) needs the rename.
//
// Read-only: never renames anything. Pair with align-sample-library.mjs
// or a manual xlsx edit after reviewing the output.
//
// Usage:
//   node packages/arrangement/scripts/find-similar.mjs [<sample-root>] [--max-distance=N] [--top=K]

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, '..');
const AUDIT_PATH = resolve(PKG_ROOT, 'data/sample-library.audit.json');
const DEFAULT_SRC = '/mnt/d/Scissero Dropbox/Mathias Strasser/datigator-instruments/instruments';

// Mirror of the audit's catalog→disk dir aliases.
const CATALOG_TO_DISK_DIR = {
  'percussionLoops/percussionLoopsAcoustic_60-89bpm':   'percussionLoops/percussionLoopsAcoustic_50-89bpm',
  'percussionLoops/percussionLoopsAcoustic_120-150bpm': 'percussionLoops/percussionLoopsAcoustic_120-160bpm',
  'percussionLoops/percussionLoopsElectronic_60-89bpm':   'percussionLoops/percussionLoopsElectronic_50-89bpm',
  'percussionLoops/percussionLoopsElectronic_120-150bpm': 'percussionLoops/percussionLoopsElectronic_120-160bpm',
};

function args() {
  let maxDistance = 4;
  let top = 3;
  let positional;
  for (const x of process.argv.slice(2)) {
    if (x.startsWith('--max-distance=')) maxDistance = Number(x.slice(15));
    else if (x.startsWith('--top=')) top = Number(x.slice(6));
    else positional = x;
  }
  return { maxDistance, top, root: positional ? resolve(positional) : DEFAULT_SRC };
}

// Levenshtein. O(n*m) memory + time; basenames are short so this is
// trivially fast.
function lev(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = new Array(b.length + 1);
  const curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

function diskDirFor(row) {
  const key = `${row.family}/${row.lowLevel}`;
  return CATALOG_TO_DISK_DIR[key] ?? key;
}

function simpleExpected(row) {
  const parts = [row.family, row.lowLevel, row.mainStyle, row.library, row.preset]
    .filter((x) => typeof x === 'string' && x.length > 0);
  let s = parts.join(' - ');
  if (row.key !== null) s += ` - ${row.key}`;
  return s + '.mp3';
}

function fxKeyBpmExpected(row) {
  if (row.family !== 'fx' || row.bpm === null || row.key === null || row.library === null || row.preset === null) return null;
  const trailer = ` - ${row.bpm}`;
  if (!row.preset.endsWith(trailer)) return null;
  const stem = row.preset.slice(0, -trailer.length);
  const mid = [row.family, row.lowLevel, row.mainStyle, row.library, stem]
    .filter((x) => typeof x === 'string' && x.length > 0).join(' - ');
  return `${mid} - ${row.key} ${row.bpm}bpm.mp3`;
}

function main() {
  const { maxDistance, top, root } = args();
  const audit = JSON.parse(readFileSync(AUDIT_PATH, 'utf8'));

  const results = [];
  for (const row of audit.missing) {
    const dir = resolve(root, diskDirFor(row));
    let files;
    try {
      files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.mp3'));
    } catch {
      results.push({ row, kind: 'no-dir' });
      continue;
    }
    const targets = [simpleExpected(row)];
    const fx = fxKeyBpmExpected(row);
    if (fx) targets.push(fx);

    // For each disk file, distance is the MIN distance to any target.
    const scored = files.map((f) => {
      let d = Infinity;
      for (const t of targets) d = Math.min(d, lev(t, f));
      return { file: f, distance: d };
    }).filter((x) => x.distance <= maxDistance)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, top);

    results.push({ row, targets, candidates: scored, dir: diskDirFor(row) });
  }

  // Print per-family.
  const byFamily = new Map();
  for (const r of results) {
    const fam = r.row.family;
    if (!byFamily.has(fam)) byFamily.set(fam, []);
    byFamily.get(fam).push(r);
  }

  for (const [fam, list] of [...byFamily.entries()].sort()) {
    process.stdout.write(`\n=== ${fam} (${list.length} missing) ===\n`);
    for (const r of list) {
      const id = r.row.catalogId.slice(0, 8);
      process.stdout.write(`\n  [${id}] catalog: lib=${JSON.stringify(r.row.library)} preset=${JSON.stringify(r.row.preset)} key=${r.row.key} bpm=${r.row.bpm}\n`);
      process.stdout.write(`    expected:   ${r.targets[0]}\n`);
      if (r.targets[1]) process.stdout.write(`    (or fx-rule: ${r.targets[1]})\n`);
      if (!r.candidates || r.candidates.length === 0) {
        process.stdout.write(`    no disk file within distance ${args().maxDistance}.\n`);
      } else {
        for (const c of r.candidates) {
          process.stdout.write(`    ~d=${c.distance}: ${c.file}\n`);
        }
      }
    }
  }
}

main();
