// Scale: key + diatonic helpers.
//
// Major and minor scales as 7-pitch-class sets relative to a tonic. The
// brain uses these for: relative-to-key transposition of noteRelative
// events, validating that generated chords come from the diatonic palette,
// and picking melody pitches that fit the current key.

export type ScaleMode = 'major' | 'minor';

const MAJOR_INTERVALS: readonly number[] = [0, 2, 4, 5, 7, 9, 11];
const MINOR_INTERVALS: readonly number[] = [0, 2, 3, 5, 7, 8, 10];

export interface ParsedKey {
  tonic: number; // pitch class 0..11
  mode: ScaleMode;
}

const KEY_REGEX = /^([A-Ga-g])([#b]?)(m|M|min|maj|minor|major)?$/u;

import { LETTER_TO_PITCH_CLASS_ALIAS } from './chord-internals.js';

export function parseKey(key: string): ParsedKey {
  const m = KEY_REGEX.exec(key);
  if (!m) throw new Error(`parseKey: cannot parse "${key}"`);
  const letter = m[1]!.toUpperCase();
  const accidental = m[2] ?? '';
  const modeRaw = m[3] ?? '';
  let tonic = LETTER_TO_PITCH_CLASS_ALIAS[letter]!;
  if (accidental === '#') tonic = (tonic + 1) % 12;
  else if (accidental === 'b') tonic = (tonic + 11) % 12;
  // Single-char 'm' (lowercase) = minor; 'M' (uppercase) = major.
  // Longer forms ('min', 'minor', 'maj', 'major') are case-insensitive.
  let isMinor: boolean;
  if (modeRaw === 'm') isMinor = true;
  else if (modeRaw === 'M') isMinor = false;
  else {
    const lower = modeRaw.toLowerCase();
    isMinor = lower === 'min' || lower === 'minor';
  }
  return { tonic, mode: isMinor ? 'minor' : 'major' };
}

export function scalePitchClasses(key: ParsedKey): readonly number[] {
  const intervals = key.mode === 'major' ? MAJOR_INTERVALS : MINOR_INTERVALS;
  return intervals.map((i) => (key.tonic + i) % 12);
}

/** Returns the pitch class for the given 1-based scale degree (1..7). */
export function degreePitchClass(key: ParsedKey, degree: number): number {
  if (degree < 1 || degree > 7)
    throw new Error(`degreePitchClass: degree ${degree} out of range`);
  const intervals = key.mode === 'major' ? MAJOR_INTERVALS : MINOR_INTERVALS;
  return (key.tonic + intervals[degree - 1]!) % 12;
}

export function isInScale(key: ParsedKey, pitchClass: number): boolean {
  return scalePitchClasses(key).includes(pitchClass % 12);
}
