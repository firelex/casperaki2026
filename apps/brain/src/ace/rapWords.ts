// Write rap lyrics (docs/superpowers/specs/2026-11-28-rap-like-singing-design.md): the rap's words from the language
// model. One short line per bar (rapLineCount), rhyming in couplets (lines 1-2, 3-4, …) with a rhyme inside every
// couplet too (owner 2026-11-28: rap needs "a different rhythmic pattern, more internal rhymes, shorter sentences"),
// every word in our pronunciation dictionary, as many syllables a line as RAP_DENSITY says. Wrong lines go back to the model with what is wrong; still wrong after MAX_ROUNDS answers: an error.
// The prompt is plain English for the model.

import { pronounce, wordsOf, wordsRhyme } from '@casperaki/arrangement';
import { RAP_BARS_PER_LINE } from '@casperaki/song-schema';
import { z } from 'zod';

import type { ChatMessage, ChatModel } from '../llm/chatModel.js';

export const MAX_ROUNDS = 6;
/** The last rounds let the model reason. */
export const REASONING_ROUNDS = 2;

/** How dense the rap is: how many bars a line takes, the syllables every line must have, and most lines. */
export interface RapDensity {
  readonly barsPerLine: number;
  readonly syllables: readonly [number, number];
  readonly most: readonly [number, number];
  /** Rhymes every couplet needs inside it, besides its end rhyme. */
  readonly inlineRhymes: number;
}
/** A short line per bar, 8 to 11 syllables (owner 2026-11-28: a line per two bars was "a tad slow"; the 8-line verse
 *  he chose had 9 to 11 syllables a line, 79 in all, and "too many words" when a verse had 11 to 16, 102 in all). */
export const RAP_DENSITY: RapDensity = { barsPerLine: RAP_BARS_PER_LINE, syllables: [8, 11], most: [9, 11], inlineRhymes: 2 };
// Two rhymes inside every couplet (owner 2026-11-28, of a verse with about one: "more a classic rap, more inline rhymes
// would be good but length is good"): the short lines (`syllables`) keep it from running over.

export interface RapWordsRequest {
  readonly density: RapDensity;
  /** The song's title (the rap is about the same thing). */
  readonly title: string;
  /** The rap's style as the user gave it ("male rap vocals, confident hip hop flow"); empty for none. */
  readonly style: string;
  /** The song's own sung words, in song order (for what the song is about); empty for an instrumental. */
  readonly songWords: readonly string[];
  /** The sections to write, in song order: name, how people call it ("Verse 1"), the lines it needs. */
  readonly sections: readonly { readonly name: string; readonly label: string; readonly lines: number }[];
}

const AnswerSchema = z.object({ sections: z.array(z.object({ name: z.string(), lines: z.array(z.string()) })) });

const barsText = (bars: number) => (bars === 1 ? 'one bar' : bars === 2 ? 'two bars' : `${bars} bars`);

function brief(r: RapWordsRequest): string {
  const parts = r.sections.map((s) => `${s.label} (${s.lines} line${s.lines === 1 ? '' : 's'})`).join(', ');
  return [
    `Write the words of a rap part for a pop song called "${r.title}". A rapper performs it over the song, in these parts of the song: ${parts}.`,
    ...(r.style.trim() ? [`The rap's style: ${r.style.trim()}.`] : []),
    ...(r.songWords.length
      ? ['What the singer sings in the song (the rap goes with it: the same story and feeling, seen from another side; do not repeat these lines):', ...r.songWords.map((l) => `  ${l}`)]
      : []),
    'This is rap, not a sung song. Rap is spoken in rhythm over the drums, so its words are written differently from song lyrics:',
    '- Short, punchy phrases: break most lines into two or three short pieces (with commas or full stops) instead of one long flowing sentence.',
    '- A bouncing, syncopated rhythm: mix one-syllable words with longer ones and let the stresses of the words fall in uneven places. Avoid the even, sing-song rhythm of a nursery rhyme or a pop chorus.',
    `- Every line takes ${barsText(r.density.barsPerLine)} of music, so it has ${r.density.syllables[0]} to ${r.density.syllables[1]} syllables, most of them ${r.density.most[0]} to ${r.density.most[1]}. Count them: a longer line will not fit.`,
    '- Lines rhyme in pairs: line 2 rhymes with line 1, line 4 with line 3, and so on (near rhymes are fine, as in real rap).',
    `- Inline rhymes, many of them: besides the rhymes at the ends of the lines, put at least ${r.density.inlineRhymes} rhymes inside each pair of lines: words in the middle of the lines that rhyme with each other or with the end words, as in "No sleep, in deep, the city lights / On repeat, the beat, we own the nights". Rhymes of two or more syllables are best (for example "pocket" and "rocket", or "on the floor" and "wanting more"). Keep the lines short and saying something: the syllable count above still holds.`,
    '- Wordplay, concrete images and punchlines, said with confidence in the first person. No filler sounds such as "oh", "yeah" or "la", and no long held vowels.',
    '- Plain, modern, conversational words with attitude: contractions and everyday slang where they fit. Clean: no swearing, no slurs, nothing hateful.',
    '- Use only common English words that are in a dictionary: no made-up words, no numbers written as digits, no sound effects like "skrrt".',
    '- Each part has its own lines: no line is used twice.',
    'Write completely new lines; do not reuse any lines of existing songs.',
    `Answer with JSON only, in this form: ${JSON.stringify({ sections: r.sections.map((s) => ({ name: s.label, lines: Array.from({ length: s.lines }, () => '...') })) })}`,
  ].join('\n');
}

const norm = (w: string) => w.toLowerCase().replace(/[‘’`]/gu, "'").replace(/[^a-z']/gu, '');

/** Small words that rhyme with everything and say nothing: not counted as internal rhymes. */
const SMALL = new Set(['the', 'and', 'you', 'your', 'are', 'was', 'for', 'with', 'that', 'this', 'from', 'they', 'them', 'she', 'her', 'his', 'its', "it's", 'our', 'but', 'not', 'can', 'will', 'just', 'then', 'than', 'when', 'what', 'who', 'how', 'out', 'into', "i'm", 'all', 'too', 'any', 'one']);

/** The rhymes inside a couplet: pairs of words of its lines that rhyme, other than its two end words with each other
 *  (a word inside a line rhyming with an end word counts). */
export function internalRhymes(a: string, b: string): number {
  const words = (line: string) => wordsOf(line).map(norm).filter(Boolean);
  const wa = words(a);
  const wb = words(b);
  const all = [...wa.map((w, i) => ({ w, end: i === wa.length - 1 })), ...wb.map((w, i) => ({ w, end: i === wb.length - 1 }))]
    .filter((x) => x.w.length >= 3 && !SMALL.has(x.w) && pronounce(x.w));
  let n = 0;
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const x = all[i]!;
      const y = all[j]!;
      if ((x.end && y.end) || x.w === y.w) continue;
      if (wordsRhyme(x.w, y.w)) n++;
    }
  }
  return n;
}

/** What is wrong with one part's lines (empty when they are fine), for the model. */
export function rapProblems(lines: readonly string[], count: number, syllables: readonly [number, number], inline: number): string[] {
  if (lines.length !== count) return [`It needs exactly ${count} lines, but ${lines.length} were written.`];
  const out: string[] = [];
  lines.forEach((line, i) => {
    const words = wordsOf(line);
    const unknown = words.filter((w) => !pronounce(w));
    if (words.length === 0) {
      out.push(`Line ${i + 1} is empty.`);
      return;
    }
    if (unknown.length) {
      out.push(`Line ${i + 1}: these words are not in the dictionary (use other, common English words): ${unknown.join(', ')}.`);
      return;
    }
    const n = words.reduce((a, w) => a + pronounce(w)!.phones.length, 0);
    if (n < syllables[0] || n > syllables[1]) out.push(`Line ${i + 1} has ${n} syllables; every line needs ${syllables[0]} to ${syllables[1]}.`);
  });
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const a = norm(wordsOf(lines[i]!).at(-1) ?? '');
    const b = norm(wordsOf(lines[i + 1]!).at(-1) ?? '');
    if (!a || !b || !pronounce(a) || !pronounce(b)) continue;
    if (a === b) out.push(`Lines ${i + 1} and ${i + 2} both end on "${a}": end them on two different words that rhyme.`);
    else if (!wordsRhyme(a, b)) out.push(`Lines ${i + 1} and ${i + 2} must rhyme, but "${a}" and "${b}" do not. Rewrite one or both so they end on rhyming words.`);
    else {
      const n = internalRhymes(lines[i]!, lines[i + 1]!);
      if (n === 0) {
        out.push(`Lines ${i + 1} and ${i + 2} have no rhyme inside them, only at their ends. Rap needs internal rhymes: put words in the middle of the lines that rhyme with other words of the two lines (${inline} at least).`);
      } else if (n < inline) {
        out.push(`Lines ${i + 1} and ${i + 2} have ${n} rhyme inside them; they need ${inline}: put more words in the middle of the lines that rhyme with other words of the two lines, keeping the lines as short.`);
      }
    }
  }
  return out;
}

function parse(text: string, r: RapWordsRequest): Record<string, string[]> | string {
  let raw: unknown;
  try {
    raw = JSON.parse(text.trim().replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, ''));
  } catch {
    return 'Your last answer was not JSON.';
  }
  const a = AnswerSchema.safeParse(raw);
  if (!a.success) return 'Your last answer did not have a list "sections" of parts, each with a "name" and its "lines".';
  const out: Record<string, string[]> = {};
  for (const s of r.sections) {
    const got = a.data.sections.find((x) => x.name.trim().toLowerCase() === s.label.toLowerCase());
    if (!got) return `Your last answer had no part named "${s.label}".`;
    out[s.name] = got.lines.map((l) => l.trim());
  }
  return out;
}

/** The rap's lines for every requested section (section name → lines). */
export async function writeRapWords(model: ChatModel, r: RapWordsRequest): Promise<Record<string, string[]>> {
  if (r.sections.length === 0) throw new Error('writeRapWords: no sections to write');
  const messages: ChatMessage[] = [
    { role: 'system', content: 'You are a professional rap lyricist who writes rap verses for pop songs. You answer in JSON.' },
    { role: 'user', content: brief(r) },
  ];
  let wrong = '';
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const text = await model.complete(messages, { thinking: round > MAX_ROUNDS - REASONING_ROUNDS });
    const parsed = parse(text, r);
    if (typeof parsed === 'string') {
      wrong = parsed;
      messages.push({ role: 'assistant', content: text }, { role: 'user', content: `${parsed} Answer again, as JSON in exactly the form asked for.` });
      continue;
    }
    const problems = r.sections.flatMap((s) => rapProblems(parsed[s.name]!, s.lines, r.density.syllables, r.density.inlineRhymes).map((p) => `- ${s.label}: ${p}`));
    const seen = new Set<string>();
    for (const s of r.sections) {
      for (const l of parsed[s.name]!) {
        const key = wordsOf(l).map(norm).join(' ');
        if (seen.has(key)) problems.push(`- ${s.label}: the line "${l}" is used twice; write a new one.`);
        seen.add(key);
      }
    }
    if (problems.length === 0) return parsed;
    wrong = problems.join('\n');
    messages.push(
      { role: 'assistant', content: text },
      { role: 'user', content: `Some lines need rewriting:\n${wrong}\nRewrite those lines and keep every other line exactly as it is. Answer with every part again, as JSON in the same form.` },
    );
  }
  throw new Error(`the rap's words: still wrong after ${MAX_ROUNDS} answers from the language model:\n${wrong}`);
}
