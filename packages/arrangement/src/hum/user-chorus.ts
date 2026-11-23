// The user's own chorus: a hummed (or otherwise given) 8-bar melody with its chords, handed to song generation in
// `params.params.userChorus`. The vocals then sing it as every chorus instead of a borrowed precedent, and the
// chorus sections take its chords; the rest of the song is written around it as usual.
//
// Input units: real MIDI note numbers and chord symbols in the song's key; beats from bar 1 (4 per bar).
// The vocal pipeline works in C and in legacy note indices (MIDI - 12; see vocals/range.ts), so the melody and
// chords are moved into C here, exactly as the precedent banks are stored, and the usual chorus fit
// (vocals/index.ts: into the key, peak at the top of the singing range) moves them back.

import { z } from 'zod';

import { ChordSymbolSchema } from '@casperaki/song-schema';

import { keyOffsetFromC, transposeChordSymbol } from '../vocals/fit.js';
import type { MergedPrecedent } from '../vocals/precedents.js';
import { LEGACY_INDEX_TO_MIDI, MAX_NOTE } from '../vocals/range.js';

export const USER_CHORUS_BARS = 8;
/** Chords per bar in a user chorus (one per half bar, as the chord fitter writes them). */
export const USER_CHORUS_CHORDS_PER_BAR = 2;

export const UserChorusSchema = z
  .object({
    melody: z
      .array(
        z
          .object({
            beat: z.number().nonnegative().max(USER_CHORUS_BARS * 4 - 0.25),
            midi: z.number().int().min(21).max(108),
            duration: z.number().positive(),
          })
          .strict(),
      )
      .min(1),
    /** One chord per half bar, 16 in all, in the song's key. */
    chords: z.array(ChordSymbolSchema).length(USER_CHORUS_BARS * USER_CHORUS_CHORDS_PER_BAR),
  })
  .strict();
export type UserChorus = z.infer<typeof UserChorusSchema>;

/** `params.params.userChorus` of a generation, validated; undefined when the run has none. */
export function userChorusOf(params: Readonly<Record<string, unknown>> | undefined): UserChorus | undefined {
  const raw = params?.['userChorus'];
  if (raw === undefined) return undefined;
  const parsed = UserChorusSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`userChorus: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return parsed.data;
}

const beatKey = (beat: number): string => (Number.isInteger(beat) ? `${beat}.0` : String(beat));

/** The user's chorus in the shape of a merged precedent (in C, legacy note indices), for the vocal generator. */
export function userChorusPrecedent(chorus: UserChorus, songKey: string): MergedPrecedent {
  const keyOffset = keyOffsetFromC(songKey);
  const sorted = [...chorus.melody].sort((a, b) => a.beat - b.beat || b.midi - a.midi);
  const melody: Record<string, { midi: number; duration: number }[]> = {};
  for (const n of sorted) {
    const k = beatKey(n.beat);
    if (melody[k]) continue; // one sung note per onset: the highest
    melody[k] = [{ midi: n.midi - LEGACY_INDEX_TO_MIDI - keyOffset, duration: n.duration }];
  }
  const chords: Record<string, { chord: string }> = {};
  for (let beat = 0; beat < USER_CHORUS_BARS * 4; beat++) {
    const symbol = chorus.chords[Math.floor(beat / (4 / USER_CHORUS_CHORDS_PER_BAR))]!;
    chords[beatKey(beat)] = { chord: transposeChordSymbol(symbol, -keyOffset) };
  }
  const notes = Object.values(melody).map((v) => v[0]!.midi);
  return {
    rhythmicPrecedentId: 'user',
    rhythmicPrecedentName: 'user chorus',
    melodicPrecedentId: 'user',
    melodicPrecedentName: 'user chorus',
    properties: {
      start: 0,
      end: USER_CHORUS_BARS,
      maxNote: MAX_NOTE,
      melodyFirstNote: notes[0]!,
      melodyLastNote: notes[notes.length - 1]!,
      melodyMinNote: Math.min(...notes),
      melodyMaxNote: Math.max(...notes),
    },
    melody,
    chords,
  };
}
