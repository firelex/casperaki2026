// How busy the generated vocal melodies are at each tempo (bank-index tempoFit, src/vocals/precedents.ts).
//
//   pnpm -C packages/arrangement exec tsx scripts/measure-melody-tempo-fit.ts [seeds=20] [step=5]
//
// For every genre, every tempo of its range (every `step` bpm, and its ends) and every sung section type, draws
// `seeds` melodies with selectMergedPrecedent (8 bars) and prints: how many could not be made (the error), the notes
// per second of the melodies (median and highest), the share sung in half time and the share using a hook.

import { GENRE_TEMPO_RANGES } from '@casperaki/song-schema';
import { createRng } from '@casperaki/music-theory';

import { loadBankIndex, selectMergedPrecedent } from '../src/vocals/precedents.js';

const seeds = Number(process.argv[2] ?? 20);
const step = Number(process.argv[3] ?? 5);
const index = loadBankIndex();
const failures: string[] = [];

for (const [genre, range] of Object.entries(GENRE_TEMPO_RANGES)) {
  const rules = index.genres[genre];
  if (!rules) continue;
  const tempos = [...new Set([range.min, ...Array.from({ length: Math.floor((range.max - range.min) / step) + 1 }, (_, i) => range.min + i * step), range.max])];
  for (const tempo of tempos) {
    const cells: string[] = [];
    for (const segmentType of Object.keys(rules)) {
      const nps: number[] = [];
      let half = 0;
      let hook = 0;
      let failed = 0;
      for (let i = 0; i < seeds; i++) {
        try {
          const m = selectMergedPrecedent({ desiredPatternLength: 8, segmentType, genre, tempo, rng: createRng(`fit-${genre}-${tempo}-${segmentType}-${i}`) });
          if (!m) continue;
          const notes = Object.keys(m.melody).filter((b) => parseFloat(b) < 32).length;
          nps.push(((notes / 8) * tempo) / 240);
          if (String(m.rhythmicPrecedentId).endsWith('@half')) half++;
          if (m.recipe?.startsWith('hook') || m.recipe === 'curatedOnHook') hook++;
        } catch (e) {
          failed++;
          if (failed === 1) failures.push(`${genre} ${tempo} bpm ${segmentType}: ${(e as Error).message.slice(0, 300)}`);
        }
      }
      nps.sort((a, b) => a - b);
      const med = nps.length ? nps[Math.floor(nps.length / 2)]!.toFixed(2) : '-';
      const max = nps.length ? nps[nps.length - 1]!.toFixed(2) : '-';
      cells.push(`${segmentType} ${med}/${max}${failed ? ` FAIL ${failed}` : ''} half ${Math.round((100 * half) / seeds)}% hook ${Math.round((100 * hook) / seeds)}%`);
    }
    console.log(`${genre.padEnd(12)} ${String(tempo).padStart(3)}  ${cells.join(' | ')}`);
  }
}
if (failures.length) {
  console.log(`\n${failures.length} section/tempo cells could not always make a melody:`);
  for (const f of failures) console.log(`  - ${f}`);
}
