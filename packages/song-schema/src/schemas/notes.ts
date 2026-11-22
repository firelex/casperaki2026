import { z } from 'zod';
import {
  BarBeatSchema,
  ChordSymbolSchema,
  NoteRefSchema,
  NoteStringSchema,
} from './common.js';

// Each note-event variant carries a `type` discriminator. The legacy engine
// also accepts unknown extra fields per event (e.g. velocity, chordType
// modifiers), so each variant uses `.passthrough()` to preserve fidelity
// rather than strip fields the engine relies on.

const BaseEvent = z.object({
  duration: z.number().nonnegative().optional(),
});

export const PlainNoteEventSchema = BaseEvent.extend({
  type: z.literal('note'),
  note: NoteRefSchema,
}).passthrough();
export type PlainNoteEvent = z.infer<typeof PlainNoteEventSchema>;

export const ChordEventSchema = BaseEvent.extend({
  type: z.literal('chord'),
  chord: ChordSymbolSchema,
  chordType: z.string().optional(),
}).passthrough();
export type ChordEvent = z.infer<typeof ChordEventSchema>;

// Two encodings, as the legacy engine reads them (SequencerUtils.h
// getRelativeNote): `distanceFromMiddleC` (snap Note{60 + d} to the nearest
// chord note), or the chord walk `octave` + `direction` + `note` (+ `offset`
// scale steps): the chord root at octave * 12 (root as a bare pitch class,
// so octave 4 → C3..B3), walked `note + 1` chord tones in `direction`
// (PlayfulSynthPatternGeneratorClass). One of the two must be complete; the
// engine adapter checks it (a discriminated-union member cannot refine).
export const NoteRelativeEventSchema = BaseEvent.extend({
  type: z.literal('noteRelative'),
  chord: ChordSymbolSchema,
  distanceFromMiddleC: z.number().int().optional(),
  octave: z.number().int().optional(),
  direction: z.string().optional(),
  note: z.number().int().optional(),
  numberOfNotes: z.number().int().optional(),
  offset: z.number().optional(),
}).passthrough();
export type NoteRelativeEvent = z.infer<typeof NoteRelativeEventSchema>;

// Legacy `arpeggio` piano event (ArpeggioPianoPatternGeneratorClass via
// PatternGeneratorBaseClass._addArpeggio). Engine path:
// `SequencerUtils.h::getArpeggioNotes:160-178` builds a base note `C{octave}`,
// transposes by the instrument octaveAdjustment, then walks the current
// chord in `direction` for `note+1` steps and picks the `note`-th. `chord`
// is INFORMATIONAL — the engine uses `currentChord`. Distinct from
// `EDMArpeggiator` (which the engine expands into a multi-step run); this
// emits exactly one chord-tone per event.
export const ArpeggioEventSchema = BaseEvent.extend({
  type: z.literal('arpeggio'),
  chord: ChordSymbolSchema,
  octave: z.number().int(),
  direction: z.string(),
  numberOfNotes: z.number().int().positive(),
  note: z.number().int().nonnegative(),
}).passthrough();
export type ArpeggioEvent = z.infer<typeof ArpeggioEventSchema>;

export const EDMArpeggiatorEventSchema = BaseEvent.extend({
  type: z.literal('EDMArpeggiator'),
  chord: ChordSymbolSchema,
  arpeggioType: z.string(),
  arpeggioRhythm: z.string(),
  numberOfOctaves: z.number().int().positive(),
  noteDuration: z.number().nonnegative().optional(),
}).passthrough();
export type EDMArpeggiatorEvent = z.infer<typeof EDMArpeggiatorEventSchema>;

export const VirtualGuitaristEventSchema = BaseEvent.extend({
  type: z.literal('virtualGuitarist'),
  chord: ChordSymbolSchema,
  event: z.string().optional(),
}).passthrough();
export type VirtualGuitaristEvent = z.infer<typeof VirtualGuitaristEventSchema>;

// docs/54t — Fret-noise event. `sounds[i]` indexes into the engine
// inst's `fx.fxFretNoise[]` array; `offset` is added to the event's
// beat position; `durations` and `velocities` are per-sound. Engine
// path: `SequencerUtils.h::getFretNoises` → `Guitar.h::createSegmentClip`
// fret-noise sampler. Brain pattern emits one sound per event today
// but the schema accepts arrays per the legacy shape (`Pop` patterns
// emit `sounds: [2, 4]` co-triggered).
export const FretNoiseEventSchema = BaseEvent.extend({
  type: z.literal('fretNoise'),
  sounds: z.array(z.number().int().nonnegative()).min(1),
  offset: z.array(z.number()).min(1),
  durations: z.array(z.number().nonnegative()).min(1),
  velocities: z.array(z.number().nonnegative()).min(1),
}).passthrough();
export type FretNoiseEvent = z.infer<typeof FretNoiseEventSchema>;

// docs/54x — Per-string strum event. The legacy `guitarPatterns` bank
// (Lane A) and the `virtualGuitaristPatterns` bank (Lane B) both emit
// these alongside `virtualGuitarist` events. Engine path:
// `SequencerUtils.h::getStrumNotes` → `Guitar.h::createSegmentClip`
// long-notes/short-notes sampler. The engine reads `strings[]` as
// per-string indices (0..5 typically; -1 means "fill upward from top
// string", see SequencerUtils.h:221-231), resolves per-string MIDI
// via `GuitarChord{currentChord}.getLowestPosition()` (always
// `positions[0].midi` per legacy "always pick first position" —
// Chord.h:537-554), and emits one engine TimeNote per string with the
// matching `offset[i] / durations[i] / velocities[i]`. The `chord`
// field is ADVISORY — the engine uses the segment's current chord
// for the MIDI lookup, not the event's literal.
export const StrumEventSchema = BaseEvent.extend({
  type: z.literal('strum'),
  chord: ChordSymbolSchema,
  strings: z.array(z.number().int()).min(1),
  offset: z.array(z.number()).min(1),
  durations: z.array(z.number().nonnegative()).min(1),
  velocities: z.array(z.number().nonnegative()).min(1),
}).passthrough();
export type StrumEvent = z.infer<typeof StrumEventSchema>;

// Vocal note. Legacy engine emits these without a `type` field but with
// lyric/phoneme metadata; canonical tags them `vocalNote` explicitly.
// The engine adapter strips the tag back off on the way out.
export const VocalNoteEventSchema = BaseEvent.extend({
  type: z.literal('vocalNote'),
  note: NoteRefSchema,
  fullWord: z.string().optional(),
  vocaloidPhonemes: z.array(z.string()).optional(),
  endOfPhrase: z.boolean().optional(),
}).passthrough();
export type VocalNoteEvent = z.infer<typeof VocalNoteEventSchema>;

export const NoteEventSchema = z.discriminatedUnion('type', [
  PlainNoteEventSchema,
  ChordEventSchema,
  NoteRelativeEventSchema,
  ArpeggioEventSchema,
  EDMArpeggiatorEventSchema,
  VirtualGuitaristEventSchema,
  FretNoiseEventSchema,
  StrumEventSchema,
  VocalNoteEventSchema,
]);
export type NoteEvent = z.infer<typeof NoteEventSchema>;

// A bar's `notes` map: BarBeat string → array of simultaneous events.
export const BarNotesSchema = z.record(BarBeatSchema, z.array(NoteEventSchema));
export type BarNotes = z.infer<typeof BarNotesSchema>;

export const BarSchema = z
  .object({
    notes: BarNotesSchema.optional(),
    chords: z.array(ChordSymbolSchema).optional(),
  })
  .passthrough();
export type Bar = z.infer<typeof BarSchema>;

// Helper re-exports
export { NoteStringSchema };
