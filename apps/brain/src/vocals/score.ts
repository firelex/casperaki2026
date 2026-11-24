// A section's lead vocal as a SoulX-Singer score (docs/superpowers/specs/2026-11-24-sung-vocals-design.md §2).
//
// The lead "Vocal" track's notes, in order, at their written MIDI pitch (the voice's octave is applied by the
// singing service), timed in seconds by the song tempo, each with its syllable's phonemes (the lyric bank's
// ARPAbet, `vocaloidPhonemes`, as one SoulX English syllable `en_K-IH0-NG`). Gaps are rests (`<SP>`).
//
// Phrases: one SoulX call per lyric line (the lyric bank writes one line per 4 bars), split earlier at a rest of a
// beat or more, so legato lines are sung whole. (`endOfPhrase` marks every bar's last note, a legacy invariant, so
// it is not used.) A phrase may start with a short rest (up to LEAD_REST_SEC, within the gap before it) so the
// singer can breathe in. Every note is sung as a note (SoulX note type 2): the lyric bank gives every note a
// syllable.

import { createHash } from 'node:crypto';

import { stableStringify, type Song } from '@casperaki/song-schema';

export const LEAD_VOCAL = 'Vocal';
const BEATS_PER_BAR = 4;
const LINE_BARS = 4;
/** A rest at least this long (beats) ends a phrase. */
const SPLIT_REST_BEATS = 1;
/** Rest sung before a phrase's first note, at most (seconds), within the gap before it. */
const LEAD_REST_SEC = 0.25;
/** Rests shorter than this (seconds) are absorbed into the note before them. */
const MIN_REST_SEC = 0.02;

export interface Phrase {
  /** Seconds from the section start. */
  readonly startSec: number;
  readonly phoneme: string[];
  /** Seconds, one per phoneme entry. */
  readonly duration: number[];
  /** MIDI as written (0 = rest). */
  readonly notePitch: number[];
  /** 1 rest, 2 note. */
  readonly noteType: number[];
}

export interface SectionScore {
  readonly segment: string;
  readonly lengthSec: number;
  readonly phrases: Phrase[];
}

/** Model and settings a take is sung with; part of every take's fingerprint (`level`: how the take's loudness is set). */
export const TAKE_SETTINGS = { model: 'soulx-singer', steps: 32, level: 'gain-17lufs', format: 'ogg' } as const;

/** ARPAbet phonemes of one syllable (`['k', 'ih0', 'ng']`) as a SoulX English syllable (`en_K-IH0-NG`). */
export function soulxPhones(arpabet: readonly string[]): string {
  if (arpabet.length === 0) throw new Error('soulxPhones: a syllable with no phonemes');
  return `en_${arpabet.map((p) => p.toUpperCase()).join('-')}`;
}

interface SungNote {
  readonly bar: number;
  readonly startBeat: number;
  readonly endBeat: number;
  readonly note: number;
  readonly phones: string;
}

/** A vocal track's score for the section (the lead "Vocal" unless a backing track is named), or undefined when
 *  the section has no notes on that track. */
export function sectionScore(song: Song, segment: string, track: string = LEAD_VOCAL): SectionScore | undefined {
  const seg = song.songStructure.find((s) => s.name === segment);
  if (!seg) throw new Error(`sectionScore: the song has no section "${segment}"`);
  const bars = seg.lengthInBars ?? seg.bars.length;
  const secPerBeat = 60 / song.bpm;
  const sectionBeats = bars * BEATS_PER_BAR;

  const notes: SungNote[] = [];
  (song.arrangement[segment]?.overrides?.[track]?.bars ?? []).slice(0, bars).forEach((bar, barIdx) => {
    for (const [beat, evs] of Object.entries(bar.notes ?? {})) {
      for (const raw of evs ?? []) {
        const e = raw as { type?: string; note?: unknown; duration?: unknown; vocaloidPhonemes?: unknown };
        if (e.type !== 'vocalNote') continue;
        if (typeof e.note !== 'number' || typeof e.duration !== 'number' || !(e.duration > 0)) {
          throw new Error(`sectionScore: ${segment} bar ${barIdx + 1} beat ${beat}: a vocal note needs a MIDI note and a positive duration`);
        }
        if (!Array.isArray(e.vocaloidPhonemes) || e.vocaloidPhonemes.length === 0) {
          throw new Error(`sectionScore: ${segment} bar ${barIdx + 1} beat ${beat}: the sung note has no phonemes (vocaloidPhonemes)`);
        }
        const startBeat = barIdx * BEATS_PER_BAR + Number.parseFloat(beat);
        notes.push({ bar: barIdx, startBeat, endBeat: startBeat + e.duration, note: e.note, phones: soulxPhones(e.vocaloidPhonemes as string[]) });
      }
    }
  });
  if (notes.length === 0) return undefined;
  notes.sort((a, b) => a.startBeat - b.startBeat);
  for (let i = 1; i < notes.length; i++) {
    if (notes[i]!.startBeat === notes[i - 1]!.startBeat) {
      throw new Error(`sectionScore: ${segment} bar ${notes[i]!.bar + 1}: two lead vocal notes start together (the lead sings one note at a time)`);
    }
  }

  // Group into phrases: a new lyric line, or a rest of a beat or more, starts one.
  const groups: SungNote[][] = [];
  notes.forEach((n, i) => {
    const prev = notes[i - 1];
    const newLine = prev === undefined || Math.floor(n.bar / LINE_BARS) !== Math.floor(prev.bar / LINE_BARS);
    const rest = prev !== undefined && n.startBeat - Math.min(prev.endBeat, n.startBeat) >= SPLIT_REST_BEATS;
    if (newLine || rest) groups.push([]);
    groups[groups.length - 1]!.push(n);
  });

  let previousEndSec = 0;
  const phrases = groups.map((g, gi): Phrase => {
    const firstSec = g[0]!.startBeat * secPerBeat;
    const lead = Math.min(LEAD_REST_SEC, firstSec - previousEndSec);
    const p: { phoneme: string[]; duration: number[]; notePitch: number[]; noteType: number[] } = { phoneme: [], duration: [], notePitch: [], noteType: [] };
    const push = (ph: string, d: number, pitch: number, type: number) => {
      p.phoneme.push(ph);
      p.duration.push(round(d));
      p.notePitch.push(pitch);
      p.noteType.push(type);
    };
    if (lead >= MIN_REST_SEC) push('<SP>', lead, 0, 1);
    let endSec = firstSec;
    g.forEach((n, i) => {
      const next = g[i + 1];
      const startSec = n.startBeat * secPerBeat;
      // A gap since the last note is a rest; a short one goes to the note before it.
      const gap = startSec - endSec;
      if (gap >= MIN_REST_SEC) push('<SP>', gap, 0, 1);
      else if (gap > 0 && p.duration.length) p.duration[p.duration.length - 1] = round(p.duration[p.duration.length - 1]! + gap);
      // A note lasts until the next note at most, and never past the section's end.
      const limitBeat = Math.min(next ? next.startBeat : Infinity, sectionBeats, groups[gi + 1]?.[0]?.startBeat ?? Infinity);
      const endBeat = Math.min(n.endBeat, limitBeat);
      push(n.phones, (endBeat - n.startBeat) * secPerBeat, n.note, 2);
      endSec = endBeat * secPerBeat;
    });
    const startSec = firstSec - (lead >= MIN_REST_SEC ? lead : 0);
    previousEndSec = endSec;
    return { startSec: round(startSec), ...p };
  });
  return { segment, lengthSec: sectionBeats * secPerBeat, phrases };
}

/** The take's fingerprint: what it was sung from (score, voice, settings) and its take number. A backing take
 *  (sung at another level) adds its role, so it never stands for a lead take with the same notes. */
export function takeFingerprint(score: SectionScore, voice: string, takeNumber: number, role: 'lead' | 'backing' = 'lead'): string {
  const what = { v: 1, settings: TAKE_SETTINGS, voice, takeNumber, lengthSec: round(score.lengthSec), phrases: score.phrases, ...(role === 'backing' ? { role } : {}) };
  return createHash('sha256').update(stableStringify(what)).digest('hex');
}

const round = (x: number) => Math.round(x * 1e4) / 1e4;
