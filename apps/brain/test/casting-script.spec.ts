// The castingScript task (docs/superpowers/plans/2026-11-28-casting-3-writer.md, task 3): its preconditions (a sung
// song, the performing avatar's singer, a chorus, a known outcome), the run with a fake language model, the steps per
// scene, and admins only.

import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { orchestrate } from '@casperaki/arrangement';
import { canonicalStringifySong } from '@casperaki/song-schema';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { UserAvatars } from '../src/avatars/userAvatars.js';
import { EventHub } from '../src/events.js';
import type { ChatModel } from '../src/llm/chatModel.js';
import { createCastingRouter } from '../src/routes/casting.js';
import { hashCanonical } from '../src/routes/songs.js';
import { openSongsStore, type SongsStore } from '../src/store.js';
import { BackgroundTasks, TaskError } from '../src/tasks/tasks.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const recipe = { pack: 'drophunter', parts: { body: '0' }, textures: {}, colors: {} };

/** A fake model: plans and lines that pass the writer's checks (each vote said in the judge's last verdicts turn). */
function fakeChat(): ChatModel & { calls: number } {
  const fake = {
    calls: 0,
    complete: async (messages: readonly { content: string }[]) => {
      fake.calls += 1;
      const system = messages[0]!.content;
      const line = (extra = '') => JSON.stringify({ text: `Well this is a fine moment for everyone here today and I have to say it really is quite something${extra}.`, delivery: 'warm', gesture: 'nod' });
      if (system.startsWith('You plan')) {
        if (system.includes('backstage')) return JSON.stringify({ beats: ['b'], turns: Array.from({ length: 5 }, () => ({ speaker: 'Narrator', intent: 'x', words: 20 })) });
        if (system.includes('yes-or-no round')) return JSON.stringify({ beats: ['v'], turns: ['Ice', 'Bob', 'Nicky', 'Love', 'Ice', 'Kesha'].map((s) => ({ speaker: s, intent: 'votes', words: 12 })) });
        return JSON.stringify({ beats: ['t'], turns: ['Bob', 'Kesha', 'Bob'].map((s) => ({ speaker: s, intent: 'talk', words: 12 })) });
      }
      const vote = /say plainly, with the word "(yes|no)"/u.exec(system)?.[1];
      return line(vote ? `, ${vote}` : '');
    },
  };
  return fake;
}

let dir: string;
let store: SongsStore;
let avatars: UserAvatars;
let chat: ReturnType<typeof fakeChat>;
let tasks: BackgroundTasks;
const songId = 'abcdef0123456789';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'casting-'));
  store = openSongsStore({ path: ':memory:' });
  const song = orchestrate({ genre: 'brightPop', key: 'C', bpm: 120, seed: 'casting-2' });
  const canonical = canonicalStringifySong(song, 2);
  store.put({ id: songId, song, canonical, hash: hashCanonical(canonical), createdAt: 't' });
  store.upsertProject({ ownerId: 'me', songId, title: 'Electric Daydream', createdAt: 't', updatedAt: 't' });
  avatars = new UserAvatars(dir);
  chat = fakeChat();
  tasks = new BackgroundTasks({
    store,
    events: new EventHub(),
    hash: hashCanonical,
    clock: () => new Date().toISOString(),
    casting: { chat, avatars, findSinger: (_o, id) => ({ name: id === 'kesha' ? 'Kesha' : 'Karla', description: 'bright pop voice' }) },
  });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function sung(singerId: string) {
  store.insertTask({ id: `sing-${singerId}`, ownerId: 'me', songId, kind: 'sing', input: '', startedAt: 't', options: { singerId } });
  store.setTaskState(`sing-${singerId}`, { state: 'done', result: {}, message: null, finishedAt: 't' });
}
const avatar = (singerId: string | null) => avatars.save('me', { style: 'anime', name: 'Mia', recipe, singerId }, PNG, 't');
const refused = (f: () => unknown, status: number, code: string) => {
  try {
    f();
  } catch (err) {
    expect(err).toBeInstanceOf(TaskError);
    expect((err as TaskError).status).toBe(status);
    expect((err as TaskError).code).toBe(code);
    return;
  }
  throw new Error(`expected a ${status} ${code}`);
};

describe('starting a casting script', () => {
  it('needs the song to have been sung, by the performing avatar\'s singer', () => {
    const mia = avatar('kesha');
    refused(() => tasks.startCastingScript('me', songId, { avatarId: mia.id, outcome: 'fourYes' }), 400, 'not_sung');
    sung('karla');
    refused(() => tasks.startCastingScript('me', songId, { avatarId: mia.id, outcome: 'fourYes' }), 400, 'wrong_singer');
  });
  it('refuses an unknown avatar, an unknown outcome and a song that is not the owner\'s', () => {
    sung('kesha');
    const mia = avatar('kesha');
    refused(() => tasks.startCastingScript('me', songId, { avatarId: 'a-000000000000', outcome: 'fourYes' }), 400, 'unknown_avatar');
    refused(() => tasks.startCastingScript('me', songId, { avatarId: mia.id, outcome: 'maybe' }), 400, 'invalid_outcome');
    refused(() => tasks.startCastingScript('someone', songId, { avatarId: mia.id, outcome: 'fourYes' }), 404, 'not_found');
  });
  it('writes the script, scene by scene, and finishes done (nothing to put into the song)', async () => {
    sung('kesha');
    const mia = avatar('kesha');
    const task = tasks.startCastingScript('me', songId, { avatarId: mia.id, outcome: 'threeOne' });
    expect(task.kind).toBe('castingScript');
    refused(() => tasks.startCastingScript('me', songId, { avatarId: mia.id, outcome: 'threeOne' }), 409, 'already_running');
    await tasks.idle();
    const done = store.getTask('me', task.id)!;
    expect(done.state).toBe('done');
    const script = done.result as { banter: { speaker: string }[]; verdicts: { speaker: string }[] };
    expect(script.banter.map((l) => l.speaker)).toContain('singer');
    expect(script.verdicts.at(-1)!.speaker).toBe('singer');
    expect(done.steps.map((s) => [s.id, s.state])).toEqual([['backstage', 'done'], ['banter', 'done'], ['verdicts', 'done']]);
  });
});

describe('the casting routes', () => {
  async function serve(admin: boolean) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).user = { id: 'me', email: 'me@example.com' };
      next();
    });
    app.use(createCastingRouter({ store, tasks, isAdminRequest: () => admin, ownerOf: () => 'me' }));
    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
  }
  it('are for admins only', async () => {
    const s = await serve(false);
    try {
      for (const method of ['POST', 'GET']) {
        const res = await fetch(`${s.url}/api/songs/${songId}/casting/script`, { method, headers: { 'content-type': 'application/json' }, ...(method === 'POST' ? { body: '{}' } : {}) });
        expect(res.status).toBe(403);
      }
    } finally {
      await s.close();
    }
  });
  it('start a script and give back the latest finished one', async () => {
    sung('kesha');
    const mia = avatar('kesha');
    const s = await serve(true);
    try {
      expect((await fetch(`${s.url}/api/songs/${songId}/casting/script`)).status).toBe(404);
      const res = await fetch(`${s.url}/api/songs/${songId}/casting/script`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ avatarId: mia.id, outcome: 'fourYes' }) });
      expect(res.status).toBe(202);
      await tasks.idle();
      const got = await fetch(`${s.url}/api/songs/${songId}/casting/script`);
      expect(got.status).toBe(200);
      const body = (await got.json()) as { script: { outcome: string } };
      expect(body.script.outcome).toBe('fourYes');
    } finally {
      await s.close();
    }
  });
});

describe('a singer named like a judge', () => {
  it('cannot be cast until renamed', () => {
    sung('nicky-singer');
    const t2 = new BackgroundTasks({
      store,
      events: new EventHub(),
      hash: hashCanonical,
      clock: () => new Date().toISOString(),
      casting: { chat, avatars, findSinger: () => ({ name: 'Nicky', description: null }) },
    });
    const mia = avatar('nicky-singer');
    refused(() => t2.startCastingScript('me', songId, { avatarId: mia.id, outcome: 'fourYes' }), 400, 'name_clash');
  });
});
