// A lyric model for tests: reads the lyricist's brief and answers with lines that fit exactly — "la" for every
// syllable but the last, which is a rhyme word ("la la la day" / "la la la way"), one version per line ("la" and
// the rhyme words are one-syllable words, free on any note). Its grammar reading finds nothing.
// Deterministic. `script` replaces chosen answers (by call number, 1-based) to test repairs.

import type { ChatMessage, ChatModel } from '../src/llm/chatModel.js';

const FAMILIES = [
  ['day', 'way', 'say', 'stay', 'play'],
  ['night', 'light', 'bright', 'sight', 'right'],
  ['rain', 'pain', 'chain', 'plain', 'main'],
  ['sea', 'free', 'me', 'tree', 'key'],
  ['go', 'so', 'know', 'show', 'slow'],
  ['blue', 'true', 'new', 'through', 'do'],
];

export interface FakeCall {
  readonly messages: readonly ChatMessage[];
  readonly thinking: boolean;
}

export function fakeLyricModel(script: Readonly<Record<number, (messages: readonly ChatMessage[]) => string>> = {}): ChatModel & { readonly calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  return {
    calls,
    async complete(messages: readonly ChatMessage[], options: { readonly thinking: boolean }): Promise<string> {
      calls.push({ messages, thinking: options.thinking });
      const scripted = script[calls.length];
      if (scripted) return scripted(messages);
      const firstAsk = messages.find((m) => m.role === 'user')!.content;
      if (firstAsk.includes(LYRICS_FIRST_FORM)) return lyricsFirstAnswer(firstAsk, calls.length);
      if (messages[0]!.content.includes('careful editor')) return JSON.stringify({ problems: [] });
      if (messages.length > 2) return JSON.stringify({ lines: [] });
      return JSON.stringify(asVersions(fittingParts(messages[1]!.content)));
    },
  };
}

/** The lines as the writer's answer: each line of each part with that one version. */
export function asVersions(parts: Record<string, { text: string }[]>): { lines: { part: string; line: number; versions: { text: string }[] }[] } {
  return { lines: Object.entries(parts).flatMap(([part, lines]) => lines.map((l, i) => ({ part, line: i + 1, versions: [l] }))) };
}

/** Lines that fit the brief exactly, per part id. */
export function fittingParts(brief: string): Record<string, { text: string }[]> {
  const parts: Record<string, { text: string }[]> = {};
  let part: string | undefined;
  let family = 0;
  const familyOfLine = new Map<number, { f: number; next: number }>();
  for (const line of brief.split('\n')) {
    const head = /part id "([^"]+)":$/u.exec(line);
    if (head) {
      part = head[1]!;
      parts[part] = [];
      familyOfLine.clear();
      continue;
    }
    const m = /^ {2}line (\d+): exactly (\d+) syllables;.*?(?:rhyme with the last word of line (\d+))?$/u.exec(line);
    if (!m || !part) continue;
    const n = Number(m[1]);
    const count = Number(m[2]);
    let word: string;
    if (m[3]) {
      const g = familyOfLine.get(Number(m[3]))!;
      word = FAMILIES[g.f]![g.next++ % 5]!;
    } else {
      const f = family++ % FAMILIES.length;
      familyOfLine.set(n, { f, next: 1 });
      word = FAMILIES[f]![0]!;
    }
    parts[part]!.push({ text: [...Array.from({ length: count - 1 }, () => 'la'), word].join(' ') });
  }
  return parts;
}

// ---- lyrics first (lyricsFirst.ts): the whole song in parts, no melody to fit ----

const LYRICS_FIRST_FORM = 'Answer with JSON only, in this form: {"sections"';
/** Two-syllable words for the song's first line, four per call, so no song starts like an earlier one. */
const OPENING_WORDS = ['summer', 'morning', 'silver', 'golden', 'maybe', 'honey', 'thunder', 'window', 'pocket', 'candle', 'river', 'ocean', 'meadow', 'yellow', 'garden', 'mirror', 'velvet', 'harbor', 'winter', 'paper', 'shadow', 'thunder', 'button', 'lemon', 'pillow', 'rocket', 'ribbon', 'tiger', 'wonder', 'basket', 'kitten', 'pepper'];
const FREE_ENDS = ['heart', 'dream', 'soul', 'road', 'home', 'sun', 'time', 'life', 'world', 'hand', 'door', 'town', 'phone', 'car'];

/** Lines that pass checkFreeLyrics: "Oh la la <end>" (the song's first line: four words of its own), ABCB rhymes from one family per part, every line-ending word
 *  used once; the opening changes with every call. */
function lyricsFirstAnswer(brief: string, call: number): string {
  const form = JSON.parse(brief.slice(brief.indexOf(LYRICS_FIRST_FORM) + LYRICS_FIRST_FORM.length - '{"sections"'.length)) as { sections: { name: string; lines: string[] }[] };
  let free = 0;
  const sections = form.sections.map((s, p) => {
    const family = FAMILIES[p % FAMILIES.length]!;
    let rhyme = 0;
    const n = s.lines.length;
    const lines = s.lines.map((_, i) => {
      // ABCB in fours; a leftover pair rhymes, a leftover three is ABA.
      const inGroup = i % 4;
      const groupSize = Math.min(4, n - (i - inGroup));
      const rhymes = groupSize === 4 ? inGroup === 1 || inGroup === 3 : groupSize === 3 ? inGroup !== 1 : groupSize === 2;
      const end = rhymes ? family[rhyme++]! : FREE_ENDS[free++]!;
      if (p === 0 && i === 0) return Array.from({ length: 4 }, (_, k) => OPENING_WORDS[(call * 4 + k) % OPENING_WORDS.length]!).join(' ');
      return `Oh la la ${end}`;
    });
    return { name: s.name, lines };
  });
  return JSON.stringify({ sections });
}
