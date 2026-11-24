// One-off gentle fix of the Melody Sauce imports (the "stefan" vocal precedent bank, 1201 algorithmically generated
// melodies). Owner's brief (2026-11-24): keep their character, just make them more agreeable and move them into the
// treble range. Run once:
//
//   node packages/arrangement/scripts/fix-melody-sauce.mjs
//
// Per melody, rhythm and pitch classes are kept; only:
//   1. clipped notes (staccato gates, which look like 16ths) last until the next note; a gap of a beat or more stays
//      a rest;
//   2. octaves: a dynamic-programming pass gives each note its own octave or one up/down, to avoid leaps wider than a
//      fifth and stay within 11 semitones of the median, changing as few notes as possible;
//   3. the whole melody moves by octaves so its median sits nearest midi 53 in the bank register (shown and sung an
//      octave up: F4, inside the treble staff);
//   4. a note on beat 1 or 3 a semitone off its chord moves onto the chord tone.
// properties.lowestNote/highestNote/medianNote/busyness are recomputed; properties.fixedFrom records the change.
// The original is in git history (before this script's commit).

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'vocals', 'precedents', 'mlDataRaw-stefan.json');
const TARGET_MED = 53;
const WIN = 11;
const NAMES = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'];
const ROOT = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };
const QUAL = {
  '': [0, 4, 7], m: [0, 3, 7], 7: [0, 4, 7, 10], m7: [0, 3, 7, 10], maj7: [0, 4, 7, 11], sus4: [0, 5, 7], sus: [0, 5, 7],
  9: [0, 4, 7, 10, 2], maj9: [0, 4, 7, 11, 2], dim: [0, 3, 6], m9: [0, 3, 7, 10, 2], sus2: [0, 2, 7], 6: [0, 4, 7, 9],
};

function chordPcs(symbol) {
  const root = symbol.length > 1 && '#b'.includes(symbol[1]) ? symbol.slice(0, 2) : symbol.slice(0, 1);
  const q = QUAL[symbol.slice(root.length)];
  if (q === undefined || ROOT[root] === undefined) throw new Error(`fix-melody-sauce: cannot read chord "${symbol}"`);
  return new Set(q.map((i) => (ROOT[root] + i) % 12));
}
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const pc = (m) => ((m % 12) + 12) % 12;
const beatKey = (b) => (Number.isInteger(b) ? b.toFixed(1) : String(b));

function fix(x) {
  const p = x.properties;
  const total = (p.end - p.start) * 4;
  const notes = Object.entries(x.melody).map(([b, v]) => ({ beat: Number(b), midi: v[0].midi, duration: v[0].duration })).sort((a, b) => a.beat - b.beat);
  if (notes.length === 0) throw new Error(`fix-melody-sauce: entry ${x.id} has no notes`);
  const chordAt = (b) => {
    const c = x.chords[beatKey(Math.floor(b))];
    if (!c) throw new Error(`fix-melody-sauce: entry ${x.id} has no chord at beat ${Math.floor(b)}`);
    return chordPcs(c.chord);
  };
  // 1. lengths
  notes.forEach((n, i) => {
    const next = i + 1 < notes.length ? notes[i + 1].beat : total;
    if (next - (n.beat + n.duration) < 1 - 1e-9) n.duration = next - n.beat;
  });
  // 2. octaves
  const med = median(notes.map((n) => n.midi));
  const opts = notes.map((n) => [n.midi, n.midi - 12, n.midi + 12]);
  const local = (i, m) => (m === notes[i].midi ? 0 : 3) + (Math.abs(m - med) <= WIN ? 0 : 20);
  const trans = (a, b) => {
    const d = Math.abs(a - b);
    return d <= 7 ? 0 : d <= 9 ? 8 : 25;
  };
  let cost = opts[0].map((m) => local(0, m));
  const back = [];
  for (let i = 1; i < notes.length; i++) {
    const row = [];
    const br = [];
    for (const m of opts[i]) {
      let best = 0;
      for (let j = 1; j < 3; j++) if (cost[j] + trans(opts[i - 1][j], m) < cost[best] + trans(opts[i - 1][best], m)) best = j;
      row.push(cost[best] + trans(opts[i - 1][best], m) + local(i, m));
      br.push(best);
    }
    cost = row;
    back.push(br);
  }
  let j = [0, 1, 2].reduce((a, k) => (cost[k] < cost[a] ? k : a), 0);
  for (let i = notes.length - 1; i >= 0; i--) {
    notes[i].midi = opts[i][j];
    if (i) j = back[i - 1][j];
  }
  // 3. register
  const shift = Math.round((TARGET_MED - median(notes.map((n) => n.midi))) / 12) * 12;
  for (const n of notes) n.midi += shift;
  // 4. strong-beat clashes
  for (const n of notes) {
    const pos = n.beat % 4;
    if (Math.abs(pos) > 1e-9 && Math.abs(pos - 2) > 1e-9) continue;
    const c = chordAt(n.beat);
    if (c.has(pc(n.midi))) continue;
    for (const d of [-1, 1]) if (c.has(pc(n.midi + d))) {
      n.midi += d;
      break;
    }
  }
  const melody = {};
  for (const n of notes) melody[beatKey(n.beat)] = [{ note: `${NAMES[pc(n.midi)]}${Math.floor(n.midi / 12)}`, midi: n.midi, duration: n.duration }];
  const sorted = notes.map((n) => n.midi).sort((a, b) => a - b);
  return {
    ...x,
    properties: {
      ...p,
      lowestNote: sorted[0], highestNote: sorted[sorted.length - 1], medianNote: sorted[Math.floor(sorted.length / 2)],
      busyness: notes.length / (p.end - p.start),
      fixedFrom: 'scripts/fix-melody-sauce.mjs (2026-11-24): register, octaves, note lengths, strong-beat clashes',
    },
    melody,
  };
}

const bank = JSON.parse(readFileSync(FILE, 'utf8'));
if (bank.some((x) => x.properties.fixedFrom)) throw new Error('fix-melody-sauce: the bank is already fixed (properties.fixedFrom is set); run it on the original only');
const out = bank.map(fix);
writeFileSync(FILE, `${JSON.stringify(out, null, 1)}\n`);
console.log(`fixed ${out.length} Melody Sauce melodies in ${FILE}`);
