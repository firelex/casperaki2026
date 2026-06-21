// Keys — legacy-derived piano pattern dispatch (per-genre).
//
// docs/58 sound-parity. Genre→style dispatch is driven entirely by
// `data/patterns/keys/bank-index.json#genreStyles` (mirroring the drums
// bank). `resolveKeysStyle` picks one style for the genre via the seeded
// rng (legacy `Tools.selectRandomly(defaultStyleMappings.pianoPatterns[genre])`)
// and this file routes by the style's `kind`:
//
//   kind 'chordPattern':
//     - format 'hitGroups'     → chordsStraight (chord events)
//     - format 'absHitTriples' → edmHousePiano  (chord events; edm/schlager)
//   kind 'algo':
//     - chordsMixed (chord events) / arpeggio (arpeggio events) — keys-algo.ts
//   kind 'ezKeys':
//     - library / altLibrary → EZKeys piano-bank.ts (noteRelative events)
//
// Engine path:
//   - chord events       → Synths.h getChordNotes
//   - noteRelative       → Synths.h getRelativeNote (SequencerUtils.h:180)
//   - arpeggio           → Synths.h getArpeggioNotes (SequencerUtils.h:160)
// All are valid keys lowerings (engine routes the `keys` lowLevelType
// through Synths.h — Instrument.cpp typeTable).

import { ChordSymbolSchema, type Segment } from '@casperaki/song-schema';

import type { GeneratorContext } from '../context.js';
import type { Rng } from '@casperaki/music-theory';
import {
  resolveKeysStyle,
  selectChordsStraightPattern,
  selectEdmHousePianoPattern,
} from './keys-bank.js';
import { generateKeysAlgoBlueprint, type KeysAlgoStyleName } from './keys-algo.js';
import {
  expandPianoLibraryPattern,
  pianoLibraryHasGenrePool,
  selectPianoLibraryPattern,
  type PianoLibrary,
} from './piano-bank.js';
import { addNoteEvent, emptyBarPattern } from './shared.js';
import type { BarPattern, FamilyPattern, InstrumentFamily } from './types.js';

export function generateKeysPattern(
  ctx: GeneratorContext,
  segment: Segment,
  activity: readonly InstrumentFamily[],
): FamilyPattern | undefined {
  if (!activity.includes('keys')) return undefined;
  const rng = ctx.rng.fork('patterns/keys');

  const style = resolveKeysStyle(rng, ctx.params.genre);
  switch (style.kind) {
    case 'chordPattern':
      return style.format === 'hitGroups'
        ? emitKeysChordsStraight(rng, segment)
        : emitKeysEdmHousePiano(rng, segment);
    case 'algo':
      return emitKeysAlgo(rng, segment, style.algoName);
    case 'ezKeys':
      return emitKeysLibrary(
        rng,
        segment,
        style.library as PianoLibrary,
        ctx.params.genre,
        ctx.params.bpm,
      );
  }
}

/** Legacy port of `chordsStraight` (ChordsPianoPatternGeneratorClass,
 *  classic substyle) — emits `type:'chord'` events. */
function emitKeysChordsStraight(rng: Rng, segment: Segment): FamilyPattern {
  const selection = selectChordsStraightPattern(rng);
  const bars: BarPattern[] = segment.bars.map(() => emptyBarPattern());

  for (let segBarIdx = 0; segBarIdx < bars.length; segBarIdx++) {
    const patternBar = segBarIdx % selection.patternBars;
    const patternBarHits = selection.pattern.bars[patternBar];
    if (!patternBarHits) continue;
    const chordsThisBar = segment.bars[segBarIdx]!.chords;
    for (const group of patternBarHits) {
      const beatIdx = rng.int(0, group.beats.length - 1);
      const beat = group.beats[beatIdx]!;
      let duration: number;
      if (typeof group.duration === 'number') {
        duration = group.duration;
      } else {
        const pool = selection.lengthDurations[group.duration];
        const durIdx = rng.int(0, pool.length - 1);
        duration = pool[durIdx]!;
      }
      const chordIdx = Math.floor(beat);
      const symbol = chordsThisBar[chordIdx] ?? chordsThisBar[0];
      if (!symbol) {
        throw new Error(
          `generateKeysPattern: segment "${segment.name}" bar ${segBarIdx} has no chords`,
        );
      }
      const chord = ChordSymbolSchema.parse(symbol);
      addNoteEvent(bars[segBarIdx]!, beat, { type: 'chord', chord, duration });
    }
  }

  return { bars };
}

/** Legacy port of `edmHousePiano` (EDMHousePianoPatternGeneratorClass) —
 *  deterministic [absHit, duration, layer] triples emitted as `chord`
 *  events (duration clamped to 0.5). Used for edm + schlager. */
function emitKeysEdmHousePiano(rng: Rng, segment: Segment): FamilyPattern {
  const selection = selectEdmHousePianoPattern(rng);
  const bars: BarPattern[] = segment.bars.map(() => emptyBarPattern());

  for (let segBarIdx = 0; segBarIdx < bars.length; segBarIdx++) {
    const patternBar = segBarIdx % selection.patternBars;
    const chordsThisBar = segment.bars[segBarIdx]!.chords;
    for (const slot of selection.slots) {
      if (slot.bar !== patternBar) continue;
      const chordIdx = Math.floor(slot.beat);
      const symbol = chordsThisBar[chordIdx] ?? chordsThisBar[0];
      if (!symbol) continue;
      const chord = ChordSymbolSchema.parse(symbol);
      addNoteEvent(bars[segBarIdx]!, slot.beat, {
        type: 'chord',
        chord,
        duration: slot.duration,
      });
    }
  }

  return { bars };
}

/** Legacy port of `chordsMixed` / `arpeggio` (keys-algo.ts). chordsMixed
 *  emits `chord` events; arpeggio emits `arpeggio` events (chord-relative
 *  walk resolved engine-side). */
function emitKeysAlgo(
  rng: Rng,
  segment: Segment,
  algoName: KeysAlgoStyleName,
): FamilyPattern {
  const blueprint = generateKeysAlgoBlueprint(rng, algoName);
  const patternBarCount = Math.max(1, blueprint.bars.length);
  const bars: BarPattern[] = segment.bars.map(() => emptyBarPattern());

  for (let segBarIdx = 0; segBarIdx < bars.length; segBarIdx++) {
    const patternBar = segBarIdx % patternBarCount;
    const events = blueprint.bars[patternBar];
    if (!events) continue;
    const chordsThisBar = segment.bars[segBarIdx]!.chords;
    for (const ev of events) {
      const chordIdx = Math.floor(ev.beat);
      const symbol = chordsThisBar[chordIdx] ?? chordsThisBar[0];
      if (!symbol) continue;
      const chord = ChordSymbolSchema.parse(symbol);
      if (ev.kind === 'chord') {
        addNoteEvent(bars[segBarIdx]!, ev.beat, {
          type: 'chord',
          chord,
          duration: ev.duration,
        });
      } else {
        addNoteEvent(bars[segBarIdx]!, ev.beat, {
          type: 'arpeggio',
          chord,
          octave: ev.octave,
          direction: ev.direction,
          numberOfNotes: ev.numberOfNotes,
          note: ev.note,
          duration: ev.duration,
        });
      }
    }
  }

  return { bars };
}

/** Legacy port of `library` / `altLibrary` (LibraryPianoPatternGeneratorClass)
 *  — emits `type:'noteRelative'` events via piano-bank.ts. */
function emitKeysLibrary(
  rng: Rng,
  segment: Segment,
  requested: PianoLibrary,
  genre: string,
  songBpm: number,
): FamilyPattern {
  // Fall back to `altLibrary` (single-bucket 'pop') if the multi-bucket
  // `library` happens to have no pool for this genre (belt-and-braces
  // guard against a future patterns.json re-extract dropping a bucket).
  const style: PianoLibrary =
    requested === 'library' && !pianoLibraryHasGenrePool('library', genre)
      ? 'altLibrary'
      : requested;

  const selection = selectPianoLibraryPattern(rng, style, genre);
  const expanded = expandPianoLibraryPattern(selection.pattern, {
    songBpm,
    monophonic: false,
    stabs: false,
    genre,
  });

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
      });
    }
  }
  return { bars };
}
