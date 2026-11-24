// One-off migration (2026-11-24): write properties.useOriginal, properties.useRemix and properties.source into every
// entry of every vocal precedent bank (data/vocals/precedents/mlDataRaw-*.json). The loader (src/vocals/precedents.ts)
// requires these fields; there are no defaults.
//
//   node scripts/add-precedent-flags.mjs
//
// useOriginal: the entry may be sung whole, exactly as written (moved by octaves only).
// useRemix:    the entry may take part in the mixing merge (rhythm of one entry, pitch shape and chords of another).
// source:      where the melody comes from: { kind: 'song' | 'melodySauce' | 'casperaki', title?, artist? }.
//
// Hooks (our own): both flags, source casperaki. Legacy banks: remix only. stefan holds imported Melody Sauce .mid
// files (names "Melody <k> melodysauceimported<n>.mid"); drLuke, schlager, limitedRange and rhythmic-* hold
// transcriptions of real songs (title = the entry's name). No artist: the admin fills it in later. Rerunning gives
// the same files (the values are set, not toggled). The file layout is kept (legacy minified, hooks indented).

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'vocals', 'precedents');
const index = JSON.parse(readFileSync(join(DIR, 'bank-index.json'), 'utf8'));

const SONG_BANKS = new Set([
  'drLuke', 'schlager', 'limitedRange',
  'rhythmic-ballad', 'rhythmic-dance', 'rhythmic-latin', 'rhythmic-organicVibes', 'rhythmic-rock', 'rhythmic-urban',
]);

function flagsFor(bankId, entry) {
  if (bankId === 'hooks') return { useOriginal: true, useRemix: true, source: { kind: 'casperaki' } };
  if (bankId === 'stefan') {
    if (!/^Melody \d+ melodysauceimported\d+\.mid$/u.test(entry.properties.name)) {
      throw new Error(`stefan entry ${entry.id}: name "${entry.properties.name}" is not a Melody Sauce import`);
    }
    return { useOriginal: false, useRemix: true, source: { kind: 'melodySauce' } };
  }
  if (SONG_BANKS.has(bankId)) {
    const title = entry.properties.name;
    if (typeof title !== 'string' || !title.trim()) throw new Error(`${bankId} entry ${entry.id} has no name to use as title`);
    return { useOriginal: false, useRemix: true, source: { kind: 'song', title } };
  }
  throw new Error(`bank "${bankId}" has no classification in this script`);
}

for (const [bankId, { file }] of Object.entries(index.banks)) {
  const path = join(DIR, file);
  const raw = readFileSync(path, 'utf8');
  const bank = JSON.parse(raw);
  for (const entry of bank) Object.assign(entry.properties, flagsFor(bankId, entry));
  const indented = raw.startsWith('[\n');
  writeFileSync(path, indented ? `${JSON.stringify(bank, null, 1)}\n` : JSON.stringify(bank));
  console.log(`${bankId}: ${bank.length} entries`);
}
