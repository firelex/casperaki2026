// Lyrics first on many songs: every genre, several seeds, the words applied (recut, drape, regenerate) without an
// error. Found an all-pickup line ("4/4/8") and a chord tone outside the melody's range when it was written.
import { expect, it } from 'vitest';
import { applyLyricsFirst, generatorParams, orchestrate, vocalSelections, writeMelody, segmentType } from '../src/index.js';
const FAM = [['day', 'way', 'say', 'stay'], ['night', 'light', 'bright', 'sight'], ['rain', 'pain', 'chain', 'plain'], ['sea', 'free', 'me', 'tree']];
const FREE = ['heart', 'dream', 'soul', 'road', 'home', 'sun', 'time', 'life', 'world', 'hand', 'door', 'town'];
it('lyrics first applies to songs of every genre', () => {
  const fails: string[] = [];
  let ok = 0;
  for (const genre of ['brightPop', 'edm', 'ballad', 'latin', 'rock', 'organicVibes', 'urban']) for (const seed of ['s1', 's2', 's3', 's4', 's5', 's6']) {
    const bpm = genre === 'ballad' ? 76 : genre === 'edm' ? 126 : 108;
    try {
      const base = writeMelody(orchestrate({ genre, key: 'C', bpm, seed, params: { vocalMelody: false } }));
      const sel = vocalSelections(generatorParams(base));
      const lyrics: Record<string, string[]> = {};
      let f = 0;
      [...sel].filter(([, m]) => m).forEach(([t, m], p) => {
        const n = (m!.properties.end - m!.properties.start) / 2;
        let r = 0;
        lyrics[t] = Array.from({ length: n }, (_, i) => `Oh la la ${(i % 2 === 1 && (n - (i - (i % 4))) >= 2) ? FAM[p % 4]![r++ % 4] : FREE[(f++) % FREE.length]}`);
      });
      applyLyricsFirst(base, lyrics);
      ok++;
    } catch (e) { fails.push(`${genre}/${seed}: ${(e as Error).message.slice(0, 160)}`); }
  }
  expect(fails).toEqual([]);
  expect(ok).toBe(42);
}, 600000);
