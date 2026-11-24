// Written lyrics through the brain: a generated song comes back at once and its sung sections' words are written in
// the background (recorded in the generator block, announced on /api/events),
// the vocal edits rewrite them or the melody for a section type, an added sung section gets words, and without a
// lyrics model those answer 503 (docs/superpowers/specs/2026-11-24-written-lyrics-design.md).

import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { orchestrate, sungSections, writtenLyricsOf } from '@casperaki/arrangement';
import type { Song } from '@casperaki/song-schema';

import { createApp } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { writeLyrics, type LyricMessage, type LyricModel } from '../src/lyrics/lyricist.js';
import type { LyricsTasks } from '../src/lyrics/tasks.js';
import { openSongsStore, type SongsStore } from '../src/store.js';
import { fakeLyricModel } from './fakeLyricModel.js';

interface Harness { url: string; store: SongsStore; tasks: LyricsTasks | undefined; stop: () => Promise<void> }

async function boot(lyricModel: LyricModel | undefined, store: SongsStore = openSongsStore({ path: ':memory:' })): Promise<Harness> {
  const app = createApp(loadConfig({} as NodeJS.ProcessEnv), { store, ...(lyricModel ? { lyricModel } : {}) });
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    store,
    tasks: (app.locals as { lyricsTasks?: LyricsTasks }).lyricsTasks,
    stop: () => new Promise<void>((resolve) => server.close(() => { store.close(); resolve(); })),
  };
}

const post = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const BODY = { genre: 'brightPop', key: 'C', bpm: 110, seed: 'lyrics-route' };
const recorded = (song: Song) => writtenLyricsOf((song.generator!.params as { params?: Record<string, unknown> }).params);
const words = (song: Song, name: string) => sungSections(song).find((s) => s.name === name)!.words.join(' / ');

interface Project { id: string; lyrics: { state: string; message?: string } | null }
const projects = async (h: Harness) => ((await (await fetch(`${h.url}/api/songs`)).json()) as { projects: Project[] }).projects;
const songOf = async (h: Harness, id: string) => ((await (await fetch(`${h.url}/api/songs/${id}`)).json()) as { song: Song }).song;

/** Generates a song and waits for its words. */
async function generated(h: Harness): Promise<Song> {
  await post(`${h.url}/api/songs/generate`, BODY);
  await h.tasks!.idle();
  const [p] = await projects(h);
  return songOf(h, p!.id);
}

/** Collects the events the brain sends on /api/events until stopped. */
function listen(h: Harness): { events: unknown[]; ready: Promise<void>; stop: () => void } {
  const events: unknown[] = [];
  const ac = new AbortController();
  let ready!: () => void;
  const readyP = new Promise<void>((r) => (ready = r));
  void (async () => {
    const res = await fetch(`${h.url}/api/events`, { signal: ac.signal });
    const reader = res.body!.getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) return;
      buf += new TextDecoder().decode(value);
      if (buf.includes(': connected')) ready();
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = /^data: (.*)$/mu.exec(chunk);
        if (data) events.push(JSON.parse(data[1]!));
      }
    }
  })();
  return { events, ready: readyP, stop: () => ac.abort() };
}

describe('lyrics in the brain', () => {
  let h: Harness | undefined;
  afterEach(async () => { await h?.stop(); h = undefined; });

  it('answers at once, writes the words in the background, saves them and announces them', async () => {
    h = await boot(fakeLyricModel());
    const ev = listen(h);
    await ev.ready;
    const res = await post(`${h.url}/api/songs/generate`, BODY);
    expect(res.status).toBe(201);
    const first = (await res.json()) as { id: string; project: Project };
    expect(first.project.lyrics).toEqual({ state: 'writing' });
    await h.tasks!.idle();
    const [p] = await projects(h);
    expect(p!.lyrics).toBeNull();
    expect(p!.id).not.toBe(first.id);
    const id = p!.id;
    const song = await songOf(h, id);
    await new Promise((r) => setTimeout(r, 50));
    ev.stop();
    expect(ev.events).toEqual([{ type: 'lyrics', state: 'done', songId: first.id, newSongId: id, lyrics: recorded(song) }]);
    const sung = sungSections(song);
    expect(Object.keys(recorded(song)).sort()).toEqual(sung.map((s) => s.name).sort());
    for (const s of sung) expect(s.words.join(' ')).toMatch(/^La\b/u);
    // Choruses share their words.
    const choruses = sung.filter((s) => s.type === 'chorus');
    expect(new Set(choruses.map((c) => c.words.join('|'))).size).toBe(1);
    const replay = (await (await post(`${h.url}/api/songs/${id}/replay`, {})).json()) as { ok: boolean };
    expect(replay.ok).toBe(true);
  });

  it('puts the words into the edits saved while they were being written', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const good = fakeLyricModel();
    h = await boot({ complete: async (m, o) => { await gate; return good.complete(m, o); } });
    const model = h;
    const { id, song } = (await (await post(`${h.url}/api/songs/generate`, BODY)).json()) as { id: string; song: Song };
    // Saved before the words are in: the outro is gone.
    const edited = { ...song, songStructure: song.songStructure.filter((s) => s.name !== 'outro') };
    const put = await fetch(`${h.url}/api/songs/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ song: edited }) });
    const saved = (await put.json()) as { id: string; project: Project };
    expect(put.status, JSON.stringify(saved)).toBe(200);
    expect(saved.project.lyrics).toEqual({ state: 'writing' });
    release();
    await model.tasks!.idle();
    const [p] = await projects(h);
    const final = await songOf(h, p!.id);
    expect(final.songStructure.map((s) => s.name)).not.toContain('outro');
    for (const s of sungSections(final)) expect(s.words.join(' ')).toMatch(/^La\b/u);
  });

  it('puts background words into a working song the editor has not saved (applyLyrics)', async () => {
    h = await boot(fakeLyricModel());
    const { song: draft } = (await (await post(`${h.url}/api/songs/generate`, BODY)).json()) as { song: Song };
    await h.tasks!.idle();
    const written = recorded(await songOf(h, (await projects(h))[0]!.id));
    const res = await post(`${h.url}/api/tracks/edit`, { song: draft, op: { kind: 'applyLyrics', lyrics: written } });
    expect(res.status).toBe(200);
    const { song } = (await res.json()) as { song: Song };
    expect(recorded(song)).toEqual(written);
    for (const s of sungSections(song)) expect(s.words.join(' ')).toMatch(/^La\b/u);
  });

  it('says why writing failed, and writes them when asked again', async () => {
    let fail = true;
    const good = fakeLyricModel();
    h = await boot({ complete: async (m, o) => { if (fail) throw new Error('the model is down'); return good.complete(m, o); } });
    const { id } = (await (await post(`${h.url}/api/songs/generate`, BODY)).json()) as { id: string };
    await h.tasks!.idle();
    expect((await projects(h))[0]!.lyrics).toEqual({ state: 'failed', message: 'the model is down' });
    fail = false;
    expect((await post(`${h.url}/api/songs/${id}/lyrics`, {})).status).toBe(202);
    await h.tasks!.idle();
    const [p] = await projects(h);
    expect(p!.lyrics).toBeNull();
    expect(Object.keys(recorded(await songOf(h, p!.id))).length).toBeGreaterThan(0);
  });

  it('resumes the words a restart interrupted', async () => {
    const store = openSongsStore({ path: ':memory:' });
    h = await boot({ complete: () => new Promise(() => undefined) }, store); // never answers: the "restart" ends it
    await post(`${h.url}/api/songs/generate`, BODY);
    expect((await projects(h))[0]!.lyrics).toEqual({ state: 'writing' });
    const again = createApp(loadConfig({} as NodeJS.ProcessEnv), { store, lyricModel: fakeLyricModel() });
    const tasks = (again.locals as { lyricsTasks: LyricsTasks }).lyricsTasks;
    tasks.resumeAll();
    await tasks.idle();
    expect(store.listWritingLyrics()).toEqual([]);
    expect(Object.keys(recorded(store.get(store.listProjects('local-dev')[0]!.songId)!.song)).length).toBeGreaterThan(0);
  });

  it('answers 503 when no lyrics model is configured', async () => {
    h = await boot(undefined);
    const res = await post(`${h.url}/api/songs/generate`, BODY);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe('lyrics_not_configured');
  });

  it('writes new words for every section of a type, and a new melody with new words', async () => {
    h = await boot(fakeLyricModel());
    const song = await generated(h);
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
    const song = await generated(h);
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
