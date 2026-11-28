// Guitar: the legacy Virtual Guitarist generator, as the legacy song pipeline
// uses it for every guitar (casperaki2 controllers/patterns.js:1362-1400; the
// traditional GuitarPatternGeneratorClass is commented out there).
//
// VirtualGuitaristPatternGeneratorClass.getVirtualGuitaristPattern:
//   1. Pick the bank and pattern (brightPop 3 in 5 / rock 2 in 4 the main
//      bank by style map + tempo, else Stefan's; other styles the main bank):
//      selectVirtualGuitaristPattern.
//   2. Copy every bar: fx events other than fx1/fx2/fx4/fx6 are replaced by a
//      random different one of fx1/fx2/fx4; strum durations at least 1:
//      postProcessVirtualGuitaristPattern.
// The pattern's events (per-string `strum`s and `virtualGuitarist` chord
// strums and fx) are written as they are, its bars repeated across the
// section. They carry no chord of their own that matters: the engine plays
// every strum on the song's chord at that moment (Guitar.h getGuitarStrums /
// guitarGetRealNotes use getChordAtTime). The schema wants a chord on strum
// and virtualGuitarist events; they get the chord sounding at their beat.
//
// One pattern per song (the legacy generates one pattern per instrument): the
// fork is the same in every section.
//
// The first port layered an invented two-hits-per-bar chord comp, the
// traditional guitarPatterns.json strums and fret noises, and only bar 0 of
// the Virtual Guitarist pattern; none of that is in the legacy.

import { ChordSymbolSchema, type Segment } from '@casperaki/song-schema';

import type { GeneratorContext } from '../context.js';
import { postProcessVirtualGuitaristPattern, selectVirtualGuitaristPattern } from './virtual-guitarist-bank.js';
import { addNoteEvent, emptyBarPattern } from './shared.js';
import type { BarPattern, FamilyPattern, InstrumentFamily } from './types.js';

export function generateGuitarPattern(
  ctx: GeneratorContext,
  segment: Segment,
  activity: readonly InstrumentFamily[],
): FamilyPattern | undefined {
  if (!activity.includes('guitar')) return undefined;
  const rng = ctx.rng.fork('patterns/guitar/virtualGuitarist');
  // A genre recipe may keep the guitar to some pattern families (Casperaki Pop: the syncopated Funk and R&B strums).
  const selection = selectVirtualGuitaristPattern(rng, ctx.params.genre, ctx.params.bpm, ctx.recipe?.guitarPatterns);
  const pattern = postProcessVirtualGuitaristPattern(rng, selection.pattern);
  if (pattern.bars.length === 0) throw new Error(`generateGuitarPattern: the Virtual Guitarist pattern has no bars`);

  const bars: BarPattern[] = segment.bars.map(() => emptyBarPattern());
  for (let segBarIdx = 0; segBarIdx < bars.length; segBarIdx++) {
    const source = pattern.bars[segBarIdx % pattern.bars.length]!;
    const chordsThisBar = segment.bars[segBarIdx]!.chords;
    for (const [beatKey, events] of Object.entries(source.notes)) {
      const beat = Number.parseFloat(beatKey);
      if (!Number.isFinite(beat)) throw new Error(`generateGuitarPattern: bad beat "${beatKey}" in the Virtual Guitarist pattern`);
      const symbol = chordsThisBar[Math.min(chordsThisBar.length - 1, Math.floor(beat))];
      if (!symbol) throw new Error(`generateGuitarPattern: segment "${segment.name}" bar ${segBarIdx} has no chords`);
      const chord = ChordSymbolSchema.parse(symbol);
      for (const raw of events as readonly Record<string, unknown>[]) {
        const ev = structuredClone(raw);
        if (ev.type === 'strum' || ev.type === 'virtualGuitarist') ev.chord = chord;
        else throw new Error(`generateGuitarPattern: unexpected event type "${String(ev.type)}" in the Virtual Guitarist pattern`);
        addNoteEvent(bars[segBarIdx]!, beat, ev as never);
      }
    }
  }
  return { bars };
}
