// Hum to song: from what the transcription service heard to an 8-bar phrase of melody and chords.
//
//   quantizeHum()      notes in seconds + the beat grid → notes in beats from bar 1 (8ths), the hummed length (2, 4
//                      or 8 bars) and the key.
//   chordAlternatives()three chord sequences for all 8 bars (half-bar chords), from the arrangement's chord fitter.
//   amtChords()        those chords as voiced notes, for the melody completion service.
//   mergeCompletion()  the hummed bars plus a completion of the others.
//
// Pure functions; the route (routes/hum.ts) calls the services.

import { hum } from '@casperaki/arrangement';

/** What the hum service (POST /transcribe) answers. */
export interface Transcription {
  readonly bpm: number;
  readonly beats: readonly number[];
  readonly downbeats: readonly number[];
  readonly key: { readonly tonic: number; readonly scale: 'major' | 'minor' };
  readonly notes: readonly { readonly onsetSec: number; readonly offsetSec: number; readonly midi: number }[];
  readonly tookMs: number;
}

export interface BeatNote {
  /** Beats from the start of bar 1 (4 beats per bar). */
  readonly beat: number;
  readonly midi: number;
  readonly duration: number;
}

export const PHRASE_BARS = 8;
const GRID = 0.5; // 8ths
const PC_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'] as const;

/** The song key string ("E", "C#m") for a transcribed key. */
export function songKeyOf(key: Transcription['key']): string {
  if (!Number.isInteger(key.tonic) || key.tonic < 0 || key.tonic > 11) throw new Error(`hum: the key's tonic must be 0..11, got ${key.tonic}`);
  return `${PC_NAMES[key.tonic]}${key.scale === 'minor' ? 'm' : ''}`;
}

/** The major key's tonic the chord fitter works in (a minor key: its relative major). */
export function majorTonicOf(key: Transcription['key']): number {
  return key.scale === 'minor' ? (key.tonic + 3) % 12 : key.tonic;
}

const snap = (x: number) => Math.round(x / GRID) * GRID;

/** Seconds → beats on the (possibly drifting) beat grid: linear between beats, the outer intervals extended. */
function beatPosition(beats: readonly number[], t: number): number {
  const n = beats.length;
  if (t <= beats[0]!) return (t - beats[0]!) / (beats[1]! - beats[0]!);
  for (let i = 0; i < n - 1; i++) {
    if (t <= beats[i + 1]!) return i + (t - beats[i]!) / (beats[i + 1]! - beats[i]!);
  }
  return n - 1 + (t - beats[n - 1]!) / (beats[n - 1]! - beats[n - 2]!);
}

/** Which beats are the first of a bar: the most common position of the downbeats among the beats (mod 4). */
function barPhase(beats: readonly number[], downbeats: readonly number[]): number {
  if (downbeats.length === 0) return 0;
  const votes = [0, 0, 0, 0];
  for (const d of downbeats) {
    let best = 0;
    for (let i = 1; i < beats.length; i++) if (Math.abs(beats[i]! - d) < Math.abs(beats[best]! - d)) best = i;
    votes[best % 4]!++;
  }
  return votes.indexOf(Math.max(...votes));
}

export interface QuantizedHum {
  /** Notes in beats from bar 1, on 8ths; none overlap. */
  readonly melody: readonly BeatNote[];
  /** 2, 4 or 8: the bars the hum fills; shorter hums are the first bars of the 8-bar phrase. */
  readonly hummedBars: 2 | 4 | 8;
  /** Notes the service heard. */
  readonly notesHeard: number;
  /** Notes kept in the phrase (dropped: a pickup before bar 1, notes past the hummed bars, repeats on one 8th). */
  readonly notesKept: number;
  /** Notes before bar 1 that were dropped (a pickup). */
  readonly pickupDropped: number;
  readonly bpm: number;
}

/** The hum on the beat grid: bar 1 is the bar of the first note (a note in its last beat leads into the next bar). */
export function quantizeHum(t: Transcription): QuantizedHum {
  if (t.beats.length < 2) throw new Error('No beat could be found in the recording. Try again with a clearer pulse, or use the click.');
  if (t.notes.length === 0) throw new Error('No notes were heard in the recording. Hum a little louder or closer to the microphone.');
  const phase = barPhase(t.beats, t.downbeats);
  const onBeats = t.notes
    .map((n) => {
      const on = beatPosition(t.beats, n.onsetSec);
      const off = beatPosition(t.beats, n.offsetSec);
      return { beat: snap(on) - phase, midi: n.midi, duration: Math.max(GRID, snap(off - on)) };
    })
    .sort((a, b) => a.beat - b.beat);
  const first = onBeats[0]!.beat;
  let barStart = Math.floor(first / 4) * 4;
  // A note in the last beat of a bar, followed by more notes in the next bar, is a pickup into it.
  if (first - barStart >= 3 && onBeats.some((n) => n.beat >= barStart + 4)) barStart += 4;
  let pickupDropped = 0;
  const rel: { beat: number; midi: number; duration: number }[] = [];
  for (const n of onBeats) {
    const beat = n.beat - barStart;
    if (beat < 0) {
      pickupDropped++;
      continue;
    }
    const prev = rel[rel.length - 1];
    if (prev && prev.beat === beat) {
      if (n.duration > prev.duration) rel[rel.length - 1] = { beat, midi: n.midi, duration: n.duration };
      continue;
    }
    rel.push({ beat, midi: n.midi, duration: n.duration });
  }
  const lastEnd = Math.max(...rel.map((n) => n.beat + n.duration));
  const barsUsed = Math.max(1, Math.ceil(lastEnd / 4 - 1e-9));
  // The nearest of 2, 4, 8 bars (a tie goes to the longer phrase, keeping more of the hum).
  const hummedBars: 2 | 4 | 8 = barsUsed <= 2 ? 2 : barsUsed <= 5 ? 4 : 8;
  const end = hummedBars * 4;
  const kept = rel.filter((n) => n.beat < end);
  const melody = kept.map((n, i) => {
    const next = kept[i + 1];
    const limit = (next ? next.beat : end) - n.beat;
    return { beat: n.beat, midi: n.midi, duration: Math.min(n.duration, limit) };
  });
  return { melody, hummedBars, notesHeard: t.notes.length, notesKept: melody.length, pickupDropped, bpm: t.bpm };
}

export interface ChordAlternative {
  /** 16 chord ids ("deg:quality"), one per half bar. */
  readonly slots: readonly string[];
  /** The same as chord symbols in the song's key. */
  readonly chords: readonly string[];
  /** How the fitter got it ("known: …", "best free", …). */
  readonly label: string;
}

/** Three chord sequences for the 8-bar phrase, [0] recommended. */
export function chordAlternatives(melody: readonly BeatNote[], hummedBars: number, key: Transcription['key']): ChordAlternative[] {
  const model = hum.loadChordFitModel();
  const fill = model.fillByMelodyBars[String(hummedBars)];
  if (!fill) throw new Error(`hum: the chord model has no setting for a ${hummedBars}-bar hum`);
  const tonic = majorTonicOf(key);
  const { alternatives } = hum.harmonize(melody, hummedBars, tonic, model.prior, model.known, { ...model.params, fill });
  return alternatives.map((a) => ({
    slots: a.slots,
    chords: a.slots.map((id) => hum.chordSymbol(hum.chordFromId(id), tonic)),
    label: a.label,
  }));
}

/** The half-bar chords as block chords (root from C3 up), for the melody completion service. */
export function amtChords(slots: readonly string[], key: Transcription['key']): { beat: number; duration: number; midi: number[] }[] {
  const tonic = majorTonicOf(key);
  return slots.map((id, s) => {
    const c = hum.chordFromId(id);
    const root = 48 + ((tonic + c.deg) % 12);
    return { beat: s * 2, duration: 2, midi: hum.QUALITY_INTERVALS[c.q].map((i) => root + i) };
  });
}

/** Bars of the phrase the hum fills (0-based, as the completion service counts them), which it keeps. */
export const keptBars = (hummedBars: number): number[] => Array.from({ length: hummedBars }, (_, i) => i);

/** The hummed bars as hummed, the other bars from the completion. */
export function mergeCompletion(hummed: readonly BeatNote[], hummedBars: number, completion: readonly BeatNote[]): BeatNote[] {
  const end = hummedBars * 4;
  const added = completion
    .filter((n) => n.beat >= end && n.beat < PHRASE_BARS * 4)
    .map((n) => ({ beat: n.beat, midi: n.midi, duration: Math.min(n.duration, PHRASE_BARS * 4 - n.beat) }));
  return [...hummed, ...added].sort((a, b) => a.beat - b.beat);
}

/** Chords for an edited 8-bar melody: the fitter's recommendation for all 8 bars (the "Re-fit chords" button). */
export function refitChords(melody: readonly BeatNote[], key: Transcription['key']): { slots: string[]; chords: string[] } {
  const model = hum.loadChordFitModel();
  const tonic = majorTonicOf(key);
  const best = hum.harmonize(melody, PHRASE_BARS, tonic, model.prior, model.known, model.params).alternatives[0]!;
  return { slots: [...best.slots], chords: best.slots.map((id) => hum.chordSymbol(hum.chordFromId(id), tonic)) };
}

/**
 * Every chord the fitter knows, as symbols in the song key, ranked by how well it fits the melody in one half bar.
 * `bars`: the phrase length (the hum editor's 8; a melody library pattern with a lead-in bar has 9).
 */
export function chordOptions(melody: readonly BeatNote[], slot: number, key: Transcription['key'], bars: number = PHRASE_BARS): { chord: string; fit: number }[] {
  const slots = bars * 2;
  if (!Number.isInteger(slot) || slot < 0 || slot >= slots) throw new Error(`hum: the half bar must be 0..${slots - 1}, got ${slot}`);
  const model = hum.loadChordFitModel();
  const tonic = majorTonicOf(key);
  // The fitter weighs at most 8 bars: a longer phrase is seen through the 8 bars that end with the slot's bar (only
  // the notes around a half bar weigh on it).
  const shift = Math.max(0, Math.floor(slot / 2) - (PHRASE_BARS - 1));
  const seen = shift === 0 ? melody : melody.filter((n) => n.beat >= shift * 4).map((n) => ({ ...n, beat: n.beat - shift * 4 }));
  const w = hum.slotWeights(seen, Math.min(bars, PHRASE_BARS), model.params.fit, 'empty')[slot - shift * 2]!;
  return model.prior.vocab
    .map((id, i) => ({ i, chord: hum.chordSymbol(hum.chordFromId(id), tonic), fit: hum.fitScore(w, hum.chordFromId(id), tonic, model.params.fit) }))
    .sort((a, b) => b.fit - a.fit || a.i - b.i)
    .map(({ chord, fit }) => ({ chord, fit }));
}

/** Chord symbols in the song key → the fitter's chord ids ("deg:quality"); throws on a chord it cannot read. */
export function slotsOfChords(chords: readonly string[], key: Transcription['key']): string[] {
  const tonic = majorTonicOf(key);
  return chords.map((c) => hum.chordId(hum.parseChordSymbol(c, tonic)));
}

/**
 * The notes of the kept bars from `prompt`, the other bars from the completion; a note running into the next note is
 * cut where that note starts, and nothing runs past bar 8.
 */
export function mergeKept(prompt: readonly BeatNote[], keepBars: readonly number[], completion: readonly BeatNote[]): BeatNote[] {
  const kept = new Set(keepBars);
  const end = PHRASE_BARS * 4;
  const barOf = (n: BeatNote) => Math.floor(n.beat / 4);
  const notes = [
    ...prompt.filter((n) => kept.has(barOf(n))),
    ...completion.filter((n) => n.beat >= 0 && n.beat < end && !kept.has(barOf(n))),
  ].sort((a, b) => a.beat - b.beat);
  return notes.map((n, i) => {
    const next = notes[i + 1];
    return { beat: n.beat, midi: n.midi, duration: Math.min(n.duration, (next ? next.beat : end) - n.beat) };
  }).filter((n) => n.duration > 0);
}
