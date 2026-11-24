// Build the hooks bank from the hook text files (docs/superpowers/specs/2026-11-24-hook-library-design.md).
//
//   pnpm -C packages/arrangement exec tsx scripts/build-hooks.mjs [--check]
//
// Reads data/vocals/hooks/*.hooks (format: src/vocals/hook-text.ts), checks every hook, and writes
// data/vocals/precedents/mlDataRaw-hooks.json. Any problem is printed and nothing is written (exit 1).
// --check: check only, write nothing. Ids are <file name>-<nn>, so keep files append-only to keep ids stable.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseHookText } from '../src/vocals/hook-text.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'data', 'vocals', 'hooks');
const OUT = join(ROOT, 'data', 'vocals', 'precedents', 'mlDataRaw-hooks.json');
const check = process.argv.includes('--check');

const files = readdirSync(SRC).filter((f) => f.endsWith('.hooks')).sort();
if (files.length === 0) throw new Error(`no .hooks files in ${SRC}`);
const all = [];
const errors = [];
const bySig = new Map();
const byName = new Map();
for (const f of files) {
  const prefix = basename(f, '.hooks');
  const { hooks, errors: e } = parseHookText(readFileSync(join(SRC, f), 'utf8'), prefix);
  errors.push(...e);
  for (const h of hooks) {
    const sig = JSON.stringify(h.melody);
    if (bySig.has(sig)) errors.push(`${h.id} "${h.properties.name}": the same melody as ${bySig.get(sig)}`);
    bySig.set(sig, h.id);
    if (byName.has(h.properties.name)) errors.push(`${h.id}: the name "${h.properties.name}" is already used by ${byName.get(h.properties.name)}`);
    byName.set(h.properties.name, h.id);
    all.push(h);
  }
}
const count = (k) => Object.entries(all.reduce((a, h) => ((a[h.properties[k]] = (a[h.properties[k]] ?? 0) + 1), a), {})).map(([x, n]) => `${x} ${n}`).join(', ');
console.log(`${all.length} hooks in ${files.length} files. By type: ${count('type')}. By feel: ${count('feel')}.`);
console.log(`Lead-in: ${all.filter((h) => h.properties.start === 1).length}. Tempo: slow (<85) ${all.filter((h) => h.properties.tempoMin < 85).length}, fast (>125) ${all.filter((h) => h.properties.tempoMax > 125).length}.`);
if (errors.length) {
  console.error(`\n${errors.length} problem(s):\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  process.exit(1);
}
if (!check) {
  writeFileSync(OUT, `${JSON.stringify(all, null, 1)}\n`);
  console.log(`wrote ${OUT}`);
}
