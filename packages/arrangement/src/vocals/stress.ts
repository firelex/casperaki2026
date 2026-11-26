// Stress: which notes want a stressed syllable and which syllables are stressed, ported from the old lyric writer
// (casperaki1 api/v1.0/services/classes/vocals1: LyricsClass.js `_extractMelodyFromSong` grades the notes,
// LyricsTemplatePoetClass.js `_getSyllables` gives the words' rhythm, LyricsTemplatePoetVerseClass.js's filter
// matches them). The old system allowed no clash at all, and neither does this one.
//
// Grades and rhythms use the old marks: '+' stressed, '-' unstressed, '0' either.

export type Stress = '+' | '-' | '0';

/**
 * A length in beats named as the old code named lengths (casperaki1 tools.js convertHitLengthToNoteDuration, ported
 * as it is): the largest power-of-two length that fits ('1' whole = 4 beats, '2' half, '4' quarter, '8' eighth, '16'
 * sixteenth, '32'…), then a '+' for each further half, quarter… of it until the length is reached or passed. So 1.5 is
 * '4+', 1.25 also '4+' (the old code rounded up), 1.75 '4++', 2.5 and 3 '2+', 3.5 '2++', 0.75 '8+', 5 '1+'.
 */
export function legacyDuration(beats: number): string {
  if (!(beats > 0)) throw new Error(`legacyDuration: a note of length ${beats}`);
  const basicHitLength = Math.pow(2, Math.floor(Math.log(beats) / Math.log(2)));
  let name = (1 / basicHitLength * 4).toString();
  let residual = basicHitLength;
  for (let i = 0; beats - residual > 0; i++) {
    residual += Math.pow(0.5, i + 1) * basicHitLength;
    name += '+';
  }
  return name;
}

/** Whether a beat position is a whole number of the given step: the old code's `x / n === Math.floor(x / n)`. */
const whole = (x: number) => x === Math.floor(x);

/**
 * The old grade of one sung note: its length, where it starts in its bar (beat from 0) and the lengths of the notes
 * just before and after it in the same bar (undefined at the bar's start or end). Lengths are named as the old code
 * named them (legacyDuration) and the old switch is applied to the names, branch by branch, as it was.
 *
 * Neighbours are the bar's notes in order whatever the rests between them, as in the old code: its bars listed only
 * notes, a rest between two notes was not an entry of its own (a 'Rest' entry filled only an otherwise empty bar), so
 * the note before a rest had the note after it as its neighbour. A note that started in the bar before is not one.
 *
 * Lengths with no case in the old switch get '0' (either): the whole note '1' (in the old code it kept the grade of
 * the note before it in the bar, or none at all for a bar's first note, an accident of the code) and anything longer
 * ('1+'…), the dotted sixteenth '16+' and the '16++', and notes shorter than a sixteenth.
 */
export function gradeNote(beat: number, duration: number, prev: number | undefined, next: number | undefined): Stress {
  const d = legacyDuration(duration);
  const p = prev === undefined ? undefined : legacyDuration(prev);
  const n = next === undefined ? undefined : legacyDuration(next);
  const is = (x: string | undefined, names: readonly string[]) => x !== undefined && names.includes(x);
  const k = beat;
  switch (d) {
    case '2':
    case '2+':
    case '2++':
      // On the bar's start or not, the old code gave '0' (its '+' and '-' here were commented out).
      return '0';
    case '4':
    case '4+':
    case '4++':
      if (whole(k / 2) || whole((k + 0.5) / 2)) {
        // On beat 1 or 3, or half a beat before beat 2 or 4.
        return is(n, ['1', '2', '2+', '4+']) || is(p, ['8', '16']) ? '0' : '+';
      }
      return (d === '4+' && whole((k + 1) / 2)) || is(p, ['8', '16']) ? '0' : '-';
    case '8':
    case '8+':
    case '8++':
      if (whole(k) || whole(k + 0.25)) {
        // On a beat, or a sixteenth before one.
        return is(n, ['1', '2', '2+', '4', '4+', '8+']) || is(p, ['16']) ? '0' : '+';
      }
      // A dotted eighth half a beat before a beat, or after a sixteenth.
      return (d === '8+' && whole(k + 0.5)) || is(p, ['16']) ? '0' : '-';
    case '16':
      if (whole(k * 2)) return is(n, ['1', '2', '2+', '4', '4+', '8', '8+', '16+']) ? '0' : '+';
      return '-';
    default:
      return '0';
  }
}

export interface BarNote {
  /** Beat in the bar (from 0). */
  readonly beat: number;
  readonly duration: number;
}

/** The grades of one bar's sung notes, in the order given (by beat). */
export function gradeBar(notes: readonly BarNote[]): Stress[] {
  return notes.map((n, i) => gradeNote(n.beat, n.duration, notes[i - 1]?.duration, notes[i + 1]?.duration));
}

/** One-syllable words sung unstressed (the old `_getSyllables` list); every other one-syllable word may go on any
 *  note. */
export const UNSTRESSED_SMALL_WORDS: ReadonlySet<string> = new Set(['a', 'an', 'and', 'but', 'for', 'the', 'this', 'or', 'to']);

/**
 * A word's rhythm, one mark per sung syllable. A word of two or more syllables: its dictionary stress (1 primary
 * '+', 0 none '-', 2 secondary '0'), which is exactly the old syllables.json rhythm (checked over all its words of
 * two syllables or more: 107391 of 107391 agree). A one-syllable word: '-' for the small words above, '0' for any
 * other. A sung contraction ("ev'ry", "fire" in one) has the stress of its sung syllables and follows the same
 * rules ("fire" in one syllable is '0', "ev'ry" is '+-').
 *
 * `key` is the word as the dictionary spells it (lowercase).
 */
export function wordRhythm(key: string, stress: readonly number[]): Stress[] {
  if (stress.length === 0) throw new Error(`wordRhythm: "${key}" has no syllables`);
  if (stress.length === 1) return [UNSTRESSED_SMALL_WORDS.has(key) ? '-' : '0'];
  return stress.map((s) => {
    if (s === 1) return '+';
    if (s === 0) return '-';
    if (s === 2) return '0';
    throw new Error(`wordRhythm: "${key}" has a stress digit ${s}`);
  });
}

/** Whether a syllable of this rhythm may be sung on a note of this grade: the same mark, or either is '0'. */
export const stressFits = (grade: Stress, syllable: Stress) => grade === syllable || grade === '0' || syllable === '0';
