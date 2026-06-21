// docs/58 — popStrings + popBrass pattern emitters.
//
// Faithful port of the legacy String/Brass pattern generators (see
// orchestral-bank.ts). Both emit `noteRelative` events (engine path:
// Synths.h → SequencerUtils.h::getRelativeNote). `popStrings` plays the
// 'stabs' library on edm + schlager; `popBrass` plays the schlager-signature
// brass library on schlager. Multi-bar bank patterns wrap modulo their bar
// count across the segment (same as the keys EZKeys-library lowering).

import { ChordSymbolSchema, type Segment } from '@casperaki/song-schema';

import type { GeneratorContext } from '../context.js';
import type { Rng } from '@casperaki/music-theory';
import {
  expandOrchestralPattern,
  selectOrchestralPattern,
  type OrchestralRole,
} from './orchestral-bank.js';
import { addNoteEvent, emptyBarPattern } from './shared.js';
import type { BarPattern, FamilyPattern, InstrumentFamily } from './types.js';

function emitOrchestral(
  ctx: GeneratorContext,
  segment: Segment,
  role: OrchestralRole,
): FamilyPattern {
  const rng = ctx.rng.fork(`patterns/${role}`);
  // Strings dispatch by genre bucket + bpm band and octave-center the pattern
  // (LibraryStringPatternGeneratorClass.js); brass has a single all-'any'
  // schlager bank and emits note positions verbatim.
  const selection = selectOrchestralPattern(rng, role, ctx.params.genre, ctx.params.bpm);
  const expanded = expandOrchestralPattern(selection.pattern, role === 'popStrings');

  const bars: BarPattern[] = segment.bars.map(() => emptyBarPattern());
  for (let segBarIdx = 0; segBarIdx < bars.length; segBarIdx++) {
    const patternBarIdx = segBarIdx % Math.max(1, expanded.barCount);
    const chordsThisBar = segment.bars[segBarIdx]!.chords;
    for (const ev of expanded.events) {
      if (ev.bar !== patternBarIdx) continue;
      const chordIdx = Math.floor(ev.beat);
      const symbol = chordsThisBar[chordIdx] ?? chordsThisBar[0];
      if (!symbol) continue;
      const chord = ChordSymbolSchema.parse(symbol);
      addNoteEvent(bars[segBarIdx]!, ev.beat, {
        type: 'noteRelative',
        chord,
        distanceFromMiddleC: ev.distanceFromMiddleC,
        duration: ev.duration,
        ...(typeof ev.velocity === 'number' ? { velocity: ev.velocity } : {}),
      });
    }
  }
  return { bars };
}

export function generateStringsPattern(
  ctx: GeneratorContext,
  segment: Segment,
  activity: readonly InstrumentFamily[],
): FamilyPattern | undefined {
  if (!activity.includes('popStrings')) return undefined;
  return emitOrchestral(ctx, segment, 'popStrings');
}

export function generateBrassPattern(
  ctx: GeneratorContext,
  segment: Segment,
  activity: readonly InstrumentFamily[],
): FamilyPattern | undefined {
  if (!activity.includes('popBrass')) return undefined;
  return emitOrchestral(ctx, segment, 'popBrass');
}
