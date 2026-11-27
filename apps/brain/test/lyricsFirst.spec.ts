import { describe, expect, it } from 'vitest';

import type { ChatMessage, ChatModel } from '../src/llm/chatModel.js';
import { ARTISTS, drawInspiration, situations } from '../src/lyrics/inspiration.js';
import { MAX_ROUNDS, writeLyricsFirst, type LyricsFirstRequest } from '../src/lyrics/lyricsFirst.js';

const GOOD = {
  verse: ['Saw your phone light up again', 'A name I do not know', 'You said it was nothing', 'But I could see it show'],
  chorus: ['Cinnamon Boulevard that is where we are', 'Dancing in the summer heat', 'Cinnamon Boulevard that is where we are', 'Moving to the beat'],
};
const answer = (parts: Record<string, string[]>) =>
  JSON.stringify({ sections: Object.entries(parts).map(([type, lines]) => ({ name: type === 'verse' ? 'Verse' : 'Chorus', lines })) });

function scripted(answers: readonly string[]): ChatModel & { calls: { messages: readonly ChatMessage[]; thinking: boolean }[] } {
  const calls: { messages: readonly ChatMessage[]; thinking: boolean }[] = [];
  return {
    calls,
    async complete(messages, options) {
      calls.push({ messages, thinking: options.thinking });
      const a = answers[Math.min(calls.length, answers.length) - 1];
      if (a === undefined) throw new Error('no scripted answer');
      return a;
    },
  };
}

const REQUEST: LyricsFirstRequest = {
  types: [
    { type: 'verse', label: 'Verse', lines: 4 },
    { type: 'chorus', label: 'Chorus', lines: 4 },
  ],
  title: 'Cinnamon Boulevard',
  genre: 'brightPop',
  recentOpenings: [],
  inspiration: { artist: 'Dua Lipa', situation: 'a text you should not send at 2 a.m.' },
};

describe('the lyrics-first lyricist', () => {
  it('asks once, without reasoning, with the title, the artist, the situation and each part', async () => {
    const model = scripted([answer(GOOD)]);
    const out = await writeLyricsFirst(model, REQUEST);
    expect(out).toEqual(GOOD);
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]!.thinking).toBe(false);
    const prompt = model.calls[0]!.messages.map((m) => m.content).join('\n');
    for (const s of ['Cinnamon Boulevard', 'Dua Lipa', 'a text you should not send at 2 a.m.', 'Verse (4 lines)', 'Chorus (4 lines)', '4 to 11 syllables']) expect(prompt).toContain(s);
  });

  it('sends a bad rhyme back once, naming the line, and keeps the rest', async () => {
    const bad = { ...GOOD, verse: [...GOOD.verse.slice(0, 3), 'But I could feel it then'] };
    const model = scripted([answer(bad), answer(GOOD)]);
    expect(await writeLyricsFirst(model, REQUEST)).toEqual(GOOD);
    expect(model.calls).toHaveLength(2);
    const repair = model.calls[1]!.messages.at(-1)!.content;
    expect(repair).toMatch(/Verse, line 4/u);
    expect(repair).toMatch(/rhyme/u);
  });

  it('rejects an opening like a recent song', async () => {
    const copy = { ...GOOD, verse: ['Met you at the gas station', ...GOOD.verse.slice(1)] };
    const model = scripted([answer(copy), answer(GOOD)]);
    expect(await writeLyricsFirst(model, { ...REQUEST, recentOpenings: ['Met you at the corner store'] })).toEqual(GOOD);
    expect(model.calls[1]!.messages.at(-1)!.content).toMatch(/recent song/u);
  });

  it(`fails after ${MAX_ROUNDS} rounds, naming what is still wrong`, async () => {
    const bad = { ...GOOD, verse: [...GOOD.verse.slice(0, 3), 'But I could feel it then'] };
    const model = scripted([answer(bad)]);
    await expect(writeLyricsFirst(model, REQUEST)).rejects.toThrow(/Verse, line 4/u);
    expect(model.calls).toHaveLength(MAX_ROUNDS);
  });

  it('an answer that is not the asked form is sent back as such', async () => {
    const model = scripted(['not json', answer(GOOD)]);
    expect(await writeLyricsFirst(model, REQUEST)).toEqual(GOOD);
    expect(model.calls[1]!.messages.at(-1)!.content).toMatch(/form/u);
  });
});

describe('inspiration', () => {
  it('draws an artist and a situation from the lists', () => {
    const a = drawInspiration(() => 0);
    expect(a).toEqual({ artist: ARTISTS[0], situation: situations()[0] });
    expect(drawInspiration(() => 0.999).artist).toBe(ARTISTS.at(-1));
  });
  it('has at least 150 distinct situations', () => {
    expect(new Set(situations()).size).toBeGreaterThanOrEqual(150);
  });
});
