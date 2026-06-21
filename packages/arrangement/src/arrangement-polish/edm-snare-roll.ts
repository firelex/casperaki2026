// EDM snare-drum roll pattern — verbatim port of casperaki2's
// `EDMSnareDrumRollGeneratorClass.createDrumPattern`
// (api/v1.0/services/classes/patterns/drumPatterns/EDMSnareDrumRollGeneratorClass.js).
//
// The brain emits the `edmSnareDrumRoll` transition tag for anchor segments
// (rules.json: verse/preChorus endBrightPopExtra + bridge endAnyGenre). That
// tag is a `TransitionPattern` (not a sample): the actual snare-roll step grid
// is a per-song random decision, so it belongs in the brain with a forked Rng.
// The engine-adapter then pairs the grid with two `snareDrumsElectronic`
// samples and lowers it to the engine's `TransitionPattern.h` clip.
//
// Legacy length model: `parameters.lengthInBars` arrives as
// `Math.min(segmentLengthInBars, 4)` (TransitionsClass.js:316). The roll itself
// is `rollBars ∈ {1,2,2,4,4,4}` (filtered ≤ capped length); the grid is padded
// with leading empty bars so its total length always equals the capped length,
// i.e. the roll is right-aligned at the end of the segment.

import type { Rng } from '@casperaki/music-theory';

/** One bar of silence in the legacy grid format (32 steps, space-grouped per
 *  quarter, trailing bar separator). The engine strips every char except
 *  `0`/`x`, so the spaces / `|` are cosmetic — kept for byte-parity with the
 *  legacy strings and so `muteLastQuarterNote`'s substring math lines up. */
const EMPTY_BAR = '00000000 00000000 00000000 00000000|';

// Legacy `blueprints`, keyed by roll length in bars.
const BLUEPRINTS: Readonly<Record<number, readonly string[]>> = {
  1: ['x0x0x0x0 x0x0x0x0 xxxxxxxx xxxxxxxx'],
  2: ['x000x000 x000x000 x000x000 x000x000|x0x0x0x0 x0x0x0x0 xxxxxxxx xxxxxxxx'],
  4: [
    'x0000000 00000000 x0000000 00000000|x0000000 x0000000 x0000000 x0000000|x000x000 x000x000 x000x000 x000x000|x0x0x0x0 x0x0x0x0 xxxxxxxx xxxxxxxx',
    'x0000000 x0000000 x0000000 x0000000|x0000000 x0000000 x0000000 x0000000|x000x000 x000x000 x000x000 x000x000|x0x0x0x0 x0x0x0x0 xxxxxxxx xxxxxxxx',
  ],
};

// Legacy `auxiliaryBlueprints` (the optional `snareDrum2` channel).
const AUX_BLUEPRINTS: Readonly<Record<number, readonly string[]>> = {
  1: ['x00x00x0 x00x00x0 x00x00x0 x00x00x0'],
  2: ['x00x00x0 x00x00x0 x00x00x0 x00x00x0|x00x00x0 x00x00x0 x00x00x0 x00x00x0'],
  4: [
    'x00x00x0 x00x00x0 x00x00x0 x00x00x0|x00x00x0 x00x00x0 x00x00x0 x00x00x0|x00x00x0 x00x00x0 x00x00x0 x00x00x0|x00x00x0 x00x00x0 x00x00x0 x00x00x0',
  ],
};

// Legacy roll-length pool — biased toward 2 and 4 bars.
const ROLL_LENGTH_POOL: readonly number[] = [1, 2, 2, 4, 4, 4];

export interface EdmSnareRollPattern {
  /** channel name → step grid (legacy `pattern` object; the engine reads its
   *  keys in order as step-clip channels, mapped to the inst's `samples`). */
  readonly pattern: Readonly<Record<string, string>>;
  /** Total grid length in bars (= capped segment length). Matches the
   *  `barsCount` the engine derives from the grid and the `config.lengthInBars`
   *  it carries. */
  readonly lengthInBars: number;
}

/** Replace the final quarter-note (last 8 grid steps) with silence. Operates
 *  on the raw legacy string: each quarter is an 8-char group, so the trailing
 *  8 chars are exactly the last quarter regardless of the cosmetic spaces. */
function muteLastQuarterNote(grid: string): string {
  return grid.substring(0, grid.length - 8) + '00000000';
}

/**
 * Build an EDM snare-roll step grid. Pure: all randomness comes from `rng`.
 *
 * @param rng        caller-forked stream (see `generateTransitions`).
 * @param cappedBars `Math.min(segmentLengthInBars, 4)` — the grid's total
 *                   length in bars. Must be ≥ 1.
 */
export function buildEdmSnareRollPattern(rng: Rng, cappedBars: number): EdmSnareRollPattern {
  const lengthInBars = Math.max(1, Math.floor(cappedBars));

  // Roll length: legacy filters the pool to entries ≤ the capped length, so a
  // 1-bar segment always rolls 1 bar, a 2-bar segment rolls 1 or 2, etc.
  const rollBars = rng.pick(ROLL_LENGTH_POOL.filter((e) => e <= lengthInBars));
  const padding = EMPTY_BAR.repeat(lengthInBars - rollBars);

  const muteLast = rng.pick([false, true]);

  const pattern: Record<string, string> = {};

  let snareDrum1 = padding + rng.pick(BLUEPRINTS[rollBars]!);
  if (muteLast) snareDrum1 = muteLastQuarterNote(snareDrum1);
  pattern['snareDrum1'] = snareDrum1;

  // Optional auxiliary channel — legacy `selectRandomly([false, true, true])`
  // (2/3 chance). Drawn AFTER snareDrum1 to preserve the legacy rng order.
  if (rng.pick([false, true, true])) {
    let snareDrum2 = padding + rng.pick(AUX_BLUEPRINTS[rollBars]!);
    if (muteLast) snareDrum2 = muteLastQuarterNote(snareDrum2);
    pattern['snareDrum2'] = snareDrum2;
  }

  return { pattern, lengthInBars };
}
