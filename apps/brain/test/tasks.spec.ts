// Background tasks through the brain (docs/superpowers/specs/2026-11-25-vocal-tasks-design.md): a new song's vocal
// tracks start empty, Write melody shows them, Write lyrics runs in the background and keeps its result until a page
// applies it (saved as a new version of the project), a save or a delete while it runs, failures and retries, and
// resuming after a restart.

import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { sungSections } from '@casperaki/arrangement';
import { rapLineCount, type Song } from '@casperaki/song-schema';

import { createApp } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';
import type { ChatModel } from '../src/llm/chatModel.js';
import { openSongsStore, type SongsStore } from '../src/store.js';
import type { BackgroundTasks } from '../src/tasks/tasks.js';
import { fakeLyricModel } from './fakeLyricModel.js';

interface Harness { url: string; store: SongsStore; tasks: BackgroundTasks; stop: () => Promise<void> }

async function boot(lyricModel: ChatModel, store: SongsStore = openSongsStore({ path: ':memory:' })): Promise<Harness> {
  const app = createApp(loadConfig({} as NodeJS.ProcessEnv), { store, lyricModel });
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    store,
    tasks: (app.locals as { tasks: BackgroundTasks }).tasks,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const send = async (method: string, url: string, body?: unknown) => {
  const res = await fetch(url, { method, headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, body: (await res.json().catch(() => undefined)) as Record<string, unknown> };
};

interface TaskJson { id: string; kind: string; songId: string; title: string; state: string; message?: string }

/** A generated song (empty vocal tracks) and the same song with its melody written (unsaved). */
async function songWithMelody(h: Harness): Promise<{ id: string; hidden: Song; working: Song }> {
  const made = await send('POST', `${h.url}/api/songs/generate`, { genre: 'brightPop', key: 'C', bpm: 110, seed: 'tasks' });
  const hidden = made.body.song as Song;
  const edited = await send('POST', `${h.url}/api/tracks/edit`, { song: hidden, op: { kind: 'writeMelody' } });
  expect(edited.status).toBe(200);
  return { id: made.body.id as string, hidden, working: edited.body.song as Song };
}

const tasksOf = async (h: Harness) => (await send('GET', `${h.url}/api/tasks`)).body.tasks as TaskJson[];
const startLyrics = (h: Harness, songId: string, song: Song) => send('POST', `${h.url}/api/tasks`, { kind: 'writeLyrics', songId, song });

/** A model whose first answer waits until `release` is called. */
function gatedModel(): ChatModel & { release: () => void } {
  const inner = fakeLyricModel();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let first = true;
  return {
    release: () => release(),
    async complete(m, o) {
      if (first) {
        first = false;
        await gate;
      }
      return inner.complete(m, o);
    },
  };
}

describe('background tasks', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.tasks.idle();
    await h?.stop();
    h = undefined;
  });

  it('a new song starts with empty vocal tracks; Write melody shows them', async () => {
    h = await boot(fakeLyricModel());
    const { hidden, working } = await songWithMelody(h);
    expect(sungSections(hidden)).toEqual([]);
    expect(hidden.instrumentDefinitions.some((d) => d.name === 'Vocal')).toBe(true);
    expect(sungSections(working).length).toBeGreaterThan(0);
    // Written again: another melody (owner, 2026-11-27: Write melody is always there).
    const again = await send('POST', `${h.url}/api/tracks/edit`, { song: working, op: { kind: 'writeMelody' } });
    expect(again.status).toBe(200);
    const lead = (song: Song) => JSON.stringify(sungSections(song).map((s) => song.arrangement[s.name]!.overrides.Vocal));
    expect(lead(again.body.song as Song)).not.toBe(lead(working));
  });

  it('refuses to write lyrics before there is a melody', async () => {
    h = await boot(fakeLyricModel());
    const { id, hidden } = await songWithMelody(h);
    const r = await startLyrics(h, id, hidden);
    expect(r.status).toBe(422);
    expect(r.body.message).toBe('Write a melody first.');
  });

  it('writes lyrics in the background, keeps them ready, and applies them as a new version', async () => {
    h = await boot(fakeLyricModel());
    const { id, working } = await songWithMelody(h);
    const started = await startLyrics(h, id, working);
    expect(started.status).toBe(201);
    const task = started.body.task as TaskJson;
    expect(task).toMatchObject({ kind: 'writeLyrics', songId: id, state: 'running' });
    expect((await startLyrics(h, id, working)).status).toBe(409);
    await h.tasks.idle();
    expect((await tasksOf(h))[0]).toMatchObject({ id: task.id, state: 'ready' });
    // Ready: the saved song is untouched until a page applies it.
    expect(sungSections((await send('GET', `${h.url}/api/songs/${id}`)).body.song as Song)).toEqual([]);
    const applied = await send('POST', `${h.url}/api/tasks/${task.id}/apply`);
    expect(applied.status).toBe(200);
    const newId = applied.body.songId as string;
    expect(newId).not.toBe(id);
    expect((applied.body.task as TaskJson).state).toBe('done');
    const saved = (await send('GET', `${h.url}/api/songs/${newId}`)).body.song as Song;
    const sung = sungSections(saved);
    expect(sung.length).toBeGreaterThan(0);
    // Lyrics first: the fake's words ("<opener> la la <end>"), sung on a rhythm recut to them and recorded.
    for (const s of sung) for (const w of s.words) expect(w.toLowerCase()).toMatch(/^(oh la la \w+|\w+ \w+)$/u);
    const savedSong = (await send('GET', `${h.url}/api/songs/${newId}`)).body.song as Song;
    expect(Object.keys((savedSong.generator!.params as { params: { lyricRhythms: Record<string, unknown> } }).params.lyricRhythms).length).toBeGreaterThan(0);
    expect((await send('POST', `${h.url}/api/tasks/${task.id}/apply`)).status).toBe(409);
  });

  it('follows the project when it is saved while the task runs', async () => {
    const model = gatedModel();
    h = await boot(model);
    const { id, working } = await songWithMelody(h);
    const task = (await startLyrics(h, id, working)).body.task as TaskJson;
    const savedWhileRunning = await send('PUT', `${h.url}/api/songs/${id}`, { song: working });
    const movedId = savedWhileRunning.body.id as string;
    expect(movedId).not.toBe(id);
    model.release();
    await h.tasks.idle();
    const [listed] = await tasksOf(h);
    expect(listed).toMatchObject({ id: task.id, songId: movedId, state: 'ready' });
    const applied = await send('POST', `${h.url}/api/tasks/${task.id}/apply`);
    expect(applied.status).toBe(200);
    const projects = (await send('GET', `${h.url}/api/songs`)).body.projects as { id: string }[];
    expect(projects.map((p) => p.id)).toEqual([applied.body.songId]);
  });

  it('drops the task when the song is deleted while it runs', async () => {
    const model = gatedModel();
    h = await boot(model);
    const { id, working } = await songWithMelody(h);
    const task = (await startLyrics(h, id, working)).body.task as TaskJson;
    expect((await send('DELETE', `${h.url}/api/songs/${id}`)).status).toBeLessThan(300);
    model.release();
    await h.tasks.idle();
    expect(await tasksOf(h)).toEqual([]);
    expect(h.store.listRunningTasks().map((t) => t.id)).not.toContain(task.id);
  });

  it('a failed task says why and can be started again', async () => {
    let fail = true;
    const inner = fakeLyricModel();
    h = await boot({
      async complete(m, o) {
        if (fail) throw new Error('the lyrics model answered 503: busy');
        return inner.complete(m, o);
      },
    });
    const { id, working } = await songWithMelody(h);
    const task = (await startLyrics(h, id, working)).body.task as TaskJson;
    await h.tasks.idle();
    expect((await tasksOf(h))[0]).toMatchObject({ id: task.id, state: 'failed', message: 'the lyrics model answered 503: busy' });
    fail = false;
    expect((await send('POST', `${h.url}/api/tasks/${task.id}/retry`)).body.task).toMatchObject({ state: 'running' });
    await h.tasks.idle();
    expect((await tasksOf(h))[0]).toMatchObject({ id: task.id, state: 'ready' });
  });

  it('resumes running tasks when the brain starts again', async () => {
    const store = openSongsStore({ path: ':memory:' });
    const model = gatedModel();
    h = await boot(model, store);
    const { id, working } = await songWithMelody(h);
    const task = (await startLyrics(h, id, working)).body.task as TaskJson;
    // A second brain on the same database (the first one "crashed" with the task running).
    const second = await boot(fakeLyricModel(), store);
    second.tasks.resumeAll();
    await second.tasks.idle();
    expect((await tasksOf(second))[0]).toMatchObject({ id: task.id, state: 'ready' });
    await second.stop();
    model.release();
  });
});

/** A model that writes rap: every part asked for gets distinct rhyming couplets from a pool. */
function rapModel(): ChatModel {
  const pool = [
    'I hit the street, I feel the beat tonight',
    'I never stop, I keep it burning bright',
    'We ride, we glide, together, never fall',
    'We hear the calling and we give it all',
    'The neon glowing, slowing on the road',
    'We keep on flowing and we drop the load',
    'My heart a drum that beats inside my chest',
    'I start to run, I never take a rest',
    'The fire in my soul is like a flame',
    'The higher that I go, I know my name',
    "I ride the waves, I'm braver every day",
    'The rhythm saves the night, it fades away',
    "We're running in the rain along the street",
    'The thunder and the wonder of the beat',
    'The stars are bright above the silent town',
    'Guitars are loud, we never slow it down',
  ];

  return {
    async complete(messages) {
      const brief = messages.find((m) => m.role === 'user')!.content;
      const form = JSON.parse(brief.slice(brief.indexOf('in this form: ') + 'in this form: '.length)) as { sections: { name: string; lines: string[] }[] };
      let i = 0;
      return JSON.stringify({ sections: form.sections.map((s) => ({ name: s.name, lines: s.lines.map(() => pool[i++ % pool.length]!) })) });
    },
  };
}

describe('Write rap lyrics (docs/superpowers/specs/2026-11-28-rap-like-singing-design.md)', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.tasks.idle();
    await h?.stop();
    h = undefined;
  });

  it("writes the chosen sections' rap words in the background and applies them into the song", async () => {
    h = await boot(rapModel());
    const { id, working } = await songWithMelody(h);
    const verse = working.songStructure.find((s) => s.name.startsWith('verse'))!;
    const started = await send('POST', `${h.url}/api/tasks`, { kind: 'writeRapLyrics', songId: id, song: working, style: 'male rap vocals', sections: [verse.name] });
    expect(started.status).toBe(201);
    expect(started.body.task).toMatchObject({ kind: 'writeRapLyrics', state: 'running' });
    await h.tasks.idle();
    const applied = await send('POST', `${h.url}/api/tasks/${(started.body.task as TaskJson).id}/apply`);
    expect(applied.status).toBe(200);
    const saved = (await send('GET', `${h.url}/api/songs/${applied.body.songId as string}`)).body.song as Song;
    const rap = (saved.generator!.params as { params: { rapLyrics: Record<string, string[]> } }).params.rapLyrics;
    expect(Object.keys(rap)).toEqual([verse.name]);
    expect(rap[verse.name]).toHaveLength(rapLineCount(verse.bars.length));
  });

  it('refuses an unknown section', async () => {
    h = await boot(rapModel());
    const { id, working } = await songWithMelody(h);
    const r = await send('POST', `${h.url}/api/tasks`, { kind: 'writeRapLyrics', songId: id, song: working, style: 'male rap vocals', sections: ['nowhere'] });
    expect(r.status).toBe(400);
    expect(r.body.message).toBe('The song has no section "nowhere".');
  });
});
