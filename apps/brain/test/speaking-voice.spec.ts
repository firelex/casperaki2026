// Singers' speaking voices (src/singers/speakingVoice.ts, speakingVoiceTask.ts, the routes in src/routes/singers.ts)
// against a fake vocals service, a fake speech service and a fake language model: the voice described from the
// singing and the closest candidate kept; the user's own description used as is; another candidate chosen; Add a
// singer ending with the speaking voice; built-in singers' voices kept in the data folder; failures and refusals.

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';
import type { ChatMessage, ChatModel } from '../src/llm/chatModel.js';
import { DEV_OWNER_ID } from '../src/routes/songs.js';
import { VocalsClient } from '../src/sing/vocalsClient.js';
import { SpeakingVoices } from '../src/singers/speakingVoice.js';
import { makeSpeakingVoice } from '../src/singers/speakingVoiceTask.js';
import { openSongsStore } from '../src/store.js';
import type { BackgroundTasks } from '../src/tasks/tasks.js';
import { fakeVocalLevel } from './fakeVocalLevel.js';
import { startFakeSpeechService, type FakeSpeechService } from './fakeSpeechService.js';
import { startFakeVocalsService, toneWav, type FakeVocalsService } from './fakeVocalsService.js';

const BUILT_IN = join(__dirname, '../../models/services/vocals/voices');
const BUILT_IN_ID = 'yue2_female_dry2';

let dir: string;
let vocals: FakeVocalsService;
let speech: FakeSpeechService;
let url: string;
let tasks: BackgroundTasks;
let prompts: ChatMessage[][];
let stop: () => Promise<void>;

const chat: ChatModel = {
  complete: async (messages) => {
    prompts.push([...messages]);
    return JSON.stringify({ description: 'A young woman with a bright, fairly high speaking voice, natural and conversational.' });
  },
};

async function boot(env: Record<string, string>) {
  const app = createApp(loadConfig({ BRAIN_SINGERS_DIR: BUILT_IN, ...env } as NodeJS.ProcessEnv), {
    store: openSongsStore({ path: ':memory:' }),
    singPollMs: 5,
    vocalLevel: fakeVocalLevel(),
    lyricModel: chat,
  });
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  tasks = (app.locals as { tasks: BackgroundTasks }).tasks;
  stop = () => new Promise<void>((resolve) => server.close(() => resolve()));
}

const baseEnv = () => ({
  VOCALS_SERVICE_URL: vocals.url,
  BRAIN_TASK_FILES_DIR: join(dir, 'files'),
  BRAIN_VOCAL_TAKES_DIR: join(dir, 'takes'),
  BRAIN_SINGERS_DATA_DIR: join(dir, 'singers'),
});
const fullEnv = () => ({ ...baseEnv(), SPEECH_SERVICE_URL: speech.url });

const send = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${url}${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, body: (await res.json().catch(() => undefined)) as Record<string, any> };
};

/** Adds a singer (the fake vocals service) and waits for its task; returns its id. */
async function addSinger(): Promise<string> {
  const q = new URLSearchParams({ name: 'Karla', description: 'Strasser', rightToUse: '1', fullSong: '0', reference: 'best', extension: 'wav' });
  const res = await fetch(`${url}/api/singers?${q}`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: toneWav(20) });
  expect(res.status).toBe(201);
  await tasks.idle();
  const singers = (await send('GET', '/api/singers')).body.singers as Array<Record<string, any>>;
  return singers.find((s) => s.name === 'Karla')!.id as string;
}

const singer = async (id: string) => ((await send('GET', '/api/singers')).body.singers as Array<Record<string, any>>).find((s) => s.id === id)!;
const lastTask = async () => ((await send('GET', '/api/tasks')).body.tasks as Array<Record<string, any>>)[0]!;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'speaking-'));
  vocals = await startFakeVocalsService();
  speech = await startFakeSpeechService();
  prompts = [];
});

afterEach(async () => {
  await tasks?.idle();
  await stop?.();
  await vocals.stop();
  await speech.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('speaking voices', () => {
  it('adding a singer ends with its speaking voice, described from the singing and the closest candidate kept', async () => {
    await boot(fullEnv());
    const id = await addSinger();
    const task = await lastTask();
    expect(task.state).toBe('done');
    expect(task.steps.at(-1)).toMatchObject({ id: 'speaking', state: 'done' });
    expect(task.steps.map((s: { id: string }) => s.id)).toContain('describe');

    const prompt = prompts[0]!.map((m) => m.content).join('\n');
    expect(prompt).toMatch(/Karla/u);
    expect(prompt).toMatch(/Strasser/u);
    expect(prompt).toMatch(/about 460 Hz/u);

    const params = speech.jobs[0]!.params;
    expect(params).toMatchObject({ stage: 'speaking_voice', singer: 'Karla', match: true, seeds: [7, 11, 21, 33, 42, 57, 64, 99], test_line: "Hi, I'm Karla. Honestly, I'm a bit nervous, but I'm really excited to be here." });
    expect(String(params['reference'])).toMatch(new RegExp(`${id}/voice\\.wav$`, 'u'));
    expect(params['description']).toMatch(/bright, fairly high/u);

    const s = await singer(id);
    expect(s.speaking).toMatchObject({ madeBy: 'matched', seed: 11, description: expect.stringMatching(/bright/u) });
    expect(s.speaking.candidates.map((c: { seed: number }) => c.seed)).toEqual([7, 11, 21, 33, 42, 57, 64, 99]);
    const sample = await fetch(`${url}${s.speaking.sampleUrl}`);
    expect(sample.status).toBe(200);
    expect(sample.headers.get('content-type')).toBe('audio/wav');
    expect(readdirSync(join(dir, 'singers', DEV_OWNER_ID, id, 'speaking', 'candidates'))).toHaveLength(8);
  });

  it("uses the user's own description as is, with one voice", async () => {
    await boot(fullEnv());
    const id = await addSinger();
    const r = await send('POST', `/api/singers/${id}/speaking-voice`, { description: '  A man in his forties, deep and calm.  ' });
    expect(r.status).toBe(202);
    await tasks.idle();
    expect(speech.jobs[1]!.params).toMatchObject({ description: 'A man in his forties, deep and calm.', seeds: [7], match: false });
    expect(prompts).toHaveLength(1); // only the one made when the singer was added
    expect((await singer(id)).speaking).toMatchObject({ madeBy: 'described', seed: 7, description: 'A man in his forties, deep and calm.' });
  });

  it('lets the user choose another candidate', async () => {
    await boot(fullEnv());
    const id = await addSinger();
    const before = readFileSync(join(dir, 'singers', DEV_OWNER_ID, id, 'speaking', 'candidates', 'candidate-57.wav'));
    const r = await send('POST', `/api/singers/${id}/speaking-voice/choose`, { seed: 57 });
    expect(r.status).toBe(200);
    expect((await singer(id)).speaking).toMatchObject({ seed: 57, madeBy: 'matched' });
    expect(readFileSync(join(dir, 'singers', DEV_OWNER_ID, id, 'speaking', 'speaking.wav')).equals(before)).toBe(true);
    expect((await send('POST', `/api/singers/${id}/speaking-voice/choose`, { seed: 5 })).status).toBe(400);
  });

  it("keeps a built-in singer's voice under the data folder, never in the built-in folder", async () => {
    await boot(fullEnv());
    const before = readdirSync(BUILT_IN).sort();
    expect((await send('POST', `/api/singers/${BUILT_IN_ID}/speaking-voice`, {})).status).toBe(202);
    await tasks.idle();
    expect(readdirSync(BUILT_IN).sort()).toEqual(before);
    expect(existsSync(join(dir, 'singers', DEV_OWNER_ID, 'builtin-speaking', BUILT_IN_ID, 'speaking.json'))).toBe(true);
    expect((await singer(BUILT_IN_ID)).speaking).toMatchObject({ madeBy: 'matched' });
  });

  it('fails naming the speech service when it fails, and keeps the earlier voice', async () => {
    await boot(fullEnv());
    const id = await addSinger();
    const earlier = (await singer(id)).speaking;
    speech.fail('Breeze ran out of memory');
    expect((await send('POST', `/api/singers/${id}/speaking-voice`, { description: 'A man.' })).status).toBe(202);
    await tasks.idle();
    const task = await lastTask();
    expect(task.state).toBe('failed');
    expect(task.message).toMatch(/Breeze ran out of memory/u);
    expect((await singer(id)).speaking).toEqual(earlier);
  });

  it('refuses a blank description, an unknown singer, a second request while one runs, and answers 503 without the service', async () => {
    await boot(fullEnv());
    const id = await addSinger();
    expect((await send('POST', `/api/singers/${id}/speaking-voice`, { description: '   ' })).body).toMatchObject({ message: expect.stringMatching(/describe the voice/iu) });
    expect((await send('POST', '/api/singers/u-000000000000/speaking-voice', {})).status).toBe(404);
    const first = await send('POST', `/api/singers/${id}/speaking-voice`, {});
    expect(first.status).toBe(202);
    expect((await send('POST', `/api/singers/${id}/speaking-voice`, {})).status).toBe(409);
    await tasks.idle();
    await stop();
    await boot(baseEnv());
    const off = await send('POST', `/api/singers/${id}/speaking-voice`, {});
    expect(off.status).toBe(503);
    expect(off.body.message).toMatch(/SPEECH_SERVICE_URL/u);
    expect((await singer(id)).speaking).toBeTruthy(); // still listed: the files stay
  });

  it('fails naming the speech service and its address when it cannot be reached', async () => {
    await boot({ ...baseEnv(), SPEECH_SERVICE_URL: 'http://127.0.0.1:9' });
    expect((await send('POST', `/api/singers/${BUILT_IN_ID}/speaking-voice`, { description: 'A man.' })).status).toBe(202);
    await tasks.idle();
    const task = await lastTask();
    expect(task.state).toBe('failed');
    expect(task.message).toMatch(/speech service at http:\/\/127\.0\.0\.1:9/u);
  });

  it('after a restart, follows the same job with the description it was spoken from', async () => {
    const job = ((await (await fetch(`${speech.url}/generate`, { method: 'POST', body: JSON.stringify({ stage: 'speaking_voice', seeds: [7, 11, 21, 33, 42, 57, 64, 99], match: true }) })).json()) as { job_id: string }).job_id;
    const voices = new SpeakingVoices(join(dir, 'singers'));
    const voice = await makeSpeakingVoice({
      ownerId: 'o',
      singer: { id: BUILT_IN_ID, name: 'Singer 1', description: 'd', audio: join(BUILT_IN, 'yue2_female_dry2.mp3'), meta: join(BUILT_IN, 'yue2_female_dry2.json'), builtIn: true },
      deps: { client: new VocalsClient(speech.url, 'speech service'), voices, chat: { complete: async () => { throw new Error('the language model is down'); } }, filesDir: join(dir, 'files'), pollMs: 5 },
      filesDir: join(dir, 'files', 'task'),
      signal: new AbortController().signal,
      jobs: { speaking: job, speakingDescription: 'The description the job was spoken from.' },
      setJobs: () => undefined,
      setSteps: () => undefined,
      now: () => 'now',
    });
    expect(voice).toMatchObject({ description: 'The description the job was spoken from.', madeBy: 'matched' });
    expect(speech.jobs).toHaveLength(1);
  });

  it('refuses a second voice while Add a singer is making one for that singer', async () => {
    await boot(fullEnv());
    speech.hold();
    const q = new URLSearchParams({ name: 'Karla', description: 'Strasser', rightToUse: '1', fullSong: '0', reference: 'best', extension: 'wav' });
    expect((await fetch(`${url}/api/singers?${q}`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: toneWav(20) })).status).toBe(201);
    for (let i = 0; i < 200 && speech.jobs.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    const id = ((await send('GET', '/api/singers')).body.singers as Array<Record<string, any>>).find((s) => s.name === 'Karla')!.id as string;
    expect((await send('POST', `/api/singers/${id}/speaking-voice`, {})).status).toBe(409);
    speech.release();
  });

  it("retrying an Add a singer whose speaking voice failed makes only the speaking voice", async () => {
    await boot(fullEnv());
    speech.fail('Breeze ran out of memory');
    const q = new URLSearchParams({ name: 'Karla', description: 'Strasser', rightToUse: '1', fullSong: '0', reference: 'best', extension: 'wav' });
    await fetch(`${url}/api/singers?${q}`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: toneWav(20) });
    await tasks.idle();
    const failed = await lastTask();
    expect(failed.state).toBe('failed');
    expect((await send('POST', `/api/tasks/${failed.id}/retry`)).status).toBe(200);
    await tasks.idle();
    expect((await lastTask()).state).toBe('done');
    expect(vocals.jobs).toHaveLength(1);
    expect(speech.jobs).toHaveLength(2);
    expect((await singer(failed.singerId)).speaking).toMatchObject({ madeBy: 'matched' });
  });

  it("fails naming the seed when the service leaves a candidate's score out", async () => {
    await boot(fullEnv());
    speech.dropScore = 33;
    const q = new URLSearchParams({ name: 'Karla', description: 'Strasser', rightToUse: '1', fullSong: '0', reference: 'best', extension: 'wav' });
    await fetch(`${url}/api/singers?${q}`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: toneWav(20) });
    await tasks.idle();
    expect((await lastTask()).message).toMatch(/no score for candidate 33/u);
  });

  it('adds a singer without a speaking voice when the speech service is not set up', async () => {
    await boot(baseEnv());
    const id = await addSinger();
    expect((await lastTask()).steps.at(-1)).toMatchObject({ id: 'keep', state: 'done' });
    expect((await singer(id)).speaking).toBeNull();
  });
});
