// Scoring sung words against the old lyric writer's stress rules (@casperaki/arrangement stress.ts, a port of
// casperaki1's LyricsClass.js note grades and LyricsTemplatePoetClass.js word rhythm), shared by
// score-lyric-stress.ts (stored songs) and try-stress-lyrics.ts (new lyrics written live).
//
// "As sung": the syllables as a song's Vocal lane notes sing them (fullWord), each on its own note graded as stored
// (gradeBar over the bar's vocal notes, held notes included as notes); a held note ("-") sings no syllable. The
// words are the section's written words in order when it has them (a sung contraction is displayed in its short
// spelling, "E-" "vry", which does not spell the word), else the syllables joined ("To-" + "night"). Repeated
// identical sections (the same notes and words) count once. A line is a pair of bars (the lyric lines are two bars
// each, pickups aside).

import { gradeBar, stressFits, sungPronunciations, wordsOf, type Stress, type WrittenLyrics } from '@casperaki/arrangement';
import type { Song } from '@casperaki/song-schema';

interface Sung {
  readonly bar: number;
  readonly beat: number;
  readonly duration: number;
  readonly fullWord: string;
  readonly grade: Stress;
}

export interface AsSung {
  words: number;
  clashingWords: number;
  clashingSyllables: number;
  lines: number;
  clashingLines: number;
  /** Each word sung against its stress: section, bar (from 1), beat, the word, its rhythm and its notes' grades. */
  clashes: { section: string; bar: number; beat: number; word: string; rhythm: string; grades: string }[];
}

export function scoreAsSung(song: Song, where: string, written: WrittenLyrics = {}): AsSung {
  const t: AsSung = { words: 0, clashingWords: 0, clashingSyllables: 0, lines: 0, clashingLines: 0, clashes: [] };
  const seen = new Set<string>();
  for (const [segment, seg] of Object.entries(song.arrangement)) {
    const lane = seg.overrides?.Vocal;
    if (!lane?.bars) continue;
    const sung: Sung[] = [];
    lane.bars.forEach((bar, bi) => {
      const evs = Object.entries(bar.notes ?? {})
        .flatMap(([k, es]) => (es ?? []).map((e) => ({ beat: Number.parseFloat(k), e: e as { type?: string; duration: number; fullWord?: string } })))
        .filter((x) => x.e.type === 'vocalNote')
        .sort((a, b) => a.beat - b.beat);
      const grades = gradeBar(evs.map((x) => ({ beat: x.beat, duration: x.e.duration })));
      evs.forEach((x, i) => {
        if (x.e.fullWord !== undefined) sung.push({ bar: bi, beat: x.beat, duration: x.e.duration, fullWord: x.e.fullWord, grade: grades[i]! });
      });
    });
    const sig = JSON.stringify(sung.map((s) => [s.bar, s.beat, s.duration, s.fullWord]));
    if (sung.length === 0 || seen.has(sig)) continue;
    seen.add(sig);
    // Syllables into words: "To-" + "night"; a held note ("-") sings no syllable.
    const words: Sung[][] = [];
    let cur: Sung[] = [];
    for (const s of sung) {
      if (s.fullWord === '-') continue;
      cur.push(s);
      if (!s.fullWord.endsWith('-')) {
        words.push(cur);
        cur = [];
      }
    }
    const lines = new Set<number>();
    const bad = new Set<number>();
    const textWords = written[segment] ? wordsOf(written[segment].join(' ')) : undefined;
    if (textWords && textWords.length !== words.length) {
      throw new Error(`${where} / ${segment}: ${textWords.length} written words but ${words.length} words sung on the notes`);
    }
    for (const [k, w] of words.entries()) {
      const text = textWords ? textWords[k]! : w.map((s) => s.fullWord.replace(/-$/u, '')).join('');
      const p = sungPronunciations(text).find((x) => x.syllables.length === w.length);
      if (!p) throw new Error(`${where} / ${segment}: "${text}" is sung on ${w.length} notes, which no pronunciation of it has`);
      const line = Math.floor(w[0]!.bar / 2);
      lines.add(line);
      const clashes = w.filter((s, i) => !stressFits(s.grade, p.rhythm[i]!)).length;
      t.words++;
      if (clashes > 0) {
        t.clashingWords++;
        t.clashingSyllables += clashes;
        bad.add(line);
        t.clashes.push({ section: segment, bar: w[0]!.bar + 1, beat: w[0]!.beat, word: text.toLowerCase(), rhythm: p.rhythm.join(''), grades: w.map((s) => s.grade).join('') });
      }
    }
    t.lines += lines.size;
    t.clashingLines += bad.size;
  }
  return t;
}
