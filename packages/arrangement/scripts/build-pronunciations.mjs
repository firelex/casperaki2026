// Builds data/lyrics/pronunciations.json.gz from casperaki2's syllable dictionary (CMU-based, 123k words):
//   node scripts/build-pronunciations.mjs <path to casperaki2-engine-js/api/v1.0/services/data/lyrics/database/syllables.json>
// Each word maps to [written syllables, ARPAbet per syllable]. Words whose written split does not match their
// spoken syllables are left out (the lyric checker then asks for another word).
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = process.argv[2];
if (!source) throw new Error('usage: node scripts/build-pronunciations.mjs <casperaki2 syllables.json>');
const raw = JSON.parse(readFileSync(source, 'utf8'));
const words = {};
let dropped = 0;
for (const [word, e] of Object.entries(raw)) {
  const vowels = e.phonemeSyllables.map((s) => s.split(' ').filter((p) => /\d$/u.test(p)).length);
  if (e.syllables.length !== e.phonemeSyllables.length || vowels.some((v) => v !== 1)) {
    dropped++;
    continue;
  }
  words[word] = [e.syllables, e.phonemeSyllables];
}
const out = { $schemaVersion: 1, $source: 'casperaki2-engine-js/api/v1.0/services/data/lyrics/database/syllables.json', words };
const target = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'lyrics', 'pronunciations.json.gz');
writeFileSync(target, gzipSync(JSON.stringify(out), { level: 9 }));
console.log(`${Object.keys(words).length} words written to ${target}, ${dropped} left out`);
