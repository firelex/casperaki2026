// Train, tune and score chord-fit on the vocal precedents.
//   ../node_modules/.bin/tsx src/eval.ts
// Writes results/scores.md, results/model.json (prior + params trained on ALL precedents, for the brain) and
// listening examples as MIDI in /mnt/d/casperaki-data/chord-fit/.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chordFromId, chordId, chordPcs, chordRoman, chordSymbol, DIATONIC, sharedNotes } from './chords.js';
import { loadBankProgressions, loadItems, splitByFamily, type BankProgression, type Item } from './data.js';
import {
  BARS, harmonize, rankKnown, SLOTS, SLOTS_PER_BAR, slotWeights, trainPrior, viterbi,
  type HarmonizeParams, type KnownProgression, type Prior, type WeightedSequence,
} from './model.js';
import { writeMidi, type MidiNote } from './midi.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS = resolve(HERE, '..', 'results');
const MIDI_DIR = '/mnt/d/casperaki-data/chord-fit';
const SALT = 'chord-fit-v1';
const HOLDOUT = 0.2;
const MIN_VOCAB_COUNT = 2;
const BASELINE = ['0:maj', '0:maj', '7:maj', '7:maj', '9:min', '9:min', '5:maj', '5:maj'];
const BASELINE_SLOTS = [...BASELINE, ...BASELINE];

const out: string[] = [];
const log = (s = '') => { console.log(s); out.push(s); };

// ------------------------------------------------------------------ helpers

function familySizes(items: readonly Item[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const i of items) m.set(i.family, (m.get(i.family) ?? 0) + 1);
  return m;
}

interface Model { prior: Prior; bank: KnownProgression[]; plus: KnownProgression[]; oovSlots: number; bankExcluded: number }

/** Prior from training items (each family weighs 1 in total) and the chord bank (each entry weighs 1). Bank entries
 *  named like a held-out song are left out of both the prior and the known progressions. */
function buildModel(train: readonly Item[], heldOutNames: ReadonlySet<string>, bankAll: readonly BankProgression[]): Model {
  const bank = bankAll.filter((b) => !heldOutNames.has(b.normName));
  const fam = familySizes(train);
  const seqs: WeightedSequence[] = [
    ...train.map((i) => ({ slots: i.chords, weight: 1 / fam.get(i.family)! })),
    ...bank.map((b) => ({ slots: b.slots, weight: 1 })),
  ];
  const counts = new Map<string, number>();
  for (const s of seqs) for (const c of s.slots) counts.set(c, (counts.get(c) ?? 0) + 1);
  // Vocabulary: diatonic triads and sevenths, every chord seen at least MIN_VOCAB_COUNT times, and every chord of the
  // chord bank (so each known progression can be scored by the prior).
  const vocab = [...new Set([...DIATONIC.map(chordId), ...[...counts].filter(([, n]) => n >= MIN_VOCAB_COUNT).map(([c]) => c),
    ...bank.flatMap((b) => b.slots)])].sort();
  const { prior, oovSlots } = trainPrior(seqs, vocab);
  const seen = new Set<string>();
  const trainProgs: KnownProgression[] = [];
  for (const i of train) {
    const k = i.chords.join(' ');
    if (seen.has(k) || i.chords.some((c) => !vocab.includes(c))) continue;
    seen.add(k);
    trainProgs.push({ name: `precedent ${i.name}`, slots: i.chords });
  }
  return { prior, bank, plus: [...bank, ...trainProgs], oovSlots, bankExcluded: bankAll.length - bank.length };
}

const truncate = (i: Item, bars: number) => i.notes.filter((n) => n.beat < bars * 4).map((n) => ({ ...n, duration: Math.min(n.duration, bars * 4 - n.beat) }));

interface SlotScore { exact: number; root: number; compat: number }
function slotScore(pred: readonly string[], orig: readonly string[]): SlotScore {
  let exact = 0, root = 0, compat = 0;
  for (let s = 0; s < SLOTS; s++) {
    const a = chordFromId(pred[s]!), b = chordFromId(orig[s]!);
    if (pred[s] === orig[s]) exact++;
    if (a.deg === b.deg) root++;
    if (sharedNotes(a, b) >= 2) compat++;
  }
  return { exact: exact / SLOTS, root: root / SLOTS, compat: compat / SLOTS };
}

interface Row { exact: number; root: number; compat: number; top3?: number; top3Song?: number; knownPref?: number; n: number }
function mean(rows: readonly Record<string, number>[], k: string): number { return rows.reduce((a, r) => a + r[k]!, 0) / rows.length; }

type Method = 'baseline' | 'free' | 'known' | 'method' | 'method+';
function runMethod(items: readonly Item[], bars: number, model: Model, p: HarmonizeParams, method: Method): Row {
  const rows = items.map((it) => {
    const notes = truncate(it, bars);
    if (method === 'baseline') return { ...slotScore(BASELINE_SLOTS, it.chords) };
    const W = slotWeights(notes, bars, p.fit, p.fill);
    if (method === 'free') return { ...slotScore(viterbi(W, it.tonicPc, model.prior, p).slots, it.chords) };
    if (method === 'known') return { ...slotScore(rankKnown(W, it.tonicPc, model.bank, model.prior, p)[0]!.slots, it.chords) };
    const h = harmonize(notes, bars, it.tonicPc, model.prior, method === 'method' ? model.bank : model.plus, p);
    const s = slotScore(h.alternatives[0]!.slots, it.chords);
    const alts = h.alternatives.map((a) => slotScore(a.slots, it.chords).exact);
    return { ...s, top3: Math.max(...alts), top3Song: alts.some((x) => x === 1) ? 1 : 0, knownPref: h.knownPreferred ? 1 : 0 };
  });
  const r: Row = { exact: mean(rows, 'exact'), root: mean(rows, 'root'), compat: mean(rows, 'compat'), n: rows.length };
  if (method === 'method' || method === 'method+') return { ...r, top3: mean(rows, 'top3'), top3Song: mean(rows, 'top3Song'), knownPref: mean(rows, 'knownPref') };
  return r;
}

// ------------------------------------------------------------------ data + stats

const { items, report } = loadItems();
const bankAll = loadBankProgressions();
log('# chord-fit scores');
log();
log(`Generated by \`src/eval.ts\` on ${new Date().toISOString().slice(0, 10)}. Precedents with chords: ${items.length} `
  + `(dropped: ${report.dropped.map((d) => `${d.id} (${d.reason})`).join(', ') || 'none'}; ${report.pickupNotesDropped} pickup notes before bar 1 ignored; `
  + `${report.offGridChordChanges} chord changes off the half-bar grid, i.e. on beat 2 or 4, folded into the half bar they fall in). Chord bank: ${bankAll.length} progressions.`);
log();

log('## Chord vocabulary (half-bar slots, relative to the key, major key)');
log();
const vocabTable = (label: string, seqs: readonly (readonly string[])[]) => {
  const c = new Map<string, number>();
  let tot = 0;
  for (const s of seqs) for (const x of s) { c.set(x, (c.get(x) ?? 0) + 1); tot++; }
  const sorted = [...c].sort((a, b) => b[1] - a[1]);
  const diat = new Set(['0:maj', '2:min', '4:min', '5:maj', '7:maj', '9:min', '11:dim']);
  const triadShare = sorted.filter(([k]) => diat.has(k)).reduce((a, [, n]) => a + n, 0) / tot;
  const sevenShare = sorted.filter(([k]) => !['maj', 'min', 'dim', 'aug'].includes(chordFromId(k).q)).reduce((a, [, n]) => a + n, 0) / tot;
  log(`- **${label}**: ${sorted.length} distinct chords; diatonic triads ${(100 * triadShare).toFixed(1)}%, sevenths/ninths/sus/other ${(100 * sevenShare).toFixed(1)}%. `
    + sorted.slice(0, 18).map(([k, n]) => `${chordRoman(chordFromId(k))} ${(100 * n / tot).toFixed(1)}%`).join(', '));
};
for (const bank of ['drLuke', 'limitedRange', 'schlager', 'stefan'] as const) vocabTable(bank, items.filter((i) => i.bank === bank).map((i) => i.chords));
vocabTable('chord bank', bankAll.map((b) => b.slots.slice(0, 8)));
log();
log('## Chord rate');
log();
for (const bank of ['drLuke', 'limitedRange', 'schlager', 'stefan'] as const) {
  const its = items.filter((i) => i.bank === bank);
  const mid = its.reduce((a, i) => a + i.midBarChanges, 0) / (its.length * BARS);
  let changesAcross = 0;
  for (const i of its) for (let b = 1; b < BARS; b++) if (i.chords[b * SLOTS_PER_BAR] !== i.chords[b * SLOTS_PER_BAR - 1]) changesAcross++;
  const repeat = its.filter((i) => i.chords.slice(0, 8).join() === i.chords.slice(8).join()).length / its.length;
  log(`- ${bank}: ${its.length} melodies; ${(100 * mid).toFixed(1)}% of bars change chord at beat 3 (two chords per bar); `
    + `${(100 * changesAcross / (its.length * (BARS - 1))).toFixed(1)}% of bar lines change chord; bars 5-8 repeat bars 1-4 in ${(100 * repeat).toFixed(0)}%.`);
}
{
  const mid = bankAll.reduce((a, b) => a + [0, 1, 2, 3].filter((k) => b.slots[2 * k] !== b.slots[2 * k + 1]).length, 0) / (bankAll.length * 4);
  log(`- chord bank: ${(100 * mid).toFixed(1)}% of bars have two chords.`);
}
log();

// ------------------------------------------------------------------ split

const { train, test } = splitByFamily(items, HOLDOUT, SALT);
const nFam = (xs: readonly Item[], g: string) => new Set(xs.filter((i) => i.group === g).map((i) => i.family)).size;
log('## Split');
log();
log(`Families: a song name for drLuke / limitedRange / schlager (several sections and variants of one song share it, and the app treats `
  + `precedents of one name as the same melody); for stefan, a generator batch (names "Melody k ...imported n" with k restarting at 1). `
  + `20% of families held out per group (salted hash \`${SALT}\`).`);
log();
log(`| | train melodies | train families | test melodies | test families |`);
log(`|---|---|---|---|---|`);
for (const g of ['songs', 'stefan'] as const)
  log(`| ${g} | ${train.filter((i) => i.group === g).length} | ${nFam(train, g)} | ${test.filter((i) => i.group === g).length} | ${nFam(test, g)} |`);
log();
const testSongNames = new Set(test.filter((i) => i.group === 'songs').map((i) => i.family.replace(/^song:/u, '')));

// ------------------------------------------------------------------ tuning: 5-fold cross-validation over training families

const trainFams = [...new Set(train.map((i) => i.family))].sort();
const FOLDS = 5;
const folds = Array.from({ length: FOLDS }, (_, f) => {
  const fams = new Set(trainFams.filter((_, j) => j % FOLDS === f));
  const valid = train.filter((i) => fams.has(i.family));
  const tr = train.filter((i) => !fams.has(i.family));
  const names = new Set([...testSongNames, ...valid.filter((i) => i.group === 'songs').map((i) => i.family.replace(/^song:/u, ''))]);
  // Subsample stefan validation melodies (every 4th) to keep the grid search quick.
  const validSub = valid.filter((i, j) => i.group === 'songs' || j % 4 === 0);
  return { model: buildModel(tr, names, bankAll), valid: validSub };
});

function cvScore(p: HarmonizeParams, bars: number, method: Method): number {
  // Macro average of the two groups so the 1,000 stefan melodies do not drown out the real songs.
  const per = { songs: [] as number[], stefan: [] as number[] };
  for (const f of folds) for (const g of ['songs', 'stefan'] as const) {
    const v = f.valid.filter((i) => i.group === g);
    if (v.length) per[g].push(runMethod(v, bars, f.model, p, method).exact * v.length, v.length);
  }
  const avg = (xs: number[]) => { let s = 0, n = 0; for (let k = 0; k < xs.length; k += 2) { s += xs[k]!; n += xs[k + 1]!; } return s / n; };
  return (avg(per.songs) + avg(per.stefan)) / 2;
}

let best: HarmonizeParams = { fit: { alpha: 1, rootBonus: 0, carryWeight: 0.5, passingWeight: 0.3 }, lambda: 1, delta: 0, fill: 'tile', knownRank: 'fit' };
let bestScore = -1;
for (const lambda of [0.25, 0.5, 1, 2, 4])
  for (const alpha of [0.5, 1, 1.5])
    for (const rootBonus of [0, 0.3]) {
      const p: HarmonizeParams = { ...best, fit: { ...best.fit, alpha, rootBonus }, lambda };
      const s = cvScore(p, BARS, 'free');
      if (s > bestScore) { bestScore = s; best = p; }
    }
log('## Tuning (5-fold cross-validation over training families, macro average of songs and stefan)');
log();
log(`- free sequence: lambda=${best.lambda}, alpha=${best.fit.alpha}, rootBonus=${best.fit.rootBonus} (carry 0.5, passing 0.3 fixed): exact ${(100 * bestScore).toFixed(1)}%`);
// The known-progression margin (and how known progressions are ranked) is tuned separately for the two known sets.
const tuneKnown = (method: 'method' | 'method+'): HarmonizeParams => {
  let bp = best, bs = -1;
  for (const knownRank of ['fit', 'score'] as const) {
    const line: string[] = [];
    for (const delta of [-1e9, 0, 0.02, 0.05, 0.1, 0.2, 0.3, 0.5]) {
      const p = { ...best, delta, knownRank };
      const s = cvScore(p, BARS, method);
      line.push(`${delta < -1 ? 'never' : delta}: ${(100 * s).toFixed(1)}%`);
      if (s > bs) { bs = s; bp = p; }
    }
    log(`- ${method === 'method' ? 'bank' : 'bank + training progressions'}, known ranked by ${knownRank}, margin delta -> recommendation exact: ${line.join(', ')}`);
  }
  log(`  -> delta=${bp.delta < -1 ? 'never' : bp.delta}, ranked by ${bp.knownRank}`);
  return bp;
};
const bestPlus = tuneKnown('method+');
best = tuneKnown('method');
const fillFor = new Map<number, 'tile' | 'empty'>();
for (const bars of [4, 2]) {
  const t = cvScore({ ...best, fill: 'tile' }, bars, 'method');
  const e = cvScore({ ...best, fill: 'empty' }, bars, 'method');
  fillFor.set(bars, t >= e ? 'tile' : 'empty');
  log(`- ${bars}-bar hum, bars without melody: loop the hummed bars ${(100 * t).toFixed(1)}% vs leave to the prior ${(100 * e).toFixed(1)}% -> ${fillFor.get(bars)}`);
}
fillFor.set(BARS, 'tile');
log();

// ------------------------------------------------------------------ held-out scores

const model = buildModel(train, testSongNames, bankAll);
log(`Final model: vocabulary ${model.prior.vocab.length} chords (${model.prior.vocab.map((v) => chordRoman(chordFromId(v))).join(' ')}); `
  + `${model.oovSlots} training slots outside it; ${model.bankExcluded} chord-bank entries left out because they share a name with a held-out song.`);
log();
log('## Held-out scores');
log();
log('Per half-bar slot (16 per melody; a one-chord bar counts twice), mean over melodies. exact = same root and quality; '
  + 'root = same root; compatible = at least 2 shared notes; top-3 = best of the 3 alternatives per melody; '
  + 'top-3 whole = some alternative matches all 16 slots exactly; known = how often the recommendation is a known progression.');
const pct = (x: number | undefined) => (x === undefined ? '' : `${(100 * x).toFixed(1)}%`);
const METHODS: [Method, string][] = [
  ['baseline', 'baseline I-V-vi-IV'],
  ['free', 'best free (Viterbi)'],
  ['known', 'best chord-bank progression'],
  ['method', 'recommendation (bank)'],
  ['method+', 'recommendation (bank + training progressions)'],
];
const finalRows: Record<string, Row> = {};
for (const g of ['songs', 'stefan'] as const) {
  const its = test.filter((i) => i.group === g);
  for (const bars of [8, 4, 2]) {
    log();
    log(`### ${g}: melody of ${bars} bars given, chords scored on all 8 bars (${its.length} melodies)`);
    log();
    log('| method | exact | root | compatible | top-3 exact | top-3 whole | known |');
    log('|---|---|---|---|---|---|---|');
    for (const [m, label] of METHODS) {
      const p = { ...(m === 'method+' ? bestPlus : best), fill: fillFor.get(bars)! };
      const r = runMethod(its, bars, model, p, m);
      finalRows[`${g}/${bars}/${m}`] = r;
      log(`| ${label} | ${pct(r.exact)} | ${pct(r.root)} | ${pct(r.compat)} | ${pct(r.top3)} | ${pct(r.top3Song)} | ${pct(r.knownPref)} |`);
    }
  }
}
log();

// ------------------------------------------------------------------ listening examples

mkdirSync(MIDI_DIR, { recursive: true });
const examples = [
  ...test.filter((i) => i.group === 'songs').filter((i, j, a) => a.findIndex((x) => x.family === i.family) === j).slice(0, 5),
  ...test.filter((i) => i.group === 'stefan').filter((_, j) => j % 60 === 0).slice(0, 3),
];
log('## Listening examples');
log();
log(`Shipped variant (known = chord bank + training progressions). MIDI in \`${MIDI_DIR}\`. Each file plays the melody four times (an octave up from the precedent's register): `
  + 'with alternative 1, 2, 3, then the original chords (markers name each pass; chords are on their own tracks).');
log();
const chordVoicing = (id: string, tonic: number): number[] => {
  const c = chordFromId(id);
  const root = 48 + ((tonic + c.deg) % 12);
  const pcs = [...chordPcs(c, tonic)];
  return [root - 12, ...pcs.map((pc) => { let n = 52 + ((pc - 52) % 12 + 12) % 12; return n; })];
};
const chordNotes = (slots: readonly string[], tonic: number, offset: number): MidiNote[] => {
  const notes: MidiNote[] = [];
  let s = 0;
  while (s < SLOTS) {
    let e = s + 1;
    while (e < SLOTS && slots[e] === slots[s]) e++;
    for (const m of chordVoicing(slots[s]!, tonic)) notes.push({ beat: offset + s * 2, duration: (e - s) * 2, midi: m, velocity: 70 });
    s = e;
  }
  return notes;
};
const names = (slots: readonly string[], tonic: number) => {
  const bars: string[] = [];
  for (let b = 0; b < BARS; b++) {
    const a = slots[2 * b]!, c = slots[2 * b + 1]!;
    bars.push(a === c ? chordSymbol(chordFromId(a), tonic) : `${chordSymbol(chordFromId(a), tonic)} ${chordSymbol(chordFromId(c), tonic)}`);
  }
  return bars.join(' | ');
};
for (const [k, it] of examples.entries()) for (const bars of [8, 4]) {
  const p = { ...bestPlus, fill: fillFor.get(bars)! };
  const notes = truncate(it, bars);
  const h = harmonize(notes, bars, it.tonicPc, model.prior, model.plus, p);
  const passes = [...h.alternatives.map((a) => ({ label: a.label, slots: a.slots })), { label: 'original', slots: it.chords }];
  const mel: MidiNote[] = [];
  const tracks = passes.map((ps, j) => ({ name: `${j + 1}: ${ps.label}`, channel: j + 1, program: 0, notes: chordNotes(ps.slots, it.tonicPc, j * BARS * 4) }));
  passes.forEach((_, j) => { for (const n of notes) mel.push({ beat: j * BARS * 4 + n.beat, duration: n.duration, midi: n.midi + 12, velocity: 100 }); });
  const file = `${String(k + 1).padStart(2, '0')}-${it.bank}-${it.name.replace(/[^A-Za-z0-9]+/gu, '_').slice(0, 40)}-${bars}bars.mid`;
  writeFileSync(resolve(MIDI_DIR, file), writeMidi(it.tempo, [{ name: 'melody', channel: 0, program: 73, notes: mel }, ...tracks],
    passes.map((ps, j) => ({ beat: j * BARS * 4, text: ps.label }))));
  log(`- \`${file}\`${bars < BARS ? ` (only the first ${bars} bars of melody given)` : ''}`);
  for (const ps of passes) log(`  - ${ps.label}: ${names(ps.slots, it.tonicPc)}`);
}
log();

// ------------------------------------------------------------------ model for the brain: prior on ALL precedents + full bank

const full = buildModel(items, new Set(), bankAll);
mkdirSync(RESULTS, { recursive: true });
writeFileSync(resolve(RESULTS, 'model.json'), JSON.stringify({
  $description: 'chord-fit model: prior trained on all vocal precedents with chords + the chord bank; params tuned by cross-validation. Load with src/model.ts harmonize().',
  // Shipped variant: known progressions = chord bank + every distinct progression of the precedents, with the margin
  // tuned for that set (the bank-only variant never prefers a known progression).
  params: bestPlus,
  fillByMelodyBars: Object.fromEntries(fillFor),
  prior: full.prior,
  known: full.plus.map((b) => ({ name: b.name, slots: b.slots })),
}, null, 1));
writeFileSync(resolve(RESULTS, 'scores.md'), out.join('\n') + '\n');
console.log(`\nwrote ${resolve(RESULTS, 'scores.md')} and model.json`);
