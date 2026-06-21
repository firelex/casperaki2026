// Public barrel for @casperaki/music-theory.
//
// Five orthogonal primitives the brain depends on. No generators here —
// those live in @casperaki/arrangement. No data here — those live in
// @casperaki/arrangement/data. No schemas here — those live in
// @casperaki/song-schema. This package is pure logic.

export type { Rng } from './rng.js';
export { createRng } from './rng.js';

export type { ParsedNote } from './note.js';
export {
  parseNoteString,
  midiToNoteString,
  transposeMidi,
  pitchClassDistance,
} from './note.js';

export type { ChordQuality, ParsedChord } from './chord.js';
export { parseChord, chordNotes } from './chord.js';

export type { ScaleMode, ParsedKey } from './scale.js';
export {
  parseKey,
  scalePitchClasses,
  degreePitchClass,
  isInScale,
} from './scale.js';

export {
  beatsPerBar,
  formatBarBeat,
  parseBarBeat,
  barsToBeats,
  barsToSeconds,
} from './time.js';
