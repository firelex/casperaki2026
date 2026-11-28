// Song titles: the model's answer is cleaned and checked, the prompt describes
// the song, and the titler renames only a project that still has its placeholder.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { orchestrate } from '@casperaki/arrangement';
import { canonicalStringifySong } from '@casperaki/song-schema';
import { openSongsStore, type SongsStore } from '../src/store.js';
import { cleanTitle, songPrompt, SongTitler } from '../src/titles/songTitler.js';
import { drawTitles, MAX_TITLE_WORDS, TITLE_EXAMPLES, titleBank } from '../src/titles/titleBank.js';

describe('cleanTitle', () => {
  it('keeps the first line and strips quotes, a "Title:" label and a full stop', () => {
    expect(cleanTitle('"Still Water"\nA calm song.')).toBe('Still Water');
    expect(cleanTitle('Title: Neon Skyline.')).toBe('Neon Skyline');
    expect(cleanTitle('**Glass Horizon**')).toBe('Glass Horizon');
  });
  it('refuses an empty or over-long answer', () => {
    expect(() => cleanTitle('  ""  ')).toThrow(/no title/);
    expect(() => cleanTitle('x'.repeat(61))).toThrow(/too long/);
  });
});

describe('songPrompt', () => {
  it('asks for a short chart-pop title, not a poetic image', () => {
    const prompt = songPrompt(orchestrate({ genre: 'brightPop', key: 'C', bpm: 120, seed: 'pop-title' }), [], []);
    expect(prompt).toMatch(/chart-pop/u);
    for (const s of ['Bad Idea', 'Kiss Me Back', 'Not Your Girl', 'Cinnamon Boulevard']) expect(prompt).toContain(s);
    expect(prompt).not.toMatch(/Evocative/u);
  });

  it('describes the song and lists the titles to avoid', () => {
    const song = orchestrate({ genre: 'brightPop', key: 'C', bpm: 120, seed: 'titles' });
    const prompt = songPrompt(song, ['Still Water'], []);
    expect(prompt).toContain('Style: bright pop');
    expect(prompt).toContain('Key: C');
    expect(prompt).toContain('Tempo: 120 beats per minute');
    expect(prompt).toContain('Still Water');
    expect(prompt).toContain('Answer with the title only');
  });
});

describe('example titles (owner 2026-11-28: "more pop ... give DeepSeek references like we do for the lyrics")', () => {
  it('the bank holds about 1,000 different chart-pop titles of one to four words', () => {
    const bank = titleBank();
    expect(bank.length).toBeGreaterThanOrEqual(1000);
    expect(new Set(bank.map((t) => t.toLowerCase())).size).toBe(bank.length);
    for (const t of bank) expect(t.split(/\s+/u).length, t).toBeLessThanOrEqual(MAX_TITLE_WORDS);
  });

  it('a dozen different examples are drawn per song and shown as the feel, not to copy', () => {
    let n = 0;
    const examples = drawTitles(titleBank(), TITLE_EXAMPLES, () => ((n = (n * 7 + 3) % 97) / 97));
    expect(new Set(examples).size).toBe(TITLE_EXAMPLES);
    const prompt = songPrompt(orchestrate({ genre: 'brightPop', key: 'C', bpm: 120, seed: 'pop-title' }), [], examples);
    for (const e of examples) expect(prompt).toContain(e);
    expect(prompt).toMatch(/do not copy any of them/u);
  });
});

describe('SongTitler', () => {
  let server: Server | undefined;
  let store: SongsStore | undefined;
  afterEach(async () => {
    store?.close();
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
    store = undefined;
  });

  async function setup(answer: (body: { messages: { content: string }[] }) => { status: number; text: string }) {
    const prompts: string[] = [];
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = JSON.parse(raw) as { messages: { content: string }[]; chat_template_kwargs?: { thinking?: boolean } };
        expect(body.chat_template_kwargs?.thinking).toBe(false);
        prompts.push(body.messages[0]!.content);
        const a = answer(body);
        res.writeHead(a.status, { 'content-type': 'application/json' });
        res.end(a.status === 200 ? JSON.stringify({ choices: [{ message: { content: a.text } }] }) : a.text);
      });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as AddressInfo).port;
    store = openSongsStore({ path: ':memory:' });
    const song = orchestrate({ genre: 'edm', key: 'A', bpm: 126, seed: 'titler' });
    store.put({ id: 'a'.repeat(16), song, canonical: canonicalStringifySong(song, 2), hash: 'h', createdAt: '2026-11-22T00:00:00Z' });
    store.upsertProject({ ownerId: 'u', songId: 'a'.repeat(16), title: 'Edm in A', createdAt: '2026-11-22T00:00:00Z', updatedAt: '2026-11-22T00:00:00Z' });
    const titler = new SongTitler({ baseUrl: `http://127.0.0.1:${port}/v1`, model: 'test' }, store, () => '2026-11-22T00:00:01Z');
    return { titler, song, prompts };
  }

  it('renames a project that still has its placeholder', async () => {
    const { titler, song } = await setup(() => ({ status: 200, text: '"Glass Horizon"' }));
    titler.name({ ownerId: 'u', songId: 'a'.repeat(16), song, placeholderTitle: 'Edm in A' });
    await titler.idle();
    expect(store!.getProject('u', 'a'.repeat(16))!.title).toBe('Glass Horizon');
  });

  it('leaves a title the user changed meanwhile', async () => {
    const { titler, song } = await setup(() => {
      store!.renameProject({ ownerId: 'u', songId: 'a'.repeat(16), title: 'Mine', updatedAt: '2026-11-22T00:00:00Z' });
      return { status: 200, text: 'Glass Horizon' };
    });
    titler.name({ ownerId: 'u', songId: 'a'.repeat(16), song, placeholderTitle: 'Edm in A' });
    await titler.idle();
    expect(store!.getProject('u', 'a'.repeat(16))!.title).toBe('Mine');
  });

  it('asks again when the answer copies one of the example titles it was shown', async () => {
    let n = 0;
    const { titler, song, prompts } = await setup((body) => {
      n++;
      // the first answer is one of the shown examples
      const shown = /Aim for the feel of these chart-pop titles \(do not copy any of them\): (.*)\.$/mu.exec(body.messages[0]!.content)![1]!.split('; ');
      return { status: 200, text: n === 1 ? shown[0]! : 'Brand New Line' };
    });
    titler.name({ ownerId: 'u', songId: 'a'.repeat(16), song, placeholderTitle: 'Edm in A' });
    await titler.idle();
    expect(prompts).toHaveLength(2);
    expect(store!.getProject('u', 'a'.repeat(16))!.title).toBe('Brand New Line');
  });

  it('a title already in the bank is not offered again: the next ask lists it to avoid, and four bank titles in a row still end named (song "Casperaki Pop in D", 2026-11-28)', async () => {
    let n = 0;
    const bankTitles = titleBank().slice(0, 4);
    const { titler, song, prompts } = await setup(() => {
      n++;
      return { status: 200, text: n <= 4 ? bankTitles[n - 1]! : 'Brand New Line' };
    });
    titler.name({ ownerId: 'u', songId: 'a'.repeat(16), song, placeholderTitle: 'Edm in A' });
    await titler.idle();
    expect(prompts).toHaveLength(5);
    for (const t of bankTitles) expect(prompts[4]).toContain(t);
    expect(store!.getProject('u', 'a'.repeat(16))!.title).toBe('Brand New Line');
  });

  it('keeps the placeholder when the model fails', async () => {
    const { titler, song } = await setup(() => ({ status: 500, text: 'boom' }));
    titler.name({ ownerId: 'u', songId: 'a'.repeat(16), song, placeholderTitle: 'Edm in A' });
    await titler.idle();
    expect(store!.getProject('u', 'a'.repeat(16))!.title).toBe('Edm in A');
  });
});
