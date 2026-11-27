// Avatars through the brain (src/routes/avatars.ts): the part packs listed and their files served (never outside a
// pack), the user's avatars saved with a checked recipe, voice and portrait, edited, seen only by their owner, and
// deleted; 503 naming the setting when avatars are not set up.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { UserAvatars } from '../src/avatars/userAvatars.js';
import { openSongsStore } from '../src/store.js';
import { fakeVocalLevel } from './fakeVocalLevel.js';

const BUILT_IN = join(__dirname, '../../models/services/vocals/voices');
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const portrait = `data:image/png;base64,${PNG_1PX}`;

let dir: string;
let url: string;
let stop: () => Promise<void>;

/** A small pack in Character Studio's manifest format: body and eyes required, hair with tints, skin textures. */
function writePack(root: string) {
  const p = join(root, 'testpack');
  mkdirSync(join(p, 'body'), { recursive: true });
  writeFileSync(join(p, 'body', 'base.vrm'), 'vrm');
  writeFileSync(join(p, 'icon.png'), 'png');
  writeFileSync(join(root, 'secret.txt'), 'outside the pack');
  writeFileSync(
    join(p, 'manifest.json'),
    JSON.stringify({
      thumbnail: './character-assets/testpack/icon.png',
      requiredTraits: ['body', 'eyes'],
      traits: [
        { trait: 'body', collection: [{ id: '0', name: 'Body', directory: 'body/base.vrm', textureCollection: 'skin color' }] },
        { trait: 'eyes', collection: [{ id: 'regular', name: 'Eyes', directory: 'eyes/regular.vrm' }] },
        { trait: 'head', collection: [{ id: 'buns', name: 'Buns', directory: 'head/buns.vrm', colorCollection: 'Basic Colors' }] },
      ],
      textureCollections: [{ trait: 'skin color', collection: [{ id: 'tan', name: 'Tan', directory: ['skin/tan.png'] }] }],
      colorCollections: [{ trait: 'Basic Colors', collection: [{ id: 'lime', name: 'Lime', value: ['#E6FF75'] }] }],
    }),
  );
}

const recipe = { pack: 'testpack', parts: { body: '0', eyes: 'regular', head: 'buns' }, textures: { body: 'tan' }, colors: { head: '#E6FF75' } };

async function boot(env: Record<string, string>) {
  const app = createApp(loadConfig({ BRAIN_SINGERS_DIR: BUILT_IN, ...env } as NodeJS.ProcessEnv), { store: openSongsStore({ path: ':memory:' }), vocalLevel: fakeVocalLevel() });
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  stop = () => new Promise<void>((resolve) => server.close(() => resolve()));
}

const send = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${url}${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, body: (await res.json().catch(() => undefined)) as Record<string, any> };
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'avatars-'));
  mkdirSync(join(dir, 'packs'));
  writePack(join(dir, 'packs'));
});

afterEach(async () => {
  await stop?.();
  rmSync(dir, { recursive: true, force: true });
});

// BRAIN_SINGERS_DATA_DIR also turns on Add a singer, which needs the vocals service and task files settings (not used here).
const singersEnv = () => ({ BRAIN_SINGERS_DATA_DIR: join(dir, 'singers'), VOCALS_SERVICE_URL: 'http://127.0.0.1:9', BRAIN_TASK_FILES_DIR: join(dir, 'files'), BRAIN_VOCAL_TAKES_DIR: join(dir, 'takes') });
const env = () => ({ BRAIN_AVATAR_PACKS_DIR: join(dir, 'packs'), ...singersEnv() });

describe('avatars', () => {
  it('lists the packs and serves their files, never one outside a pack', async () => {
    await boot(env());
    const packs = (await send('GET', '/api/avatar-packs')).body.packs as Array<Record<string, any>>;
    expect(packs).toHaveLength(1);
    expect(packs[0]).toMatchObject({ name: 'testpack', title: 'Testpack', thumbnailUrl: '/api/avatar-packs/testpack/icon.png' });
    expect(packs[0]!.manifest.requiredTraits).toEqual(['body', 'eyes']);
    const file = await fetch(`${url}/api/avatar-packs/testpack/body/base.vrm`);
    expect(file.status).toBe(200);
    expect(await file.text()).toBe('vrm');
    expect((await fetch(`${url}/api/avatar-packs/testpack/%2E%2E/secret.txt`)).status).toBe(404);
    expect((await fetch(`${url}/api/avatar-packs/testpack/missing.vrm`)).status).toBe(404);
    expect((await fetch(`${url}/api/avatar-packs/nopack/icon.png`)).status).toBe(404);
  });

  it('saves, edits and deletes an avatar with a voice and portrait, seen only by its owner', async () => {
    await boot(env());
    const made = await send('POST', '/api/avatars', { name: 'Kai', recipe, singerId: 'yue2_female_dry2', portrait });
    expect(made.status).toBe(201);
    const a = made.body.avatar;
    expect(a).toMatchObject({ name: 'Kai', recipe, singerId: 'yue2_female_dry2' });
    expect(a.id).toMatch(/^a-[0-9a-f]{12}$/u);
    const png = await fetch(`${url}${a.portraitUrl}`);
    expect(png.status).toBe(200);
    expect(png.headers.get('content-type')).toBe('image/png');

    const edited = await send('PUT', `/api/avatars/${a.id}`, { name: 'Kai 2', recipe: { ...recipe, colors: {} }, singerId: null, portrait });
    expect(edited.status).toBe(200);
    expect(edited.body.avatar).toMatchObject({ id: a.id, name: 'Kai 2', singerId: null, createdAt: a.createdAt });
    expect(((await send('GET', '/api/avatars')).body.avatars as unknown[]).length).toBe(1);
    expect(new UserAvatars(join(dir, 'singers')).list('someone-else')).toEqual([]);

    expect((await send('DELETE', `/api/avatars/${a.id}`)).status).toBe(200);
    expect((await send('GET', '/api/avatars')).body.avatars).toEqual([]);
    expect((await fetch(`${url}${a.portraitUrl}`)).status).toBe(404);
    expect((await send('DELETE', `/api/avatars/${a.id}`)).status).toBe(404);
  });

  it('refuses a recipe the pack cannot build, an unknown singer, a bad portrait and an unknown avatar, saying why', async () => {
    await boot(env());
    const bad = async (body: Record<string, unknown>, error: string, message: RegExp) => {
      const r = await send('POST', '/api/avatars', { name: 'X', recipe, singerId: null, portrait, ...body });
      expect(r.status).toBe(400);
      expect(r.body).toMatchObject({ error });
      expect(r.body.message).toMatch(message);
    };
    await bad({ recipe: { ...recipe, parts: { body: '0', eyes: 'regular', head: 'mohawk' } } }, 'invalid_recipe', /"head" has no part "mohawk"/u);
    await bad({ recipe: { ...recipe, parts: { body: '0' } } }, 'invalid_recipe', /needs a part in "eyes"/u);
    await bad({ recipe: { ...recipe, colors: { head: '#000000' } } }, 'invalid_recipe', /#000000 is not one of "Basic Colors"/u);
    await bad({ recipe: { ...recipe, pack: 'nopack' } }, 'invalid_recipe', /no avatar pack "nopack"/u);
    await bad({ singerId: 'nobody' }, 'unknown_singer', /There is no singer "nobody"/u);
    await bad({ portrait: 'data:image/png;base64,aGVsbG8=' }, 'invalid_portrait', /not a PNG/u);
    await bad({ name: '  ' }, 'invalid_body', /give the avatar a name/u);
    expect((await send('PUT', '/api/avatars/a-000000000000', { name: 'X', recipe, singerId: null, portrait })).status).toBe(404);
  });

  it('answers 503 naming the setting when avatars are not set up', async () => {
    await boot(singersEnv());
    const r = await send('GET', '/api/avatars');
    expect(r.status).toBe(503);
    expect(r.body.message).toMatch(/BRAIN_AVATAR_PACKS_DIR/u);
  });
});
