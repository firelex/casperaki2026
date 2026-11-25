// The sung melody: the lead vocal of some sections as it was actually sung and transcribed back (the "Sing" task,
// docs/superpowers/specs/2026-11-25-sing-and-transcribe-design.md). Recorded in the generator block as
// `params.sungMelody` (section name → notes); `writeVocals` puts those notes (and words) on the lead in place of
// the borrowed melody's, the chords staying the precedent's. Notes are in the lane's register, as the melody bank
// writes them.

import { z } from 'zod';

import { MidiNoteSchema, BarBeatSchema } from '@casperaki/song-schema';

import { beatKey } from './written-lyrics.js';
import type { VocalBar, VocalNoteEvent, VocalSegment } from './types.js';

export const SUNG_MELODY_PARAM = 'sungMelody';

export const SungNoteSchema = z
  .object({
    /** Beats from the section start. */
    start: z.number().min(0),
    duration: z.number().positive(),
    midi: z.number().int().min(0).max(127),
    /** fullWord convention: "Un-" continues into the next syllable. */
    word: z.string().min(1),
    /** Vocaloid phonemes, lowercase with stress digits. */
    phonemes: z.array(z.string().min(1)),
  })
  .strict();
export type SungNote = z.infer<typeof SungNoteSchema>;

/** Section name (as the generator names it) → the notes sung there. */
export const SungMelodySchema = z.record(z.string().min(1), z.array(SungNoteSchema).min(1));
export type SungMelody = z.infer<typeof SungMelodySchema>;

/** The sung melody in generator params (empty when the key is absent). */
export function sungMelodyOf(params: Readonly<Record<string, unknown>> | undefined): SungMelody {
  const raw = params?.[SUNG_MELODY_PARAM];
  if (raw === undefined) return {};
  return SungMelodySchema.parse(raw);
}

const BEATS_PER_BAR = 4;
const EPS = 1e-6;

/** The segment with its vocal notes replaced by the sung notes (an error when a note falls outside the section). */
export function attachSungMelody(segment: VocalSegment, notes: readonly SungNote[]): VocalSegment {
  const bars: VocalBar[] = segment.bars.map(() => ({ notes: {} }));
  const sorted = [...notes].sort((a, b) => a.start - b.start);
  sorted.forEach((n, i) => {
    const barIndex = Math.floor(n.start / BEATS_PER_BAR + EPS);
    const bar = bars[barIndex];
    if (!bar) throw new Error(`sung melody for ${segment.segmentName}: a note at beat ${n.start} falls outside the section`);
    const next = sorted[i + 1];
    const endOfPhrase = next === undefined || next.start - (n.start + n.duration) >= 1 - EPS;
    const ev: VocalNoteEvent = {
      type: 'vocalNote',
      note: MidiNoteSchema.parse(n.midi),
      duration: n.duration,
      fullWord: n.word,
      vocaloidPhonemes: [...n.phonemes],
      ...(endOfPhrase ? { endOfPhrase: true } : {}),
    };
    (bar.notes[BarBeatSchema.parse(beatKey(n.start))] ??= []).push(ev);
  });
  return { ...segment, bars };
}
