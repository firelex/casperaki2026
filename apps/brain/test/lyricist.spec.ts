// The lyric writer (src/lyrics/lyricist.ts) with a scripted model: a fitting draft is taken as it is, lines that fail
// the melody checks or the grammar reading go back to the model, the last two rounds reason, and lines still wrong
// after six rounds are an error.

import { describe, expect, it } from 'vitest';

import { orchestrate, sungSections } from '@casperaki/arrangement';

import type { ChatMessage, ChatModel } from '../src/llm/chatModel.js';
import { MAX_ROUNDS, writeLyrics } from '../src/lyrics/lyricist.js';
import { fakeLyricModel, fittingParts } from './fakeLyricModel.js';

const song = orchestrate({ genre: 'brightPop', key: 'C', bpm: 110, seed: 'lyricist' });
const sections = sungSections(song).map((s) => s.name);

const isGrammar = (m: readonly ChatMessage[]) => m[0]!.content.includes('careful editor');
const isRepair = (m: readonly ChatMessage[]) => !isGrammar(m) && m.length > 2;

/** A model scripted per kind of request; the draft fits unless `draft` changes it. */
function model(opts: {
  draft?: (parts: Record<string, { text: string }[]>) => void;
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
        return JSON.stringify(opts.repair?.(++repair, m) ?? { fixes: [] });
      }
      calls.push({ kind: 'draft', thinking });
      const parts = fittingParts(m[1]!.content);
      opts.draft?.(parts);
      return JSON.stringify({ parts });
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

  it('marks held notes and asks for ABCB rhymes in the brief', async () => {
    const m = fakeLyricModel();
    await writeLyrics(song, m, { sections });
    const brief = m.calls[0]!.messages[1]!.content;
    expect(brief).toMatch(/notes: [^;]*HOLD/u);
    expect(brief).toMatch(/A B C B/u);
    // A three-line verse rhymes ABA: line 2 is free.
    expect(brief).toMatch(/line 2: exactly \d+ syllables; notes: [^;]*; need not rhyme\n  line 3: exactly \d+ syllables; notes: [^;]*; its last word must rhyme with the last word of line 1/u);
  });

  it('sends a line that does not fit back to the model and keeps the rest', async () => {
    const first = sections[0]!;
    const m = model({
      draft: (parts) => (parts[first]![0]!.text = 'la'),
      repair: (_n, msgs) => {
        expect(msgs.at(-1)!.content).toMatch(new RegExp(`part "${first}", line 1 \\("la"\\): It has 1 syllables`, 'u'));
        return { fixes: [{ part: first, line: 1, text: fittingParts(msgs[1]!.content)[first]![0]!.text }] };
      },
    });
    const lyrics = await writeLyrics(song, m, { sections });
    expect(lyrics[first]![0]).toMatch(/^la la/u);
    expect(m.calls.map((c) => c.kind)).toEqual(['draft', 'grammar', 'repair', 'grammar']);
  });

  it('repairs a line the grammar reading flags', async () => {
    const first = sections[0]!;
    let fixed = '';
    const m = model({
      grammar: (n) => (n === 1 ? { problems: [{ part: first, line: 2, reason: 'a word is missing' }] } : { problems: [] }),
      repair: (_n, msgs) => {
        expect(msgs.at(-1)!.content).toMatch(/not correct, natural English: a word is missing\./u);
        fixed = fittingParts(msgs[1]!.content)[first]![1]!.text;
        return { fixes: [{ part: first, line: 2, text: fixed }] };
      },
    });
    const lyrics = await writeLyrics(song, m, { sections });
    expect(lyrics[first]![1]).toBe(fixed);
  });

  it('reasons in the last two rounds and fails, naming the lines, when they stay wrong', async () => {
    const first = sections[0]!;
    const m = model({ draft: (parts) => (parts[first]![0]!.text = 'la') });
    await expect(writeLyrics(song, m, { sections })).rejects.toThrow(new RegExp(`in ${MAX_ROUNDS} tries; still wrong:\\n- ${first} line 1: It has 1 syllables`, 'u'));
    const writes = m.calls.filter((c) => c.kind !== 'grammar');
    expect(writes.map((c) => c.thinking)).toEqual([false, false, false, false, true, true]);
    expect(m.calls.filter((c) => c.kind === 'grammar').every((c) => !c.thinking)).toBe(true);
  });

  it('refuses a song without a vocal melody', async () => {
    const hidden = orchestrate({ genre: 'brightPop', key: 'C', bpm: 110, seed: 'lyricist', params: { vocalMelody: false } });
    await expect(writeLyrics(hidden, fakeLyricModel(), { sections: [] })).rejects.toThrow(/no vocal melody/u);
  });
});
