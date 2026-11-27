// The length rule (docs/superpowers/specs/2026-11-27-lyrics-first-singing-design.md, "The length rule"): how long a
// syllable may be sung, from its sounds. A syllable that does not end its word is sung short, even when stressed
// ("go" in gotta): holding it would freeze the word half way. A word's last syllable may be held when its vowel can be
// sung long (a long vowel or diphthong, or a vowel running into l, r, m, n or ng: "feel", "night", "home"); one on a
// short vowel ("it", "get", "up") is short to medium. Thresholds are in milliseconds, so the rule holds at any tempo.

import type { LyricLine } from './lyric-lines.js';
import { sungLineSyllables } from './written-lyrics.js';

export type SyllableLength = 'short' | 'medium' | 'any';

/** Under this long: a short note. */
export const SHORT_MS = 300;
/** The shortest note sung, in beats (an eighth; owner, 2026-11-27: sixteenths sang too fast). */
export const SHORTEST_BEATS = 0.5;
/** Under this long: a short-to-medium note. */
export const MEDIUM_MS = 500;

const LONG_VOWELS = new Set(['IY', 'EY', 'AY', 'OY', 'OW', 'UW', 'AW', 'AA', 'AO', 'ER']);
const SONORANTS = new Set(['L', 'R', 'M', 'N', 'NG']);

/** How long a sung syllable may be (`phones`: its ARPAbet, uppercase with stress digits). */
export function syllableLength(phones: readonly string[], endsWord: boolean): SyllableLength {
  const v = phones.findIndex((p) => /\d$/u.test(p));
  if (v < 0) throw new Error(`syllableLength: a syllable with no vowel (${phones.join(' ')})`);
  if (!endsWord) return 'short';
  if (LONG_VOWELS.has(phones[v]!.replace(/\d$/u, ''))) return 'any';
  if (phones.slice(v + 1).some((p) => SONORANTS.has(p))) return 'any';
  return 'medium';
}

/** Whether a note of `durationBeats` at `bpm` suits a syllable of this length. */
export function lengthFits(kind: SyllableLength, durationBeats: number, bpm: number): boolean {
  if (kind === 'any') return true;
  // An eighth is the shortest note sung (recut.ts), so it suits every syllable at any tempo.
  if (durationBeats <= SHORTEST_BEATS) return true;
  const ms = (durationBeats * 60000) / bpm;
  return ms < (kind === 'short' ? SHORT_MS : MEDIUM_MS);
}

/** Syllables of the line sung longer than they may be (plain English, one entry each); empty when all fit. An error
 *  when the line does not fit its notes at all (the line check, checkLyricLine, says why). */
export function lineLengthProblems(text: string, slots: LyricLine, bpm: number, asWritten = false): string[] {
  const sung = sungLineSyllables(text, slots, asWritten);
  if (!sung) throw new Error(`lineLengthProblems: "${text}" does not fit its ${slots.length} notes`);
  return sung.flatMap((s) => {
    const kind = syllableLength(s.phones, s.endsWord);
    if (lengthFits(kind, s.beats, bpm)) return [];
    const ms = Math.round((s.beats * 60000) / bpm);
    const vowel = s.phones.find((p) => /\d$/u.test(p))!.replace(/\d$/u, '').toLowerCase();
    const why = kind === 'short' ? 'it does not end its word' : 'its vowel is short';
    return [`"${s.word}" (the syllable with "${vowel}") is held ${ms} ms, but ${why}, so it must be under ${kind === 'short' ? SHORT_MS : MEDIUM_MS} ms`];
  });
}
