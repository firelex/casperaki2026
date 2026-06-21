// Algorithmic drum pattern generators — faithful port of the legacy
// `casperaki1/.../patterns/drumPatterns/*GeneratorClass.js` family
// (docs/58 sound-parity, "port legacy, no A/B").
//
// The legacy generators build a 64-slot grid (2 bars × 32 thirty-second
// notes, 8 slots per beat) of `'0'`/`'x'` strings via an `_addHit`
// collision helper (DrumPatternGeneratorBaseClass.js). We port that grid
// model verbatim, swap every `Math.random()` / `Tools.selectRandomly(...)`
// for a seeded `Rng` so the brain stays deterministic, then convert the
// finished grid to the rebuild's `DrumBlueprint` shape (lane → beat
// positions, where beat = slotIndex / 8). drums.ts loops that blueprint
// across each segment exactly as it does for the library banks.
//
// Coverage (legacy class → algo style name wired in bank-index.json):
//   EDMDrumPatternGeneratorClass      → "edm"      (edm + schlager genres)
//   UrbanDrumPatternGeneratorClass    → "urban"
//   LatinDrumPatternGeneratorClass    → "latin"
//   PopRockDrumPatternGeneratorClass  → "ballad" / "popLoose" / "popTight"
//
// PopRock's `drLuke` / `rockPattern` methods delegate to a LIBRARY bank;
// the caller supplies a `libraryPick` callback (drums-bank.ts) so those
// methods resolve to a real drLuke / rock blueprint, mirroring the legacy
// `require('./data/drLukePatterns.json')` branch.

import type { Rng } from '@casperaki/music-theory';

import type { DrumBlueprint } from './drums-bank.js';

const PATTERN_LENGTH = 64;
const SLOTS_PER_BEAT = 8;

/** Picks a blueprint from a LIBRARY style bank (drLuke / rock). */
export type LibraryPick = (styleName: string) => DrumBlueprint;

// ---- base grid helpers (DrumPatternGeneratorBaseClass.js) ----

type Grid = Record<string, string>;

function blankLane(): string {
  return '0'.repeat(PATTERN_LENGTH);
}

/**
 * Port of `_addHit`. Sets slot `hit` of `drum` to 'x'. Returns false (and
 * leaves the grid untouched) if the slot is already played, or if any
 * `related` drum plays on/around the slot. Returns true on a fresh hit.
 *
 * The legacy `_addHit` returned `undefined` on success and `false` on a
 * blocked hit; every caller only tests `=== false`, so a boolean is an
 * exact behavioural match (and the `while (!addHit(...))` retry loops read
 * naturally).
 */
function addHit(
  grid: Grid,
  drum: string,
  hit: number,
  related: readonly string[] = [],
): boolean {
  if (hit < 0 || hit >= PATTERN_LENGTH) return false;
  let lane = grid[drum];
  if (lane === undefined) lane = blankLane();
  if (lane[hit] === 'x') return false;
  for (const r of related) {
    const rs = grid[r];
    if (rs === undefined) continue;
    // Legacy clamps the look-ahead to slot 31 (a 1-bar window), not 63.
    if (
      rs[hit] === 'x' ||
      rs[Math.max(0, hit - 1)] === 'x' ||
      rs[Math.min(31, hit + 1)] === 'x'
    ) {
      return false;
    }
  }
  grid[drum] = lane.substring(0, hit) + 'x' + lane.substring(hit + 1);
  return true;
}

/** Mutes a single slot (legacy roll logic overwrites hiHatClosed1 with '0'). */
function muteSlot(grid: Grid, drum: string, slot: number): void {
  const lane = grid[drum];
  if (lane === undefined || slot < 0 || slot >= lane.length) return;
  grid[drum] = lane.substring(0, slot) + '0' + lane.substring(slot + 1);
}

/** Copies bar 1 (slots 0-31) over bar 2 — legacy `s.substring(0,32)*2`. */
function duplicateFirstBar(grid: Grid, drum: string): void {
  const lane = grid[drum];
  if (lane === undefined) return;
  grid[drum] = lane.substring(0, 32) + lane.substring(0, 32);
}

/** Convert the finished grid to lane → beat positions, dropping empties. */
function gridToBlueprint(grid: Grid): DrumBlueprint {
  const blueprint: Record<string, number[]> = {};
  for (const [lane, value] of Object.entries(grid)) {
    const positions: number[] = [];
    for (let i = 0; i < value.length; i++) {
      if (value[i] === 'x') positions.push(i / SLOTS_PER_BEAT);
    }
    if (positions.length > 0) blueprint[lane] = positions;
  }
  return blueprint;
}

// ---- EDM (EDMDrumPatternGeneratorClass.js) ----

function edmBassDrum(grid: Grid, offset = 0): void {
  for (const item of [0, 1, 2, 3]) addHit(grid, 'bassDrum1', offset * 32 + item * 8);
}

function edmSnareDrum(grid: Grid, offset = 0): void {
  for (const item of [1, 3]) addHit(grid, 'snareDrum1', offset * 32 + item * 8);
}

function edmClap(grid: Grid, offset = 0): void {
  for (const item of [3]) addHit(grid, 'clap', offset * 32 + item * 8);
}

function edmHiHatClosed(rng: Rng, grid: Grid, busyness: number, offset = 0): void {
  let blueprint: number[];
  if (busyness === 1) {
    blueprint = rng.pick([
      [0, 1, 2, 3],
      [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5],
    ]);
  } else {
    blueprint = [0.5, 1, 1.5, 2, 2.5, 3, 3.5];
  }
  const drum = rng.pick(['hiHatClosed1']);
  for (const item of blueprint) addHit(grid, drum, offset * 32 + item * 8);

  const hiHatOpen = rng.pick(['hiHatOpen']);
  for (const item of [0.5, 1.5, 2.5, 3.5]) addHit(grid, hiHatOpen, offset * 32 + item * 8);

  if (busyness === 2 || busyness === 3) {
    // Legacy keeps numberOfRolls at 0 for EDM; only doubles are added.
    const numberOfDoubles =
      busyness === 2 ? rng.pick([0, 4]) : rng.pick([5, 9]);
    const used: number[] = [];
    for (let i = 0; i < numberOfDoubles; i++) {
      let double: number;
      do {
        double = (rng.int(0, 14) * 2 + 1) * 2;
      } while (used.includes(double));
      used.push(double);
      addHit(grid, drum, double);
    }
  }
}

function edmPercussion(
  rng: Rng,
  grid: Grid,
  drum: string,
  style: string,
  busyness: number,
  offset = 0,
): void {
  let blueprint: number[];
  if (style === 'straight') {
    blueprint =
      busyness === 1
        ? rng.pick([
            [0.5, 2.5],
            [1.5, 3.5],
          ])
        : rng.pick([[0.5, 1.5, 2.5, 3.5]]);
  } else {
    if (busyness === 1) {
      blueprint = rng.pick([
        [0.25],
        [0.75],
        [1.25],
        [1.75],
        [2.25],
        [2.75],
        [3.25],
        [3.75],
      ]);
    } else {
      blueprint = [...rng.pick([[0.25], [1.25], [2.25], [3.25]])];
      blueprint.push(rng.pick([0.75, 1.75, 2.75, 3.75]));
      blueprint.sort((a, b) => a - b);
    }
  }
  for (const item of blueprint) addHit(grid, drum, offset * 32 + item * 8);
}

function generateEdm(rng: Rng, busyness: number): DrumBlueprint {
  const grid: Grid = {};
  if (busyness === 1) {
    const drum = rng.pick(['bassDrum1', 'hiHatClosed1']);
    if (drum === 'bassDrum1') edmBassDrum(grid);
    else edmHiHatClosed(rng, grid, busyness);
  } else {
    edmBassDrum(grid);
    edmHiHatClosed(rng, grid, busyness);
    if (busyness === 3) {
      edmSnareDrum(grid);
      if (rng.pick([false, true])) edmClap(grid);
    }
    const drum = rng.pick(['shaker']);
    const style = rng.pick(['straight', 'syncopated']);
    edmPercussion(rng, grid, drum, style, busyness);
  }
  // Legacy duplicates bar 1 onto bar 2 for every lane (drops bar-2 doubles).
  for (const lane of Object.keys(grid)) duplicateFirstBar(grid, lane);
  return gridToBlueprint(grid);
}

// ---- Urban (UrbanDrumPatternGeneratorClass.js) ----

function generateUrban(rng: Rng, busyness: number): DrumBlueprint {
  const grid: Grid = {};
  let numberOfAnchorHits = 0;

  for (const drum of ['bassDrum1', 'bassDrum2', 'snareDrum1', 'hiHatClosed1']) {
    if (drum === 'bassDrum1') {
      const numberOfHits = rng.pick([3, 4]);
      for (let i = 0; i < numberOfHits; i++) {
        if (i === 0) {
          addHit(grid, drum, 0);
        } else if (i % 2 === 0) {
          while (!addHit(grid, drum, (rng.int(0, 5) + 1) * 4)) {
            /* retry until a fresh first-half slot lands */
          }
        } else {
          while (!addHit(grid, drum, 16 + rng.int(0, 6) * 4)) {
            /* retry until a fresh second-half slot lands */
          }
        }
      }
      if (rng.pick([false, true])) {
        for (;;) {
          const randomHit = rng.int(0, 31) * 2;
          if (randomHit > 0 && grid[drum]?.[randomHit] === 'x') {
            addHit(grid, drum, randomHit - 1);
            break;
          }
        }
      }
      numberOfAnchorHits = numberOfHits;
    } else if (drum === 'bassDrum2') {
      const related = ['bassDrum1'];
      // Legacy reads `this.busyness` (always undefined) here → default branch.
      const numberOfHits = rng.pick([5, 6]) - numberOfAnchorHits;
      for (let i = 0; i < numberOfHits; i++) {
        while (!addHit(grid, drum, rng.int(0, 31) * 2, related)) {
          /* retry until a non-colliding slot lands */
        }
      }
    } else if (drum === 'snareDrum1') {
      const blueprint = rng.pick([
        [1, 3, 5, 7],
        [1, 2.75, 5, 7],
        [1, 3, 5, 6.75],
        [1, 2.75, 5, 6.75],
      ]);
      for (const item of blueprint) addHit(grid, 'snareDrum1', item * 8);
      const clapMode = rng.pick(['noClap', 'clapOnEverySnare', 'clapOnEveryOtherSnare']);
      if (clapMode === 'clapOnEverySnare') {
        for (const item of blueprint) addHit(grid, 'clap', item * 8);
      } else if (clapMode === 'clapOnEveryOtherSnare') {
        let i = 0;
        for (const item of blueprint) {
          if (i % 2 !== 0) addHit(grid, 'clap', item * 8);
          i++;
        }
      }
    } else {
      // hiHatClosed1
      const numberOfBasicHits = busyness === 1 ? rng.pick([4, 8]) : 8;
      const used: number[] = [];
      if (numberOfBasicHits === 4) {
        for (let i = 0; i < 8; i++) addHit(grid, drum, i * 8);
        const numberOfDoubles = rng.pick([0, 3]);
        for (let i = 0; i < numberOfDoubles; i++) {
          let double: number;
          do {
            double = (rng.int(0, 14) * 2 + 1) * 2;
          } while (used.includes(double));
          used.push(double);
          addHit(grid, drum, double);
        }
      } else {
        for (let i = 0; i < 16; i++) addHit(grid, drum, i * 4);
        let numberOfRolls: number;
        let numberOfDoubles: number;
        if (busyness === 1) {
          numberOfRolls = 0;
          numberOfDoubles = rng.pick([4, 7]);
        } else if (busyness === 2) {
          numberOfRolls = rng.pick([0, 1]);
          numberOfDoubles = rng.pick([6, 9]) - numberOfRolls;
        } else {
          numberOfRolls = rng.pick([1, 2]);
          numberOfDoubles = rng.pick([6, 9]) - numberOfRolls;
        }
        for (let i = 0; i < numberOfRolls; i++) {
          let rollStart: number;
          do {
            rollStart = rng.int(0, 6) * 8;
          } while (
            used.includes(rollStart) ||
            (rollStart > 0 && used.includes(rollStart - 8)) ||
            (rollStart < 56 && used.includes(rollStart + 8))
          );
          for (let j = 0; j < 8; j++) {
            addHit(grid, 'hiHatClosed2', rollStart + j);
            muteSlot(grid, 'hiHatClosed1', rollStart + j);
            used.push(rollStart + j);
          }
        }
        for (let i = 0; i < numberOfDoubles; i++) {
          let double: number;
          do {
            double = (rng.int(0, 14) * 2 + 1) * 2;
          } while (used.includes(double));
          used.push(double);
          addHit(grid, drum, double);
        }
      }
    }
  }

  return gridToBlueprint(grid);
}

// ---- Latin (LatinDrumPatternGeneratorClass.js) ----

function generateLatin(rng: Rng, busyness: number): DrumBlueprint {
  const grid: Grid = {};

  // Bass drum (one blueprint today; kept as a pick for fidelity).
  for (const item of rng.pick([[0, 1.5, 2, 3.5, 4, 5.5, 6, 7.5]])) {
    addHit(grid, 'bassDrum1', item * 4);
    addHit(grid, 'bassDrum1', 32 + item * 4);
  }

  const latinDrumPatterns = [
    [0, 1, 2.5, 3.5, 4.5, 6, 7], // Partido alto (samba, bossa nova)
    [0, 1.5, 3, 5, 6], // Son clave (salsa, mambo)
    [0, 1.5, 3.5, 5, 6], // Rumba clave (rumba)
    [0, 1.5, 3, 3.5, 5, 6, 7.5], // Standard bell
    [0.5, 2, 3, 4, 5, 6.5, 7.5], // Reverse partido alto
    [1, 2, 4, 5.5, 7], // Reverse son clave
    [1, 2, 4, 5.5, 7.5], // Reverse rumba clave
    [1, 2, 3.5, 4, 5.5, 7, 7.5], // Reverse standard bell
  ];

  let latinDrums: string[];
  if (busyness === 1) {
    latinDrums = rng.pick([
      ['snareDrum1'],
      ['snareDrum1', 'snareDrum2'],
      ['snareDrum1', 'clap'],
    ]);
  } else if (busyness === 2) {
    latinDrums = rng.pick([
      ['snareDrum1', 'snareDrum2'],
      ['snareDrum1', 'clap'],
      ['snareDrum1', 'snareDrum2', 'clap'],
    ]);
  } else {
    latinDrums = ['snareDrum1', 'snareDrum2', 'clap', 'hiHatClosed1', 'hiHatClosed2', 'shaker'];
  }

  const dictionary: Record<number, string> = {};
  for (const item of rng.pick(latinDrumPatterns)) {
    if (dictionary[item] === undefined) dictionary[item] = rng.pick(latinDrums);
    addHit(grid, dictionary[item]!, item * 4);
    addHit(grid, dictionary[item]!, 32 + item * 4);
  }

  if (busyness === 2 || busyness === 3) {
    for (const item of [0, 1, 2, 3, 4, 5, 6, 7]) {
      addHit(grid, 'ride', item * 4);
      addHit(grid, 'ride', 32 + item * 4);
    }
  }

  return gridToBlueprint(grid);
}

// ---- PopRock (PopRockDrumPatternGeneratorClass.js) ----

function prBassDrum(
  rng: Rng,
  grid: Grid,
  method: string,
  busyness: number,
  offset = 0,
): void {
  let blueprint: number[];
  if (method === 'algoTight') {
    const patterns = [
      [0, 1, 2, 3],
      [0, 1.5],
      [0, 1.5, 2],
      [0, 1.5, 2, 3.5],
      [0, 1.5, 2, 3.75],
      [0, 2],
      [0, 2, 2.5],
      [0, 2, 3.5],
      [0, 2, 3.75],
    ];
    let filtered: number[][];
    if (busyness === 1) filtered = patterns.filter((e) => e.length === 2);
    else if (busyness === 2) filtered = patterns.filter((e) => e.length === 2 || e.length === 3);
    else filtered = patterns.filter((e) => e.length === 3 || e.length === 4);
    blueprint = rng.pick(filtered.length > 0 ? filtered : patterns);
  } else {
    // algoLoose bass-drum pools — beat-0 is always present (legacy
    // PopRockDrumPatternGeneratorClass.js:64-69). An earlier port dropped the
    // leading 0 from three of the four pools; restored here for parity.
    blueprint = rng.pick([
      [0, 1.5, 3],
      [0, 0.5, 3],
      [0, 1, 2.5],
      [0, 1.5, 3],
    ]);
  }
  for (const item of blueprint) addHit(grid, 'bassDrum1', offset * 32 + item * 8);
}

function prSnareDrum(
  rng: Rng,
  grid: Grid,
  method: string,
  busyness: number,
  isBalladGenre: boolean,
  offset = 0,
): void {
  let blueprint: number[];
  if (method === 'algoTight') {
    const patterns = [
      [0.5, 3],
      [0.5, 1.5, 3],
      [1, 3],
      [1, 3],
      [1, 3],
    ];
    let filtered: number[][];
    if (busyness === 1) filtered = patterns.filter((e) => e.length === 2);
    else if (busyness === 2) filtered = patterns.filter((e) => e.length === 2);
    else filtered = patterns.filter((e) => e.length === 2 || e.length === 3);
    blueprint = rng.pick(filtered.length > 0 ? filtered : patterns);
  } else {
    blueprint = rng.pick([
      [0.5, 2.5],
      [1, 3],
    ]);
  }
  for (const item of blueprint) addHit(grid, 'snareDrum1', offset * 32 + item * 8);

  if (method === 'algoTight') {
    if (!isBalladGenre && blueprint.includes(3)) {
      addHit(grid, 'clap', offset * 32 + 3 * 8);
    }
  } else if (!isBalladGenre) {
    if (rng.pick([false, true])) {
      addHit(grid, 'clap', offset * 32 + rng.pick([0.25, 0.5, 0.75, 1.25, 1.5, 1.75]) * 8);
      addHit(grid, 'clap', offset * 32 + rng.pick([2.25, 2.5, 2.75, 3.25, 3.5, 3.75]) * 8);
    }
  }
}

function prHiHatClosed(rng: Rng, grid: Grid, busyness: number, offset = 0): void {
  const patterns = [
    [0, 0.25, 0.5, 1, 1.5, 2, 2.5, 3, 3.5],
    [0, 0.25, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 3.75],
    [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5],
    [0, 0.5, 1, 1.5, 1.75, 2, 2.5, 3, 3.5],
    [0, 0.5, 1, 1.5, 1.75, 2, 2.25, 2.5, 3, 3.5],
    [0, 0.5, 1, 1.5, 1.75, 2, 2.25, 2.5, 3, 3.5, 3.75],
    [0, 0.5, 1, 1.5, 1.75, 2, 2.5, 3, 3.25, 3.5, 3.75],
    [0, 0.5, 1, 1.5, 1.75, 2, 2.5, 3, 3.5, 3.75],
    [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 3.75],
    [0, 1, 2, 3],
    [0.5, 1.5, 2.5, 3.5],
    [0.5, 1.5, 2.5, 3.5, 3.75],
  ];
  let filtered: number[][];
  if (busyness === 1) filtered = patterns.filter((e) => e.length <= 8);
  else if (busyness === 2) filtered = patterns.filter((e) => e.length >= 9 && e.length <= 10);
  else filtered = patterns.filter((e) => e.length >= 11);
  const blueprint = rng.pick(filtered.length > 0 ? filtered : patterns);
  for (const item of blueprint) addHit(grid, 'hiHatClosed1', offset * 32 + item * 8);
}

function prRide(rng: Rng, grid: Grid, busyness: number, offset = 0): void {
  const patterns = [
    [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5],
    [0, 1, 2, 3],
  ];
  let blueprint: number[] | undefined;
  if (busyness === 1) {
    blueprint = undefined;
  } else if (busyness === 2) {
    // Legacy evaluates selectRandomly([0,4]) per-element inside .filter.
    const filtered = patterns.filter((e) => e.length <= rng.pick([0, 4]));
    blueprint = filtered.length > 0 ? rng.pick(filtered) : undefined;
  } else {
    const filtered = patterns.filter((e) => e.length <= rng.pick([4, 8]));
    blueprint = filtered.length > 0 ? rng.pick(filtered) : undefined;
  }
  if (blueprint !== undefined) {
    for (const item of blueprint) addHit(grid, 'ride', offset * 32 + item * 8);
  }
}

function generatePopRock(
  rng: Rng,
  style: string,
  busyness: number,
  isBalladGenre: boolean,
  libraryPick: LibraryPick,
): DrumBlueprint {
  let method: string;
  if (style === 'rock') method = rng.pick(['algoTight', 'rockPattern']);
  else if (style === 'ballad') method = rng.pick(['algoTight', 'algoLoose']);
  else if (style === 'popTight') method = rng.pick(['algoTight', 'drLuke']);
  else if (style === 'popLoose') method = 'algoLoose';
  else method = 'algoTight';

  if (method === 'drLuke') return libraryPick('drLuke');
  if (method === 'rockPattern') return libraryPick('rock');

  const grid: Grid = {};
  prBassDrum(rng, grid, method, busyness, 0);
  prSnareDrum(rng, grid, method, busyness, isBalladGenre, 0);
  prHiHatClosed(rng, grid, busyness, 0);
  prRide(rng, grid, busyness, 0);

  switch (rng.pick(['bassDrum1', 'snareDrum1', 'hiHatClosed1'])) {
    case 'bassDrum1':
      prBassDrum(rng, grid, method, busyness, 1);
      duplicateFirstBar(grid, 'snareDrum1');
      if (grid['clap'] !== undefined) duplicateFirstBar(grid, 'clap');
      duplicateFirstBar(grid, 'hiHatClosed1');
      if (grid['ride'] !== undefined) duplicateFirstBar(grid, 'ride');
      break;
    case 'snareDrum1':
      prSnareDrum(rng, grid, method, busyness, isBalladGenre, 1);
      duplicateFirstBar(grid, 'bassDrum1');
      duplicateFirstBar(grid, 'hiHatClosed1');
      if (grid['ride'] !== undefined) duplicateFirstBar(grid, 'ride');
      break;
    default:
      // hiHatClosed1 — legacy re-runs bass at offset 0 (collisions ignored).
      prBassDrum(rng, grid, method, busyness, 0);
      prHiHatClosed(rng, grid, busyness, 1);
      duplicateFirstBar(grid, 'bassDrum1');
      duplicateFirstBar(grid, 'snareDrum1');
      if (grid['clap'] !== undefined) duplicateFirstBar(grid, 'clap');
      if (grid['ride'] !== undefined) duplicateFirstBar(grid, 'ride');
      break;
  }

  return gridToBlueprint(grid);
}

// ---- public dispatcher ----

/** Algo style names the bank manifest may reference via `{ "algo": ... }`. */
export const ALGO_STYLE_NAMES = [
  'edm',
  'urban',
  'latin',
  'ballad',
  'popLoose',
  'popTight',
] as const;

export type AlgoStyleName = (typeof ALGO_STYLE_NAMES)[number];

export function isAlgoStyleName(name: string): name is AlgoStyleName {
  return (ALGO_STYLE_NAMES as readonly string[]).includes(name);
}

/**
 * Generate one algorithmic drum blueprint. `busyness` (legacy 1-3) is
 * rolled per call, mirroring the legacy arrangement layer's per-segment
 * `selectRandomly(['1','2','3'])` (ballad genre forced to 1 in getPattern).
 */
export function generateAlgoBlueprint(
  rng: Rng,
  algoName: AlgoStyleName,
  libraryPick: LibraryPick,
): DrumBlueprint {
  switch (algoName) {
    case 'edm':
      return generateEdm(rng, rng.int(1, 3));
    case 'urban':
      return generateUrban(rng, rng.int(1, 3));
    case 'latin':
      return generateLatin(rng, rng.int(1, 3));
    case 'ballad': {
      // Legacy `config.drumPatterns.ballad` = [popTight, popLoose];
      // busyness forced to 1; genre flag 'ballad' suppresses claps.
      const subStyle = rng.pick(['popTight', 'popLoose']);
      return generatePopRock(rng, subStyle, 1, true, libraryPick);
    }
    case 'popLoose':
      return generatePopRock(rng, 'popLoose', rng.int(1, 3), false, libraryPick);
    case 'popTight':
      return generatePopRock(rng, 'popTight', rng.int(1, 3), false, libraryPick);
  }
}
