// Drums — legacy-derived bank lowered into typed brain note events.
//
// Replaces the Phase 3-step 6 hand-authored kick/snare/hat fixture with a
// faithful slice of the legacy drum pattern bank (per docs/53u). For every
// segment that includes Drums in its activity table:
//
//   1. Fork `ctx.rng.fork('patterns/drums')` (determinism contract from
//      step 6 — independent of every other family's stream).
//   2. Resolve the genre → style → bank file via `bank-index.json`.
//   3. Deterministically pick one blueprint from the bank.
//   4. Loop the blueprint across the segment's bars and emit one
//      `type: 'note'` event per hit, MIDI-mapped through the bank
//      manifest's `lanes` block.
//
// The blueprint shape is the legacy file's verbatim shape:
// `{ [lane]: beatPositions[] }` where positions are 0-indexed beats within
// the blueprint (a value of 1.5 → BarBeat key "1.5"). Blueprint bars are
// derived from the max position via the same `ceil(lastHit/32)*32` rule
// the legacy `PopRockDrumPatternGeneratorClass.createDrumPattern` used.
//
// Lanes the engine adapter (Drums-only step 9 lowering) currently grids:
// `bassDrum1` (MIDI 36), `snareDrum1` (38), `hiHatClosed1` (42). Additional
// imported lanes (bassDrum2, claps, toms, crashes, ride, …) are emitted as
// MIDI events so downstream adapters can pick them up, but today they're
// silently dropped during the ASCII-grid lowering. See docs/53u "Engine-
// adapter coverage" for the deferred lane list.

import { MidiNoteSchema, type Segment } from '@casperaki/song-schema';

import type { GeneratorContext } from '../context.js';
import { selectDrumBlueprint, selectPreviewDrumBlueprint, BEATS_PER_LEGACY_BAR } from './drums-bank.js';
import { drumPreviewFromParams } from './proposals.js';
import { addNoteEvent, emptyBarPattern } from './shared.js';
import type { BarPattern, FamilyPattern, InstrumentFamily } from './types.js';

export function generateDrumPattern(
  ctx: GeneratorContext,
  segment: Segment,
  activity: readonly InstrumentFamily[],
): FamilyPattern | undefined {
  if (!activity.includes('drums')) return undefined;
  const rng = ctx.rng.fork('patterns/drums');

  // Pattern lab: a preview forces a proposed pattern in place of the genre's styles.
  const preview = drumPreviewFromParams(ctx.params.params);
  const selection = preview ? selectPreviewDrumBlueprint(rng, preview) : selectDrumBlueprint(rng, ctx.params.genre);
  const bars: BarPattern[] = segment.bars.map(() => emptyBarPattern());

  for (const [lane, positions] of Object.entries(selection.blueprint)) {
    const rawMidi = selection.laneMidi[lane];
    if (rawMidi === undefined) continue;
    const midi = MidiNoteSchema.parse(rawMidi);
    for (const position of positions) {
      // `-1` is the legacy "don't auto-double" sentinel; the brain port
      // doesn't auto-double (it loops the blueprint explicitly per segment
      // bar) so we just skip the sentinel.
      if (position < 0) continue;
      const blueprintBar = Math.floor(position / BEATS_PER_LEGACY_BAR);
      const beat = position - blueprintBar * BEATS_PER_LEGACY_BAR;
      if (beat < 0 || beat >= BEATS_PER_LEGACY_BAR) continue;
      for (let segBarIdx = 0; segBarIdx < bars.length; segBarIdx++) {
        if (segBarIdx % selection.blueprintBars !== blueprintBar) continue;
        addNoteEvent(bars[segBarIdx]!, beat, { type: 'note', note: midi });
      }
    }
  }

  return { bars };
}
