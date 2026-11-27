// Builds data/lyrics/stress-shifts.json: for English noun/verb stress-shift words ("PER-fect" an adjective, "per-FECT"
// a verb; "RE-cord" / "re-CORD"), both pronunciations, from the official CMU dictionary (which lists variants; our
// pronunciations.json keeps one per word, sometimes the verb's). Which one a line sings is read from the sentence
// (written-lyrics.ts pronounceLine: a verb takes the late stress, anything else the early one). Owner, 2026-11-27:
// "full of perfect" was sung per-FECT.
//   node scripts/build-stress-shifts.mjs <cmudict.dict from github.com/cmusphinx/cmudict>
// Only the words listed here: CMU has variants of many other words that are not about the part of speech (July,
// adult), and those keep their one pronunciation.
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Noun or adjective with the stress early, verb with it late (the initial-stress-derived nouns of English, and
 *  "perfect"). */
const WORDS = [
  'abstract', 'accent', 'addict', 'address', 'affix', 'ally', 'annex', 'combat', 'combine', 'commune', 'compact',
  'complex', 'compound', 'compress', 'concert', 'conduct', 'confine', 'conflict', 'conscript', 'console', 'consort',
  'construct', 'consult', 'contest', 'contract', 'contrast', 'converse', 'convert', 'convict', 'decrease', 'defect',
  'desert', 'detail', 'digest', 'discharge', 'discount', 'escort', 'excise', 'exploit', 'export', 'extract', 'ferment',
  'impact', 'implant', 'import', 'impress', 'imprint', 'incense', 'incline', 'increase', 'insert', 'insult', 'intern',
  'object', 'perfect', 'perfume', 'permit', 'pervert', 'present', 'produce', 'progress', 'project', 'protest', 'rebel',
  'recall', 'record', 'refill', 'refund', 'refuse', 'reject', 'relay', 'remake', 'reprint', 'retake', 'rewrite',
  'segment', 'subject', 'survey', 'suspect', 'torment', 'transfer', 'transform', 'transplant', 'transport', 'upgrade',
  'upset',
];

const source = process.argv[2];
if (!source) throw new Error('usage: node scripts/build-stress-shifts.mjs <cmudict.dict>');
const here = dirname(fileURLToPath(import.meta.url));
const ours = JSON.parse(gunzipSync(readFileSync(resolve(here, '..', 'data', 'lyrics', 'pronunciations.json.gz'))).toString('utf8')).words;

const variants = new Map();
for (const line of readFileSync(source, 'utf8').split('\n')) {
  const m = /^([a-z']+)(?:\(\d+\))?\s+([A-Z0-9 ]+?)\s*(?:#.*)?$/u.exec(line);
  if (!m) continue;
  if (!variants.has(m[1])) variants.set(m[1], []);
  variants.get(m[1]).push(m[2].split(' '));
}

const isVowel = (p) => /\d$/u.test(p);
/** Phonemes split into syllables at the same places as `like` (our entry), consonant for consonant: between two
 *  vowels, as many consonants go to the earlier syllable as in our entry. */
function split(phones, like) {
  const vowelsAt = phones.flatMap((p, i) => (isVowel(p) ? [i] : []));
  if (vowelsAt.length !== like.length) return undefined;
  const codas = like.slice(0, -1).map((s) => {
    const ps = s.split(' ');
    return ps.length - 1 - ps.findIndex(isVowel);
  });
  const out = [];
  let from = 0;
  for (let k = 0; k < vowelsAt.length - 1; k++) {
    const between = vowelsAt[k + 1] - vowelsAt[k] - 1;
    const to = vowelsAt[k] + 1 + Math.min(codas[k], between);
    out.push(phones.slice(from, to).join(' '));
    from = to;
  }
  out.push(phones.slice(from).join(' '));
  return out;
}
const primary = (syllables) => syllables.findIndex((s) => s.split(' ').some((p) => p.endsWith('1')));

const out = {};
const skipped = [];
for (const word of WORDS) {
  const entry = ours[word];
  const vs = (variants.get(word) ?? []).map((v) => split(v, entry?.[1] ?? [])).filter(Boolean);
  const early = vs.find((v) => primary(v) === 0);
  const late = vs.find((v) => primary(v) > 0);
  if (!entry || !early || !late) {
    skipped.push(word);
    continue;
  }
  out[word] = { early, late };
}
const target = resolve(here, '..', 'data', 'lyrics', 'stress-shifts.json');
writeFileSync(target, `${JSON.stringify({ $schemaVersion: 1, $source: 'github.com/cmusphinx/cmudict cmudict.dict', words: out }, null, 1)}\n`);
console.log(`${Object.keys(out).length} words written to ${target}; no two stresses in CMU (kept as they are): ${skipped.join(', ')}`);
