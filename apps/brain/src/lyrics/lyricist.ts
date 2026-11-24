// Song lyrics from the language model (the self-hosted DeepSeek: first draft without reasoning, repairs with it),
// written to fit the melody
// (docs/superpowers/specs/2026-11-24-written-lyrics-design.md).
//
// One request writes every section asked for. Per lyric line the model gets the exact syllable count, the stress
// pattern of its notes and which line it rhymes with; every answer is checked (dictionary words, syllable count, stress,
// rhymes, @casperaki/arrangement checkSectionLyrics) and lines that fail go back to the model with the problems
// written out, up to MAX_ROUNDS in all. Then it fails: there is no fallback.

import {
  checkSectionLyrics,
  rhymeScheme,
  sungSections,
  writtenLyricsOf,
  type LyricLine,
  type SungSection,
  type WrittenLyrics,
} from '@casperaki/arrangement';
import type { Song } from '@casperaki/song-schema';
import { z } from 'zod';

export interface LyricMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

/** A chat model that answers with text; `thinking`: let it reason before it answers. */
export interface LyricModel {
  complete(messages: readonly LyricMessage[], options: { readonly thinking: boolean }): Promise<string>;
}

export interface LyricEndpoint {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey?: string;
}

const TIMEOUT_MS = 300_000;
/** The first draft and up to three repairs. */
const MAX_ROUNDS = 4;

/** Any OpenAI-compatible chat endpoint (vLLM's DeepSeek in production), JSON answers. */
export class OpenAiLyricModel implements LyricModel {
  constructor(private readonly ep: LyricEndpoint) {}

  async complete(messages: readonly LyricMessage[], options: { readonly thinking: boolean }): Promise<string> {
    const url = `${this.ep.baseUrl.replace(/\/+$/u, '')}/chat/completions`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.ep.apiKey ? { authorization: `Bearer ${this.ep.apiKey}` } : {}) },
      body: JSON.stringify({
        model: this.ep.model,
        messages,
        temperature: 0.9,
        max_tokens: options.thinking ? 32000 : 4000,
        response_format: { type: 'json_object' },
        chat_template_kwargs: { thinking: options.thinking },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`the lyrics model (${this.ep.model}) answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as { choices?: { message?: { content?: string | null } }[] };
    const text = body.choices?.[0]?.message?.content;
    if (typeof text !== 'string') throw new Error('the lyrics model answered without any text');
    return text;
  }
}

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

const lineShape = (lines: readonly LyricLine[]) => lines.map((l) => l.map((s) => (s.strong ? 'S' : 'w')).join('')).join('|');

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
    const partner = scheme.indexOf(scheme[i]!);
    const rhyme = partner === i ? 'ends a new rhyme' : `its last word must rhyme with the last word of line ${partner + 1}`;
    return `  line ${i + 1}: exactly ${l.length} syllables; beat: ${l.map((s) => (s.strong ? 'DA' : 'da')).join(' ')}; ${rhyme}`;
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
  const example = { [parts[0]!.id]: [{ syllables: ['When', 'the', 'mor', 'ning', 'light', 'comes', 'through'], text: 'When the morning light comes through' }, '…'] };
  return [
    `Write the lyrics for a ${genre} song${title ? ` called "${title}"` : ''}.`,
    title
      ? 'The lyrics are about what the title suggests.'
      : 'Choose one clear theme or story for the whole song and keep to it.',
    '',
    'The melody is already fixed. Every line of lyrics is sung on a fixed number of notes, one syllable per note, so every line must have exactly the number of syllables given for it: not one more, not one less. Count syllables the way the words are normally spoken: "tonight" has 2, "fire" has 2, "every" has 3, "beautiful" has 3.',
    '',
    'Stress: each line comes with the beat pattern of its notes, one mark per syllable. DA is a strong note (on the beat), da a weak one. Put the stressed syllable of every word of two or more syllables on a DA, so the words are sung the way they are spoken.',
    '',
    'Rhyme: where a line says so, its last word must rhyme with the last word of the line named: the same vowel sound and a similar ending, like time / mind, fire / higher, heart / apart, night / light. Never rhyme a word with itself. End every line on a strong word that can carry a rhyme, never on "the", "a", "and", "to", "of" or the like.',
    '',
    'Write natural, singable, everyday English, the way a real song in this style sounds. The chorus carries the main idea and the hook, and is the most memorable part; the verses tell the story with concrete details and images; a pre-chorus builds up toward the chorus; a bridge gives a new angle. Each line should make sense on its own and lead into the next. Do not pad lines with filler ("oh yeah", "baby baby") just to reach the syllable count. Use only common English words: no names, no made-up words, no numbers written as digits. The singer may be a man or a woman, so never say what the singer is (no "girl", "boy", "man", "woman" about the singer or the one sung to).',
    '',
    'The song, in order:',
    '',
    ...order,
    'Answer with JSON only, in exactly this form, with every part id listed above and exactly as many lines in each as listed. For every line, first list its syllables one by one (so you can count them against the number asked for), then the line as it is written:',
    JSON.stringify({ parts: example }),
  ].join('\n');
}

const LineSchema = z.object({ syllables: z.array(z.string()), text: z.string() });
const AnswerSchema = z.object({ parts: z.record(z.string(), z.array(LineSchema)) });
const FixesSchema = z.object({ fixes: z.array(LineSchema.extend({ part: z.string(), line: z.number().int().positive() })) });

/** The JSON object in a model answer (code fences allowed), or undefined when there is none. */
function jsonOf(text: string): unknown {
  try {
    return JSON.parse(text.trim().replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, ''));
  } catch {
    return undefined;
  }
}

/** Per part, per line: what is wrong (plain English), for the lines that do not fit yet. */
function problemsOf(parts: readonly Part[], current: ReadonlyMap<string, (string | undefined)[]>): { part: string; line: number; text: string | undefined; message: string }[] {
  const out: { part: string; line: number; text: string | undefined; message: string }[] = [];
  for (const p of parts) {
    const lines = current.get(p.id)!;
    const missing = lines.flatMap((t, i) => (t === undefined ? [i] : []));
    for (const i of missing) out.push({ part: p.id, line: i, text: undefined, message: 'This line is missing.' });
    if (missing.length > 0) continue;
    for (const pr of checkSectionLyrics(p.lines, lines as string[])) out.push({ part: p.id, line: pr.line, text: lines[pr.line], message: pr.message });
  }
  return out;
}

/**
 * Words for the asked-for sections of a song (generator names), written by the model to fit their melodies.
 * Repeats of a chorus or pre-chorus with the same melody share their words. Sections already carrying written words
 * (recorded in the generator block) and not asked for are shown to the model as context. Lines that fit are kept;
 * only the others go back to the model.
 */
export async function writeLyrics(song: Song, model: LyricModel, request: LyricsRequest): Promise<WrittenLyrics> {
  const sung = sungSections(song);
  for (const name of request.sections) {
    if (!sung.some((s) => s.name === name)) throw new Error(`writeLyrics: the song has no sung section "${name}"`);
  }
  const parts = partsOf(sung, new Set(request.sections));
  if (parts.length === 0) return {};
  const recorded = writtenLyricsOf((song.generator?.params as { params?: Record<string, unknown> } | undefined)?.params);
  const context = sung.filter((s) => !request.sections.includes(s.name) && recorded[s.name]).map((s) => ({ label: s.name, words: recorded[s.name]! }));

  const system: LyricMessage = { role: 'system', content: 'You are a professional songwriter. You write English song lyrics that fit an existing melody exactly, syllable for syllable, and you answer in JSON.' };
  const brief: LyricMessage = { role: 'user', content: lyricsBrief(song, parts, context, request.title) };
  const current = new Map(parts.map((p) => [p.id, p.lines.map((): string | undefined => undefined)]));
  const take = (part: string, line: number, text: string) => {
    const lines = current.get(part);
    if (lines && line >= 0 && line < lines.length) lines[line] = text.trim();
  };
  /** The lyrics so far, as the model's own answer to the brief. */
  const draft = (): LyricMessage => ({
    role: 'assistant',
    content: JSON.stringify({ parts: Object.fromEntries([...current].map(([id, lines]) => [id, lines.map((t) => ({ text: t ?? '' }))])) }),
  });

  let problems: ReturnType<typeof problemsOf> = [];
  let formProblem: string | undefined;
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    // Every repair starts afresh from the brief, the lyrics so far and what is still wrong, so the model does not get
    // stuck on its earlier attempts.
    const messages: LyricMessage[] =
      round === 1
        ? [system, brief]
        : [
            system,
            brief,
            draft(),
            {
              role: 'user',
              content: [
                ...(formProblem ? [formProblem, ''] : []),
                'These lines do not fit yet:',
                ...problems.map((pr) => `- part "${pr.part}", line ${pr.line + 1}${pr.text !== undefined ? ` ("${pr.text}")` : ''}: ${pr.message}`),
                '',
                'Rewrite only these lines (and, for a rhyme, the other line of the pair if that works better); every other line stays as it is. Keep the meaning and the story, and make every line read naturally. List the syllables of each new line one by one and count them before you answer. Answer with JSON only, in this form:',
                JSON.stringify({ fixes: [{ part: problems[0]?.part ?? parts[0]!.id, line: (problems[0]?.line ?? 0) + 1, syllables: ['…'], text: '…' }] }),
              ].join('\n'),
            },
          ];
    // The first draft is written without reasoning (seconds); repairs reason (a minute or two), which is what makes
    // the syllable counts and rhymes come right (docs/superpowers/specs/2026-11-24-written-lyrics-design.md).
    const text = await model.complete(messages, { thinking: round > 1 });
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
    problems = problemsOf(parts, current);
    if (problems.length === 0) {
      const out: Record<string, string[]> = {};
      for (const p of parts) for (const s of p.sections) out[s] = current.get(p.id) as string[];
      return out;
    }
  }
  throw new Error(`the lyrics model could not write lines that fit the melody in ${MAX_ROUNDS} tries; still wrong:\n${problems.map((pr) => `- ${pr.part} line ${pr.line + 1}: ${pr.message}`).join('\n')}`);
}
