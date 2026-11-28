// Add a singer through the brain (src/singers/addSingerTask.ts, src/routes/singers.ts) against a fake vocals
// service: the refusals (no consent box, over 5 minutes, not audio, not set up), the task with every step recorded
// and done without being applied, the new singer listed with its voice reference, test line and reference choice,
// visible only to its owner, usable by Sing, and deleted.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { singerVoice } from '../src/routes/singers.js';
import { DEV_OWNER_ID } from '../src/routes/songs.js';
import { NO_CONSENT } from '../src/tasks/tasks.js';
import { UserSingers } from '../src/singers/userSingers.js';
import { openSongsStore } from '../src/store.js';
import type { BackgroundTasks } from '../src/tasks/tasks.js';
import { fakeVocalLevel } from './fakeVocalLevel.js';
import { startFakeVocalsService, toneWav, type FakeVocalsService } from './fakeVocalsService.js';

const BUILT_IN = join(__dirname, '../../models/services/vocals/voices');

let dir: string;
let svc: FakeVocalsService;
let url: string;
let tasks: BackgroundTasks;
let stop: () => Promise<void>;

async function boot(env: Record<string, string>) {
  const app = createApp(loadConfig({ BRAIN_SINGERS_DIR: BUILT_IN, ...env } as NodeJS.ProcessEnv), { store: openSongsStore({ path: ':memory:' }), singPollMs: 5, vocalLevel: fakeVocalLevel() });
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  tasks = (app.locals as { tasks: BackgroundTasks }).tasks;
  stop = () => new Promise<void>((resolve) => server.close(() => resolve()));
}

const fullEnv = () => ({
  VOCALS_SERVICE_URL: svc.url,
  BRAIN_TASK_FILES_DIR: join(dir, 'files'),
  BRAIN_VOCAL_TAKES_DIR: join(dir, 'takes'),
  BRAIN_SINGERS_DATA_DIR: join(dir, 'singers'),
});

interface Query { name?: string; description?: string; rightToUse?: string; fullSong?: string; reference?: string; extension?: string }

async function upload(recording: Buffer, q: Query = {}) {
  const params = new URLSearchParams({ name: 'My voice', description: 'Warm and low.', rightToUse: '1', fullSong: '0', reference: 'best', extension: 'wav', ...q });
  const res = await fetch(`${url}/api/singers?${params}`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: recording });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

const get = async (path: string) => {
  const res = await fetch(`${url}${path}`);
  return { status: res.status, body: (await res.json().catch(() => undefined)) as Record<string, any> };
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'add-singer-'));
  svc = await startFakeVocalsService();
});

afterEach(async () => {
  await tasks?.idle();
  await stop?.();
  await svc.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('Add a singer', () => {
  it('makes a singer from a recording: the task runs every step, is done, and the singer is listed for its owner', async () => {
    await boot(fullEnv());
    const started = await upload(toneWav(20), { reference: 'beginning', fullSong: '1' });
    expect(started.status).toBe(201);
    expect(started.body.task).toMatchObject({ kind: 'addSinger', songId: null, title: 'My voice', state: 'running' });
    await tasks.idle();

    expect(svc.jobs).toHaveLength(1);
    const params = svc.jobs[0]!.params;
    expect(params).toMatchObject({ stage: 'add_singer', separate: true, reference: 'beginning' });
    expect(String(params['upload'])).toMatch(/singers\/local-dev\/u-[0-9a-f]{12}\/original\.wav$/u);

    const listed = (await get('/api/tasks')).body.tasks as Array<Record<string, any>>;
    const task = listed.find((t) => t.id === started.body.task.id)!;
    expect(task.state).toBe('done');
    expect(task.steps.map((s: { id: string }) => s.id)).toEqual(['decode', 'separate', 'silence', 'reference', 'pitch', 'words', 'notes', 'test-line', 'keep']);
    expect(task.steps.every((s: { state: string }) => s.state === 'done')).toBe(true);
    const testLineStep = task.steps.find((s: { id: string }) => s.id === 'test-line');
    expect((await fetch(`${url}/api/tasks/${task.id}/files/${testLineStep.files[0]}`)).status).toBe(200);

    const singers = (await get('/api/singers')).body.singers as Array<Record<string, any>>;
    expect(singers.map((s) => s.name)).toEqual(['Singer 1', 'My voice']);
    const mine = singers[1]!;
    expect(mine).toMatchObject({ own: true, description: 'Warm and low.', transcription: 'words', reference: { choice: 'beginning', startSeconds: 2, endSeconds: 12, seconds: 10.1 } });
    expect(mine.id).toBe(task.singerId);
    expect(mine.source).toMatch(/vocals separated from an uploaded song/u);
    for (const u of [mine.previewUrl, mine.testLineUrl]) {
      const res = await fetch(`${url}${u}`);
      expect(res.status).toBe(200);
      expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(44);
    }
    expect(readdirSync(join(dir, 'singers', DEV_OWNER_ID, mine.id)).sort()).toEqual(['original.wav', 'test_line.wav', 'voice.json', 'voice.wav']);

    // Sing can sing with it; another owner cannot see it.
    const users = new UserSingers(join(dir, 'singers'));
    expect(singerVoice(BUILT_IN, users, DEV_OWNER_ID, mine.id)).toEqual({ audio: join(dir, 'singers', DEV_OWNER_ID, mine.id, 'voice.wav'), meta: join(dir, 'singers', DEV_OWNER_ID, mine.id, 'voice.json') });
    expect(() => singerVoice(BUILT_IN, users, 'someone-else', mine.id)).toThrow(/There is no singer/u);
    expect(users.list('someone-else')).toEqual([]);
    expect(singerVoice(BUILT_IN, users, 'someone-else', 'yue2_female_dry2').audio).toMatch(/yue2_female_dry2\.mp3$/u);

    // Deleting it: gone from the list and the disk.
    const deleted = await fetch(`${url}/api/singers/${mine.id}`, { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    expect(((await get('/api/singers')).body.singers as unknown[]).length).toBe(1);
    expect(existsSync(join(dir, 'singers', DEV_OWNER_ID, mine.id))).toBe(false);
    expect((await fetch(`${url}/api/singers/${mine.id}/preview`)).status).toBe(404);
    expect((await fetch(`${url}/api/singers/${mine.id}`, { method: 'DELETE' })).status).toBe(404);

    // A built-in singer: deleted for this owner only (Sing cannot use it any more); its files stay for everyone else.
    expect((await fetch(`${url}/api/singers/yue2_female_dry2`, { method: 'DELETE' })).status).toBe(200);
    expect((await get('/api/singers')).body.singers).toEqual([]);
    expect((await fetch(`${url}/api/singers/yue2_female_dry2/preview`)).status).toBe(404);
    expect((await fetch(`${url}/api/singers/yue2_female_dry2`, { method: 'DELETE' })).status).toBe(404);
    expect(() => singerVoice(BUILT_IN, users, DEV_OWNER_ID, 'yue2_female_dry2')).toThrow(/There is no singer/u);
    expect(singerVoice(BUILT_IN, users, 'someone-else', 'yue2_female_dry2').audio).toMatch(/yue2_female_dry2\.mp3$/u);
    expect(existsSync(join(BUILT_IN, 'yue2_female_dry2.mp3'))).toBe(true);
  });

  it('renames a singer: an added one in its list, a built-in one for this owner only; a blank or too long name is refused (owner 2026-11-28)', async () => {
    await boot(fullEnv());
    await upload(toneWav(20));
    await tasks.idle();
    const mine = ((await get('/api/singers')).body.singers as Array<Record<string, any>>).find((s) => s.own)!;
    const rename = (id: string, name: unknown) =>
      fetch(`${url}/api/singers/${id}/name`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });

    const a = await rename(mine.id, '  Velvet  ');
    expect(a.status).toBe(200);
    expect(await a.json()).toMatchObject({ id: mine.id, name: 'Velvet' });
    expect((await rename('yue2_female_dry2', 'Aurora')).status).toBe(200);
    expect(((await get('/api/singers')).body.singers as Array<Record<string, any>>).map((s) => s.name)).toEqual(['Aurora', 'Velvet']);
    // the speaking side (casting) uses the new name too; another owner still sees the built-in's own name
    const users = new UserSingers(join(dir, 'singers'));
    expect(users.builtInNames(DEV_OWNER_ID)).toEqual({ yue2_female_dry2: 'Aurora' });
    expect(users.builtInNames('someone-else')).toEqual({});

    expect((await rename(mine.id, '   ')).status).toBe(400);
    expect((await rename(mine.id, 'x'.repeat(61))).status).toBe(400);
    expect((await rename('u-000000000000', 'Nobody')).status).toBe(404);
  });

  it('can be cancelled while it runs, then started again from the kept recording', async () => {
    await boot(fullEnv());
    svc.hold('add_singer');
    const started = await upload(toneWav(20));
    const id = started.body.task.id as string;
    for (let i = 0; i < 500 && svc.jobs.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    const cancelled = await fetch(`${url}/api/tasks/${id}/cancel`, { method: 'POST' });
    expect(cancelled.status).toBe(200);
    await tasks.idle();
    expect(svc.cancels).toEqual([svc.jobs[0]!.id]);
    let task = ((await get('/api/tasks')).body.tasks as Array<Record<string, any>>).find((t) => t.id === id)!;
    expect(task).toMatchObject({ state: 'failed', message: 'Cancelled' });
    expect(((await get('/api/singers')).body.singers as unknown[]).length).toBe(1);

    // Files an earlier run got as far as (as when it was stopped after its reference): the retry's own replace them.
    const stale = join(dir, 'files', id, 'singer');
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, 'voice.wav'), 'from the earlier run');

    svc.release('add_singer');
    expect((await fetch(`${url}/api/tasks/${id}/retry`, { method: 'POST' })).status).toBe(200);
    await tasks.idle();
    task = ((await get('/api/tasks')).body.tasks as Array<Record<string, any>>).find((t) => t.id === id)!;
    expect(task.state).toBe('done');
    expect(svc.jobs).toHaveLength(2);
    expect(svc.fileFetches).toContain(`${svc.jobs[1]!.id}/voice.wav`);
    const singerId = task.singerId as string;
    expect(readFileSync(join(dir, 'singers', DEV_OWNER_ID, singerId, 'voice.wav'), 'utf8')).not.toBe('from the earlier run');
    expect(((await get('/api/singers')).body.singers as Array<{ name: string }>).map((s) => s.name)).toEqual(['Singer 1', 'My voice']);
  });

  it('refuses without the consent box ticked', async () => {
    await boot(fullEnv());
    const r = await upload(toneWav(10), { rightToUse: '0' });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: 'no_consent', message: NO_CONSENT });
    expect(svc.jobs).toHaveLength(0);
  });

  it('refuses a recording over 5 minutes, saying so, and keeps nothing', async () => {
    await boot(fullEnv());
    const r = await upload(toneWav(301));
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: 'recording_too_long', message: "The recording is 5 min 1 s long: a singer's recording can be at most 5 min." });
    expect(readdirSync(join(dir, 'singers', DEV_OWNER_ID))).toEqual([]);
    expect(svc.jobs).toHaveLength(0);
  });

  it('refuses a file that is not audio, and one without a name', async () => {
    await boot(fullEnv());
    const r = await upload(Buffer.from('this is not a recording'));
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('not_audio');
    expect(r.body.message).toMatch(/could not be read as audio/u);
    const unnamed = await upload(toneWav(10), { name: '  ' });
    expect(unnamed.status).toBe(400);
    expect(unnamed.body.message).toBe('Give the singer a name (at most 60 characters).');
    const noChoice = await upload(toneWav(10), { reference: 'middle' });
    expect(noChoice.status).toBe(400);
  });

  it('answers 503 naming the settings when adding singers is not set up, and lists the built-in singers only', async () => {
    await boot({});
    const r = await upload(toneWav(10));
    expect(r.status).toBe(503);
    expect(r.body.message).toMatch(/VOCALS_SERVICE_URL, BRAIN_TASK_FILES_DIR and BRAIN_SINGERS_DATA_DIR/u);
    expect(((await get('/api/singers')).body.singers as Array<{ own: boolean }>).map((s) => s.own)).toEqual([false]);
  });

  it('refuses to start without the vocals service and task files folder', () => {
    expect(() => createApp(loadConfig({ BRAIN_SINGERS_DATA_DIR: join(dir, 'singers') } as NodeJS.ProcessEnv), { store: openSongsStore({ path: ':memory:' }) })).toThrow(
      /BRAIN_SINGERS_DATA_DIR is set, so Add a singer also needs VOCALS_SERVICE_URL and BRAIN_TASK_FILES_DIR/u,
    );
  });
});
