// Write one canonical Casperaki song (orchestrated offline by @casperaki/arrangement) to <out>/song-in.json.
//   node make_song.mjs <out_dir> <genre> <key> <bpm> <seed>
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [out, genre, key, bpm, seed] = process.argv.slice(2);
if (!seed) throw new Error('usage: make_song.mjs <out_dir> <genre> <key> <bpm> <seed>');
const arr = await import(join(process.env.HOME, 'apps/casperaki/packages/arrangement/dist/index.js'));
const song = arr.orchestrate({ genre, key, bpm: Number(bpm), seed });
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'song-in.json'), JSON.stringify(song));
console.log(JSON.stringify({ genre, key, bpm: Number(bpm), seed }));
