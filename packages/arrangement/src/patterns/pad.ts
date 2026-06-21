// Pad — legacy-derived sustained accompaniment. Replaces the Phase-3
// step-6 hand-authored whole-bar chord with a faithful slice of the
// legacy PadPatternGeneratorClass (9 voicing styles, see docs/53x).
//
// For every segment that includes Pad in its activity table:
//   1. Fork `ctx.rng.fork('patterns/pad')` (per-family salt — adding /
//      removing a family or a generator step never shifts another
//      family's stream).
//   2. Resolve the genre → style list via `bank-index.json`.
//   3. Deterministically pick one voicing style.
//   4. For every segment bar, emit a single hit at beat 0 sustained for
//      the bank-declared `barDuration` (4 beats / one whole 4/4 bar):
//        - `chords*` styles → `type: 'chord'` event carrying the bar's
//          first chord symbol (legacy `_addChord(0, chord, chordType, 4)`).
//        - `singleNote*` styles → `type: 'note'` event whose MIDI pitch
//          is the chord root in the style's declared MIDI octave (legacy
//          `_addNoteAbsolute(0, getChordBaseNote(chord) + <octave>, 4)`).
//
// The legacy 'oneOctave' vs 'twoOctaves' distinction inside the chord
// styles is the legacy `chordType` voicing tag. It is now surfaced on the
// emitted chord event's `chordType` field (to-do #6); the engine consumer
// that voices the six chord styles from it is C++ and out of scope here.

import { parseChord } from '@casperaki/music-theory';
import { ChordSymbolSchema, MidiNoteSchema, type Segment } from '@casperaki/song-schema';

import type { GeneratorContext } from '../context.js';
import { selectPadStyle } from './pad-bank.js';
import { addNoteEvent, emptyBarPattern } from './shared.js';
import type { BarPattern, FamilyPattern, InstrumentFamily } from './types.js';

export function generatePadPattern(
  ctx: GeneratorContext,
  segment: Segment,
  activity: readonly InstrumentFamily[],
): FamilyPattern | undefined {
  if (!activity.includes('pad')) return undefined;
  const rng = ctx.rng.fork('patterns/pad');

  const selection = selectPadStyle(rng, ctx.params.genre);
  const bars: BarPattern[] = segment.bars.map(() => emptyBarPattern());

  for (let segBarIdx = 0; segBarIdx < bars.length; segBarIdx++) {
    const chordsThisBar = segment.bars[segBarIdx]!.chords;
    const symbol = chordsThisBar[0];
    if (!symbol) {
      throw new Error(
        `generatePadPattern: segment "${segment.name}" bar ${segBarIdx} has no chords`,
      );
    }
    if (selection.style.kind === 'chord') {
      const chord = ChordSymbolSchema.parse(symbol);
      // Legacy `_addChord(0, chord, chordType, 4)` carries the voicing tag
      // (oneOctaveHigh / twoOctavesMid / …) as `chordType`; surface the tag
      // the bank already records so the engine can voice the six chord styles
      // distinctly (to-do #6). The engine consumer (C++) is out of scope.
      addNoteEvent(bars[segBarIdx]!, 0, {
        type: 'chord',
        chord,
        chordType: selection.style.voicing,
        duration: selection.barDuration,
      });
    } else {
      const root = parseChord(symbol).root;
      const raw = (selection.style.rootMidiOctave + 1) * 12 + root;
      let pitch = raw;
      while (pitch < 0) pitch += 12;
      while (pitch > 127) pitch -= 12;
      const note = MidiNoteSchema.parse(pitch);
      addNoteEvent(bars[segBarIdx]!, 0, {
        type: 'note',
        note,
        duration: selection.barDuration,
      });
    }
  }

  return { bars };
}
