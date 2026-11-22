// docs/54z + docs/55a — Synths (leadSynths) pattern generator.
//
// Legacy contract:
//   casperaki2-engine-js/api/v1.0/services/classes/arrangements/ArrangementsClass.js:127-175
//   routes every leadSynths lowLevel through SynthPatternGeneratorClass
//   (synthPatterns/SynthPatternGeneratorClass.js). For brightPop the
//   genre style mapping (config.json:944-966) is
//     ['EDMArpeggiator', 'EDMSynthsPlucked', 'EDMSynthsStabs', 'playful']
//   and `Tools.selectRandomly` picks one.
//
// Three of the four styles delegate to PianoPatternGeneratorClass with
// an `altLibrary` / `edmSynthsPluckedLibrary` / `edmSynthsStabsLibrary`
// override; the fourth — **EDMArpeggiator** — is a fully self-contained
// synth generator.
//
// 54z scope: EDMArpeggiator only (the self-contained style).
// 55a scope: ADDS EDMSynthsPlucked + EDMSynthsStabs via the piano-bank
// port (see `piano-bank.ts`). `playful` remains deferred — it uses
// a dedicated PlayfulSynthPatternGeneratorClass that's NOT a piano-
// bank delegation. Three of four brightPop synth styles are now
// implemented; the brightPop pool below mirrors that.

import { chordNotes, parseChord, type Rng } from '@casperaki/music-theory';
import { ChordSymbolSchema, type Segment } from '@casperaki/song-schema';

import type { GeneratorContext } from '../context.js';
import {
  expandPianoLibraryPattern,
  selectPianoLibraryPattern,
  type PianoLibrary,
} from './piano-bank.js';
import { addNoteEvent, emptyBarPattern } from './shared.js';
import type { BarPattern, FamilyPattern, InstrumentFamily } from './types.js';

const ARPEGGIO_TYPES: readonly [
  'up',
  'down',
  'upAndDown',
  'downAndUp',
  'insideOut',
  'outsideIn',
] = ['up', 'down', 'upAndDown', 'downAndUp', 'insideOut', 'outsideIn'];

function rhythmPoolForType(type: (typeof ARPEGGIO_TYPES)[number]): readonly string[] {
  switch (type) {
    case 'up':
    case 'down':
      return ['eighthNotes', 'sixteenthNotes', 'eighthNotes332', 'eighthNotes332'];
    case 'upAndDown':
    case 'downAndUp':
      return ['eighthNotes', 'eighthNotes332', 'eighthNotes332'];
    case 'insideOut':
    case 'outsideIn':
    default:
      return ['eighthNotes', 'sixteenthNotes', 'eighthNotes332', 'eighthNotes332'];
  }
}

const NUMBER_OF_OCTAVES: readonly [2, 3] = [2, 3];
const EDM_ARPEGGIATOR_EVENT_DURATION = 0.25;
const EDM_ARPEGGIATOR_NOTE_DURATION = 0.25;

/** docs/56c follow-on — full legacy synth style pools, ported from
 *  `config.json:944-1000 → defaultStyleMappings.synthPatterns`. Every
 *  canonical genre now has its own pool intersected with the styles
 *  we've implemented. The `EDM*` styles route through the piano-bank
 *  edmSynths* libraries (55a/56a). The keyboard* styles route through
 *  the altLibrary bank loaded as part of the 56c-follow-on patterns.
 *  json import. `playful` is a fully self-contained legacy generator
 *  (PlayfulSynthPatternGeneratorClass.js) ported below as
 *  {@link emitPlayful} — it emits `noteRelative` events whose
 *  `distanceFromMiddleC` is computed from the legacy state machine's
 *  (note, offset) pair via a chord-tone walker so the engine's
 *  standard noteRelative path (SequencerUtils.h::getRelativeNote)
 *  plays them without needing a new engine handler.
 *
 *  edm / brightPop pools KEEP the original 55a/56a styles to preserve
 *  the EDM render-proof byte stability. The other genres dispatch to
 *  the legacy-faithful per-genre style. */
type SynthStyle =
  | 'EDMArpeggiator'
  | 'EDMSynthsPlucked'
  | 'EDMSynthsStabs'
  | 'playful'
  | 'keyboardMonophonic'
  | 'keyboardMonophonicRhythmic'
  | 'keyboardPolyphonic';

const GENRE_SYNTH_STYLES: Readonly<Record<string, readonly SynthStyle[]>> = {
  ballad:       ['playful'],
  brightPop:    ['EDMArpeggiator', 'EDMSynthsPlucked', 'EDMSynthsStabs', 'playful'],
  edm:          ['EDMArpeggiator', 'EDMSynthsPlucked', 'EDMSynthsStabs', 'playful'],
  latin:        ['keyboardMonophonicRhythmic', 'playful'],
  organicVibes: ['keyboardMonophonic', 'keyboardMonophonicRhythmic'],
  rock:         ['playful'],
  schlager:     ['EDMArpeggiator', 'keyboardMonophonic', 'keyboardMonophonicRhythmic', 'keyboardPolyphonic', 'playful'],
  urban:        ['playful'],
};

function pianoLibraryFor(style: SynthStyle): PianoLibrary | undefined {
  if (style === 'EDMSynthsPlucked') return 'edmSynthsPluckedLibrary';
  if (style === 'EDMSynthsStabs') return 'edmSynthsStabsLibrary';
  if (
    style === 'keyboardMonophonic' ||
    style === 'keyboardMonophonicRhythmic' ||
    style === 'keyboardPolyphonic'
  ) {
    return 'altLibrary';
  }
  return undefined;
}

/** Per-keyboard-style options matching the legacy
 *  SynthPatternGeneratorClass.js:84-127 wrapper: keyboardMonophonic
 *  sets monophonic=true; keyboardMonophonicRhythmic sets monophonic +
 *  stabs; keyboardPolyphonic leaves both unset (polyphonic, no stabs). */
function keyboardStyleFlags(style: SynthStyle): {
  monophonic: boolean;
  stabs: boolean;
} {
  if (style === 'keyboardMonophonic') return { monophonic: true, stabs: false };
  if (style === 'keyboardMonophonicRhythmic') return { monophonic: true, stabs: true };
  if (style === 'keyboardPolyphonic') return { monophonic: false, stabs: false };
  return { monophonic: false, stabs: false };
}

export function generateSynthsPattern(
  ctx: GeneratorContext,
  segment: Segment,
  activity: readonly InstrumentFamily[],
  lowLevel?: string,
): FamilyPattern | undefined {
  if (!activity.includes('synths')) return undefined;
  const rng = ctx.rng.fork('patterns/synths');

  // docs/62 A6 — legacy ArrangementsClass.js FORCES leadSynthsAnalog to the
  // `keyboardMonophonicRhythmic` style regardless of genre (its own `case`,
  // no genre-random pick). We mirror that: skip the genre pool draw entirely
  // so the analog lead never renders as arpeggiator/plucked/playful. Verified
  // present in BOTH casperaki1 (ArrangementsClass.js:259) and casperaki2
  // (ArrangementsClass.js:159-160). (`synthsPlucked` is already forced via its
  // own `pluckedSynths` lane → generatePluckedSynthsPattern.)
  if (lowLevel === 'leadSynthsAnalog') {
    const flags = keyboardStyleFlags('keyboardMonophonicRhythmic');
    return emitPianoLibrary(rng, segment, 'altLibrary', {
      monophonic: flags.monophonic,
      stabs: flags.stabs,
      genre: ctx.params.genre,
      songBpm: ctx.params.bpm,
    });
  }

  const pool = GENRE_SYNTH_STYLES[ctx.params.genre];
  if (!pool || pool.length === 0) {
    throw new Error(
      `generateSynthsPattern: no synth style pool for genre "${ctx.params.genre}" — extend GENRE_SYNTH_STYLES`,
    );
  }
  // Legacy `Tools.selectRandomly` mirrors `rng.pick`.
  const style = rng.pick(pool);

  if (style === 'EDMArpeggiator') {
    return emitEdmArpeggiator(rng, segment);
  }
  if (style === 'playful') {
    return emitPlayful(rng, segment, ctx.params.genre, ctx.params.bpm);
  }

  const library = pianoLibraryFor(style);
  if (!library) {
    throw new Error(`generateSynthsPattern: unsupported style "${style}"`);
  }
  const flags = keyboardStyleFlags(style);
  return emitPianoLibrary(rng, segment, library, {
    monophonic: flags.monophonic,
    stabs: flags.stabs,
    genre: ctx.params.genre,
    songBpm: ctx.params.bpm,
  });
}

/** docs/55a — synths/synthsPlucked lane. Legacy
 *  `ArrangementsClass.js:131-134` FORCES style = 'EDMSynthsPlucked'
 *  on this lowLevel (no random pick from the synth style pool). The
 *  generator routes straight to the piano-bank port with
 *  edmSynthsPluckedLibrary, polyphonic, no stabs. Separate fork
 *  (`patterns/pluckedSynths`) so this lane's PRNG state stays
 *  independent of the `synths` (leadSynths) lane's. */
export function generatePluckedSynthsPattern(
  ctx: GeneratorContext,
  segment: Segment,
  activity: readonly InstrumentFamily[],
): FamilyPattern | undefined {
  if (!activity.includes('pluckedSynths')) return undefined;
  const rng = ctx.rng.fork('patterns/pluckedSynths');
  return emitPianoLibrary(rng, segment, 'edmSynthsPluckedLibrary', {
    monophonic: false,
    stabs: false,
    genre: ctx.params.genre,
    songBpm: ctx.params.bpm,
  });
}

// ---- emitters ----

function emitEdmArpeggiator(rng: Rng, segment: Segment): FamilyPattern {
  // Three legacy `Tools.selectRandomly` calls, in source order
  // (EDMArpeggiatorSynthPatternGeneratorClass.js:21-46).
  const arpeggioType = rng.pick(ARPEGGIO_TYPES);
  const arpeggioRhythm = rng.pick(rhythmPoolForType(arpeggioType));
  const numberOfOctaves = rng.pick(NUMBER_OF_OCTAVES);

  // docs/62 A8 — legacy SynthPatternGeneratorClass.js:50 builds a FIXED 2-bar
  // pattern (`new Array(2)`) with ONE seed event in bar 0 (chords[0][0]); bar 1
  // stays empty. The engine self-unfolds the 8-beat up/down sweep across both
  // bars (getEDMArpeggiatorNotes), re-deriving each beat's chord from the
  // segment's chord track via getChordAtTime — so the brain must NOT re-seed
  // per bar (that restarts the arpeggio every bar). The 2-bar length matters:
  // the engine's `barIndex % numPatternBars` lands the seed on even bars and
  // unfolds each across the next. Verified against both casperaki1/2 generators
  // and the engine's TonalInstrument / WASM Tonal.h `barIndex % numPatternBars`.
  const symbol = segment.bars[0]!.chords[0];
  if (!symbol) {
    throw new Error(
      `generateSynthsPattern: segment "${segment.name}" bar 0 has no chords`,
    );
  }
  const chord = ChordSymbolSchema.parse(symbol);
  const bars: BarPattern[] = [emptyBarPattern(), emptyBarPattern()];
  addNoteEvent(bars[0]!, 0, {
    type: 'EDMArpeggiator',
    chord,
    arpeggioType,
    arpeggioRhythm,
    numberOfOctaves,
    duration: EDM_ARPEGGIATOR_EVENT_DURATION,
    noteDuration: EDM_ARPEGGIATOR_NOTE_DURATION,
  });
  return { bars };
}

interface PianoLibraryEmitOptions {
  readonly monophonic: boolean;
  readonly stabs: boolean;
  readonly genre: string;
  readonly songBpm: number;
}

function emitPianoLibrary(
  rng: Rng,
  segment: Segment,
  library: PianoLibrary,
  opts: PianoLibraryEmitOptions,
): FamilyPattern {
  const selection = selectPianoLibraryPattern(rng, library);
  const expanded = expandPianoLibraryPattern(selection.pattern, {
    songBpm: opts.songBpm,
    monophonic: opts.monophonic,
    stabs: opts.stabs,
    genre: opts.genre,
  });

  const bars: BarPattern[] = segment.bars.map(() => emptyBarPattern());

  // Repeat the picked pattern across the segment by `barIdx %
  // expanded.barCount` — mirrors the legacy renderer's pattern-
  // extension behaviour for multi-bar segments.
  for (let segBarIdx = 0; segBarIdx < bars.length; segBarIdx++) {
    const patternBarIdx = segBarIdx % Math.max(1, expanded.barCount);
    const chordsThisBar = segment.bars[segBarIdx]!.chords;
    for (const ev of expanded.events) {
      if (ev.bar !== patternBarIdx) continue;
      const chordIdx = Math.floor(ev.beat);
      const symbol = chordsThisBar[chordIdx] ?? chordsThisBar[0];
      if (!symbol) continue;
      const chord = ChordSymbolSchema.parse(symbol);
      // 55a — noteRelative event. Engine path:
      // SequencerUtils.h::getRelativeNote:175-186 reads
      // `distanceFromMiddleC` and snaps `Note{60+distanceFromMiddleC}`
      // to the segment's current chord nearest note. `chord` on the
      // event is INFORMATIONAL — engine uses `currentChord` directly.
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

// ---- playful emitter (PlayfulSynthPatternGeneratorClass.js port) ----

// docs/56c follow-on §"Playful synth port".
//
// Faithful port of
// `casperaki2-engine-js/api/v1.0/services/classes/patterns/synthPatterns/PlayfulSynthPatternGeneratorClass.js`
// (302 lines). The legacy generator:
//   1. Picks one of three "skeleton" types — onlyFull / fullHalf /
//      halfFull — and concatenates the picked half/full sub-pattern.
//      `fullPatterns` are 14 8th-note sub-bars; `halfPatterns` are 8
//      half-bar sub-bars.
//   2. Picks a `melody` mode — up / down / upDown / downUp / sideways
//      (weighted: sideways appears 5× more than the others, matching
//      the legacy `Tools.selectRandomly(['up','down','upDown','downUp','sideways','sideways','sideways','sideways','sideways'])`).
//   3. Picks an octave from [4, 5].
//   4. Walks the skeleton's hits. State machine maintains `lastNote`
//      (0..4) + `lastOffset` (-1..+1). Each step updates note + offset
//      per the melody mode rules (verbatim port below). The first hit
//      always uses note=2 / offset=0.
//   5. Emits one `_addNoteRelative` per hit with parameters:
//      hit, chord, octave, direction:'center', numberOfNotes:5, note,
//      offset, duration (0.25 or 0.5, random).
//
// The legacy engine reads `noteRelative` events with `note`+`offset`
// when `distanceFromMiddleC` is absent and walks the segment's current
// chord notes to resolve the pitch; the events are emitted as is and the
// engine adapter passes the walk fields through. (The first port computed
// a distance from middle C with chordNotes(octave) = (octave + 1) * 12,
// an octave above the engine's root-pitch-class * octave * 12, and added
// `offset` as semitones the engine then snapped back to a chord tone.)
//
// This approximation preserves the legacy rhythmic shape + voice-
// leading state machine exactly; the per-note pitch differs from
// the legacy engine's chord-tone-indexer interpretation only when
// the chord is non-triad (suspended, 7ths) AND note>=3 wraps to a
// chord tone that the legacy engine would have skipped or
// re-indexed differently. Documented as the "playful pitch
// approximation" in docs/56c §"Per-genre synth pools".

const PLAYFUL_FULL_PATTERNS: readonly (readonly number[])[] = [
  [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5],
  [0, 0.5, 1, 1.5, 2, 3],
  [0, 0.5, 1, 1.5, 2, 3, 3.5],
  [0, 0.5, 1.5, 2, 2.5, 3],
  [0, 0.5, 1.5, 2, 3],
  [0, 0.5, 1.5, 2, 3, 3.5],
  [0, 1, 2, 3],
  [0, 1, 1.5, 2, 3],
  [0, 1, 1.5, 2, 3, 3.5],
  [0, 1, 2, 2.5, 3],
  [0, 1, 2, 2.5, 3, 3.5],
  [0, 1, 2.5, 3],
  [0, 1.5, 2, 2.5, 3.5],
  [0.5, 1.5, 2.25, 3, 3.75],
];

const PLAYFUL_HALF_PATTERNS: readonly (readonly number[])[] = [
  [0, 0.5, 1, 1.5],
  [0, 3.5],
  [0.5, 1],
  [0.5, 1, 1.5],
  [1.5, 2],
  [1.5, 2, 2.5],
  [2.5, 3],
  [2.5, 3, 3.5],
];

const PLAYFUL_SKELETONS = ['onlyFull', 'fullHalf', 'halfFull'] as const;
type PlayfulSkeleton = (typeof PLAYFUL_SKELETONS)[number];

const PLAYFUL_MELODIES = [
  'up', 'down', 'upDown', 'downUp',
  // Weighted: 5× sideways matches legacy `Tools.selectRandomly` array.
  'sideways', 'sideways', 'sideways', 'sideways', 'sideways',
] as const;
type PlayfulMelody = (typeof PLAYFUL_MELODIES)[number];

const PLAYFUL_OCTAVES = [4, 5] as const;
const PLAYFUL_DURATIONS = [0.25, 0.5] as const;

function buildPlayfulSkeleton(rng: Rng): readonly number[] {
  const skeleton: PlayfulSkeleton = rng.pick(PLAYFUL_SKELETONS);
  switch (skeleton) {
    case 'onlyFull':
      return [...rng.pick(PLAYFUL_FULL_PATTERNS)];
    case 'fullHalf': {
      const full = [...rng.pick(PLAYFUL_FULL_PATTERNS)];
      const half = rng.pick(PLAYFUL_HALF_PATTERNS);
      full.push(...half.map((e) => e + 4));
      return full;
    }
    case 'halfFull': {
      const half = [...rng.pick(PLAYFUL_HALF_PATTERNS)];
      const full = rng.pick(PLAYFUL_FULL_PATTERNS);
      half.push(...full.map((e) => e + 4));
      return half;
    }
  }
}

interface PlayfulStep {
  readonly note: number; // 0..4 chord-tone index
  readonly offset: number; // -1, 0, +1 semitone
}

function nextPlayfulStep(
  rng: Rng,
  melody: PlayfulMelody,
  firstLoop: boolean,
  hit: number,
  lastNote: number,
  lastOffset: number,
): PlayfulStep {
  if (firstLoop) {
    // Legacy: first iteration always emits note=2, offset=0.
    return { note: 2, offset: 0 };
  }
  let note = 2;
  let offset = 0;
  switch (melody) {
    case 'up':
      if (lastOffset === 0) {
        note = lastNote;
        offset = 1;
      } else {
        note = lastNote + 1;
        offset = 0;
      }
      break;
    case 'down':
      if (lastOffset === 0) {
        note = lastNote;
        offset = -1;
      } else {
        note = lastNote - 1;
        offset = 0;
      }
      break;
    case 'upDown':
    case 'downUp':
      // Legacy branches both walked `item['hit'] < 4` vs `>= 4` with
      // the SAME action (the legacy code reads `item['hit']` from an
      // index that's actually a number, not an object; the `<4`/`>=4`
      // branches in the legacy upDown/downUp cases are functionally
      // equivalent — both descend). Faithful port keeps the descent.
      void hit;
      if (lastOffset === 0) {
        note = lastNote;
        offset = -1;
      } else {
        note = lastNote - 1;
        offset = 0;
      }
      break;
    case 'sideways': {
      // Legacy sub-pick: ['baseNote','baseNote','up','down'] but the
      // 'down' branch isn't implemented in the legacy code; missing
      // case falls through with note=2/offset=0 (initial defaults).
      // Faithful port mirrors that exactly.
      const sub = rng.pick(['baseNote', 'baseNote', 'up', 'down'] as const);
      if (sub === 'baseNote') {
        note = 2;
        offset = 0;
      } else if (sub === 'up') {
        if (lastNote > 2) {
          const sub2 = rng.pick(['noOffset', 'offset'] as const);
          if (sub2 === 'noOffset') {
            note = rng.pick([3, 4] as const);
            offset = 0;
          } else {
            note = lastNote;
            offset = rng.pick([-1, 1] as const);
          }
        } else if (lastNote === 2) {
          const sub2 = rng.pick(['noOffset', 'offset'] as const);
          if (sub2 === 'noOffset') {
            note = 3;
            offset = 0;
          } else {
            note = 2;
            offset = 1;
          }
        } else {
          // lastNote < 2
          const sub2 = rng.pick(['noOffset', 'offset'] as const);
          if (sub2 === 'noOffset') {
            note = rng.pick([0, 1] as const);
            offset = 0;
          } else {
            note = lastNote;
            offset = rng.pick([-1, 1] as const);
          }
        }
      }
      // sub === 'down' falls through (legacy bug preserved).
      break;
    }
  }
  // Legacy clamp: Math.min(Math.max(note, 0), 4).
  note = Math.min(Math.max(note, 0), 4);
  return { note, offset };
}

function emitPlayful(
  rng: Rng,
  segment: Segment,
  genre: string,
  songBpm: number,
): FamilyPattern {
  // Legacy `Tools.selectRandomly` picks (skeleton, melody, octave) at
  // the top of createSynthPattern — same order, single fork.
  const skeleton = buildPlayfulSkeleton(rng);
  const melody: PlayfulMelody = rng.pick(PLAYFUL_MELODIES);
  const octave: 4 | 5 = rng.pick(PLAYFUL_OCTAVES);
  void genre;
  void songBpm;

  const bars: BarPattern[] = segment.bars.map(() => emptyBarPattern());
  let lastNote = 2;
  let lastOffset = 0;
  let firstLoop = true;

  for (const item of skeleton) {
    const barIdx = Math.floor(item / 4);
    const hit = item % 4;
    const beatIdx = Math.floor(hit);

    const step = nextPlayfulStep(rng, melody, firstLoop, hit, lastNote, lastOffset);

    // Walk all matching segment bars (the skeleton spans up to ~8
    // beats = 2 bars; repeat the 2-bar window across the whole segment
    // to match the legacy renderer's segment-extension behaviour).
    const skeletonBarCount = Math.max(
      1,
      Math.floor(skeleton[skeleton.length - 1]! / 4) + 1,
    );
    for (let segBarIdx = 0; segBarIdx < bars.length; segBarIdx++) {
      if (segBarIdx % skeletonBarCount !== barIdx) continue;
      const chordsThisBar = segment.bars[segBarIdx]!.chords;
      const symbol = chordsThisBar[beatIdx] ?? chordsThisBar[0];
      if (!symbol) continue;
      const chord = ChordSymbolSchema.parse(symbol);
      // Duration is picked per-hit (mirrors the legacy
      // `Tools.selectRandomly([0.25, 0.5])`).
      const duration = rng.pick(PLAYFUL_DURATIONS);
      // The legacy event as is (PlayfulSynthPatternGeneratorClass
      // _addNoteRelative): the engine walks it (getRelativeNote's chord-walk
      // branch: the chord root as a bare pitch class at octave * 12, so octave
      // 4 → C3..B3; `note + 1` chord tones around it; `offset` scale steps).
      addNoteEvent(bars[segBarIdx]!, hit, {
        type: 'noteRelative',
        chord,
        octave,
        direction: 'center',
        numberOfNotes: 5,
        note: step.note,
        offset: step.offset,
        duration,
      });
    }

    lastNote = step.note;
    lastOffset = step.offset;
    firstLoop = false;
  }

  return { bars };
}
