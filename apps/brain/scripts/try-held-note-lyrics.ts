// Experiment: the DeepSeek lyric writer brought back with held notes marked, the held-note check (a half note or
// longer must carry the end of a word) and repairs without reasoning, to see how often it gets every line right and how
// long it takes.
//
// Per song: one draft without reasoning, then up to five repair rounds (also without reasoning) for the lines the
// checks send back; once every line passes them, a grammar reading (without reasoning) flags lines that are not
// correct, natural English, and those are repaired too (syllable count, stress, held notes, ABCB rhyme). Reported per song: rounds, seconds, lines still wrong,
// and the lyrics. The phrase-bank words the song has now are counted for word cuts on held notes as the baseline.
//
// The checks come from the arrangement package's source (not its built dist/), so the experiment runs without a build.
//
//   tsx scripts/try-held-note-lyrics.ts <song.json>... (env LLM_URL, LLM_MODEL)

import { readFileSync } from 'node:fs';

import type { Song } from '@casperaki/song-schema';

import { checkSectionLyrics, rhymeScheme, sungSections, type LyricLine, type SungSection } from '../../../packages/arrangement/src/index.js';
import { HOLD_BEATS } from '../../../packages/arrangement/src/vocals/written-lyrics.js';
import { OpenAiChatModel, type ChatMessage } from '../src/llm/chatModel.js';

const EPS = 1e-6;
/** The first draft and up to five repairs: the draft and the first three repairs without reasoning, the last two with it. */
const MAX_ROUNDS = 6;
const FAST_ROUNDS = 4;

const url = process.env.LLM_URL;
const modelName = process.env.LLM_MODEL;
if (!url || !modelName) throw new Error('set LLM_URL and LLM_MODEL (the DeepSeek endpoint)');
const model = new OpenAiChatModel({ baseUrl: url, model: modelName });

const mark = (s: LyricLine[number]) => (s.duration >= HOLD_BEATS - EPS ? 'HOLD' : s.grade === '+' ? 'DA' : 'da');

/** One piece the model writes: a section, or a chorus / pre-chorus shared by its repeats with the same melody. */
interface Part {
  readonly id: string;
  readonly sections: string[];
  readonly lines: readonly LyricLine[];
}

function partsOf(sung: readonly SungSection[]): Part[] {
  const parts: (Part & { type: string; shape: string })[] = [];
  for (const s of sung) {
    const shape = s.lines.map((l) => l.map((x) => `${x.grade}${x.duration}`).join('')).join('|');
    const shared = ['chorus', 'preChorus'].includes(s.type) ? parts.find((p) => p.type === s.type && p.shape === shape) : undefined;
    if (shared) shared.sections.push(s.name);
    else parts.push({ id: s.name, type: s.type, shape, sections: [s.name], lines: s.lines });
  }
  return parts;
}

function brief(song: Song, parts: readonly Part[]): string {
  const describe = (lines: readonly LyricLine[]) => {
    const scheme = rhymeScheme(lines.length);
    return lines.map((l, i) => {
      const partner = scheme.indexOf(scheme[i]!);
      const later = scheme.indexOf(scheme[i]!, i + 1);
      const rhyme =
        partner !== i ? `its last word must rhyme with the last word of line ${partner + 1}` : later >= 0 ? `line ${later + 1} will rhyme with it` : 'need not rhyme';
      return `  line ${i + 1}: exactly ${l.length} syllables; notes: ${l.map(mark).join(' ')}; ${rhyme}`;
    });
  };
  return [
    `Write the lyrics for a ${song.genre ?? 'pop'} song.`,
    'Choose one clear theme or story for the whole song and keep to it.',
    '',
    'The melody is already fixed. Every line of lyrics is sung on a fixed number of notes, one syllable per note, so every line must have exactly the number of syllables given for it: not one more, not one less. Count syllables the way the words are normally spoken: "tonight" has 2, "fire" has 2, "every" has 3, "beautiful" has 3.',
    '',
    'Notes: each line comes with its notes, one mark per syllable, in order. DA is a strong note (on the beat), da a weak one, HOLD a long note held for two beats or more (also strong). Put the stressed syllable of every word of two or more syllables on a strong note, so the words are sung the way they are spoken.',
    '',
    'Held notes: the syllable sung on a HOLD must be the end of its word: a one-syllable word, or the last syllable of a longer word. Never put the first or a middle syllable of a word on a HOLD, because the singer would have to stop in the middle of the word and hold it ("sun" of "sunrise", "to" of "tonight" must never be on a HOLD).',
    '',
    'Rhyme: the lines go in groups of four that rhyme A B C B: only the second and fourth line of each group rhyme, the first and third need not. Each line says what it rhymes with. A rhyme has the same vowel sound and a similar ending, like time / mind, fire / higher, heart / apart. Two lines may never end on the same word ("old" and "old" is not a rhyme). Lines that need not rhyme should not be forced to: say something natural there. End every line on a strong word, never on "the", "a", "and", "to" or the like.',
    '',
    'Write natural, singable, everyday English. Use only common English words: no names, no made-up words, no digits. Do not pad lines with filler ("oh yeah", "baby baby").',
    '',
    'The song, in order. Write every part listed, with exactly as many lines as listed:',
    '',
    ...parts.flatMap((p) => [`Part id "${p.id}"${p.sections.length > 1 ? ` (sung ${p.sections.length} times, same words)` : ''}:`, ...describe(p.lines), '']),
    'Answer with JSON only, in exactly this form, with every part id listed above. For every line, first list its syllables one by one, each with the mark of the note it is sung on, then the line as it is written:',
    JSON.stringify({ parts: { [parts[0]!.id]: [{ syllables: ['When/da', 'the/da', 'mor/DA', 'ning/da', 'light/HOLD'], text: 'When the morning light' }, '…'] } }),
  ].join('\n');
}

function jsonOf(text: string): unknown {
  try {
    return JSON.parse(text.trim().replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, ''));
  } catch {
    return undefined;
  }
}

type Problem = { part: string; line: number; text: string; message: string };

function problemsOf(parts: readonly Part[], current: ReadonlyMap<string, string[]>): Problem[] {
  const out: Problem[] = [];
  for (const p of parts) {
    const lines = current.get(p.id)!;
    const missing = lines.flatMap((t, i) => (t === '' ? [i] : []));
    for (const i of missing) out.push({ part: p.id, line: i, text: '', message: 'This line is missing.' });
    if (missing.length > 0) continue;
    for (const pr of checkSectionLyrics(p.lines, lines)) out.push({ part: p.id, line: pr.line, text: lines[pr.line] ?? '', message: pr.message });
  }
  return out;
}

const system: ChatMessage = { role: 'system', content: 'You are a professional songwriter. You write English song lyrics that fit an existing melody exactly, syllable for syllable, and you answer in JSON.' };

async function write(song: Song, parts: readonly Part[]) {
  const first: ChatMessage = { role: 'user', content: brief(song, parts) };
  const current = new Map(parts.map((p) => [p.id, p.lines.map(() => '')]));
  const take = (part: string, line: number, text: string) => {
    const lines = current.get(part);
    if (lines && line >= 0 && line < lines.length) lines[line] = text.trim();
  };
  const t0 = Date.now();
  let problems: Problem[] = [];
  const perRound: number[] = [];
  let grammarFlags = 0;
  let reasoned = 0;
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const messages: ChatMessage[] =
      round === 1
        ? [system, first]
        : [
            system,
            first,
            { role: 'assistant', content: JSON.stringify({ parts: Object.fromEntries([...current].map(([id, lines]) => [id, lines.map((text) => ({ text }))])) }) },
            {
              role: 'user',
              content: [
                'These lines are not right yet:',
                ...problems.map((pr) => `- part "${pr.part}", line ${pr.line + 1}${pr.text ? ` ("${pr.text}")` : ''}: ${pr.message}`),
                '',
                'Rewrite only these lines (and, for a rhyme, the other line of the pair if that works better); every other line stays as it is. Keep the meaning and the story, and make every line read naturally. List the syllables of each new line one by one, each with the mark of its note, and count them before you answer. Answer with JSON only, in this form:',
                JSON.stringify({ fixes: [{ part: problems[0]!.part, line: problems[0]!.line + 1, syllables: ['…'], text: '…' }] }),
              ].join('\n'),
            },
          ];
    const thinking = round > FAST_ROUNDS;
    if (thinking) reasoned++;
    const raw = jsonOf(await model.complete(messages, { thinking })) as
      | { parts?: Record<string, { text?: string }[]>; fixes?: { part?: string; line?: number; text?: string }[] }
      | undefined;
    if (round === 1) for (const [id, lines] of Object.entries(raw?.parts ?? {})) lines.forEach((l, i) => take(id, i, l.text ?? ''));
    else for (const f of raw?.fixes ?? []) if (f.part && f.line && f.text) take(f.part, f.line - 1, f.text);
    // Every round: the melody checks, and a reading for grammar and sense of the lines that pass them.
    problems = problemsOf(parts, current);
    const failing = new Set(problems.map((p) => `${p.part}|${p.line}`));
    const grammar = (await grammarProblems(parts, current)).filter((g) => !failing.has(`${g.part}|${g.line}`));
    grammarFlags += grammar.length;
    problems = [...problems, ...grammar];
    perRound.push(problems.length);
    if (problems.length === 0) break;
  }
  return { current, problems, perRound, grammarFlags, reasoned, seconds: (Date.now() - t0) / 1000 };
}

const GrammarAnswer = (raw: unknown): { part: string; line: number; reason: string }[] => {
  const problems = (raw as { problems?: unknown } | undefined)?.problems;
  if (!Array.isArray(problems)) throw new Error(`the grammar reader answered without a "problems" list: ${JSON.stringify(raw).slice(0, 200)}`);
  return problems.map((p) => p as { part: string; line: number; reason: string });
};

/** A second reading of the lyrics, without reasoning: lines that are not correct, natural English. */
async function grammarProblems(parts: readonly Part[], current: ReadonlyMap<string, string[]>): Promise<Problem[]> {
  const text = parts.flatMap((p) => [`Part "${p.id}":`, ...current.get(p.id)!.map((t, i) => `  line ${i + 1}: ${t}`), '']);
  const answer = await model.complete(
    [
      { role: 'system', content: 'You are a careful editor of English song lyrics. You answer in JSON.' },
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
  return GrammarAnswer(jsonOf(answer))
    .filter((g) => current.get(g.part)?.[g.line - 1] !== undefined)
    .map((g) => ({ part: g.part, line: g.line - 1, text: current.get(g.part)![g.line - 1]!, message: `This is not correct, natural English: ${g.reason} Keep the same notes: same syllable count, stress, held notes and rhyme.` }));
}

/** Held notes whose phrase-bank syllable (or the one it carries on) is not the end of a word. */
function phraseBankCuts(song: Song, section: string): { held: number; cut: number } {
  const bars = song.arrangement[section]!.overrides!['Vocal']!.bars! as { notes: Record<string, { type: string; duration: number; fullWord?: string }[]> }[];
  const notes: { start: number; duration: number; word: string }[] = [];
  bars.forEach((bar, b) => {
    for (const [beat, evs] of Object.entries(bar.notes ?? {})) for (const ev of evs) if (ev.type === 'vocalNote') notes.push({ start: b * 4 + Number.parseFloat(beat), duration: ev.duration, word: ev.fullWord ?? '' });
  });
  notes.sort((a, b) => a.start - b.start);
  let carried = '';
  let held = 0;
  let cut = 0;
  for (const n of notes) {
    const syl = n.word === '-' ? carried : n.word;
    carried = syl;
    if (n.duration < HOLD_BEATS - EPS) continue;
    held++;
    if (syl.endsWith('-')) cut++;
  }
  return { held, cut };
}

async function main() {
  const files = process.argv.slice(2);
  if (files.length === 0) throw new Error('give song JSON files');
  const summary: string[] = [];
  for (const file of files) {
    const song = JSON.parse(readFileSync(file, 'utf8')) as Song;
    const sung = sungSections(song);
    const parts = partsOf(sung);
    const lineCount = parts.reduce((n, p) => n + p.lines.length, 0);
    const base = sung.map((s) => phraseBankCuts(song, s.name)).reduce((a, b) => ({ held: a.held + b.held, cut: a.cut + b.cut }), { held: 0, cut: 0 });
    const r = await write(song, parts);
    const line = `${file.split('/').pop()} (${song.genre}, ${lineCount} lines): ${r.problems.length === 0 ? 'all lines fit' : `${r.problems.length} lines still wrong`} after ${r.perRound.length} rounds (wrong after each: ${r.perRound.join(' → ')}; grammar flags ${r.grammarFlags}, rounds with reasoning ${r.reasoned}), ${r.seconds.toFixed(0)} s; phrase bank cuts ${base.cut}/${base.held} held notes`;
    summary.push(line);
    console.log(`\n=== ${line}`);
    for (const p of parts) console.log(`  ${p.id}: ${r.current.get(p.id)!.join(' / ')}`);
    for (const pr of r.problems) console.log(`  STILL WRONG ${pr.part} line ${pr.line + 1}: ${pr.message}`);
  }
  console.log(`\n=== summary\n${summary.join('\n')}`);
}

await main();
