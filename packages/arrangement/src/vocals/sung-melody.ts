// The sung melody: the lead vocal of some sections as it was actually sung and transcribed back (the "Sing" task,
// docs/superpowers/specs/2026-11-25-sing-and-transcribe-design.md). Recorded in the generator block as
// `params.sungMelody` (section name → notes); `writeVocals` puts those notes (and words) on the lead in place of
// the borrowed melody's, the chords staying the precedent's. Notes are in the lane's register, as the melody bank
// writes them.

import { z } from 'zod';

import { MidiNoteSchema, BarBeatSchema } from '@casperaki/song-schema';

import type { VocalBarsLike } from './lyric-lines.js';
import { buildVocalScaffolding } from './scaffolding.js';
import { applyLyricsToSegments, type PhrasePlanLine, type SyllableToken } from './syllabify.js';
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

/** The generator's lyric lines are 4 bars long (scaffolding.ts). */
const BARS_PER_LINE = 4;

/**
 * Pitch-only notes (a recording transcribed without written lyrics: beats from the section start, lane register) with
 * the words the section's Vocal lane has now (`laneBars`; without written lyrics, the phrase bank's), attached the
 * way the generator attaches the phrase bank's words (`applyLyricsToSegments` over `buildVocalScaffolding`): per
 * 4-bar line, one syllable per note in order, the line's syllables cycled when the notes outnumber them (and only the
 * first ones used when they are fewer). Errors name the section: a note outside it, two notes starting together, a
 * lane note without a word, notes in a 4-bar line where the lane has no words.
 */
export function laneWordsOn(section: string, laneBars: VocalBarsLike, notes: readonly { start: number; duration: number; midi: number }[]): SungNote[] {
  // The lane's syllables, per 4-bar line, in order.
  const laneLines: SyllableToken[][] = [];
  laneBars.forEach((bar, barIndex) => {
    const keys = Object.keys(bar.notes ?? {}).sort((a, b) => Number.parseFloat(a) - Number.parseFloat(b));
    for (const key of keys) {
      for (const ev of bar.notes?.[key] ?? []) {
        const e = ev as { type?: string; fullWord?: string; vocaloidPhonemes?: string[] };
        if (e.type !== 'vocalNote') continue;
        if (!e.fullWord || !e.vocaloidPhonemes || e.vocaloidPhonemes.length === 0) {
          throw new Error(`${section} bar ${barIndex + 1} beat ${key}: a Vocal lane note without a word or phonemes`);
        }
        (laneLines[Math.floor(barIndex / BARS_PER_LINE)] ??= []).push({ fullWord: e.fullWord, vocaloidPhonemes: [...e.vocaloidPhonemes] });
      }
    }
  });
  // The notes as a vocal segment without words.
  const bars: VocalBar[] = laneBars.map(() => ({ notes: {} }));
  const sorted = [...notes].sort((a, b) => a.start - b.start);
  sorted.forEach((n, i) => {
    const bar = bars[Math.floor(n.start / BEATS_PER_BAR + EPS)];
    if (!bar || n.start < -EPS) throw new Error(`${section}: a note at beat ${n.start} falls outside the section`);
    if (i > 0 && Math.abs(sorted[i - 1]!.start - n.start) < EPS) throw new Error(`${section}: two notes start at beat ${n.start}`);
    (bar.notes[BarBeatSchema.parse(beatKey(n.start))] ??= []).push({ type: 'vocalNote', note: MidiNoteSchema.parse(n.midi), duration: n.duration });
  });
  const segment: VocalSegment = { segmentName: section, bars };
  const scaffolding = buildVocalScaffolding({ segments: [segment] });
  const anyWords = laneLines.find((l) => l !== undefined && l.length > 0);
  if (!anyWords) throw new Error(`${section}: the Vocal lane has no words`);
  const lines: PhrasePlanLine[] = scaffolding[0]!.lines.map((line, l) => {
    const words = laneLines[l] ?? [];
    if (line.length > 0 && words.length === 0) {
      throw new Error(`${section} bars ${l * BARS_PER_LINE + 1}-${(l + 1) * BARS_PER_LINE}: the recording has notes where the Vocal lane has no words`);
    }
    // A line without notes takes no words; the attach asks every line for some, so it is handed the lane's first.
    return { phrase: [], syllables: line.length > 0 ? words : anyWords };
  });
  const attached = applyLyricsToSegments({ segments: [segment] }, scaffolding, { segments: [{ lines }] }).result.segments[0]!;
  const out: SungNote[] = [];
  attached.bars.forEach((bar, barIndex) => {
    for (const [key, evs] of Object.entries(bar.notes)) {
      for (const ev of evs ?? []) {
        if (ev.type !== 'vocalNote') continue;
        if (!ev.fullWord || !ev.vocaloidPhonemes) throw new Error(`${section}: a note at bar ${barIndex + 1} beat ${key} got no word`);
        if (ev.duration === undefined) throw new Error(`${section}: a note at bar ${barIndex + 1} beat ${key} lost its duration`);
        out.push({ start: barIndex * BEATS_PER_BAR + Number.parseFloat(key), duration: ev.duration, midi: MidiNoteSchema.parse(ev.note), word: ev.fullWord, phonemes: [...ev.vocaloidPhonemes] });
      }
    }
  });
  return out.sort((a, b) => a.start - b.start);
}
