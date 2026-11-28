// Casperaki-written patterns for the pitched families (pattern lab).
//
// Two pattern formats, both written once and played over any chord:
//
// 1. Chord-tone patterns (keys, pad, strings, brass, synths, plucked synths).
//    Each note is a fixed pitch, in semitones from middle C. The engine moves
//    it to the nearest tone of the chord sounding at that beat
//    (`noteRelative` with `distanceFromMiddleC`: Tonal.h getRelativeNote →
//    Chord::findNotes(center), which searches 0, -1, +1, -2, +2 … semitones,
//    so a tie goes down). A voicing written once therefore follows every
//    chord change with the smallest movement (voice leading), and the chord's
//    own quality (minor, seventh, sus …) decides the notes.
//
// 2. Guitar picks (guitar). Each hit names strings of the chord's guitar shape,
//    counted from its lowest note (0 = the bass note). One string is a picked
//    note on the sampled guitar (a `strum` event; engine Guitar.h getStrumNotes
//    over GuitarChord shapes); several strings are a strum, played as the
//    Virtual Guitarist's recording (strumAsRecording: [0,1,2,3,4,5] a down
//    strum, [5,4,3,2,1,0] an up strum).
//
// Patterns loop over the section, bar by bar. A pattern may say which
// sections it is for (`energy`): 'low' for intros, verses, breaks and outros,
// 'high' for choruses, none for any section.

import { z } from 'zod';

import { parseChord, type Rng } from '@casperaki/music-theory';
import { ChordSymbolSchema, type Segment } from '@casperaki/song-schema';

import { segmentType } from '../arrangement-polish/segment-type.js';
import { addNoteEvent, emptyBarPattern } from './shared.js';
import type { BarPattern, FamilyPattern, InstrumentFamily } from './types.js';

const BEATS_PER_BAR = 4;

/** Families that play chord-tone patterns. */
export const CHORD_TONE_FAMILIES = ['keys', 'pad', 'popStrings', 'popBrass', 'synths', 'pluckedSynths'] as const;
export type ChordToneFamily = (typeof CHORD_TONE_FAMILIES)[number];

export const EnergySchema = z.enum(['low', 'high']);
export type Energy = z.infer<typeof EnergySchema>;

/** [beat in the pattern, semitones from middle C, length in beats] */
export const ChordToneNoteSchema = z.tuple([z.number().min(0), z.number().int().min(-36).max(36), z.number().positive()]);

export const ChordTonePatternSchema = z
  .object({
    bars: z.number().int().min(1).max(8),
    energy: EnergySchema.optional(),
    notes: z.array(ChordToneNoteSchema).min(1),
  })
  .strict()
  .superRefine((p, ctx) => {
    p.notes.forEach(([beat], i) => {
      if (beat >= p.bars * BEATS_PER_BAR) ctx.addIssue({ code: 'custom', path: ['notes', i], message: `beat ${beat} is past the pattern's ${p.bars} bar(s)` });
    });
  });
export type ChordTonePattern = z.infer<typeof ChordTonePatternSchema>;

/** [beat in the pattern, strings of the chord shape (0 = lowest), length in beats, velocity 1-127] */
export const GuitarPickSchema = z.tuple([
  z.number().min(0),
  z.array(z.number().int().min(0).max(5)).min(1).max(6),
  z.number().positive(),
  z.number().int().min(1).max(127),
]);

/** The Virtual Guitarist effects a pattern may use (the ones the legacy patterns keep). */
export const GUITAR_FX = ['fx1', 'fx2', 'fx4', 'fx6'] as const;

export const GuitarPickPatternSchema = z
  .object({
    bars: z.number().int().min(1).max(8),
    energy: EnergySchema.optional(),
    hits: z.array(GuitarPickSchema).min(1),
    /** Virtual Guitarist effect samples (the guitar's recorded fx1, fx2, fx4, fx6: string noises
     *  and slides that make a part sound played), each `[beat, name]`. Guitars without effect
     *  samples (12-string, banjo, mandolin, ukulele, TC Rectifier) skip them. */
    fx: z.array(z.tuple([z.number().min(0), z.enum(GUITAR_FX)])).optional(),
  })
  .strict()
  .superRefine((p, ctx) => {
    p.hits.forEach(([beat], i) => {
      if (beat >= p.bars * BEATS_PER_BAR) ctx.addIssue({ code: 'custom', path: ['hits', i], message: `beat ${beat} is past the pattern's ${p.bars} bar(s)` });
    });
    (p.fx ?? []).forEach(([beat], i) => {
      if (beat >= p.bars * BEATS_PER_BAR) ctx.addIssue({ code: 'custom', path: ['fx', i], message: `beat ${beat} is past the pattern's ${p.bars} bar(s)` });
    });
  });
export type GuitarPickPattern = z.infer<typeof GuitarPickPatternSchema>;

/** How a recorded chord strum is played: short or long (let ring), down or up. */
export const STRUM_STROKES = ['down', 'up', 'longDown', 'longUp'] as const;
export type StrumStroke = (typeof STRUM_STROKES)[number];
/** The Virtual Guitarist sample each stroke plays. */
export const STRUM_STROKE_EVENTS: Readonly<Record<StrumStroke, string>> = {
  down: 'chordShortStrumDown',
  up: 'chordShortStrumUp',
  longDown: 'chordLongStrumDown',
  longUp: 'chordLongStrumUp',
};
/** [beat in the pattern, stroke, length in beats] */
export const GuitarStrumSchema = z.tuple([z.number().min(0), z.enum(STRUM_STROKES), z.number().positive()]);

export const GuitarStrumPatternSchema = z
  .object({
    bars: z.number().int().min(1).max(8),
    energy: EnergySchema.optional(),
    /** Recorded whole-chord strums (the guitar's Virtual Guitarist chord samples). */
    strums: z.array(GuitarStrumSchema).min(1),
    /** Optional picked strings between the strums (the guitar-picks hit format). */
    picks: z.array(GuitarPickSchema).optional(),
    fx: z.array(z.tuple([z.number().min(0), z.enum(GUITAR_FX)])).optional(),
  })
  .strict()
  .superRefine((p, ctx) => {
    const past = (field: string, i: number, beat: number) => {
      if (beat >= p.bars * BEATS_PER_BAR) ctx.addIssue({ code: 'custom', path: [field, i], message: `beat ${beat} is past the pattern's ${p.bars} bar(s)` });
    };
    p.strums.forEach(([beat], i) => past('strums', i, beat));
    (p.picks ?? []).forEach(([beat], i) => past('picks', i, beat));
    (p.fx ?? []).forEach(([beat], i) => past('fx', i, beat));
  });
export type GuitarStrumPattern = z.infer<typeof GuitarStrumPatternSchema>;

/** A set of patterns one style plays. */
export type AuthoredPatterns =
  | { readonly kind: 'chordTones'; readonly patterns: readonly ChordTonePattern[] }
  | { readonly kind: 'guitarPicks'; readonly patterns: readonly GuitarPickPattern[] }
  | { readonly kind: 'guitarStrums'; readonly patterns: readonly GuitarStrumPattern[] };

export function familyTakesKind(family: InstrumentFamily, kind: AuthoredPatterns['kind']): boolean {
  return kind === 'guitarPicks' || kind === 'guitarStrums' ? family === 'guitar' : (CHORD_TONE_FAMILIES as readonly string[]).includes(family);
}

/** The energy a section asks for: verses quiet, choruses full, the rest either. */
export function sectionEnergy(segmentName: string): Energy | undefined {
  switch (segmentType(segmentName)) {
    case 'intro':
    case 'verse':
    case 'break':
    case 'outro':
      return 'low';
    case 'chorus':
      return 'high';
    default:
      return undefined;
  }
}

/** Patterns a section may play: those with no energy or the section's energy. */
export function patternsForSection<P extends { readonly energy?: Energy }>(patterns: readonly P[], segmentName: string): P[] {
  const want = sectionEnergy(segmentName);
  return patterns.filter((p) => p.energy === undefined || want === undefined || p.energy === want);
}

/** A style must have something to play in every section: a pattern for quiet and one for full sections. */
export function energyCoverageProblem(patterns: readonly { readonly energy?: Energy }[]): string | undefined {
  if (!patterns.some((p) => p.energy !== 'high')) return 'every pattern is marked "high": add one for verses (no energy, or "low")';
  if (!patterns.some((p) => p.energy !== 'low')) return 'every pattern is marked "low": add one for choruses (no energy, or "high")';
  return undefined;
}

/** Guitar strum spread: the time between two strings of one strum, in beats. */
export const STRUM_SPREAD_BEATS = 0.02;

/** The strum lengths the Virtual Guitarist conversion rounds to (legacy convertNonVirtualGuitaristPatternsIntoVirtualGuitaristPatterns.js). */
const RECORDED_STRUM_LENGTHS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4] as const;

/** A hit on several strings as a recorded Virtual Guitarist strum, the legacy app's way
 *  (casperaki2-engine-js …/offline/virtualGuitarist/convertNonVirtualGuitaristPatternsIntoVirtualGuitaristPatterns.js):
 *  down when the strings go up from the bass (`strings[1] > strings[0]`), up otherwise; its length the nearest of
 *  RECORDED_STRUM_LENGTHS (the first on a tie), a short strum at 0.25 and a long one above. */
export function strumAsRecording(strings: readonly number[], duration: number): { event: string; duration: number } {
  if (strings.length < 2) throw new Error(`a strum needs two strings or more, got [${strings.join(', ')}]`);
  const length = RECORDED_STRUM_LENGTHS.reduce((best, l) => (Math.abs(l - duration) < Math.abs(best - duration) ? l : best));
  const down = strings[1]! > strings[0]!;
  const event = length === 0.25 ? (down ? 'chordShortStrumDown' : 'chordShortStrumUp') : down ? 'chordLongStrumDown' : 'chordLongStrumUp';
  return { event, duration: length };
}

/**
 * Play a style's patterns over one section of one lane. One pattern per
 * section type (`rng` is the lane's stream, so verses share a pattern and the
 * chorus may take another), looped bar by bar; every event takes the chord
 * sounding at its beat.
 */
export function emitAuthoredPatterns(rng: Rng, segment: Segment, style: AuthoredPatterns): FamilyPattern {
  const candidates = patternsForSection<ChordTonePattern | GuitarPickPattern | GuitarStrumPattern>(style.patterns, segment.name);
  if (candidates.length === 0) throw new Error(`authored patterns: no pattern fits section "${segment.name}"`);
  const pattern = rng.fork(`authored/${segmentType(segment.name)}`).pick(candidates);
  const bars: BarPattern[] = segment.bars.map(() => emptyBarPattern());

  const chordAt = (segBar: number, beat: number) => {
    const chords = segment.bars[segBar]!.chords;
    const symbol = chords[Math.min(chords.length - 1, Math.floor(beat))];
    if (!symbol) throw new Error(`authored patterns: section "${segment.name}" bar ${segBar} has no chords`);
    return ChordSymbolSchema.parse(symbol);
  };

  for (let segBar = 0; segBar < bars.length; segBar++) {
    const patternBar = segBar % pattern.bars;
    if (style.kind === 'chordTones') {
      for (const [at, pitch, duration] of (pattern as ChordTonePattern).notes) {
        if (Math.floor(at / BEATS_PER_BAR) !== patternBar) continue;
        const beat = at - patternBar * BEATS_PER_BAR;
        addNoteEvent(bars[segBar]!, beat, { type: 'noteRelative', chord: chordAt(segBar, beat), distanceFromMiddleC: pitch, duration });
      }
    } else {
      const guitar = pattern as GuitarPickPattern | GuitarStrumPattern;
      if (style.kind === 'guitarStrums') {
        for (const [at, stroke, duration] of (guitar as GuitarStrumPattern).strums) {
          if (Math.floor(at / BEATS_PER_BAR) !== patternBar) continue;
          const beat = at - patternBar * BEATS_PER_BAR;
          addNoteEvent(bars[segBar]!, beat, { type: 'virtualGuitarist', chord: chordAt(segBar, beat), event: STRUM_STROKE_EVENTS[stroke], duration });
        }
      }
      const picks = 'hits' in guitar ? guitar.hits : (guitar.picks ?? []);
      for (const [at, strings, duration, velocity] of picks) {
        if (Math.floor(at / BEATS_PER_BAR) !== patternBar) continue;
        const beat = at - patternBar * BEATS_PER_BAR;
        // A hit on several strings is a strum, and strums are always the Virtual Guitarist's recordings (owner
        // 2026-11-28); its loudness is the engine's by position (Resolver legacyTonalVelocity).
        if (strings.length > 1) {
          addNoteEvent(bars[segBar]!, beat, { type: 'virtualGuitarist', chord: chordAt(segBar, beat), ...strumAsRecording(strings, duration) });
          continue;
        }
        addNoteEvent(bars[segBar]!, beat, {
          type: 'strum',
          chord: chordAt(segBar, beat),
          strings: [...strings],
          offset: strings.map((_, i) => i * STRUM_SPREAD_BEATS),
          durations: [duration],
          velocities: [velocity],
        });
      }
      for (const [at, event] of guitar.fx ?? []) {
        if (Math.floor(at / BEATS_PER_BAR) !== patternBar) continue;
        const beat = at - patternBar * BEATS_PER_BAR;
        addNoteEvent(bars[segBar]!, beat, { type: 'virtualGuitarist', chord: chordAt(segBar, beat), event });
      }
    }
  }
  return { bars };
}

/**
 * The pitch the engine plays for a chord-tone note (for checks and the lab):
 * the nearest tone of `chord` to middle C + `semitones`, a tie going down
 * (Chord::findNotes center order 0, -1, +1, -2, +2 …).
 */
export function resolveChordTone(semitones: number, chord: string): number {
  const parsed = parseChord(chord);
  const classes = new Set(parsed.intervals.map((i) => (parsed.root + i) % 12));
  const base = 60 + semitones;
  for (let d = 0; d <= 12; d++) {
    if (classes.has((((base - d) % 12) + 12) % 12)) return base - d;
    if (classes.has((((base + d) % 12) + 12) % 12)) return base + d;
  }
  throw new Error(`resolveChordTone: chord "${chord}" has no tones`);
}
