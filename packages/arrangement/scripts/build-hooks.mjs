// Add new hooks to the hooks bank from the hook text files (docs/superpowers/specs/2026-11-24-hook-library-design.md).
//
//   pnpm -C packages/arrangement exec tsx scripts/build-hooks.mjs [--check]
//
// Reads data/vocals/hooks/*.hooks (format: src/vocals/hook-text.ts) and checks every hook. The bank,
// data/vocals/precedents/mlDataRaw-hooks.json, is append-only: hooks whose id is not yet in it are appended at the
// end; entries already in it are never rewritten (edits to them live in the brain's edits overlay, see
// setPrecedentEdits in src/vocals/precedents.ts). A hook whose text no longer matches its bank entry is listed, and
// the bank entry stays. Any problem is printed and nothing is written (exit 1). --check: check only, write nothing.
// Ids are <file name>-<nn> by position in the file, so keep the text files append-only too.

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseHookText } from '../src/vocals/hook-text.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'data', 'vocals', 'hooks');
const OUT = join(ROOT, 'data', 'vocals', 'precedents', 'mlDataRaw-hooks.json');
const check = process.argv.includes('--check');

if (!existsSync(OUT)) throw new Error(`the hooks bank ${OUT} does not exist; it is append-only and must be there`);
const bank = JSON.parse(readFileSync(OUT, 'utf8'));
const inBank = new Map(bank.map((h) => [h.id, h]));

const files = readdirSync(SRC).filter((f) => f.endsWith('.hooks')).sort();
if (files.length === 0) throw new Error(`no .hooks files in ${SRC}`);
const parsed = [];
const errors = [];
for (const f of files) {
  const { hooks, errors: e } = parseHookText(readFileSync(join(SRC, f), 'utf8'), basename(f, '.hooks'));
  errors.push(...e);
  parsed.push(...hooks);
}

const added = parsed.filter((h) => !inBank.has(h.id));
const differs = parsed.filter((h) => inBank.has(h.id) && JSON.stringify(h) !== JSON.stringify(inBank.get(h.id)));
const missingText = bank.filter((h) => !parsed.some((p) => p.id === h.id));

// Duplicates over the bank as it will be: the bank's entries plus the new ones.
const bySig = new Map();
const byName = new Map();
for (const h of [...bank, ...added]) {
  const sig = JSON.stringify(h.melody);
  if (bySig.has(sig)) errors.push(`${h.id} "${h.properties.name}": the same melody as ${bySig.get(sig)}`);
  bySig.set(sig, h.id);
  if (byName.has(h.properties.name)) errors.push(`${h.id}: the name "${h.properties.name}" is already used by ${byName.get(h.properties.name)}`);
  byName.set(h.properties.name, h.id);
}

const all = [...bank, ...added];
const count = (k) => Object.entries(all.reduce((a, h) => ((a[h.properties[k]] = (a[h.properties[k]] ?? 0) + 1), a), {})).map(([x, n]) => `${x} ${n}`).join(', ');
console.log(`${parsed.length} hooks in ${files.length} files; ${bank.length} already in the bank, ${added.length} new.`);
console.log(`Bank after: ${all.length} hooks. By type: ${count('type')}. By feel: ${count('feel')}.`);
console.log(`Lead-in: ${all.filter((h) => h.properties.start === 1).length}. Tempo: slow (<85) ${all.filter((h) => h.properties.tempoMin < 85).length}, fast (>125) ${all.filter((h) => h.properties.tempoMax > 125).length}.`);
if (differs.length) console.log(`Text differs from the bank entry (bank kept, edit it in the library): ${differs.map((h) => h.id).join(', ')}`);
if (missingText.length) console.log(`In the bank but not in the text files (kept): ${missingText.map((h) => h.id).join(', ')}`);
if (errors.length) {
  console.error(`\n${errors.length} problem(s):\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  process.exit(1);
}
if (!check && added.length > 0) {
  writeFileSync(OUT, `${JSON.stringify(all, null, 1)}\n`);
  console.log(`appended ${added.length} to ${OUT}`);
}
