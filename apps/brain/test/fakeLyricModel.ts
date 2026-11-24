// A lyric model for tests: reads the lyricist's brief and answers with lines that fit exactly — "la" for every
// syllable but the last, which is a rhyme word ("la la la day" / "la la la way"). Deterministic.

import type { LyricMessage, LyricModel } from '../src/lyrics/lyricist.js';

const FAMILIES = [
  ['day', 'way', 'say', 'stay', 'play'],
  ['night', 'light', 'bright', 'sight', 'right'],
  ['rain', 'pain', 'chain', 'plain', 'main'],
  ['sea', 'free', 'me', 'tree', 'key'],
  ['go', 'so', 'know', 'show', 'slow'],
  ['blue', 'true', 'new', 'through', 'do'],
];

export function fakeLyricModel(): LyricModel & { readonly calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async complete(messages: readonly LyricMessage[]): Promise<string> {
      calls++;
      const brief = messages.find((m) => m.role === 'user')!.content;
      const parts: Record<string, { syllables: string[]; text: string }[]> = {};
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
        const syllables = [...Array.from({ length: count - 1 }, () => 'la'), word];
        parts[part]!.push({ syllables, text: syllables.join(' ') });
      }
      return JSON.stringify({ parts });
    },
  };
}
