// Checks for lyrics written first (docs/superpowers/specs/2026-11-27-lyrics-first-singing-design.md, step 1): the
// words come before the notes, so there are no slots to fit; what is checked is what the recut needs and what makes
// the words good pop: dictionary words, lines of 4 to 11 syllables, ABCB rhymes, no rhyme word used twice unless it is
// a word of the title or the whole line repeats (owner, 2026-11-27), and an opening that does not start like one of
// the owner's recent songs. Messages are plain English for the language model.

import { rhymeScheme } from './lyric-lines.js';
import { pronounce, wordsOf, wordsRhyme } from './written-lyrics.js';

export const MIN_LINE_SYLLABLES = 4;
export const MAX_LINE_SYLLABLES = 11;
/** An opening is too close to a recent one when it starts with the same three words, or when this share of its words
 *  is in it. */
const SAME_START_WORDS = 3;
const OVERLAP_SHARE = 0.6;

export interface FreeLyricsProblem {
  /** Section type. */
  readonly type: string;
  /** 0-based line, −1 for the whole part. */
  readonly line: number;
  readonly message: string;
}

const norm = (w: string) => w.toLowerCase().replace(/[‘’`]/gu, "'").replace(/[^a-z']/gu, '');
const lastWord = (line: string) => norm(wordsOf(line).at(-1) ?? '');

/** What is wrong with the lyrics (`parts`: section type → lines, in song order; `lineCounts`: lines each part must
 *  have), empty when they are fine. */
export function checkFreeLyrics(
  parts: Readonly<Record<string, readonly string[]>>,
  lineCounts: Readonly<Record<string, number>>,
  title: string,
  recentOpenings: readonly string[],
): FreeLyricsProblem[] {
  const problems: FreeLyricsProblem[] = [];
  const titleWords = new Set(wordsOf(title).map(norm));
  for (const [type, count] of Object.entries(lineCounts)) {
    const lines = parts[type];
    if (!lines || lines.length !== count) {
      problems.push({ type, line: -1, message: `This part needs exactly ${count} lines, but ${lines?.length ?? 0} were written.` });
      continue;
    }
    lines.forEach((text, i) => {
      const words = wordsOf(text);
      const unknown = words.filter((w) => !pronounce(w));
      if (unknown.length > 0) {
        problems.push({ type, line: i, message: `These words are not in the pronunciation dictionary (use other, common English words): ${unknown.join(', ')}.` });
        return;
      }
      const n = words.reduce((a, w) => a + pronounce(w)!.phones.length, 0);
      if (n < MIN_LINE_SYLLABLES || n > MAX_LINE_SYLLABLES) {
        problems.push({ type, line: i, message: `It has ${n} syllables; every line must have ${MIN_LINE_SYLLABLES} to ${MAX_LINE_SYLLABLES}.` });
      }
    });
    // Rhymes (ABCB): each line with the first line of its rhyme group.
    const scheme = rhymeScheme(lines.length);
    scheme.forEach((letter, i) => {
      const first = scheme.indexOf(letter);
      if (first === i) return;
      const a = lastWord(lines[first]!);
      const b = lastWord(lines[i]!);
      if (!a || !b || !pronounce(a) || !pronounce(b)) return;
      if (a === b) {
        if (titleWords.has(a) || lines[first]!.trim() === lines[i]!.trim()) return;
        problems.push({ type, line: i, message: `Lines ${first + 1} and ${i + 1} must rhyme, but both end on "${b}": the same word may end two lines only when it is a word of the song's title or the whole line is repeated. Rewrite line ${i + 1} so it ends on a different word that rhymes with "${a}".` });
      } else if (!wordsRhyme(a, b)) {
        problems.push({ type, line: i, message: `Lines ${first + 1} and ${i + 1} must rhyme, but "${a}" and "${b}" do not (a rhyme has the same vowel sound and a similar ending). Rewrite line ${i + 1}, or both lines, so they end on rhyming words.` });
      }
    });
  }
  // Across the song: a word ends two different lines only when it is a title word or the lines are the same.
  const seen = new Map<string, { type: string; line: number; text: string }>();
  for (const [type, lines] of Object.entries(parts)) {
    if (!(type in lineCounts)) continue;
    lines.forEach((text, i) => {
      const w = lastWord(text);
      if (!w || titleWords.has(w)) return;
      const before = seen.get(w);
      if (!before) {
        seen.set(w, { type, line: i, text });
        return;
      }
      if (before.text.trim() === text.trim()) return;
      const already = problems.some((p) => p.type === type && p.line === i);
      if (!already) problems.push({ type, line: i, message: `"${w}" already ends another line of the song; end this line on a different word (a word may end two lines only when it is a word of the title or the whole line is repeated).` });
    });
  }
  // The opening: the first line of the first part.
  const firstType = Object.keys(parts).find((t) => t in lineCounts);
  const opening = firstType ? parts[firstType]![0] : undefined;
  if (firstType && opening) {
    const mine = wordsOf(opening).map(norm);
    for (const recent of recentOpenings) {
      const theirs = wordsOf(recent).map(norm);
      const sameStart = mine.length >= SAME_START_WORDS && mine.slice(0, SAME_START_WORDS).join(' ') === theirs.slice(0, SAME_START_WORDS).join(' ');
      const shared = mine.filter((w) => theirs.includes(w)).length;
      if (sameStart || (mine.length > 0 && shared / mine.length >= OVERLAP_SHARE)) {
        problems.push({ type: firstType, line: 0, message: `The song's first line is too close to the first line of a recent song ("${recent}"). Start the song in a completely different way: another situation, another image, other words.` });
        break;
      }
    }
  }
  return problems;
}
