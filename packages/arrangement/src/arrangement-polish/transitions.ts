// Per-segment transitions — legacy `transitions.js` rule port.
//
// The brain-port emits a `TransitionEntry` per legacy transition tag
// (e.g. `cymbalsCrashHit`, `fxReverse`, `percussionBreaksFills`). The
// schema's TransitionEntrySchema is `z.unknown()` today so the exact shape
// is flexible — we use:
//
//   arrangement[seg].transitions[`<tag>`] = {
//     type: <tag>,
//     placement: 'beginningOfSegment' | 'endOfSegment' | 'midSegment',
//     // edmSnareDrumRoll only — the generated snare-roll step grid + its
//     // length in bars, consumed by the engine-adapter TransitionPattern path:
//     pattern?: { snareDrum1: '<grid>', snareDrum2?: '<grid>' },
//     lengthInBars?: number,
//   };
//
// The legacy renderer / `TransitionsClass.getTransition` post-processes
// these tags into per-segment sample placements; that lowering is engine-
// bridge work (see docs/53k engine-bridge inventory). For the brain port
// we stop at recording the legacy tag + placement so future adapters can
// pick them up.

import type { SongStructure, TransitionEntry } from '@casperaki/song-schema';

import type { GeneratorContext } from '../context.js';
import type { Rng } from '@casperaki/music-theory';
import {
  loadArrangementRules,
  type TransitionSegmentRule,
} from './data.js';
import { buildEdmSnareRollPattern } from './edm-snare-roll.js';
import type { DrumOverrideDecision } from './overrides.js';
import { isTransitionAnchorSegment, segmentType } from './segment-type.js';

// docs/54n — `edmSnareDrumRoll` is a `TransitionPattern`: its snare-roll step
// grid is generated here (a per-song random decision) and carried on the
// transition entry for the engine-adapter to pair with two snare samples.
const EDM_SNARE_DRUM_ROLL = 'edmSnareDrumRoll';
// Legacy caps the roll grid at the segment length OR 4 bars, whichever is
// smaller (TransitionsClass.js:316).
const EDM_SNARE_ROLL_MAX_BARS = 4;

type TransitionPlacement = 'beginningOfSegment' | 'midSegment' | 'endOfSegment';

interface TransitionPick {
  readonly type: string;
  readonly placement: TransitionPlacement;
}

export interface ArrangementTransitions {
  /** segment name → tag → entry */
  readonly bySegment: Readonly<Record<string, Readonly<Record<string, TransitionEntry>>>>;
}

// docs/62 B2 — the legacy `transitions.js` gates the EDM-flavoured extras
// (percussionBreaks fills/buildups, edmSnareDrumRoll, fxDownlifter/fxTransition)
// on FOUR genres, not brightPop alone (c2 transitions.js:98/120/130/151/196/225).
// The chorus `cymbalsCrashHit` has a WIDER gate that also includes rock
// (c2 transitions.js:190). The rule-key names (`brightPopExtra*`) predate this
// fix and are kept for data stability; the flags below carry the real gates.
const EDM_TRANSITION_GENRES = new Set(['edm', 'latin', 'brightPop', 'schlager']);
const CHORUS_CRASH_GENRES = new Set(['edm', 'latin', 'brightPop', 'rock', 'schlager']);
// docs/62 B4a — fxNoiseRise is injected before every chorus for these genres
// (legacy transitions.js:257; c1 literal set {edm,latin,popTight,popLoose,rock,
// schlager} → rebuild tokens, popLoose→organicVibes).
const NOISE_RISE_GENRES = new Set([
  'edm', 'latin', 'brightPop', 'organicVibes', 'rock', 'schlager',
]);
// docs/62 B13 — EDM percussion fill/buildup tags (c2 rename of c1 fxEdmFills /
// fxEdmBuildups). Decided in code (the preChorus buildup/fill split is a coin,
// not a static byNext map).
const PERCUSSION_FILLS = 'percussionBreaksFills';
const PERCUSSION_BUILDUPS = 'percussionBreaksBuildups';
const FX_NOISE_RISE = 'fxNoiseRise';
const FX_REVERSE = 'fxReverse';
const CYMBALS_CRASH_HIT = 'cymbalsCrashHit';

export function generateTransitions(
  ctx: GeneratorContext,
  structure: SongStructure,
  /** docs/62 B13 — per-segment Drums override; gates the EDM fill/buildup. */
  drumDecisions: Record<string, DrumOverrideDecision> = {},
): ArrangementTransitions {
  const rules = loadArrangementRules();
  const rng = ctx.rng.fork('transitions');
  // Snare-roll grids are generated on a separate, per-segment-forked stream so
  // adding them never perturbs the transition-selection draws above.
  const rollRng = ctx.rng.fork('edmSnareDrumRoll');
  const genre = ctx.params.genre;
  const useEdmExtras = EDM_TRANSITION_GENRES.has(genre);
  const useChorusCrash = CHORUS_CRASH_GENRES.has(genre);

  const bySegment: Record<string, Record<string, TransitionEntry>> = {};

  for (let i = 0; i < structure.length; i++) {
    const segment = structure[i]!;
    if (!isTransitionAnchorSegment(segment.name)) continue;

    const type = segmentType(segment.name);
    const rule = rules.transitions[type];
    if (!rule) continue;

    const picks = pickTransitionsForSegment(rng, type, rule, {
      useEdmExtras,
      useChorusCrash,
      segName: segment.name,
      drumDecisions,
    });
    if (picks.length === 0) continue;

    const block: Record<string, TransitionEntry> = {};
    for (const pick of picks) {
      block[pick.type] = materializeEntry(pick, segment, rollRng);
    }
    bySegment[segment.name] = block;
  }

  // docs/62 B4 — cross-segment post-passes (legacy transitions.js:254-315).
  // Both are deterministic (zero RNG draws). Lowering reads bySegment per
  // segment name with no inheritance, so writing into non-anchor segments is
  // safe and matches the legacy per-segment injection.
  injectNoiseRiseBeforeChorus(structure, genre, bySegment);
  injectCrashAfterFxReverse(structure, bySegment);

  return { bySegment };
}

/** Build the stored entry for a pick, generating the snare-roll grid for the
 *  `edmSnareDrumRoll` tag (its own per-segment fork). */
function materializeEntry(
  pick: TransitionPick,
  segment: { name: string; bars: readonly unknown[] },
  rollRng: Rng,
): TransitionEntry {
  const entry: Record<string, unknown> = { type: pick.type, placement: pick.placement };
  if (pick.type === EDM_SNARE_DRUM_ROLL) {
    const cappedBars = Math.min(segment.bars.length, EDM_SNARE_ROLL_MAX_BARS);
    const roll = buildEdmSnareRollPattern(rollRng.fork(segment.name), cappedBars);
    entry['pattern'] = roll.pattern;
    entry['lengthInBars'] = roll.lengthInBars;
  }
  return entry as unknown as TransitionEntry;
}

interface SegmentPickContext {
  readonly useEdmExtras: boolean;
  readonly useChorusCrash: boolean;
  readonly segName: string;
  readonly drumDecisions: Record<string, DrumOverrideDecision>;
}

function pickTransitionsForSegment(
  rng: Rng,
  type: string,
  rule: TransitionSegmentRule,
  c: SegmentPickContext,
): TransitionPick[] {
  switch (type) {
    case 'intro':
      return pickIntroBreak(rng, rule, c.useEdmExtras, false);
    case 'break':
      return pickIntroBreak(rng, rule, c.useEdmExtras, true);
    case 'verse':
    case 'preChorus':
      return pickBeginningEndPair(rng, rule, type, c);
    case 'chorus':
      return pickChorusTransitions(rng, rule, c.useEdmExtras, c.useChorusCrash);
    case 'bridge':
      return pickBridgeTransitions(rng, rule, c.useEdmExtras);
    case 'outro':
    default:
      return []; // legacy has no outro case; transitions come via post-passes.
  }
}

/** Sample WITHOUT replacement, mirroring legacy `array.splice(idx,1)[0]`. */
function spliceFromPool(rng: Rng, pool: string[]): string | undefined {
  if (pool.length === 0) return undefined;
  return pool.splice(rng.int(0, pool.length - 1), 1)[0];
}

/** intro / break (legacy transitions.js:90-103). intro always emits; break
 *  emits on a 50% coin. One pick from `anyGenre` (+ brightPopExtra for EDM). */
function pickIntroBreak(
  rng: Rng,
  rule: TransitionSegmentRule,
  useEdmExtras: boolean,
  isBreak: boolean,
): TransitionPick[] {
  if (isBreak && !rng.pick([false, true])) return [];
  const pool = [...(rule.anyGenre ?? [])];
  if (useEdmExtras) pool.push(...(rule.brightPopExtra ?? []));
  if (pool.length === 0) return [];
  const choice = pool[rng.int(0, pool.length - 1)]!;
  return [{ type: choice, placement: 'beginningOfSegment' }];
}

/** verse / preChorus (legacy transitions.js:108-166). Draw order is faithful:
 *  snare coin → begin splice → 50% second begin splice → end splice → B13 fill. */
function pickBeginningEndPair(
  rng: Rng,
  rule: TransitionSegmentRule,
  type: string,
  c: SegmentPickContext,
): TransitionPick[] {
  const picks: TransitionPick[] = [];

  const beginPool = [...(rule.beginningAnyGenre ?? [])];
  if (c.useEdmExtras) beginPool.push(...(rule.beginningBrightPopExtra ?? []));

  const endPool = [...(rule.endAnyGenre ?? [])];
  // Snare coin is ALWAYS drawn (legacy `selectRandomly([false,true]) && genre…`
  // evaluates the coin first); edmSnareDrumRoll only joins the pool for EDM.
  const wantSnare = rng.pick([false, true]);
  if (wantSnare && c.useEdmExtras) endPool.push(...(rule.endBrightPopExtra ?? []));

  const b1 = spliceFromPool(rng, beginPool);
  if (b1) picks.push({ type: b1, placement: 'beginningOfSegment' });
  // 50% second beginning transition (legacy :138-145).
  if (rng.pick([false, true])) {
    const b2 = spliceFromPool(rng, beginPool);
    if (b2) picks.push({ type: b2, placement: 'beginningOfSegment' });
  }
  const e1 = spliceFromPool(rng, endPool);
  if (e1) picks.push({ type: e1, placement: 'endOfSegment' });

  // B13 — EDM fill/buildup, gated on the segment's Drums override NOT being
  // reduced to hiHatOnly/percussionOnly (legacy :149-162). preChorus 50%-picks
  // buildups else fills; verse always fills.
  if (c.useEdmExtras && !drumsReduced(c.drumDecisions[c.segName])) {
    if (type === 'preChorus' && rng.pick([false, true])) {
      picks.push({ type: PERCUSSION_BUILDUPS, placement: 'midSegment' });
    } else {
      picks.push({ type: PERCUSSION_FILLS, placement: 'midSegment' });
    }
  }

  return picks;
}

function drumsReduced(dec: DrumOverrideDecision | undefined): boolean {
  return (
    dec?.kind === 'mask' && (dec.maskType === 'hiHatOnly' || dec.maskType === 'percussionOnly')
  );
}

/** chorus (legacy transitions.js:174-203). begin splice → 50% second begin →
 *  guaranteed cymbalsCrashHit (wider gate, dedup) → guaranteed EDM fill. */
function pickChorusTransitions(
  rng: Rng,
  rule: TransitionSegmentRule,
  useEdmExtras: boolean,
  useChorusCrash: boolean,
): TransitionPick[] {
  const picks: TransitionPick[] = [];
  const beginPool = [...(rule.beginningAnyGenre ?? [])];
  const b1 = spliceFromPool(rng, beginPool);
  if (b1) picks.push({ type: b1, placement: 'beginningOfSegment' });
  if (rng.pick([false, true])) {
    const b2 = spliceFromPool(rng, beginPool);
    if (b2) picks.push({ type: b2, placement: 'beginningOfSegment' });
  }
  if (useChorusCrash && !picks.find((p) => p.type === CYMBALS_CRASH_HIT)) {
    picks.push({ type: CYMBALS_CRASH_HIT, placement: 'beginningOfSegment' });
  }
  if (useEdmExtras) {
    picks.push({ type: PERCUSSION_FILLS, placement: 'midSegment' });
  }
  return picks;
}

/** bridge (legacy transitions.js:207-229). begin splice → 50% snare roll (all
 *  genres) → 2/3 buildup (EDM). */
function pickBridgeTransitions(
  rng: Rng,
  rule: TransitionSegmentRule,
  useEdmExtras: boolean,
): TransitionPick[] {
  const picks: TransitionPick[] = [];
  const beginPool = [...(rule.beginningAnyGenre ?? [])];
  const b1 = spliceFromPool(rng, beginPool);
  if (b1) picks.push({ type: b1, placement: 'beginningOfSegment' });
  // 50% snare roll — NO genre gate in legacy (:219).
  if (rng.pick([false, true])) {
    picks.push({ type: EDM_SNARE_DRUM_ROLL, placement: 'endOfSegment' });
  }
  // 2/3 buildup for EDM genres (:225 `selectRandomly([false,true,true])`).
  if (useEdmExtras && rng.pick([false, true, true])) {
    picks.push({ type: PERCUSSION_BUILDUPS, placement: 'midSegment' });
  }
  return picks;
}

/** docs/62 B4a — inject fxNoiseRise into every segment immediately before a
 *  chorus (eligible genres), unless it already carries one. Deterministic. */
function injectNoiseRiseBeforeChorus(
  structure: SongStructure,
  genre: string,
  bySegment: Record<string, Record<string, TransitionEntry>>,
): void {
  if (!NOISE_RISE_GENRES.has(genre)) return;
  for (let i = 0; i < structure.length; i++) {
    const next = structure[i + 1];
    if (!next || segmentType(next.name) !== 'chorus') continue;
    const name = structure[i]!.name;
    if (bySegment[name]?.[FX_NOISE_RISE]) continue;
    (bySegment[name] ??= {})[FX_NOISE_RISE] = {
      type: FX_NOISE_RISE,
      placement: 'endOfSegment',
    } as unknown as TransitionEntry;
  }
}

/** docs/62 B4b — inject cymbalsCrashHit into any segment whose PREVIOUS segment
 *  carried fxReverse, unless it already has a crash. Deterministic. */
function injectCrashAfterFxReverse(
  structure: SongStructure,
  bySegment: Record<string, Record<string, TransitionEntry>>,
): void {
  let prevHadFxReverse = false;
  for (const segment of structure) {
    const name = segment.name;
    if (prevHadFxReverse && !bySegment[name]?.[CYMBALS_CRASH_HIT]) {
      (bySegment[name] ??= {})[CYMBALS_CRASH_HIT] = {
        type: CYMBALS_CRASH_HIT,
        placement: 'beginningOfSegment',
      } as unknown as TransitionEntry;
    }
    prevHadFxReverse = Boolean(bySegment[name]?.[FX_REVERSE]);
  }
}
