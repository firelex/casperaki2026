// The lyric writer (src/lyrics/lyricist.ts) with a scripted model: a fitting draft is taken as it is; of several
// versions of a line the first that passes is chosen (rhyme pairs chosen together); a version the grammar reading
// flags gives way to the next passing one; lines with no passing version go back to the model; the last two rounds
// reason, and lines still wrong after six rounds are an error.

import { describe, expect, it } from 'vitest';

import { checkSectionLyrics, orchestrate, rhymeScheme, sungSections, type LyricLine } from '@casperaki/arrangement';

import type { ChatMessage, ChatModel } from '../src/llm/chatModel.js';
import { describeLines, FAST_ROUNDS, MAX_ROUNDS, writeLyrics } from '../src/lyrics/lyricist.js';
import { fakeLyricModel, fittingParts } from './fakeLyricModel.js';

const song = orchestrate({ genre: 'brightPop', key: 'C', bpm: 110, seed: 'lyricist' });
const sections = sungSections(song).map((s) => s.name);

const isGrammar = (m: readonly ChatMessage[]) => m[0]!.content.includes('careful editor');
const isRepair = (m: readonly ChatMessage[]) => !isGrammar(m) && m.length > 2;

/** The draft per part id and line (0-based): the versions of each line. */
type Draft = Record<string, { versions: { text: string }[] }[]>;

/** A model scripted per kind of request; the draft fits (one version a line) unless `draft` changes it. */
function model(opts: {
  draft?: (parts: Draft, brief: string) => void;
  grammar?: (call: number, m: readonly ChatMessage[]) => unknown;
  repair?: (call: number, m: readonly ChatMessage[]) => unknown;
}): ChatModel & { calls: { kind: string; thinking: boolean }[] } {
  const calls: { kind: string; thinking: boolean }[] = [];
  let grammar = 0;
  let repair = 0;
  return {
    calls,
    async complete(m, { thinking }) {
      if (isGrammar(m)) {
        calls.push({ kind: 'grammar', thinking });
        return JSON.stringify(opts.grammar?.(++grammar, m) ?? { problems: [] });
      }
      if (isRepair(m)) {
        calls.push({ kind: 'repair', thinking });
        return JSON.stringify(opts.repair?.(++repair, m) ?? { lines: [] });
      }
      calls.push({ kind: 'draft', thinking });
      const fitting = fittingParts(m[1]!.content);
      const parts: Draft = Object.fromEntries(Object.entries(fitting).map(([id, lines]) => [id, lines.map((l) => ({ versions: [l] }))]));
      opts.draft?.(parts, m[1]!.content);
      return JSON.stringify({ lines: Object.entries(parts).flatMap(([part, lines]) => lines.map((l, i) => ({ part, line: i + 1, versions: l.versions }))) });
    },
  };
}

describe('the lyric writer', () => {
  it('takes a fitting draft after one grammar reading, without reasoning', async () => {
    const m = fakeLyricModel();
    const lyrics = await writeLyrics(song, m, { sections });
    expect(Object.keys(lyrics).sort()).toEqual([...sections].sort());
    expect(m.calls.map((c) => c.thinking)).toEqual([false, false]);
    // Repeats of the chorus with the same melody share their words.
    const choruses = sections.filter((n) => n.startsWith('chorus'));
    expect(choruses.length).toBeGreaterThan(1);
    for (const c of choruses) expect(lyrics[c]).toEqual(lyrics[choruses[0]!]);
  });

  it('marks every note strong, weak, free or held, names the small unstressed words and asks for ABCB rhymes', async () => {
    const m = fakeLyricModel();
    await writeLyrics(song, m, { sections });
    const brief = m.calls[0]!.messages[1]!.content;
    expect(brief).toMatch(/notes: [^;]*HOLD/u);
    expect(brief).toMatch(/notes: (?:(?:S|w|f|HOLD) )*S /u);
    expect(brief).toMatch(/notes: (?:(?:S|w|f|HOLD) )*w /u);
    expect(brief).toMatch(/S is a strong note: it needs the stressed syllable of a longer word, or a one-syllable word/u);
    expect(brief).toMatch(/except these small unstressed words, which may not go on an S: "a", "an", "and", "but", "for", "the", "this", "or", "to"/u);
    expect(brief).toMatch(/write 3 different versions of every line/u);
    expect(brief).toMatch(/A B C B/u);
    // Each line's marks are its notes' grades (S '+', w '-', f '0', HOLD two beats or more).
    const first = sungSections(song)[0]!;
    const marks = first.lines[0]!.map((n) => (n.duration >= 2 ? 'HOLD' : n.grade === '+' ? 'S' : n.grade === '-' ? 'w' : 'f')).join(' ');
    expect(brief).toContain(`line 1: exactly ${first.lines[0]!.length} syllables; notes: ${marks};`);
  });

  it('describes a three-line section as ABA: line 2 is free', () => {
    const line = sungSections(song)[0]!.lines[0]!;
    const text = describeLines([line, line, line]).join('\n');
    expect(rhymeScheme(3)).toEqual(['A', 'B', 'A']);
    expect(text).toMatch(/line 2: exactly \d+ syllables; notes: [^;]*; need not rhyme\n  line 3: exactly \d+ syllables; notes: [^;]*; its last word must rhyme with the last word of line 1/u);
  });

  it('sends a line that does not fit back to the model and keeps the rest', async () => {
    const first = sections[0]!;
    const m = model({
      draft: (parts) => (parts[first]![0]!.versions = [{ text: 'la' }]),
      repair: (_n, msgs) => {
        expect(msgs.at(-1)!.content).toMatch(new RegExp(`part "${first}", line 1: No version fits yet. The versions so far and what is wrong with each:\\n    - "la": It has 1 syllables`, 'u'));
        return { lines: [{ part: first, line: 1, versions: [{ text: fittingParts(msgs[1]!.content)[first]![0]!.text }] }] };
      },
    });
    const lyrics = await writeLyrics(song, m, { sections });
    expect(lyrics[first]![0]).toMatch(/^la la/u);
    expect(m.calls.map((c) => c.kind)).toEqual(['draft', 'grammar', 'repair', 'grammar']);
  });

  it('repairs a line the grammar reading flags when it has no other version', async () => {
    const first = sections[0]!;
    let fixed = '';
    const m = model({
      grammar: (n) => (n === 1 ? { problems: [{ part: first, line: 2, reason: 'a word is missing' }] } : { problems: [] }),
      repair: (_n, msgs) => {
        expect(msgs.at(-1)!.content).toMatch(/not correct, natural English: a word is missing\./u);
        fixed = fittingParts(msgs[1]!.content)[first]![1]!.text.replace(/^la /u, 'oh ');
        return { lines: [{ part: first, line: 2, versions: [{ text: fixed }] }] };
      },
    });
    const lyrics = await writeLyrics(song, m, { sections });
    expect(lyrics[first]![1]).toBe(fixed);
    expect(m.calls.map((c) => c.kind)).toEqual(['draft', 'grammar', 'repair', 'grammar']);
  });

  it('takes the first version that passes: one sung against its stress is passed over without asking again', async () => {
    const first = sections[0]!;
    const line = sungSections(song).find((s) => s.name === first)!.lines.findIndex((l) => l.some((n) => n.grade === '+' && n.duration < 2));
    expect(line).toBeGreaterThanOrEqual(0);
    const slots = sungSections(song).find((s) => s.name === first)!.lines[line]!;
    let good = '';
    let bad = '';
    const m = model({
      draft: (parts) => {
        good = parts[first]![line]!.versions[0]!.text;
        // "the" (a small unstressed word) on the line's first strong note.
        const words = good.split(' ');
        words[slots.findIndex((n) => n.grade === '+' && n.duration < 2)] = 'the';
        bad = words.join(' ');
        parts[first]![line]!.versions = [{ text: bad }, { text: good }];
      },
    });
    const lyrics = await writeLyrics(song, m, { sections });
    expect(checkSectionLyrics([slots], [bad])[0]!.message).toMatch(/"the" is a small unstressed word but falls on a strong note/u);
    expect(lyrics[first]![line]).toBe(good);
    expect(m.calls.map((c) => c.kind)).toEqual(['draft', 'grammar']);
  });

  it('chooses the two lines of a rhyme pair together: the first versions that rhyme', async () => {
    const part = sungSections(song).find((s) => s.lines.length >= 4)!;
    const m = model({
      draft: (parts) => {
        const two = parts[part.name]![1]!.versions[0]!.text;
        const four = parts[part.name]![3]!.versions[0]!.text;
        const swap = (t: string, w: string) => t.replace(/\S+$/u, w);
        // Line 2 first ends on "rain" (no version of line 4 rhymes with it), then on the word line 4 rhymes with.
        parts[part.name]![1]!.versions = [{ text: swap(two, 'rain') }, { text: two }];
        parts[part.name]![3]!.versions = [{ text: swap(four, 'sea') }, { text: four }];
      },
    });
    const lyrics = await writeLyrics(song, m, { sections });
    const lines = lyrics[part.name]!;
    expect(lines[1]).not.toMatch(/rain$/u);
    expect(lines[3]).not.toMatch(/sea$/u);
    expect(checkSectionLyrics(part.lines as LyricLine[], lines)).toEqual([]);
  });

  it('gives a version the grammar reading flags way to the next passing one, without writing again', async () => {
    const first = sections[0]!;
    let second = '';
    const m = model({
      draft: (parts) => {
        const v = parts[first]![0]!.versions[0]!.text;
        second = v.replace(/^la /u, 'oh ');
        parts[first]![0]!.versions = [{ text: v }, { text: second }];
      },
      grammar: (n) => (n === 1 ? { problems: [{ part: first, line: 1, reason: 'too much la' }] } : { problems: [] }),
    });
    const lyrics = await writeLyrics(song, m, { sections });
    expect(lyrics[first]![0]).toBe(second);
    expect(m.calls.map((c) => c.kind)).toEqual(['draft', 'grammar', 'grammar']);
  });

  it('reasons in the last rounds and fails, naming the lines, when they stay wrong', async () => {
    const first = sections[0]!;
    const m = model({ draft: (parts) => (parts[first]![0]!.versions = [{ text: 'la' }]) });
    await expect(writeLyrics(song, m, { sections })).rejects.toThrow(new RegExp(`in ${MAX_ROUNDS} tries; still wrong:\\n- ${first} line 1: No version fits yet[^]*"la": It has 1 syllables`, 'u'));
    const writes = m.calls.filter((c) => c.kind !== 'grammar');
    expect(writes.map((c) => c.thinking)).toEqual(Array.from({ length: MAX_ROUNDS }, (_, i) => i >= FAST_ROUNDS));
    expect(FAST_ROUNDS).toBeLessThan(MAX_ROUNDS);
    expect(m.calls.filter((c) => c.kind === 'grammar').every((c) => !c.thinking)).toBe(true);
  });

  it('refuses a song without a vocal melody', async () => {
    const hidden = orchestrate({ genre: 'brightPop', key: 'C', bpm: 110, seed: 'lyricist', params: { vocalMelody: false } });
    await expect(writeLyrics(hidden, fakeLyricModel(), { sections: [] })).rejects.toThrow(/no vocal melody/u);
  });
});
