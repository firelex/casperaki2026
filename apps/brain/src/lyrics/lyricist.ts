// Song lyrics from the language model (the self-hosted DeepSeek), written to fit the melody
// (docs/superpowers/specs/2026-11-25-vocal-tasks-design.md; the first version: 2026-11-24-written-lyrics-design.md).
//
// One request writes every section asked for. Per lyric line the model gets the exact syllable count, its notes
// (each graded by the old lyric writer's stress rules, @casperaki/arrangement stress.ts: S a strong note for a stressed
// syllable, w a weak note for an unstressed one, f a free note for either, HOLD a note held for two beats or more,
// free, which must carry the end of a word) and what it rhymes with (ABCB in groups of four), and it writes several
// versions of every line. The code checks every version (dictionary words, syllable count, stress, held notes:
// checkLyricLine) and keeps those that pass; per line it chooses the first that passes, choosing the two lines of a
// rhyme pair together (the first pair of passing versions that rhyme). The chosen lines are read again by the model
// for grammar and sense; a version it flags is dropped and the next passing one taken. Only lines with no passing
// version left go back to the model, with what was wrong with each version it wrote. The draft and the first three
// repairs are written without reasoning (seconds each); the last two repairs reason. Lines still wrong after that:
// an error naming them. There is no fallback, and every chosen section passes checkSectionLyrics before it is used.

import {
  checkLyricLine,
  checkSectionLyrics,
  HOLD_BEATS,
  rhymeScheme,
  sungSections,
  UNSTRESSED_SMALL_WORDS,
  wordsOf,
  wordsRhyme,
  writtenLyricsOf,
  type LyricLine,
  type SungSection,
  type WrittenLyrics,
} from '@casperaki/arrangement';
import type { Song } from '@casperaki/song-schema';
import { z } from 'zod';

import type { ChatMessage, ChatModel } from '../llm/chatModel.js';

/** The first draft and up to seven repairs. */
export const MAX_ROUNDS = 8;
/** Rounds written without reasoning (a few seconds each); the rest reason (half a minute or more each). */
export const FAST_ROUNDS = 6;
/** Versions the model writes of every line. */
export const VERSIONS = 3;
/** Grammar readings per round at most (a reading that drops a version may bring in another one to read). */
const GRAMMAR_READINGS_PER_ROUND = 3;

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

/** A note's mark for the model: HOLD (a held note: free, and it ends a word), S strong, w weak, f free. */
export const markOf = (s: LyricLine[number]) => (s.duration >= HOLD_BEATS - EPS ? 'HOLD' : s.grade === '+' ? 'S' : s.grade === '-' ? 'w' : 'f');
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

/** The lines of a part as the brief lists them: syllable count, note marks, what each rhymes with. */
export function describeLines(lines: readonly LyricLine[]): string[] {
  const scheme = rhymeScheme(lines.length);
  return lines.map((l, i) => {
    const first = scheme.indexOf(scheme[i]!);
    const later = scheme.indexOf(scheme[i]!, i + 1);
    const rhyme =
      first !== i ? `its last word must rhyme with the last word of line ${first + 1}` : later >= 0 ? `line ${later + 1} will rhyme with it` : 'need not rhyme';
    return `  line ${i + 1}: exactly ${l.length} syllables; notes: ${l.map(markOf).join(' ')}; ${rhyme}`;
  });
}

const SMALL_WORDS = [...UNSTRESSED_SMALL_WORDS].map((w) => `"${w}"`).join(', ');

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
  const example = {
    lines: [
      {
        part: parts[0]!.id,
        line: 1,
        versions: [
          { syllables: ['When/w', 'the/w', 'mor/S', 'ning/w', 'light/HOLD'], text: 'When the morning light' },
          { syllables: ['And/w', 'the/f', 'sun/S', 'comes/w', 'through/HOLD'], text: 'And the sun comes through' },
          { syllables: ['…'], text: '…' },
        ],
      },
      { part: parts[0]!.id, line: 2, versions: ['…'] },
      '…',
    ],
  };
  return [
    `Write the lyrics for a ${genre} song${title ? ` called "${title}"` : ''}.`,
    title ? 'The lyrics are about what the title suggests.' : 'Choose one clear theme or story for the whole song and keep to it.',
    '',
    'The melody is already fixed. Every line of lyrics is sung on a fixed number of notes, one syllable per note, so every line must have exactly the number of syllables given for it: not one more, not one less. Count syllables the way the words are normally spoken: "tonight" has 2, "fire" has 2, "every" has 3, "beautiful" has 3.',
    '',
    'Stress: each line comes with its notes, one mark per syllable, in order. Every word of two or more syllables has one stressed syllable, the one said loudest: to-NIGHT, BEAU-ti-ful, MOR-ning, be-COME, IN-to is wrong because it is in-TO. The marks say which syllable may go on which note:',
    '- S is a strong note: it needs the stressed syllable of a longer word, or a one-syllable word. Never put an unstressed syllable of a longer word (the "to" of "tonight", the "ing" of "morning") on an S.',
    '- w is a weak note: it needs an unstressed syllable of a longer word, or a one-syllable word. Never put the stressed syllable of a longer word (the "night" of "tonight", the "mor" of "morning") on a w.',
    '- f is a free note: any syllable may go on it.',
    '- HOLD is a long note held for two beats or more: any syllable may go on it, but it must be the end of its word (see below).',
    `- One-syllable words may go on any note (S, w, f or HOLD), except these small unstressed words, which may not go on an S: ${SMALL_WORDS}.`,
    '- A syllable with only a light stress, like "walk" in "sidewalk" or "noon" in "afternoon" being the main stress but "af" a light one, may go on any note; only the main stressed syllable and the fully unstressed syllables are bound by S and w.',
    'So "tonight" fits on w S, w f, f S or f f, but not on S w. Check every word of every line against its marks.',
    '',
    'Held notes: the syllable sung on a HOLD must be the end of its word: a one-syllable word, or the last syllable of a longer word. Never put the first or a middle syllable of a word on a HOLD, because the singer would have to stop in the middle of the word and hold it ("sun" of "sunrise", "to" of "tonight" must never be on a HOLD).',
    '',
    'Rhyme: the lines go in groups of four that rhyme A B C B: only the second and fourth line of each group rhyme, the first and third need not. Each line says what it rhymes with. A rhyme has the same vowel sound and a similar ending, like time / mind, fire / higher, heart / apart. Two rhyming lines may never end on the same word ("old" and "old" is not a rhyme). Lines that need not rhyme should not be forced to: say something natural there. End every line on a strong word, never on "the", "a", "and", "to" or the like.',
    '',
    'Write natural, singable, everyday English, the way a real song in this style sounds. The chorus carries the main idea and the hook, and is the most memorable part; the verses tell the story with concrete details and images; a pre-chorus builds up toward the chorus; a bridge gives a new angle. Each line should make sense on its own and lead into the next. Do not pad lines with filler ("oh yeah", "baby baby") just to reach the syllable count. Use only common English words: no names, no made-up words, no numbers written as digits. The singer may be a man or a woman, so never say what the singer is (no "girl", "boy", "man", "woman" about the singer or the one sung to).',
    '',
    `Versions: write ${VERSIONS} different versions of every line, each one complete and correct on its own (syllable count, stress marks, held notes) and each one fitting the song at that place: they may say the same thing in other words, or something a little different. The first version is the one you like best. Every version of a line that must rhyme should rhyme with the versions of its partner line, so that any of them can be chosen.`,
    '',
    'The song, in order:',
    '',
    ...order,
    `Answer with JSON only, in exactly this form: one list "lines" with an entry for every line of every part listed above, in order (its part id and its line number), each with ${VERSIONS} versions. For every version, first list its syllables one by one, each with the mark of the note it is sung on (so you can check the count, the stress and the held notes), then the line as it is written:`,
    JSON.stringify(example),
  ].join('\n');
}

const VersionSchema = z.object({ syllables: z.array(z.string()).optional(), text: z.string() });
/** The model's answer, to the brief and to every repair request alike: versions per line of a part. */
const AnswerSchema = z.object({ lines: z.array(z.object({ part: z.string(), line: z.number().int().positive(), versions: z.array(VersionSchema).min(1) })) });
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
  readonly message: string;
}

/** Everything known about one line: the versions that passed the melody checks, in the order written, and why the
 *  others failed (the last round's only, for the repair request). */
interface LineState {
  readonly passing: string[];
  failed: { text: string; message: string }[];
  /** Versions the grammar reading flagged: text → reason. */
  readonly rejected: Map<string, string>;
  /** Versions the grammar reading has passed. */
  readonly approved: Set<string>;
}

const lastWord = (t: string) => wordsOf(t).at(-1);

/** Two lines' last words rhyme (and are not the same word). */
const linesRhyme = (a: string, b: string) => {
  const x = lastWord(a);
  const y = lastWord(b);
  return x !== undefined && y !== undefined && wordsRhyme(x, y);
};

/** The rhyme pairs and single lines of a part (ABCB: lines 2 and 4 of each four; ABA: 1 and 3; AA: 1 and 2). */
function rhymeGroups(lineCount: number): number[][] {
  const scheme = rhymeScheme(lineCount);
  const groups = new Map<string, number[]>();
  scheme.forEach((letter, i) => groups.set(letter, [...(groups.get(letter) ?? []), i]));
  return [...groups.values()];
}

/**
 * The version chosen for each line of a part (undefined where none can be), and the problems where none can: per line
 * the first passing version the grammar reading has not flagged; for a rhyme pair, the first two such versions that
 * rhyme (fewest versions passed over in both lines together, then the earlier one in the first line).
 */
function choose(part: Part, state: readonly LineState[]): { chosen: (string | undefined)[]; problems: Problem[] } {
  const chosen: (string | undefined)[] = part.lines.map(() => undefined);
  const problems: Problem[] = [];
  const usable = (i: number) => state[i]!.passing.filter((t) => !state[i]!.rejected.has(t));
  const missing = (i: number): Problem => {
    const s = state[i]!;
    const tried = [...s.failed.map((f) => `"${f.text}": ${f.message}`), ...[...s.rejected].map(([t, reason]) => `"${t}": ${reason}`)];
    return {
      part: part.id,
      line: i,
      message: tried.length > 0 ? `No version fits yet. The versions so far and what is wrong with each:\n${tried.map((t) => `    - ${t}`).join('\n')}` : 'This line is missing.',
    };
  };
  for (const group of rhymeGroups(part.lines.length)) {
    if (group.length === 1) {
      const [i] = group as [number];
      const u = usable(i);
      if (u.length > 0) chosen[i] = u[0];
      else problems.push(missing(i));
      continue;
    }
    if (group.length !== 2) throw new Error(`lyricist: a rhyme group of ${group.length} lines in ${part.id}`);
    const [i, j] = group as [number, number];
    const a = usable(i);
    const b = usable(j);
    if (a.length === 0) problems.push(missing(i));
    if (b.length === 0) problems.push(missing(j));
    if (a.length === 0 || b.length === 0) continue;
    let best: [number, number] | undefined;
    a.forEach((x, ia) =>
      b.forEach((y, ib) => {
        if (!linesRhyme(x, y)) return;
        if (!best || ia + ib < best[0] + best[1] || (ia + ib === best[0] + best[1] && ia < best[0])) best = [ia, ib];
      }),
    );
    if (best) {
      chosen[i] = a[best[0]];
      chosen[j] = b[best[1]];
    } else {
      const ends = (xs: readonly string[]) => [...new Set(xs.map((x) => `"${lastWord(x)}"`))].join(', ');
      problems.push({
        part: part.id,
        line: j,
        message: `Lines ${i + 1} and ${j + 1} must rhyme, but no version of one rhymes with a version of the other (a rhyme has the same vowel sound and a similar ending, and is not the same word). The versions of line ${i + 1} end on ${ends(a)}; those of line ${j + 1} on ${ends(b)}. Write new versions of line ${j + 1} that end on a word rhyming with one of line ${i + 1}'s, or new versions of both lines.`,
      });
    }
  }
  return { chosen, problems };
}

const EDITOR_SYSTEM: ChatMessage = { role: 'system', content: 'You are a careful editor of English song lyrics. You answer in JSON.' };

/** The model reads the chosen lyrics, without reasoning: the lines that are not correct, natural English. Lines it
 *  has passed before are shown for context and not judged again. */
async function grammarFlags(
  model: ChatModel,
  parts: readonly Part[],
  chosen: ReadonlyMap<string, (string | undefined)[]>,
  state: ReadonlyMap<string, readonly LineState[]>,
): Promise<{ part: string; line: number; text: string; reason: string }[]> {
  const text = parts.flatMap((p) => [`Part "${p.id}":`, ...chosen.get(p.id)!.map((t, i) => `  line ${i + 1}: ${t ?? '(not written yet)'}`), '']);
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
  return parsed.data.problems.flatMap((g) => {
    const t = chosen.get(g.part)?.[g.line - 1];
    if (t === undefined || state.get(g.part)![g.line - 1]!.approved.has(t)) return [];
    return [{ part: g.part, line: g.line - 1, text: t, reason: g.reason }];
  });
}

const SONGWRITER_SYSTEM: ChatMessage = {
  role: 'system',
  content: 'You are a professional songwriter. You write English song lyrics that fit an existing melody exactly, syllable for syllable and stress for stress, and you answer in JSON.',
};

/** Numbers about one writing run, for logs and measurements. */
export interface LyricsRun {
  /** Writing requests (the draft and repairs). */
  writes: number;
  /** Grammar readings. */
  readings: number;
  /** Versions received, and how many passed the melody checks. */
  versions: number;
  passing: number;
}

/**
 * Words for the asked-for sections of a song (generator names), written by the model to fit their melodies.
 * Repeats of a chorus or pre-chorus with the same melody share their words. Sections already carrying written words
 * (recorded in the generator block) and not asked for are shown to the model as context. `run`, when given, is
 * filled with the number of requests and versions.
 */
export async function writeLyrics(song: Song, model: ChatModel, request: LyricsRequest, run?: LyricsRun): Promise<WrittenLyrics> {
  const sung = sungSections(song);
  if (sung.length === 0) throw new Error('writeLyrics: the song has no vocal melody to write words for');
  for (const name of request.sections) {
    if (!sung.some((s) => s.name === name)) throw new Error(`writeLyrics: the song has no sung section "${name}"`);
  }
  const parts = partsOf(sung, new Set(request.sections));
  if (parts.length === 0) return {};
  const recorded = writtenLyricsOf((song.generator?.params as { params?: Record<string, unknown> } | undefined)?.params);
  const context = sung.filter((s) => !request.sections.includes(s.name) && recorded[s.name]).map((s) => ({ label: s.name, words: recorded[s.name]! }));
  const stats: LyricsRun = run ?? { writes: 0, readings: 0, versions: 0, passing: 0 };

  const brief: ChatMessage = { role: 'user', content: lyricsBrief(song, parts, context, request.title) };
  const partById = new Map(parts.map((p) => [p.id, p]));
  const state = new Map(parts.map((p) => [p.id, p.lines.map((): LineState => ({ passing: [], failed: [], rejected: new Map(), approved: new Set() }))]));
  /** Lines the model wrote versions for in this round: their earlier failures are replaced by this round's. */
  const touched = new Set<LineState>();
  /** A version the model wrote for a line: kept when it passes the melody checks, else its problem is noted. */
  const take = (partId: string, line: number, text: string) => {
    const p = partById.get(partId);
    const s = state.get(partId)?.[line];
    const t = text.trim();
    if (!p || !s || !t) return;
    if (!touched.has(s)) {
      touched.add(s);
      s.failed = [];
    }
    stats.versions++;
    if (s.passing.includes(t)) return;
    const problem = checkLyricLine(t, p.lines[line]!);
    if (problem) s.failed.push({ text: t, message: problem });
    else {
      s.passing.push(t);
      stats.passing++;
    }
  };
  const chooseAll = () => {
    const chosen = new Map<string, (string | undefined)[]>();
    const problems: Problem[] = [];
    for (const p of parts) {
      const c = choose(p, state.get(p.id)!);
      chosen.set(p.id, c.chosen);
      problems.push(...c.problems);
    }
    return { chosen, problems };
  };
  /** The lyrics chosen so far, as the model's own answer to the brief (a line not chosen yet with no version). */
  const draft = (chosen: ReadonlyMap<string, (string | undefined)[]>): ChatMessage => ({
    role: 'assistant',
    content: JSON.stringify({ lines: [...chosen].flatMap(([id, lines]) => lines.map((t, i) => ({ part: id, line: i + 1, versions: t === undefined ? [] : [{ text: t }] }))) }),
  });

  let problems: Problem[] = [];
  let chosen = new Map<string, (string | undefined)[]>();
  let formProblem: string | undefined;
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    // Every repair starts afresh from the brief, the lyrics chosen so far and what is still wrong, so the model does
    // not get stuck on its earlier attempts.
    const messages: ChatMessage[] =
      round === 1
        ? [SONGWRITER_SYSTEM, brief]
        : [
            SONGWRITER_SYSTEM,
            brief,
            draft(chosen),
            {
              role: 'user',
              content: [
                ...(formProblem ? [formProblem, ''] : []),
                'These lines are not right yet:',
                ...problems.map((pr) => `- part "${pr.part}", line ${pr.line + 1}: ${pr.message}`),
                '',
                `Write ${VERSIONS} new versions of each of these lines (and, for a rhyme, of the other line of the pair if that works better); every other line stays as it is. Keep the meaning and the story, and make every version read naturally. List the syllables of each version one by one, each with the mark of its note, and check the count, the stress (S, w, f) and the held notes before you answer. Answer with JSON only, in this form:`,
                JSON.stringify({ lines: [{ part: problems[0]?.part ?? parts[0]!.id, line: (problems[0]?.line ?? 0) + 1, versions: [{ syllables: ['…'], text: '…' }] }] }),
              ].join('\n'),
            },
          ];
    touched.clear();
    // A round after which every line was chosen but some were not read yet (the readings ran out) only reads them.
    const write = round === 1 || problems.length > 0 || formProblem !== undefined;
    const raw = write ? jsonOf(await model.complete(messages, { thinking: round > FAST_ROUNDS })) : undefined;
    if (write) stats.writes++;
    formProblem = undefined;
    if (write) {
      const a = AnswerSchema.safeParse(raw);
      if (a.success) for (const l of a.data.lines) l.versions.forEach((v) => take(l.part, l.line - 1, v.text));
      else formProblem = 'Your last answer was not in the form {"lines": [{"part": "<part id>", "line": <line number>, "versions": [{"syllables": [...], "text": "..."}, ...]}, ...]}.';
    }
    // Choose, read the chosen lines for grammar, drop what the reading flags and choose again (no new writing needed
    // while other passing versions are left).
    let choice = chooseAll();
    for (let reading = 0; reading < GRAMMAR_READINGS_PER_ROUND; reading++) {
      const unread = parts.some((p) => choice.chosen.get(p.id)!.some((t, i) => t !== undefined && !state.get(p.id)![i]!.approved.has(t)));
      if (!unread) break;
      const flags = await grammarFlags(model, parts, choice.chosen, state);
      stats.readings++;
      const flagged = new Set(flags.map((f) => `${f.part}|${f.line}`));
      for (const p of parts) {
        choice.chosen.get(p.id)!.forEach((t, i) => {
          if (t !== undefined && !flagged.has(`${p.id}|${i}`)) state.get(p.id)![i]!.approved.add(t);
        });
      }
      for (const f of flags) state.get(f.part)![f.line]!.rejected.set(f.text, `not correct, natural English: ${f.reason.replace(/\.?$/u, '.')}`);
      if (flags.length === 0) break;
      choice = chooseAll();
    }
    chosen = choice.chosen;
    // Lines chosen but not yet read (the readings ran out this round) are read in the next round.
    problems = choice.problems;
    const allRead = parts.every((p) => chosen.get(p.id)!.every((t, i) => t !== undefined && state.get(p.id)![i]!.approved.has(t)));
    if (problems.length === 0 && allRead && !formProblem) {
      const out: Record<string, string[]> = {};
      for (const p of parts) {
        const lines = chosen.get(p.id) as string[];
        const left = checkSectionLyrics(p.lines, lines);
        if (left.length > 0) throw new Error(`lyricist: the lines chosen for ${p.id} do not pass the check: ${left.map((l) => l.message).join(' ')}`);
        for (const s of p.sections) out[s] = lines;
      }
      return out;
    }
  }
  throw new Error(
    `the lyrics model could not write lines that fit the melody in ${MAX_ROUNDS} tries; still wrong:\n${problems.map((pr) => `- ${pr.part} line ${pr.line + 1}: ${pr.message}`).join('\n')}`,
  );
}
