// Lyrics written first (docs/superpowers/specs/2026-11-27-lyrics-first-singing-design.md, step 1): the language model
// writes the words of every sung section type with no melody to fit, in the style of today's chart pop, in the way a
// drawn artist writes and about a drawn situation (inspiration.ts). The code checks them (@casperaki/arrangement
// checkFreeLyrics: dictionary words, 4 to 11 syllables a line, ABCB rhymes, rhyme words used once unless they are in
// the title or the line repeats, an opening unlike the owner's recent songs) and sends what is wrong back, naming the
// lines, up to MAX_ROUNDS answers in all, without reasoning (about 1.5 s each) but for the last REASONING_ROUNDS. Still wrong after that: an error
// naming the lines. The arrangement then bends a rhythm to the words (applyLyricsFirst).

import { checkFreeLyrics, MAX_LINE_SYLLABLES, MIN_LINE_SYLLABLES, type FreeLyricsProblem, type LyricsByType } from '@casperaki/arrangement';
import { z } from 'zod';

import type { ChatMessage, ChatModel } from '../llm/chatModel.js';
import type { SongsStore } from '../store.js';

/** A finished Write lyrics task's result: the words per section type. */
export const LyricsFirstResultSchema = z.object({ lyricsFirst: z.record(z.string().min(1), z.array(z.string().min(1)).min(1)) }).strict();

/** The section types' names for the lyric writer. */
export const TYPE_LABELS: Readonly<Record<string, string>> = { verse: 'Verse', preChorus: 'Pre-chorus', chorus: 'Chorus', bridge: 'Bridge' };

/** How many of the owner's songs, most recently changed first, the new song's opening must not start like. */
export const RECENT_SONGS = 50;

/** The first sung line of each of the owner's most recently changed songs (other than `exceptSongId`) that has
 *  written words. */
export function recentOpenings(store: SongsStore, ownerId: string, exceptSongId: string): string[] {
  const out: string[] = [];
  for (const p of store.listProjects(ownerId)) {
    if (out.length >= RECENT_SONGS) break;
    if (p.songId === exceptSongId) continue;
    const stored = store.get(p.songId);
    if (!stored) throw new Error(`recent openings: the project "${p.title}" points at song ${p.songId}, which is not stored`);
    const song = JSON.parse(stored.canonical) as { songStructure?: { name: string }[]; generator?: { params?: { params?: { lyrics?: Record<string, string[]> } } } };
    const lyrics = song.generator?.params?.params?.lyrics;
    if (!lyrics) continue;
    const first = (song.songStructure ?? []).find((s) => lyrics[s.name]?.length);
    if (first) out.push(lyrics[first.name]![0]!);
  }
  return out;
}

/** Answers from the model in all: the first draft and its repairs. */
export const MAX_ROUNDS = 10;
/** The last answers may reason (half a minute or more each), as the melody-first writer's last repairs do: for a
 *  line the model could not fix quickly (a syllable count, a rhyme). */
export const REASONING_ROUNDS = 2;

export interface LyricsFirstRequest {
  /** Sung section types in song order: their label for the model and how many lines each needs. */
  readonly types: readonly { readonly type: string; readonly label: string; readonly lines: number }[];
  readonly title: string;
  /** Generator genre id ("brightPop"). */
  readonly genre: string;
  /** First lines of the owner's recent songs (the new song must not start like them). */
  readonly recentOpenings: readonly string[];
  readonly inspiration: { readonly artist: string; readonly situation: string };
}

const GENRE_LABELS: Readonly<Record<string, string>> = {
  ballad: 'pop ballad',
  brightPop: 'bright, upbeat pop',
  edm: 'dance-pop (EDM)',
  latin: 'Latin pop',
  organicVibes: 'warm, organic, acoustic-leaning pop',
  rock: 'pop rock',
  urban: 'urban pop (R&B and hip-hop feel)',
};

const AnswerSchema = z.object({ sections: z.array(z.object({ name: z.string(), lines: z.array(z.string()) })) });

function brief(r: LyricsFirstRequest): string {
  const genre = GENRE_LABELS[r.genre];
  if (!genre) throw new Error(`lyrics first: no description of the genre "${r.genre}" for the lyric writer`);
  const parts = r.types.map((t) => `${t.label} (${t.lines} lines)`).join(', ');
  return [
    `Write the lyrics of a contemporary ${genre} song called "${r.title}", the kind that is on the radio and streaming charts today.`,
    `Parts, in this order: ${parts}. Each part is sung every time it comes round in the song, so write it once.`,
    "How today's chart pop lyrics are written:",
    '- Plain, conversational words, the way people talk and text now: contractions, everyday slang where it fits, mostly short words. Nothing poetic or old-fashioned.',
    `- Short, punchy lines: every line has ${MIN_LINE_SYLLABLES} to ${MAX_LINE_SYLLABLES} syllables, most of them 5 to 9.`,
    '- The chorus is the hook: it is built on the title (or a short phrase from it), sung at least twice in the chorus. Repeating a line, or a line with one word changed, is good. It should be easy to sing along to after one listen.',
    '- Verses tell a simple, relatable situation with one or two specific details (a place, a thing, a moment), not a list of images.',
    '- Direct emotion and attitude: confident, cheeky, hurt, defiant, giddy or in love. Say what you feel.',
    '- A pre-chorus builds tension toward the chorus; a bridge turns the story or the feeling.',
    '- Use only common English words: no made-up words, no numbers written as digits. The singer may be a man or a woman, so never say what the singer is (no "girl", "boy", "man", "woman" about the singer).',
    'Rhymes: in each group of 4 lines, line 4 rhymes with line 2 (lines 1 and 3 need not rhyme); in a group of 2 lines, the two lines rhyme; in a group of 3, line 3 rhymes with line 1. Near rhymes are fine, as in real pop. A word may end two lines of the song only when it is a word of the title or the whole line is repeated.',
    `Write it the way ${r.inspiration.artist} writes: their attitude, their kind of hook and their everyday wording. Write completely new lines; do not reuse any of their actual lyrics.`,
    `The song is about: ${r.inspiration.situation}.`,
    `Answer with JSON only, in this form: ${JSON.stringify({ sections: r.types.map((t) => ({ name: t.label, lines: Array.from({ length: t.lines }, () => '...') })) })}`,
  ].join('\n');
}

function parse(text: string, r: LyricsFirstRequest): LyricsByType | string {
  let raw: unknown;
  try {
    raw = JSON.parse(text.trim().replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, ''));
  } catch {
    return 'Your last answer was not JSON.';
  }
  const a = AnswerSchema.safeParse(raw);
  if (!a.success) return 'Your last answer did not have a list "sections" of parts, each with a "name" and its "lines".';
  const out: Record<string, readonly string[]> = {};
  for (const t of r.types) {
    const s = a.data.sections.find((x) => x.name.trim().toLowerCase() === t.label.toLowerCase());
    if (!s) return `Your last answer had no part named "${t.label}".`;
    out[t.type] = s.lines.map((l) => l.trim());
  }
  return out;
}

const describeProblem = (p: FreeLyricsProblem, r: LyricsFirstRequest) => {
  const label = r.types.find((t) => t.type === p.type)?.label ?? p.type;
  return p.line < 0 ? `- ${label}: ${p.message}` : `- ${label}, line ${p.line + 1}: ${p.message}`;
};

/** The words of every requested section type (type → lines). */
export async function writeLyricsFirst(model: ChatModel, r: LyricsFirstRequest): Promise<LyricsByType> {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'You are a professional pop songwriter. You write English song lyrics for today\'s charts, and you answer in JSON.' },
    { role: 'user', content: brief(r) },
  ];
  const counts = Object.fromEntries(r.types.map((t) => [t.type, t.lines]));
  let wrong = '';
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const text = await model.complete(messages, { thinking: round > MAX_ROUNDS - REASONING_ROUNDS });
    const parsed = parse(text, r);
    if (typeof parsed === 'string') {
      wrong = parsed;
      messages.push({ role: 'assistant', content: text }, { role: 'user', content: `${parsed} Answer again in exactly the form asked for: ${messages[1]!.content.split('\n').at(-1)!.replace(/^Answer with JSON only, in this form: /u, '')}` });
      continue;
    }
    const problems = checkFreeLyrics(parsed, counts, r.title, r.recentOpenings);
    if (problems.length === 0) return parsed;
    wrong = problems.map((p) => describeProblem(p, r)).join('\n');
    messages.push(
      { role: 'assistant', content: text },
      {
        role: 'user',
        content: `Some lines need rewriting:\n${wrong}\nRewrite those lines (for a rhyme, the other line of the pair too if that works better) and keep every other line exactly as it is. Answer with the whole song again, as JSON in the same form.`,
      },
    );
  }
  throw new Error(`lyrics first: still wrong after ${MAX_ROUNDS} answers:\n${wrong}`);
}
