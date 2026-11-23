// chord-fit: pick chords for a melody. Pure functions, no I/O, so the brain can import this file directly.
//
// Grid: 8 bars of 4 beats, two "slots" (half bars, 2 beats each) per bar => 16 slots. A one-chord bar is the same
// chord in both of its slots. Everything is in the major key, chords as roots relative to the tonic.
//
//   score(sequence) = lambda * sum_s fit(slot s, chord s) + log P(first chord) + sum_s log P(chord s | chord s-1)
//
// The transition probability uses one table inside a bar (half 1 -> half 2: this is where the chord rate is learned)
// and another across bar lines. The best sequence is found with the Viterbi algorithm.

import { chordFromId, chordId, chordPcs, type Chord } from './chords.js';

export const BARS = 8;
export const SLOTS_PER_BAR = 2;
export const SLOT_BEATS = 4 / SLOTS_PER_BAR;
export const SLOTS = BARS * SLOTS_PER_BAR;

export interface MelodyNote {
  /** Onset in beats from the start of bar 1 (4 beats per bar). */
  readonly beat: number;
  /** MIDI pitch; only its pitch class matters here. */
  readonly midi: number;
  /** Length in beats. */
  readonly duration: number;
}

export interface FitParams {
  /** Penalty per unit weight of melody that is not a chord tone (a chord tone earns +1). */
  readonly alpha: number;
  /** Extra credit when the melody sits on the chord root. */
  readonly rootBonus: number;
  /** Weight of a note that started in an earlier slot and is still sounding. */
  readonly carryWeight: number;
  /** Multiplier for short step-wise passing notes. */
  readonly passingWeight: number;
}

export interface Prior {
  readonly vocab: readonly string[];
  /** log P(first chord) */
  readonly init: readonly number[];
  /** log P(next | prev) inside a bar (first half -> second half) */
  readonly within: readonly (readonly number[])[];
  /** log P(next | prev) across a bar line */
  readonly across: readonly (readonly number[])[];
}

export interface KnownProgression {
  readonly name: string;
  /** SLOTS chord ids */
  readonly slots: readonly string[];
}

export interface HarmonizeParams {
  readonly fit: FitParams;
  /** Weight of the melody fit against the log-probability prior. */
  readonly lambda: number;
  /** A known progression is preferred when its fit is at most delta * (total melody weight) below the free best. */
  readonly delta: number;
  /** How bars with no melody (hum shorter than 8 bars) get fit: 'tile' loops the hummed bars, 'empty' leaves them to the prior. */
  readonly fill: 'tile' | 'empty';
  /** Rank known progressions by melody fit alone, or by the full score (lambda * fit + log prior). */
  readonly knownRank: 'fit' | 'score';
}

// ---------------------------------------------------------------- melody -> per-slot pitch-class weights

function metricWeight(posInBar: number): number {
  const eps = 1e-6;
  if (Math.abs(posInBar) < eps) return 2.0;
  if (Math.abs(posInBar - 2) < eps) return 1.5;
  if (Math.abs(posInBar - Math.round(posInBar)) < eps) return 1.0;
  if (Math.abs(posInBar * 2 - Math.round(posInBar * 2)) < eps) return 0.6;
  return 0.4;
}

function isPassing(prev: MelodyNote | undefined, cur: MelodyNote, next: MelodyNote | undefined): boolean {
  if (!prev || !next || cur.duration > 0.5) return false;
  const pos = cur.beat % 4;
  if (Math.abs(pos) < 1e-6 || Math.abs(pos - 2) < 1e-6) return false;
  const a = cur.midi - prev.midi;
  const b = next.midi - cur.midi;
  const step = (x: number) => Math.abs(x) >= 1 && Math.abs(x) <= 2;
  return step(a) && step(b) && Math.sign(a) === Math.sign(b);
}

/** W[slot][pc] = how much melody weight of pitch class pc lies in that slot. Notes are absolute pitch classes. */
export function slotWeights(notes: readonly MelodyNote[], melodyBars: number, fp: FitParams, fill: 'tile' | 'empty'): number[][] {
  if (!(melodyBars >= 1 && melodyBars <= BARS)) throw new Error(`melodyBars must be 1..${BARS}, got ${melodyBars}`);
  const sorted = [...notes].sort((x, y) => x.beat - y.beat);
  const melSlots = melodyBars * SLOTS_PER_BAR;
  const W: number[][] = Array.from({ length: SLOTS }, () => new Array<number>(12).fill(0));
  sorted.forEach((n, i) => {
    if (n.duration <= 0) throw new Error(`note with non-positive duration at beat ${n.beat}`);
    const pc = ((n.midi % 12) + 12) % 12;
    const passing = isPassing(sorted[i - 1], n, sorted[i + 1]) ? fp.passingWeight : 1;
    const end = n.beat + n.duration;
    // Anticipation (pop syncopation): a note starting at most half a beat before a slot line and held at least half
    // a beat past it belongs to the chord after the line, so it is counted as if it started on the line.
    const line = Math.ceil(n.beat / SLOT_BEATS - 1e-9) * SLOT_BEATS;
    const anticipates = line - n.beat > 1e-9 && line - n.beat <= 0.5 + 1e-9 && end - line >= 0.5 - 1e-9 && line < melSlots * SLOT_BEATS;
    const onset = anticipates ? line : n.beat;
    for (let s = Math.max(0, Math.floor(onset / SLOT_BEATS + 1e-9)); s < melSlots; s++) {
      const t0 = s * SLOT_BEATS;
      const t1 = t0 + SLOT_BEATS;
      if (t0 >= end) break;
      const overlap = Math.min(end, t1) - Math.max(onset, t0);
      if (overlap <= 0) continue;
      const onsetHere = onset >= t0 - 1e-9;
      const m = onsetHere ? metricWeight(onset % 4) : fp.carryWeight;
      W[s]![pc]! += m * Math.min(overlap, 2) * passing;
    }
  });
  if (fill === 'tile') for (let s = melSlots; s < SLOTS; s++) W[s] = [...W[s % melSlots]!];
  return W;
}

export function fitScore(w: readonly number[], c: Chord, tonicPc: number, fp: FitParams): number {
  const pcs = chordPcs(c, tonicPc);
  let f = 0;
  for (let pc = 0; pc < 12; pc++) {
    const x = w[pc]!;
    if (x === 0) continue;
    f += pcs.has(pc) ? x : -fp.alpha * x;
  }
  return f + fp.rootBonus * w[(tonicPc + c.deg) % 12]!;
}

const totalWeight = (W: readonly (readonly number[])[]): number => W.reduce((a, r) => a + r.reduce((b, x) => b + x, 0), 0);

// ---------------------------------------------------------------- prior

export interface WeightedSequence {
  readonly slots: readonly string[];
  readonly weight: number;
}

/** Learn the prior from chord sequences (SLOTS chord ids each). Chords outside `vocab` break the chain there. */
export function trainPrior(seqs: readonly WeightedSequence[], vocab: readonly string[], smoothing = 1): { prior: Prior; oovSlots: number } {
  const N = vocab.length;
  const idx = new Map(vocab.map((v, i) => [v, i]));
  const uni = new Array<number>(N).fill(1); // add-one unigram, used to smooth the transition rows
  const init = new Array<number>(N).fill(0);
  const within = Array.from({ length: N }, () => new Array<number>(N).fill(0));
  const across = Array.from({ length: N }, () => new Array<number>(N).fill(0));
  let oovSlots = 0;
  for (const { slots, weight } of seqs) {
    if (slots.length !== SLOTS) throw new Error(`training sequence has ${slots.length} slots, expected ${SLOTS}`);
    const ix = slots.map((c) => idx.get(c));
    ix.forEach((i, s) => {
      if (i === undefined) { oovSlots++; return; }
      uni[i]! += weight;
      if (s === 0) init[i]! += weight;
      const p = s > 0 ? ix[s - 1] : undefined;
      if (p === undefined) return;
      (s % SLOTS_PER_BAR === 0 ? across : within)[p]![i]! += weight;
    });
  }
  const uTot = uni.reduce((a, b) => a + b, 0);
  const u = uni.map((x) => x / uTot);
  const norm = (row: number[]) => {
    const t = row.reduce((a, b) => a + b, 0);
    return row.map((x, j) => Math.log((x + smoothing * u[j]!) / (t + smoothing)));
  };
  return { prior: { vocab, init: norm(init), within: within.map(norm), across: across.map(norm) }, oovSlots };
}

export function sequenceLogPrior(prior: Prior, slots: readonly string[]): number | undefined {
  const idx = new Map(prior.vocab.map((v, i) => [v, i]));
  const ix = slots.map((c) => idx.get(c));
  if (ix.some((i) => i === undefined)) return undefined;
  let lp = prior.init[ix[0]!]!;
  for (let s = 1; s < ix.length; s++) lp += (s % SLOTS_PER_BAR === 0 ? prior.across : prior.within)[ix[s - 1]!]![ix[s]!]!;
  return lp;
}

// ---------------------------------------------------------------- Viterbi

export interface Candidate {
  readonly label: string;
  readonly slots: readonly string[];
  readonly fit: number;
  readonly score: number;
}

/** Best free sequence. `firstAllowed` restricts the chord of slot 0 (for the different-colour alternative). */
export function viterbi(W: readonly (readonly number[])[], tonicPc: number, prior: Prior, p: HarmonizeParams, firstAllowed?: (c: Chord) => boolean): Candidate {
  const V = prior.vocab.map(chordFromId);
  const N = V.length;
  const F = W.map((w) => V.map((c) => fitScore(w, c, tonicPc, p.fit)));
  let score = V.map((c, j) => (firstAllowed && !firstAllowed(c) ? -Infinity : prior.init[j]! + p.lambda * F[0]![j]!));
  if (!score.some(Number.isFinite)) throw new Error('viterbi: no chord in the vocabulary satisfies the first-chord constraint');
  const back: number[][] = [];
  for (let s = 1; s < SLOTS; s++) {
    const T = s % SLOTS_PER_BAR === 0 ? prior.across : prior.within;
    const next = new Array<number>(N);
    const bp = new Array<number>(N);
    for (let j = 0; j < N; j++) {
      let best = -Infinity;
      let arg = -1;
      for (let i = 0; i < N; i++) {
        const v = score[i]! + T[i]![j]!;
        if (v > best) { best = v; arg = i; }
      }
      next[j] = best + p.lambda * F[s]![j]!;
      bp[j] = arg;
    }
    back.push(bp);
    score = next;
  }
  let j = score.indexOf(Math.max(...score));
  const best = score[j]!;
  const path = [j];
  for (let s = SLOTS - 2; s >= 0; s--) { j = back[s]![j]!; path.unshift(j); }
  const slots = path.map((i) => prior.vocab[i]!);
  return { label: 'best free', slots, fit: path.reduce((a, i, s) => a + F[s]![i]!, 0), score: best };
}

export function sequenceFit(W: readonly (readonly number[])[], tonicPc: number, slots: readonly string[], fp: FitParams): number {
  return slots.reduce((a, id, s) => a + fitScore(W[s]!, chordFromId(id), tonicPc, fp), 0);
}

/** Known progressions ranked by melody fit (best first). */
export function rankKnown(W: readonly (readonly number[])[], tonicPc: number, known: readonly KnownProgression[], prior: Prior, p: HarmonizeParams): Candidate[] {
  return known
    .map((k) => {
      const fit = sequenceFit(W, tonicPc, k.slots, p.fit);
      const lp = sequenceLogPrior(prior, k.slots);
      if (lp === undefined) throw new Error(`known progression "${k.name}" uses a chord outside the prior's vocabulary`);
      return { label: `known: ${k.name}`, slots: k.slots, fit, score: p.lambda * fit + lp };
    })
    .sort((a, b) => (p.knownRank === 'fit' ? b.fit - a.fit || b.score - a.score : b.score - a.score));
}

// ---------------------------------------------------------------- alternatives

export interface Harmonization {
  /** Three different chord sequences; [0] is the recommendation. */
  readonly alternatives: readonly Candidate[];
  /** True when [0] is a known progression chosen over the free best. */
  readonly knownPreferred: boolean;
}

const sameSeq = (a: readonly string[], b: readonly string[]) => a.every((x, i) => x === b[i]);

/**
 * Three alternatives:
 *   1. the recommendation: the best known progression if its fit is within delta of the best free sequence,
 *      otherwise the best free sequence;
 *   2. the other one of those two (if identical, the next known progression);
 *   3. a different colour: the best free sequence that starts on vi (or, if one of the first two already starts on
 *      vi, on IV, then I, V, ii).
 */
export function harmonize(notes: readonly MelodyNote[], melodyBars: number, tonicPc: number, prior: Prior, known: readonly KnownProgression[], p: HarmonizeParams): Harmonization {
  if (known.length < 2) throw new Error('harmonize needs at least two known progressions');
  const W = slotWeights(notes, melodyBars, p.fit, p.fill);
  const free = viterbi(W, tonicPc, prior, p);
  const ranked = rankKnown(W, tonicPc, known, prior, p);
  const tot = totalWeight(W);
  const knownPreferred = free.fit - ranked[0]!.fit <= p.delta * tot;
  const first = knownPreferred ? ranked[0]! : free;
  let second: Candidate = knownPreferred ? free : ranked[0]!;
  if (sameSeq(first.slots, second.slots)) second = ranked.find((k) => !sameSeq(k.slots, first.slots))!;
  if (!second) throw new Error('harmonize: no second distinct alternative');
  const starts = [first.slots[0], second.slots[0]];
  const colourOrder: Chord[] = [{ deg: 9, q: 'min' }, { deg: 5, q: 'maj' }, { deg: 0, q: 'maj' }, { deg: 7, q: 'maj' }, { deg: 2, q: 'min' }];
  let third: Candidate | undefined;
  for (const c of colourOrder) {
    const id = chordId(c);
    if (starts.includes(id) || !prior.vocab.includes(id)) continue;
    const cand = viterbi(W, tonicPc, prior, p, (x) => chordId(x) === id);
    if (sameSeq(cand.slots, first.slots) || sameSeq(cand.slots, second.slots)) continue;
    third = { ...cand, label: `best free starting on ${c.deg === 9 ? 'vi' : c.deg === 5 ? 'IV' : c.deg === 0 ? 'I' : c.deg === 7 ? 'V' : 'ii'}` };
    break;
  }
  if (!third) throw new Error('harmonize: could not build a third distinct alternative');
  return { alternatives: [first, second, third], knownPreferred };
}
