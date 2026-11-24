// Written lyrics through the brain: generation writes every sung section's words (recorded in the generator block),
// the vocal edits rewrite them or the melody for a section type, an added sung section gets words, and without a
// lyrics model those answer 503 (docs/superpowers/specs/2026-11-24-written-lyrics-design.md).

import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { orchestrate, sungSections, writtenLyricsOf } from '@casperaki/arrangement';
import type { Song } from '@casperaki/song-schema';

import { createApp } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { writeLyrics, type LyricMessage, type LyricModel } from '../src/lyrics/lyricist.js';
import { openSongsStore } from '../src/store.js';
import { fakeLyricModel } from './fakeLyricModel.js';

interface Harness { url: string; stop: () => Promise<void> }

async function boot(lyricModel: LyricModel | undefined): Promise<Harness> {
  const store = openSongsStore({ path: ':memory:' });
  const app = createApp(loadConfig({} as NodeJS.ProcessEnv), { store, ...(lyricModel ? { lyricModel } : {}) });
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    stop: () => new Promise<void>((resolve) => server.close(() => { store.close(); resolve(); })),
  };
}

const post = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const BODY = { genre: 'brightPop', key: 'C', bpm: 110, seed: 'lyrics-route' };
const recorded = (song: Song) => writtenLyricsOf((song.generator!.params as { params?: Record<string, unknown> }).params);
const words = (song: Song, name: string) => sungSections(song).find((s) => s.name === name)!.words.join(' / ');

describe('lyrics in the brain', () => {
  let h: Harness | undefined;
  afterEach(async () => { await h?.stop(); h = undefined; });

  it('generates a song with written words in every sung section, recorded so replay rebuilds it', async () => {
    h = await boot(fakeLyricModel());
    const res = await post(`${h.url}/api/songs/generate`, BODY);
    expect(res.status).toBe(201);
    const { id, song } = (await res.json()) as { id: string; song: Song };
    const sung = sungSections(song);
    expect(Object.keys(recorded(song)).sort()).toEqual(sung.map((s) => s.name).sort());
    for (const s of sung) expect(s.words.join(' ')).toMatch(/^La\b/u);
    // Choruses share their words.
    const choruses = sung.filter((s) => s.type === 'chorus');
    expect(new Set(choruses.map((c) => c.words.join('|'))).size).toBe(1);
    const replay = (await (await post(`${h.url}/api/songs/${id}/replay`, {})).json()) as { ok: boolean };
    expect(replay.ok).toBe(true);
  });

  it('answers 503 when no lyrics model is configured', async () => {
    h = await boot(undefined);
    const res = await post(`${h.url}/api/songs/generate`, BODY);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe('lyrics_not_configured');
  });

  it('writes new words for every section of a type, and a new melody with new words', async () => {
    h = await boot(fakeLyricModel());
    const { song } = (await (await post(`${h.url}/api/songs/generate`, BODY)).json()) as { song: Song };
    const verse = sungSections(song).find((s) => s.type === 'verse')!.name;

    // New words: the brain's fake model writes the same words again, so check the request went through the lyricist
    // and the song still carries every section's words.
    const a = (await (await post(`${h.url}/api/tracks/edit`, { song, op: { kind: 'newLyrics', section: verse } })).json()) as { song: Song; track: string };
    expect(a.track).toBe('Vocal');
    expect(Object.keys(recorded(a.song)).sort()).toEqual(Object.keys(recorded(song)).sort());

    const b = (await (await post(`${h.url}/api/tracks/edit`, { song, op: { kind: 'newMelody', section: 'chorus1' } })).json()) as { song: Song };
    const g = (b.song.generator!.params as { params: { melodyVariants: Record<string, number> } }).params;
    expect(g.melodyVariants.chorus).toBeGreaterThan(0);
    expect(JSON.stringify(b.song.arrangement.chorus1!.overrides.Vocal!.bars)).not.toBe(JSON.stringify(song.arrangement.chorus1!.overrides.Vocal!.bars));
    expect(JSON.stringify(b.song.arrangement.verse1!.overrides.Vocal!.bars)).toBe(JSON.stringify(song.arrangement.verse1!.overrides.Vocal!.bars));
    expect(words(b.song, 'chorus1')).toMatch(/^La\b/u);
  });

  it('gives an added sung section written words', async () => {
    h = await boot(fakeLyricModel());
    const { song } = (await (await post(`${h.url}/api/songs/generate`, BODY)).json()) as { song: Song };
    // The same length as the song's bridge (a different length trips a separate, known chord-merge bug).
    const bars = song.songStructure.find((s) => s.name === 'bridge1')!.bars.length;
    const res = await post(`${h.url}/api/sections/add`, { song, type: 'bridge', index: 2, bars });
    expect(res.status).toBe(200);
    const { song: added, name } = (await res.json()) as { song: Song; name: string };
    expect(words(added, name)).toMatch(/^La\b/u);
  });

  it('the vocal edits answer 503 without a lyrics model', async () => {
    h = await boot(undefined);
    const song = orchestrate(BODY);
    const res = await post(`${h.url}/api/tracks/edit`, { song, op: { kind: 'newLyrics', section: 'chorus1' } });
    expect(res.status).toBe(503);
  });
});

describe('the lyricist', () => {
  it('sends back only the lines that do not fit, and keeps the rest', async () => {
    const song = orchestrate(BODY);
    const verse = sungSections(song).find((s) => s.type === 'verse')!;
    const good = fakeLyricModel();
    const seen: LyricMessage[][] = [];
    let round = 0;
    const model: LyricModel = {
      async complete(messages) {
        seen.push([...messages]);
        round++;
        const answer = JSON.parse(await good.complete(messages)) as { parts: Record<string, { syllables: string[]; text: string }[]> };
        if (round > 1) return JSON.stringify({ fixes: [{ part: verse.name, line: 1, syllables: [], text: answer.parts[verse.name]![0]!.text }] });
        answer.parts[verse.name]![0] = { syllables: [], text: 'la' };
        return JSON.stringify(answer);
      },
    };
    const lyrics = await writeLyrics(song, model, { sections: [verse.name] });
    expect(round).toBe(2);
    expect(seen[1]!.at(-1)!.content).toMatch(new RegExp(`part "${verse.name}", line 1 \\("la"\\): It has 1 syllables`, 'u'));
    expect(lyrics[verse.name]!.length).toBe(verse.lines.length);
  });

  it('fails with the remaining problems when the model cannot fit the lines', async () => {
    const song = orchestrate(BODY);
    const verse = sungSections(song).find((s) => s.type === 'verse')!;
    const model: LyricModel = { complete: async () => JSON.stringify({ parts: { [verse.name]: verse.lines.map(() => ({ syllables: [], text: 'la' })) }, fixes: [] }) };
    await expect(writeLyrics(song, model, { sections: [verse.name] })).rejects.toThrow(/could not write lines that fit the melody/u);
  });
});

describe('long requests as jobs', () => {
  let h: Harness | undefined;
  afterEach(async () => { await h?.stop(); h = undefined; });

  it('answers 202 with a job when asked to, and the job ends with the answer the route would have given', async () => {
    h = await boot(fakeLyricModel());
    const res = await fetch(`${h.url}/api/songs/generate`, { method: 'POST', headers: { 'content-type': 'application/json', prefer: 'respond-async' }, body: JSON.stringify(BODY) });
    expect(res.status).toBe(202);
    const { jobId } = (await res.json()) as { jobId: string };
    let job: { done: boolean; status?: number; body?: { id: string } } = { done: false };
    for (let i = 0; i < 100 && !job.done; i++) {
      job = (await (await fetch(`${h.url}/api/jobs/${jobId}`)).json()) as typeof job;
      if (!job.done) await new Promise((r) => setTimeout(r, 50));
    }
    expect(job).toMatchObject({ done: true, status: 201, body: { id: expect.any(String) } });
    expect((await fetch(`${h.url}/api/jobs/nope`)).status).toBe(404);
  });

  it("a job's error is its route's error", async () => {
    h = await boot(undefined);
    const res = await fetch(`${h.url}/api/songs/generate`, { method: 'POST', headers: { 'content-type': 'application/json', prefer: 'respond-async' }, body: JSON.stringify(BODY) });
    const { jobId } = (await res.json()) as { jobId: string };
    let job: { done: boolean; status?: number; body?: { error: string } } = { done: false };
    for (let i = 0; i < 100 && !job.done; i++) {
      job = (await (await fetch(`${h.url}/api/jobs/${jobId}`)).json()) as typeof job;
      if (!job.done) await new Promise((r) => setTimeout(r, 50));
    }
    expect(job).toMatchObject({ done: true, status: 503, body: { error: 'lyrics_not_configured' } });
  });
});
