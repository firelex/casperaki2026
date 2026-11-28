// The rap's words from the language model (src/ace/rapWords.ts): checked lines, repaired with what is wrong.
import { describe, expect, it } from 'vitest';

import type { ChatMessage, ChatModel } from '../src/llm/chatModel.js';
import { MAX_ROUNDS, RAP_DENSITY, rapProblems, writeRapWords } from '../src/ace/rapWords.js';

// Rhyming at the end (down / town) and inside (rolling / holding).
const GOOD = ['I been rolling through the city with the windows down', 'Holding every light, I am heading into town'];
// The owner's chosen 8-line verse (2026-11-28) had 9 to 11 syllables a line.
const SHORT = ['Rolling through the city, windows down', 'Holding every light, I hit the town'];
const SYL = RAP_DENSITY.syllables;

describe('rapProblems', () => {
  it('passes rhyming couplets of dictionary words, 8 to 11 syllables a line (as the 8-line verse the owner chose)', () => {
    expect(rapProblems(SHORT, 2, SYL)).toEqual([]);
    expect(rapProblems(GOOD, 2, SYL)[0]).toMatch(/Line 1 has 13 syllables; every line needs 8 to 11/u);
  });

  it('names a wrong count, unknown words, lines too short or long, and couplets that do not rhyme', () => {
    expect(rapProblems(SHORT, 4, SYL)).toEqual(['It needs exactly 4 lines, but 2 were written.']);
    expect(rapProblems(['Skrrt skrrt in the city, windows down', SHORT[1]!], 2, SYL)[0]).toMatch(/not in the dictionary.*skrrt/u);
    expect(rapProblems(['Go now', SHORT[1]!], 2, SYL)[0]).toMatch(/Line 1 has 2 syllables/u);
    expect(rapProblems([SHORT[0]!, 'Holding every light, I feel so fine'], 2, SYL)[0]).toMatch(/"down" and "fine" do not/u);
  });

  it('needs a rhyme inside every couplet, not only at the line ends (rap, owner 2026-11-28)', () => {
    const endOnly = ['Driving through the city, windows down', 'Every light is green, I hit the town'];
    expect(rapProblems(endOnly, 2, SYL)).toEqual([expect.stringMatching(/Lines 1 and 2 have no rhyme inside them/u)]);
  });
});

/** A model that answers from a list, recording what it was sent. */
function model(answers: string[]) {
  const sent: ChatMessage[][] = [];
  const m: ChatModel = {
    complete: async (messages) => {
      sent.push([...messages]);
      const a = answers.shift();
      if (a === undefined) throw new Error('no more answers');
      return a;
    },
  };
  return { m, sent };
}

const req = { density: RAP_DENSITY, title: 'Night Drive', style: 'male rap vocals', songWords: ['We drive all night'], sections: [{ name: 'verse2', label: 'Verse 2', lines: 2 }] };

describe('writeRapWords', () => {
  it('asks in plain words for every part, and sends wrong lines back until they pass', async () => {
    const bad = JSON.stringify({ sections: [{ name: 'Verse 2', lines: [SHORT[0], 'Holding every light, I feel so fine'] }] });
    const good = JSON.stringify({ sections: [{ name: 'Verse 2', lines: SHORT }] });
    const { m, sent } = model([bad, good]);
    expect(await writeRapWords(m, req)).toEqual({ verse2: SHORT });
    const brief = sent[0]![1]!.content;
    expect(brief).toContain('"Night Drive"');
    expect(brief).toContain('Verse 2 (2 lines)');
    expect(brief).toContain('male rap vocals');
    expect(brief).toContain('We drive all night');
    expect(brief).toMatch(/Internal rhymes/u);
    expect(brief).toMatch(/Do not stuff every phrase with rhymes/u);
    expect(brief).toMatch(/not a sung song/u);
    expect(brief).toContain('Every line takes one bar of music, so it has 8 to 11 syllables, most of them 9 to 11');
    expect(sent[1]!.at(-1)!.content).toMatch(/Verse 2: Lines 1 and 2 must rhyme/u);
  });

  it('fails loud after the last round', async () => {
    const { m } = model(Array.from({ length: MAX_ROUNDS }, () => 'not json'));
    await expect(writeRapWords(m, req)).rejects.toThrow(/still wrong after/u);
  });
});
