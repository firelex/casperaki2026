// Casperaki-written algorithmic drum generators.
//
// These are not legacy ports: they are written to fill styles the legacy
// generators cover thinly, and each one starts life as a proposal in the
// pattern lab (data/patterns/proposals/). A generator here is only heard in
// real songs once its proposal is approved and exported, which wires it into
// bank-index.json as `{ "authoredAlgo": "<name>" }`.
//
// They use the legacy grid model (drums-algo.ts): two bars of 32 slots,
// 8 slots per beat, so a 16th note is 2 slots and a 32nd note is 1 slot.
// Every random choice comes from the caller's seeded Rng.

import type { Rng } from '@casperaki/music-theory';

import { addHit, gridToBlueprint, muteSlot, type Grid, type LibraryPick } from './drums-algo.js';
import type { DrumBlueprint } from './drums-bank.js';

export type AuthoredDrumGenerator = (rng: Rng, libraryPick: LibraryPick) => DrumBlueprint;

const BAR = 32;
const BEAT = 8;
const SIXTEENTH = 2;

/**
 * Trap-style hats for urban (60-100 BPM, so a trap beat sits at full time):
 * backbeat snare (often doubled by a clap), a sparse syncopated kick, and a
 * closed hi-hat line in 16ths broken up by 32nd-note rolls, with the odd
 * open hat. The roll placement is what makes each bar feel played.
 */
function trapHats(rng: Rng): DrumBlueprint {
  const grid: Grid = {};

  // Kick: one-bar figure, bar 2 varies its last hit to push into the next bar.
  const figure = rng.pick([
    [0, 12, 22], // 1, a-of-2, and-of-3 (in 16ths: 1, 2a, 3&)
    [0, 6, 20],
    [0, 14, 18, 28],
    [0, 10, 24 + 6],
  ]);
  for (const s of figure) addHit(grid, 'bassDrum1', s);
  const bar2 = figure.slice(0, -1).concat(rng.pick([figure[figure.length - 1]!, 26, 30]));
  for (const s of bar2) addHit(grid, 'bassDrum1', BAR + s);

  // Backbeat on 2 and 4, a clap layered on top most of the time.
  const layerClap = rng.next() < 0.7;
  for (const beat of [1, 3, 5, 7]) {
    addHit(grid, 'snareDrum1', beat * BEAT);
    if (layerClap) addHit(grid, 'clap', beat * BEAT);
  }

  // Closed hats: 8ths at low busyness, 16ths otherwise.
  const busyness = rng.int(1, 3);
  const step = busyness === 1 ? 2 * SIXTEENTH : SIXTEENTH;
  for (let s = 0; s < 2 * BAR; s += step) addHit(grid, 'hiHatClosed1', s);

  // 32nd-note rolls: half a beat of straight 32nds, placed off the downbeat.
  const rollStarts = busyness === 3 ? [rng.pick([12, 20, 28]), BAR + rng.pick([20, 28])] : [BAR + 28];
  for (const start of rollStarts) {
    for (let s = start; s < start + BEAT / 2; s++) addHit(grid, 'hiHatClosed1', s);
  }

  // An open hat on an off-beat 16th, replacing the closed hat there.
  if (rng.next() < 0.6) {
    const open = rng.pick([14, 30, BAR + 14]);
    muteSlot(grid, 'hiHatClosed1', open);
    addHit(grid, 'hiHatOpen', open);
  }

  return gridToBlueprint(grid);
}

/** Generators by name, referenced from proposals and (once approved) from
 *  bank-index.json `{ "authoredAlgo": "<name>" }`. */
export const AUTHORED_DRUM_ALGOS: Readonly<Record<string, AuthoredDrumGenerator>> = {
  trapHats,
};
