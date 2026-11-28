// Realistic avatars (docs/superpowers/specs/2026-11-28-realistic-avatars-design.md) through the brain: the curated
// library, designs checked against it, builds as background tasks against a fake avatar builder, saving a finished
// build as an avatar with its VRM file, admins only, and one style per video.

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { UserAvatars } from '../src/avatars/userAvatars.js';
import { videoAvatars } from '../src/avatars/videoAvatars.js';
import { createAvatarsRouter } from '../src/routes/avatars.js';
import type { BackgroundTasks } from '../src/tasks/tasks.js';
import { openSongsStore } from '../src/store.js';
import { VideoInputError } from '../src/video/videoInput.js';
import { fakeVocalLevel } from './fakeVocalLevel.js';
import { startFakeAvatarBuilder, VRM_BYTES, type FakeAvatarBuilder } from './fakeAvatarBuilder.js';

const BUILT_IN = join(__dirname, '../../models/services/vocals/voices');
const LIBRARY = join(__dirname, '../../models/services/avatar-builder/library.json');
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const portrait = `data:image/png;base64,${PNG_1PX}`;

export const design = () => ({
  body: { gender: 0, age: 26, weight: 0.45, muscle: 0.5, proportions: 0.75 },
  ancestry: { african: 0, asian: 0, european: 1 },
  face: { jawWidth: 0, chin: 0, noseWidth: 0, noseLength: 0, eyeSize: 0, lips: 0, cheekbones: 0, browAngle: 0, feminine: 0 },
  skin: 'young_caucasian_female', eyes: 'green', eyebrows: 'eyebrow003',
  hair: 'long01', hairColour: null, hairTint: null, lips: '#9E0F1A',
  clothes: ['punkduck_sleeveless_crop_top', 'elvs_jeans_bootcut', 'shoes02'],
});

let dir: string;
let url: string;
let stop: () => Promise<void>;
let builder: FakeAvatarBuilder;
let tasks: BackgroundTasks;

async function boot(env: Record<string, string>) {
  const app = createApp(loadConfig({ BRAIN_SINGERS_DIR: BUILT_IN, ...env } as NodeJS.ProcessEnv), { store: openSongsStore({ path: ':memory:' }), vocalLevel: fakeVocalLevel(), singPollMs: 5 });
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  tasks = (app.locals as { tasks: BackgroundTasks }).tasks;
  stop = () => new Promise<void>((resolve) => server.close(() => resolve()));
}

const send = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${url}${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, body: (await res.json().catch(() => undefined)) as Record<string, any> };
};

const env = () => ({
  BRAIN_AVATAR_PACKS_DIR: join(dir, 'packs'),
  BRAIN_SINGERS_DATA_DIR: join(dir, 'singers'),
  VOCALS_SERVICE_URL: 'http://127.0.0.1:9',
  BRAIN_TASK_FILES_DIR: join(dir, 'files'),
  BRAIN_VOCAL_TAKES_DIR: join(dir, 'takes'),
  AVATAR_BUILDER_URL: builder.url,
  AVATAR_LIBRARY_FILE: LIBRARY,
});

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'realistic-'));
  mkdirSync(join(dir, 'packs', 'p'), { recursive: true });
  writeFileSync(join(dir, 'packs', 'p', 'icon.png'), 'png');
  writeFileSync(join(dir, 'packs', 'p', 'manifest.json'), JSON.stringify({ thumbnail: './character-assets/p/icon.png', requiredTraits: ['body'], traits: [{ trait: 'body', collection: [{ id: 'b', name: 'Body', directory: 'b.vrm' }] }] }));
  builder = await startFakeAvatarBuilder();
});

afterEach(async () => {
  await stop?.();
  await builder.stop();
  rmSync(dir, { recursive: true, force: true });
});

/** Starts a build and waits for it; returns the task. */
async function built(d = design()) {
  const res = await send('POST', '/api/avatars/realistic/builds', { design: d });
  expect(res.status).toBe(202);
  await tasks.idle();
  return ((await send('GET', '/api/tasks')).body.tasks as Array<Record<string, any>>).find((t) => t.id === res.body.task.id)!;
}

describe('the realistic library', () => {
  it('lists the curated assets without their file paths', async () => {
    await boot(env());
    const res = await send('GET', '/api/avatars/realistic/library');
    expect(res.status).toBe(200);
    const jeans = res.body.library.clothes.find((c: any) => c.id === 'elvs_jeans_bootcut');
    expect(jeans).toMatchObject({ slot: 'bottoms', licence: 'CC-BY' });
    expect(jeans.path).toBeUndefined();
    expect(res.body.library.hair.find((h: any) => h.id === 'ponytail01').colours.length).toBeGreaterThan(0);
  });
  it('answers 503 naming the settings when the builder is not set up', async () => {
    await boot({ ...env(), AVATAR_BUILDER_URL: '', AVATAR_LIBRARY_FILE: '' });
    const res = await send('GET', '/api/avatars/realistic/library');
    expect(res.status).toBe(503);
    expect(res.body.message).toMatch(/AVATAR_BUILDER_URL.*AVATAR_LIBRARY_FILE/);
  });
});

describe('designs', () => {
  it('refuses an asset that is not in the library, naming it', async () => {
    await boot(env());
    const res = await send('POST', '/api/avatars/realistic/builds', { design: { ...design(), hair: 'nope' } });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/no hair "nope"/);
    expect(builder.jobs).toHaveLength(0);
  });
  it('refuses two garments for one slot, naming both', async () => {
    await boot(env());
    const res = await send('POST', '/api/avatars/realistic/builds', { design: { ...design(), clothes: ['elvs_jeans_bootcut', 'male_casualsuit04', 'shoes02'] } });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/elvs_jeans_bootcut.*male_casualsuit04.*bottoms/);
  });
  it('refuses an ancestry mix that does not add up', async () => {
    await boot(env());
    const res = await send('POST', '/api/avatars/realistic/builds', { design: { ...design(), ancestry: { african: 0.5, asian: 0, european: 0.2 } } });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/ancestry/);
  });
});

describe('builds', () => {
  it('runs a build task that asks the builder for the design and keeps the person', async () => {
    await boot(env());
    const task = await built();
    expect(task).toMatchObject({ kind: 'avatarBuild', state: 'done', songId: null });
    expect(builder.jobs[0]!.params).toEqual({ stage: 'build', design: design() });
    const vrm = await fetch(`${url}/api/avatars/realistic/builds/${task.id}/vrm`);
    expect(vrm.status).toBe(200);
    expect(Buffer.from(await vrm.arrayBuffer())).toEqual(VRM_BYTES);
  });
  it('fails the task with the builder\'s message', async () => {
    await boot(env());
    builder.fail('avatar-builder: Blender failed (exit 1)');
    const task = await built();
    expect(task.state).toBe('failed');
    expect(task.message).toMatch(/Blender failed/);
  });
});

describe('saving a realistic avatar', () => {
  it('stores the finished build as the avatar, with its design and file', async () => {
    await boot(env());
    const task = await built();
    const res = await send('POST', '/api/avatars/realistic', { name: 'Mia', singerId: null, buildTaskId: task.id, portrait });
    expect(res.status).toBe(201);
    expect(res.body.avatar).toMatchObject({ style: 'realistic', name: 'Mia', design: design() });
    const vrm = await fetch(`${url}/api/avatars/${res.body.avatar.id}/vrm`);
    expect(Buffer.from(await vrm.arrayBuffer())).toEqual(VRM_BYTES);
    const listed = (await send('GET', '/api/avatars')).body.avatars;
    expect(listed[0]).toMatchObject({ style: 'realistic', vrmUrl: expect.stringMatching(/\/vrm/) });
  });
  it('refuses a build that failed or does not exist', async () => {
    await boot(env());
    builder.fail('boom');
    const failed = await built();
    expect((await send('POST', '/api/avatars/realistic', { name: 'Mia', singerId: null, buildTaskId: failed.id, portrait })).status).toBe(400);
    expect((await send('POST', '/api/avatars/realistic', { name: 'Mia', singerId: null, buildTaskId: '00000000-0000-0000-0000-000000000000', portrait })).status).toBe(404);
  });
});

describe('admins only', () => {
  it('answers 403 to anyone else', async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).user = { id: 'u1', email: 'someone@example.com' };
      next();
    });
    app.use(createAvatarsRouter({ checkSinger: () => undefined, isAdminRequest: () => false }));
    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      for (const [method, path] of [['GET', '/api/avatars/realistic/library'], ['POST', '/api/avatars/realistic/builds'], ['POST', '/api/avatars/realistic']] as const) {
        const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, ...(method === 'POST' ? { body: '{}' } : {}) });
        expect(res.status, path).toBe(403);
        expect(((await res.json()) as any).error).toBe('admin_only');
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('avatars stored before styles', () => {
  it('read as anime', () => {
    const avatars = new UserAvatars(join(dir, 'singers'));
    const file = join(dir, 'singers', 'u-x', 'avatars.json');
    mkdirSync(join(file, '..'), { recursive: true });
    const recipe = { pack: 'p', parts: { body: 'b' }, textures: {}, colors: {} };
    writeFileSync(file, JSON.stringify([{ id: 'a-000000000001', name: 'Old', recipe, singerId: null, createdAt: 't', updatedAt: 't' }]));
    expect(avatars.list('u-x' as never)[0]).toMatchObject({ style: 'anime', recipe });
    expect(readFileSync(file, 'utf8')).not.toMatch(/style/);
  });
});

describe('one style per video', () => {
  it('refuses anime and realistic avatars together, and gives realistic ones their file', () => {
    const avatars = new UserAvatars(join(dir, 'singers'));
    const recipe = { pack: 'p', parts: { body: 'b' }, textures: {}, colors: {} };
    const anime = avatars.save('u1', { style: 'anime', name: 'A', recipe, singerId: null }, Buffer.from(PNG_1PX, 'base64'), 't');
    const vrm = join(dir, 'person.vrm');
    writeFileSync(vrm, VRM_BYTES);
    const real = avatars.saveRealistic('u1', { name: 'R', design: design() as never, singerId: null }, vrm, Buffer.from(PNG_1PX, 'base64'), 't');
    const store = openSongsStore({ path: ':memory:' });
    expect(() => videoAvatars(store, avatars, 'u1', 's1', [anime.id, real.id])).toThrow(VideoInputError);
    try {
      videoAvatars(store, avatars, 'u1', 's1', [anime.id, real.id]);
    } catch (err) {
      expect((err as VideoInputError).code).toBe('mixed_styles');
    }
    const [only] = videoAvatars(store, avatars, 'u1', 's1', [real.id]);
    expect(only).toMatchObject({ id: real.id, vrm: avatars.vrmPath('u1', real.id) });
    expect(only).not.toHaveProperty('recipe');
  });
});

describe('old builds', () => {
  it('are deleted a day after they end; newer ones stay', async () => {
    const { sweepOldBuilds, BUILD_KEEP_MS } = await import('../src/avatars/avatarBuildTask.js');
    const builds = join(dir, 'builds');
    mkdirSync(join(builds, 'old'), { recursive: true });
    mkdirSync(join(builds, 'new'), { recursive: true });
    const { utimesSync, existsSync } = await import('node:fs');
    const now = Date.now();
    utimesSync(join(builds, 'old'), (now - BUILD_KEEP_MS - 60_000) / 1000, (now - BUILD_KEEP_MS - 60_000) / 1000);
    expect(sweepOldBuilds(builds, now)).toEqual(['old']);
    expect(existsSync(join(builds, 'old'))).toBe(false);
    expect(existsSync(join(builds, 'new'))).toBe(true);
  });
});
