// Words for Add rap vocals (docs/superpowers/specs/2026-11-27-rap-vocals-design.md): ACE-Step raps gibberish without
// words, so the sections the user left empty get words from the language model. One line per two bars
// (rapLineCount), rhyming in couplets (lines 1-2, 3-4, …), every word in our pronunciation dictionary, 6 to 16
// syllables a line. Wrong lines go back to the model with what is wrong; still wrong after MAX_ROUNDS answers: an error.
// The prompt is plain English for the model.

import { pronounce, wordsOf, wordsRhyme } from '@casperaki/arrangement';
import { z } from 'zod';

import type { ChatMessage, ChatModel } from '../llm/chatModel.js';

export const MAX_ROUNDS = 6;
/** The last rounds let the model reason. */
export const REASONING_ROUNDS = 2;
export const MIN_RAP_SYLLABLES = 6;
export const MAX_RAP_SYLLABLES = 16;

export interface RapWordsRequest {
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

function brief(r: RapWordsRequest): string {
  const parts = r.sections.map((s) => `${s.label} (${s.lines} line${s.lines === 1 ? '' : 's'})`).join(', ');
  return [
    `Write the words of a rap part for a pop song called "${r.title}". A rapper performs it over the song, in these parts of the song: ${parts}.`,
    ...(r.style.trim() ? [`The rap's style: ${r.style.trim()}.`] : []),
    ...(r.songWords.length
      ? ['What the singer sings in the song (the rap goes with it: the same story and feeling, seen from another side; do not repeat these lines):', ...r.songWords.map((l) => `  ${l}`)]
      : []),
    'How to write it:',
    '- Every line takes two bars of music, so it has 6 to 16 syllables, most of them 9 to 13, with a strong, rhythmic flow.',
    '- Lines rhyme in pairs: line 2 rhymes with line 1, line 4 with line 3, and so on (near rhymes are fine, as in real rap).',
    '- Plain, modern, conversational words with attitude: contractions and everyday slang where they fit. Clean: no swearing, no slurs, nothing hateful.',
    '- Use only common English words that are in a dictionary: no made-up words, no numbers written as digits, no sound effects like "skrrt".',
    '- Each part has its own lines: no line is used twice.',
    'Write completely new lines; do not reuse any lines of existing songs.',
    `Answer with JSON only, in this form: ${JSON.stringify({ sections: r.sections.map((s) => ({ name: s.label, lines: Array.from({ length: s.lines }, () => '...') })) })}`,
  ].join('\n');
}

const norm = (w: string) => w.toLowerCase().replace(/[‘’`]/gu, "'").replace(/[^a-z']/gu, '');

/** What is wrong with one part's lines (empty when they are fine), for the model. */
export function rapProblems(lines: readonly string[], count: number): string[] {
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
    if (n < MIN_RAP_SYLLABLES || n > MAX_RAP_SYLLABLES) out.push(`Line ${i + 1} has ${n} syllables; every line needs ${MIN_RAP_SYLLABLES} to ${MAX_RAP_SYLLABLES}.`);
  });
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const a = norm(wordsOf(lines[i]!).at(-1) ?? '');
    const b = norm(wordsOf(lines[i + 1]!).at(-1) ?? '');
    if (!a || !b || !pronounce(a) || !pronounce(b)) continue;
    if (a === b) out.push(`Lines ${i + 1} and ${i + 2} both end on "${a}": end them on two different words that rhyme.`);
    else if (!wordsRhyme(a, b)) out.push(`Lines ${i + 1} and ${i + 2} must rhyme, but "${a}" and "${b}" do not. Rewrite one or both so they end on rhyming words.`);
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
    const problems = r.sections.flatMap((s) => rapProblems(parsed[s.name]!, s.lines).map((p) => `- ${s.label}: ${p}`));
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
