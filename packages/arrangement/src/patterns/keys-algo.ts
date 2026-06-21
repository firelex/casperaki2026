// Algorithmic keys (piano) pattern generators — faithful port of the
// legacy `casperaki1/.../patterns/pianoPatterns/*GeneratorClass.js` family
// (docs/58 sound-parity, "port legacy, no A/B").
//
// Coverage (legacy class → algo style name wired in keys/bank-index.json):
//   ChordsPianoPatternGeneratorClass (style2='straight')  → "chordsMixed"
//   ArpeggioPianoPatternGeneratorClass                    → "arpeggio"
//
// As in drums-algo.ts, every legacy `Math.random()` / `Tools.selectRandomly`
// is replaced by a seeded `Rng` so the brain stays deterministic. The
// legacy generators build a 2-bar pattern; we emit a per-bar list of
// chord-relative events (beat + payload, chord resolved at emit time by
// keys.ts against the segment-bar's chords). The legacy `leftHand` /
// `rightHand` distinction is engine-side voicing metadata — for chord
// events it is collapsed (both hands produce identical chord slots); for
// arpeggio it selects the octave + walk direction, which IS musically
// meaningful, so it is preserved on the emitted event.

import type { Rng } from '@casperaki/music-theory';

/** One algorithmically-generated keys event, chord resolved later. */
export type KeysAlgoEvent =
  | { readonly kind: 'chord'; readonly beat: number; readonly duration: number }
  | {
      readonly kind: 'arpeggio';
      readonly beat: number;
      readonly octave: number;
      readonly direction: string;
      readonly numberOfNotes: number;
      readonly note: number;
      readonly duration: number;
    };

/** A 2-bar blueprint: `bars[barIdx]` is the ordered events for that bar. */
export interface KeysAlgoBlueprint {
  readonly bars: ReadonlyArray<readonly KeysAlgoEvent[]>;
}

// ---- chordsMixed (ChordsPianoPatternGeneratorClass, style2 = 'straight') ----
//
// PianoPatternGeneratorClass routes 'chordsMixed' to ChordsPianoPatternGeneratorClass
// with leftHandStyle ∈ {shortChords, longAndShortChords}, style2 = 'straight',
// and a per-call busyness. We port the `straight` branch of
// ChordsPianoPatternGeneratorClass.createPianoPattern verbatim.

type LengthCategory = 'short' | 'medium' | 'long';

function resolveDuration(rng: Rng, length: LengthCategory): number {
  switch (length) {
    case 'short':
      return rng.pick([0.25, 0.5]);
    case 'medium':
      return 1;
    case 'long':
      return rng.pick([2, 3]);
  }
}

// Legacy `_addChordPattern( hits, length )`: pick one beat from the pool,
// pick one duration from the length-category pool, emit a chord slot.
function addChordPattern(
  rng: Rng,
  out: KeysAlgoEvent[],
  hits: readonly number[],
  length: LengthCategory,
): void {
  const beat = rng.pick(hits);
  const duration = resolveDuration(rng, length);
  out.push({ kind: 'chord', beat, duration });
}

function generateChordsMixed(rng: Rng): KeysAlgoBlueprint {
  // Legacy picks a hand first (selectRandomly(['leftHand','rightHand'])).
  // Both hands produce identical chord-slot structure (only the engine
  // voicing label differs), so we consume the roll for stream fidelity
  // but otherwise ignore it.
  rng.pick(['leftHand', 'rightHand']);

  const handStyle = rng.pick(['shortChords', 'longAndShortChords'] as const);
  const busyness = rng.pick([1, 2, 3]);

  let barStyle: readonly ['longChords' | 'shortChords', 'longChords' | 'shortChords'];
  if (handStyle === 'shortChords') {
    barStyle = ['shortChords', 'shortChords'];
  } else {
    barStyle = rng.pick([
      ['longChords', 'shortChords'],
      ['shortChords', 'longChords'],
    ] as const);
  }

  const bars: KeysAlgoEvent[][] = [[], []];
  for (let bar = 0; bar < 2; bar++) {
    const out = bars[bar]!;
    const style = barStyle[bar];
    if (busyness === 1) {
      if (style === 'longChords') {
        addChordPattern(rng, out, [0, 1], 'long');
      } else {
        addChordPattern(rng, out, [0, 0.5, 1, 1.5], 'short');
        addChordPattern(rng, out, [2, 2.5, 3, 3.5], 'short');
      }
    } else if (busyness === 2) {
      if (style === 'longChords') {
        const half = rng.pick(['firstHalf', 'secondHalf'] as const);
        if (half === 'firstHalf') {
          if (bar === 0) {
            addChordPattern(rng, out, [0, 0.5], 'medium');
            addChordPattern(rng, out, [2, 2.5], 'medium');
          } else {
            addChordPattern(rng, out, [0, 1], 'long');
          }
        } else {
          if (bar === 0) {
            addChordPattern(rng, out, [0, 1], 'long');
          } else {
            addChordPattern(rng, out, [0, 0.5], 'medium');
            addChordPattern(rng, out, [2, 2.5], 'medium');
          }
        }
      } else {
        const half = rng.pick(['firstHalf', 'secondHalf'] as const);
        if (half === 'firstHalf') {
          addChordPattern(rng, out, [0, 0.5], 'short');
          addChordPattern(rng, out, [1, 1.5], 'short');
          addChordPattern(rng, out, [2, 2.5, 3, 3.5], 'short');
        } else {
          addChordPattern(rng, out, [0, 0.5, 1, 1.5], 'short');
          addChordPattern(rng, out, [2, 2.5], 'short');
          addChordPattern(rng, out, [3, 3.5], 'short');
        }
      }
    } else {
      // busyness === 3
      if (style === 'longChords') {
        addChordPattern(rng, out, [0, 0.5, 1], 'medium');
        addChordPattern(rng, out, [2, 2.5, 3], 'medium');
      } else {
        addChordPattern(rng, out, [0, 0.5], 'short');
        addChordPattern(rng, out, [1, 1.5], 'short');
        addChordPattern(rng, out, [2, 2.5], 'short');
        addChordPattern(rng, out, [3, 3.5], 'short');
      }
    }
  }

  return { bars };
}

// ---- arpeggio (ArpeggioPianoPatternGeneratorClass) ----
//
// PianoPatternGeneratorClass routes 'arpeggio' to one or both hands. Each
// hand fixes an octave + walk direction:
//   leftHand  → octave 3, direction 'up'
//   rightHand → octave 5, direction 'down'
// numberOfNotes ∈ {3,4} (per hand instance), busyness ∈ {1,2,3} (per call).
// `_selectNote` picks a chord-degree index in [0, numberOfNotes) that
// differs from the previous one. We emit one `arpeggio` event per step.

interface ArpHand {
  readonly octave: number;
  readonly direction: string;
  readonly busynessKey: 'left' | 'right';
}

const ARP_LEFT: ArpHand = { octave: 3, direction: 'up', busynessKey: 'left' };
const ARP_RIGHT: ArpHand = { octave: 5, direction: 'down', busynessKey: 'right' };

// Legacy `_selectNote( currentNote )`: choose uniformly among the
// [0, numberOfNotes) indices excluding the current one.
function selectArpNote(rng: Rng, numberOfNotes: number, currentNote: number): number {
  const notes: number[] = [];
  for (let i = 0; i < numberOfNotes; i++) {
    if (i === currentNote) continue;
    notes.push(i);
  }
  return rng.pick(notes);
}

function runArpHand(rng: Rng, hand: ArpHand, out: KeysAlgoEvent[][]): void {
  const numberOfNotes = rng.pick([3, 4]);
  const busyness = rng.pick([1, 2, 3]);
  let currentNote: number | undefined;

  const emit = (bar: number, hit: number, note: number, duration: number): void => {
    out[bar]!.push({
      kind: 'arpeggio',
      beat: hit,
      octave: hand.octave,
      direction: hand.direction,
      numberOfNotes,
      note,
      duration,
    });
  };

  for (let bar = 0; bar < 2; bar++) {
    if (busyness === 1) {
      // numberOfNotes 3 and 4 share the same loop body in legacy.
      for (let i = 0; i < 4; i++) {
        currentNote = selectArpNote(rng, numberOfNotes, currentNote ?? -1);
        emit(bar, i, currentNote, 1);
        // Legacy: selectRandomly([f,f,f,f,f,true]) → 1/6 chance.
        if (rng.pick([false, false, false, false, false, true]) && i < 3.75) {
          currentNote = selectArpNote(rng, numberOfNotes, currentNote);
          emit(bar, i + 0.25, currentNote, 1);
        }
      }
    } else if (busyness === 2) {
      for (let i = 0; i < 4; i += 0.5) {
        currentNote = selectArpNote(rng, numberOfNotes, currentNote ?? -1);
        emit(bar, i, currentNote, 0.5);
        // Legacy: selectRandomly([f,f,f,true]) → 1/4 chance.
        if (rng.pick([false, false, false, true]) && i < 3.75) {
          currentNote = selectArpNote(rng, numberOfNotes, currentNote);
          emit(bar, i + 0.25, currentNote, 1);
        }
      }
    } else {
      // busyness === 3
      for (let i = 0; i < 4; i += 0.25) {
        currentNote = selectArpNote(rng, numberOfNotes, currentNote ?? -1);
        emit(bar, i, currentNote, 0.25);
        // Legacy: selectRandomly([false,true]) → 1/2 chance.
        if (rng.pick([false, true]) && i < 3.75) {
          currentNote = selectArpNote(rng, numberOfNotes, currentNote);
          emit(bar, i + 0.25, currentNote, 1);
        }
      }
    }
  }
}

function generateArpeggio(rng: Rng): KeysAlgoBlueprint {
  const bars: KeysAlgoEvent[][] = [[], []];
  const mode = rng.pick(['leftHand', 'rightHand', 'bothHands'] as const);
  if (mode === 'leftHand') {
    runArpHand(rng, ARP_LEFT, bars);
  } else if (mode === 'rightHand') {
    runArpHand(rng, ARP_RIGHT, bars);
  } else {
    runArpHand(rng, ARP_LEFT, bars);
    runArpHand(rng, ARP_RIGHT, bars);
  }
  return { bars };
}

// ---- public dispatcher ----

/** Algo style names the keys bank manifest may reference via `{ "algo": ... }`. */
export const KEYS_ALGO_STYLE_NAMES = ['chordsMixed', 'arpeggio'] as const;
export type KeysAlgoStyleName = (typeof KEYS_ALGO_STYLE_NAMES)[number];

export function isKeysAlgoStyleName(name: string): name is KeysAlgoStyleName {
  return (KEYS_ALGO_STYLE_NAMES as readonly string[]).includes(name);
}

/** Generate one algorithmic keys blueprint (2 bars). */
export function generateKeysAlgoBlueprint(
  rng: Rng,
  algoName: KeysAlgoStyleName,
): KeysAlgoBlueprint {
  switch (algoName) {
    case 'chordsMixed':
      return generateChordsMixed(rng);
    case 'arpeggio':
      return generateArpeggio(rng);
  }
}
