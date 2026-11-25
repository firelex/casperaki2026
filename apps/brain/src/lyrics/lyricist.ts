// Song lyrics from the language model (the self-hosted DeepSeek), written to fit the melody
// (docs/superpowers/specs/2026-11-25-vocal-tasks-design.md; the first version: 2026-11-24-written-lyrics-design.md).
//
// One request writes every section asked for. Per lyric line the model gets the exact syllable count, its notes (DA a
// strong note, da a weak one, HOLD a note held for two beats or more, which must carry the end of a word) and what it
// rhymes with (ABCB in groups of four). Every answer is checked (dictionary words, syllable count, stress, held notes,
// rhymes: @casperaki/arrangement checkSectionLyrics), and the lines that pass are read again by the model for grammar
// and sense. Lines that fail either go back to the model with the problems written out. The draft and the first three
// repairs are written without reasoning (seconds each); the last two repairs reason (a minute or so each), which is what
// makes the last stubborn lines come right. Lines still wrong after that: an error naming them. There is no fallback.

import {
  checkSectionLyrics,
  HOLD_BEATS,
  rhymeScheme,
  sungSections,
  writtenLyricsOf,
  type LyricLine,
  type SungSection,
  type WrittenLyrics,
} from '@casperaki/arrangement';
import type { Song } from '@casperaki/song-schema';
import { z } from 'zod';

import type { ChatMessage, ChatModel } from '../llm/chatModel.js';

/** The first draft and up to five repairs. */
export const MAX_ROUNDS = 6;
/** Rounds written without reasoning; the rest reason. */
export const FAST_ROUNDS = 4;

const EPS = 1e-6;

export interface LyricsRequest {
  /** Generator section names to write words for. */
  readonly sections: readonly string[];
  /** The song's title, when it has a real one (the model then writes about it). */
  readonly title?: string;
}

/** Sections whose repeats share their words when the melody is the same. */
const SHARED_TYPES = new Set(['chorus', 'preChorus']);

const TYPE_LABELS: Readonly<Record<string, string>> = { verse: 'Verse', preChorus: 'Pre-chorus', chorus: 'Chorus', bridge: 'Bridge' };

const GENRE_LABELS: Readonly<Record<string, string>> = {
  ballad: 'pop ballad',
  brightPop: 'bright, upbeat pop',
  edm: 'dance-pop (EDM)',
  latin: 'Latin pop',
  organicVibes: 'acoustic, organic pop',
  rock: 'pop-rock',
  schlager: 'Schlager-style sing-along pop',
  urban: 'R&B / urban pop',
};

/** One piece of lyrics the model writes: a section, or a chorus shared by every repeat of it. */
interface Part {
  readonly id: string;
  readonly label: string;
  readonly sections: readonly string[];
  readonly lines: readonly LyricLine[];
}

const markOf = (s: LyricLine[number]) => (s.duration >= HOLD_BEATS - EPS ? 'HOLD' : s.strong ? 'DA' : 'da');
const lineShape = (lines: readonly LyricLine[]) => lines.map((l) => l.map((s) => `${markOf(s)}${s.duration}`).join(' ')).join('|');

function partsOf(sung: readonly SungSection[], wanted: ReadonlySet<string>): Part[] {
  const parts: { id: string; type: string; shape: string; sections: string[]; lines: readonly LyricLine[] }[] = [];
  for (const s of sung) {
    if (!wanted.has(s.name)) continue;
    const shape = lineShape(s.lines);
    const shared = SHARED_TYPES.has(s.type) ? parts.find((p) => p.type === s.type && p.shape === shape) : undefined;
    if (shared) shared.sections.push(s.name);
    else parts.push({ id: s.name, type: s.type, shape, sections: [s.name], lines: s.lines });
  }
  const counts = new Map<string, number>();
  return parts.map((p) => {
    const n = (counts.get(p.type) ?? 0) + 1;
    counts.set(p.type, n);
    const base = TYPE_LABELS[p.type] ?? p.type;
    const sameType = parts.filter((q) => q.type === p.type).length;
    const label = `${base}${sameType > 1 ? ` ${n}` : ''}${p.sections.length > 1 ? ` (sung ${p.sections.length} times, the same words each time)` : ''}`;
    return { id: p.id, label, sections: p.sections, lines: p.lines };
  });
}

function describeLines(lines: readonly LyricLine[]): string[] {
  const scheme = rhymeScheme(lines.length);
  return lines.map((l, i) => {
    const first = scheme.indexOf(scheme[i]!);
    const later = scheme.indexOf(scheme[i]!, i + 1);
    const rhyme =
      first !== i ? `its last word must rhyme with the last word of line ${first + 1}` : later >= 0 ? `line ${later + 1} will rhyme with it` : 'need not rhyme';
    return `  line ${i + 1}: exactly ${l.length} syllables; notes: ${l.map(markOf).join(' ')}; ${rhyme}`;
  });
}

/** The plain-English brief for the model. */
export function lyricsBrief(song: Song, parts: readonly Part[], context: readonly { label: string; words: readonly string[] }[], title: string | undefined): string {
  const genre = (song.genre && GENRE_LABELS[song.genre]) ?? 'pop';
  const sung = sungSections(song);
  const partOf = new Map(parts.flatMap((p) => p.sections.map((s) => [s, p] as const)));
  const contextOf = new Map(context.map((c) => [c.label, c] as const));
  const order: string[] = [];
  const seen = new Set<string>();
  for (const s of sung) {
    const p = partOf.get(s.name);
    if (p) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      order.push(`${p.label}, part id "${p.id}":`, ...describeLines(p.lines), '');
    } else {
      const c = contextOf.get(s.name);
      if (c) order.push(`${TYPE_LABELS[s.type] ?? s.type} (${s.name}), already written, for context only; do not rewrite it:`, ...c.words.map((w) => `  ${w}`), '');
    }
  }
  const example = { [parts[0]!.id]: [{ syllables: ['When/da', 'the/da', 'mor/DA', 'ning/da', 'light/HOLD'], text: 'When the morning light' }, '…'] };
  return [
    `Write the lyrics for a ${genre} song${title ? ` called "${title}"` : ''}.`,
    title ? 'The lyrics are about what the title suggests.' : 'Choose one clear theme or story for the whole song and keep to it.',
    '',
    'The melody is already fixed. Every line of lyrics is sung on a fixed number of notes, one syllable per note, so every line must have exactly the number of syllables given for it: not one more, not one less. Count syllables the way the words are normally spoken: "tonight" has 2, "fire" has 2, "every" has 3, "beautiful" has 3.',
    '',
    'Notes: each line comes with its notes, one mark per syllable, in order. DA is a strong note (on the beat), da a weak one, HOLD a long note held for two beats or more (also strong). Put the stressed syllable of every word of two or more syllables on a strong note, so the words are sung the way they are spoken.',
    '',
    'Held notes: the syllable sung on a HOLD must be the end of its word: a one-syllable word, or the last syllable of a longer word. Never put the first or a middle syllable of a word on a HOLD, because the singer would have to stop in the middle of the word and hold it ("sun" of "sunrise", "to" of "tonight" must never be on a HOLD).',
    '',
    'Rhyme: the lines go in groups of four that rhyme A B C B: only the second and fourth line of each group rhyme, the first and third need not. Each line says what it rhymes with. A rhyme has the same vowel sound and a similar ending, like time / mind, fire / higher, heart / apart. Two rhyming lines may never end on the same word ("old" and "old" is not a rhyme). Lines that need not rhyme should not be forced to: say something natural there. End every line on a strong word, never on "the", "a", "and", "to" or the like.',
    '',
    'Write natural, singable, everyday English, the way a real song in this style sounds. The chorus carries the main idea and the hook, and is the most memorable part; the verses tell the story with concrete details and images; a pre-chorus builds up toward the chorus; a bridge gives a new angle. Each line should make sense on its own and lead into the next. Do not pad lines with filler ("oh yeah", "baby baby") just to reach the syllable count. Use only common English words: no names, no made-up words, no numbers written as digits. The singer may be a man or a woman, so never say what the singer is (no "girl", "boy", "man", "woman" about the singer or the one sung to).',
    '',
    'The song, in order:',
    '',
    ...order,
    'Answer with JSON only, in exactly this form, with every part id listed above and exactly as many lines in each as listed. For every line, first list its syllables one by one, each with the mark of the note it is sung on (so you can check them against the notes), then the line as it is written:',
    JSON.stringify({ parts: example }),
  ].join('\n');
}

const LineSchema = z.object({ syllables: z.array(z.string()).optional(), text: z.string() });
const AnswerSchema = z.object({ parts: z.record(z.string(), z.array(LineSchema)) });
const FixesSchema = z.object({ fixes: z.array(LineSchema.extend({ part: z.string(), line: z.number().int().positive() })) });
const GrammarSchema = z.object({ problems: z.array(z.object({ part: z.string(), line: z.number().int().positive(), reason: z.string() })) });

/** The JSON object in a model answer (code fences allowed), or undefined when there is none. */
function jsonOf(text: string): unknown {
  try {
    return JSON.parse(text.trim().replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, ''));
  } catch {
    return undefined;
  }
}

interface Problem {
  readonly part: string;
  readonly line: number;
  readonly text: string | undefined;
  readonly message: string;
}

/** Per part, per line: what is wrong for the melody (plain English), for the lines that do not fit yet. */
function problemsOf(parts: readonly Part[], current: ReadonlyMap<string, (string | undefined)[]>): Problem[] {
  const out: Problem[] = [];
  for (const p of parts) {
    const lines = current.get(p.id)!;
    const missing = lines.flatMap((t, i) => (t === undefined ? [i] : []));
    for (const i of missing) out.push({ part: p.id, line: i, text: undefined, message: 'This line is missing.' });
    if (missing.length > 0) continue;
    for (const pr of checkSectionLyrics(p.lines, lines as string[])) out.push({ part: p.id, line: pr.line, text: lines[pr.line], message: pr.message });
  }
  return out;
}

const EDITOR_SYSTEM: ChatMessage = { role: 'system', content: 'You are a careful editor of English song lyrics. You answer in JSON.' };

/** The model reads the lyrics again, without reasoning: the lines that are not correct, natural English. */
async function grammarProblems(model: ChatModel, parts: readonly Part[], current: ReadonlyMap<string, (string | undefined)[]>, skip: ReadonlySet<string>): Promise<Problem[]> {
  const text = parts.flatMap((p) => [`Part "${p.id}":`, ...current.get(p.id)!.map((t, i) => `  line ${i + 1}: ${t ?? ''}`), '']);
  const answer = await model.complete(
    [
      EDITOR_SYSTEM,
      {
        role: 'user',
        content: [
          'Read these song lyrics and find the lines that are not correct, natural English.',
          '',
          'Flag a line only when it has a real mistake: it is ungrammatical, a word is missing or in the wrong form ("I have nothing fear", "let me go to day"), the words do not make sense together, or no native speaker would say it that way. Song lyrics may be informal, poetic and short, and a sentence may run on from one line to the next, because the lines follow the melody: judge such lines together and do not flag them for that. Do not flag a line for style, for being plain or for repeating an idea.',
          '',
          ...text,
          'Answer with JSON only, in this form, with an empty list when every line is fine:',
          JSON.stringify({ problems: [{ part: parts[0]!.id, line: 1, reason: 'what is wrong, in a few words' }] }),
        ].join('\n'),
      },
    ],
    { thinking: false },
  );
  const parsed = GrammarSchema.safeParse(jsonOf(answer));
  if (!parsed.success) throw new Error(`the lyrics model's grammar reading was not in the form {"problems": [...]}: ${answer.slice(0, 200)}`);
  return parsed.data.problems
    .filter((g) => current.get(g.part)?.[g.line - 1] !== undefined && !skip.has(`${g.part}|${g.line - 1}`))
    .map((g) => ({
      part: g.part,
      line: g.line - 1,
      text: current.get(g.part)![g.line - 1],
      message: `This is not correct, natural English: ${g.reason.replace(/\.?$/u, '.')} Keep the same notes: the same syllable count, stress, held notes and rhyme.`,
    }));
}

const SONGWRITER_SYSTEM: ChatMessage = {
  role: 'system',
  content: 'You are a professional songwriter. You write English song lyrics that fit an existing melody exactly, syllable for syllable, and you answer in JSON.',
};

/**
 * Words for the asked-for sections of a song (generator names), written by the model to fit their melodies.
 * Repeats of a chorus or pre-chorus with the same melody share their words. Sections already carrying written words
 * (recorded in the generator block) and not asked for are shown to the model as context. Lines that fit are kept;
 * only the others go back to the model.
 */
export async function writeLyrics(song: Song, model: ChatModel, request: LyricsRequest): Promise<WrittenLyrics> {
  const sung = sungSections(song);
  if (sung.length === 0) throw new Error('writeLyrics: the song has no vocal melody to write words for');
  for (const name of request.sections) {
    if (!sung.some((s) => s.name === name)) throw new Error(`writeLyrics: the song has no sung section "${name}"`);
  }
  const parts = partsOf(sung, new Set(request.sections));
  if (parts.length === 0) return {};
  const recorded = writtenLyricsOf((song.generator?.params as { params?: Record<string, unknown> } | undefined)?.params);
  const context = sung.filter((s) => !request.sections.includes(s.name) && recorded[s.name]).map((s) => ({ label: s.name, words: recorded[s.name]! }));

  const brief: ChatMessage = { role: 'user', content: lyricsBrief(song, parts, context, request.title) };
  const current = new Map(parts.map((p) => [p.id, p.lines.map((): string | undefined => undefined)]));
  const take = (part: string, line: number, text: string) => {
    const lines = current.get(part);
    if (lines && line >= 0 && line < lines.length && text.trim()) lines[line] = text.trim();
  };
  /** The lyrics so far, as the model's own answer to the brief. */
  const draft = (): ChatMessage => ({
    role: 'assistant',
    content: JSON.stringify({ parts: Object.fromEntries([...current].map(([id, lines]) => [id, lines.map((t) => ({ text: t ?? '' }))])) }),
  });

  let problems: Problem[] = [];
  let formProblem: string | undefined;
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    // Every repair starts afresh from the brief, the lyrics so far and what is still wrong, so the model does not get
    // stuck on its earlier attempts.
    const messages: ChatMessage[] =
      round === 1
        ? [SONGWRITER_SYSTEM, brief]
        : [
            SONGWRITER_SYSTEM,
            brief,
            draft(),
            {
              role: 'user',
              content: [
                ...(formProblem ? [formProblem, ''] : []),
                'These lines are not right yet:',
                ...problems.map((pr) => `- part "${pr.part}", line ${pr.line + 1}${pr.text !== undefined ? ` ("${pr.text}")` : ''}: ${pr.message}`),
                '',
                'Rewrite only these lines (and, for a rhyme, the other line of the pair if that works better); every other line stays as it is. Keep the meaning and the story, and make every line read naturally. List the syllables of each new line one by one, each with the mark of its note, and count them before you answer. Answer with JSON only, in this form:',
                JSON.stringify({ fixes: [{ part: problems[0]?.part ?? parts[0]!.id, line: (problems[0]?.line ?? 0) + 1, syllables: ['…'], text: '…' }] }),
              ].join('\n'),
            },
          ];
    const text = await model.complete(messages, { thinking: round > FAST_ROUNDS });
    const raw = jsonOf(text);
    formProblem = undefined;
    if (round === 1) {
      const a = AnswerSchema.safeParse(raw);
      if (a.success) for (const [id, lines] of Object.entries(a.data.parts)) lines.forEach((l, i) => take(id, i, l.text));
      else formProblem = 'Your answer was not in the form {"parts": {"<part id>": [{"syllables": [...], "text": "..."}, ...]}}.';
    } else {
      const f = FixesSchema.safeParse(raw);
      if (f.success) for (const fix of f.data.fixes) take(fix.part, fix.line - 1, fix.text);
      else formProblem = 'Your last answer was not in the form {"fixes": [{"part": "<part id>", "line": <line number>, "syllables": [...], "text": "..."}]}.';
    }
    const melody = problemsOf(parts, current);
    // The lines that fit the melody are read for grammar and sense (skipped while lines are missing).
    const grammar = melody.some((p) => p.text === undefined)
      ? []
      : await grammarProblems(model, parts, current, new Set(melody.map((p) => `${p.part}|${p.line}`)));
    problems = [...melody, ...grammar];
    if (problems.length === 0 && !formProblem) {
      const out: Record<string, string[]> = {};
      for (const p of parts) for (const s of p.sections) out[s] = current.get(p.id) as string[];
      return out;
    }
  }
  throw new Error(
    `the lyrics model could not write lines that fit the melody in ${MAX_ROUNDS} tries; still wrong:\n${problems.map((pr) => `- ${pr.part} line ${pr.line + 1}: ${pr.message}`).join('\n')}`,
  );
}
