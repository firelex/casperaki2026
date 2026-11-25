// The Sing task through the brain (docs/superpowers/specs/2026-11-25-sing-and-transcribe-design.md) against a fake
// vocals service: both service stages run with every step recorded in order and their files fetchable; the result
// goes in only while the sung sections are as they were sung; cancel (queued and running), a lost job, a restart that
// finds the job lost; Write lyrics and Write melody refuse while a song is being sung.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { generatorParams } from '@casperaki/arrangement';
import { isTakeFresh, SUNG_TAKE_KINDS, type Song } from '@casperaki/song-schema';

import { createApp } from '../src/bootstrap.js';
import { DEV_OWNER_ID } from '../src/routes/songs.js';
import { backingShift, encodeTake, TAKE_GAIN_DB } from '../src/sing/singTask.js';
import { loadConfig } from '../src/config.js';
import { openSongsStore, type SongsStore } from '../src/store.js';
import type { BackgroundTasks } from '../src/tasks/tasks.js';
import { fakeLyricModel } from './fakeLyricModel.js';
import { startFakeVocalsService, type FakeVocalsService } from './fakeVocalsService.js';

interface Harness { url: string; store: SongsStore; tasks: BackgroundTasks; stop: () => Promise<void> }
interface StepJson { id: string; label: string; state: string; text?: string; files?: string[]; numbers?: Record<string, number> }
interface TaskJson { id: string; kind: string; songId: string; state: string; message?: string; steps: StepJson[] }

const LOST = 'the vocal service lost the job: sing again';
const CHANGED = 'The song changed while it was being sung: sing again';

let dir: string;
let svc: FakeVocalsService;
const brains: Harness[] = [];

async function boot(store: SongsStore, pollMs = 5): Promise<Harness> {
  const env = { VOCALS_SERVICE_URL: svc.url, BRAIN_TASK_FILES_DIR: join(dir, 'files'), BRAIN_VOCAL_TAKES_DIR: join(dir, 'takes') } as NodeJS.ProcessEnv;
  const app = createApp(loadConfig(env), { store, lyricModel: fakeLyricModel(), singPollMs: pollMs });
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const h = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    store,
    tasks: (app.locals as { tasks: BackgroundTasks }).tasks,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  brains.push(h);
  return h;
}

const send = async (method: string, url: string, body?: unknown) => {
  const res = await fetch(url, { method, headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, body: (await res.json().catch(() => undefined)) as Record<string, unknown> };
};

const tasksOf = async (h: Harness) => (await send('GET', `${h.url}/api/tasks`)).body.tasks as TaskJson[];
const taskOf = async (h: Harness, id: string) => (await tasksOf(h)).find((t) => t.id === id)!;

async function waitFor(what: string, cond: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

// Seed 'sing-a' gives a brightPop song whose backing vocal lines lie within the singable range at its octave; the
// tests that only need a sing under way use other seeds.

/** A saved project whose song has a melody and written lyrics (Write melody, then a Write lyrics task applied). */
async function songWithLyrics(h: Harness, seed: string, genre = 'brightPop', bpm = 110): Promise<{ id: string; song: Song }> {
  const made = await send('POST', `${h.url}/api/songs/generate`, { genre, key: 'C', bpm, seed });
  const edited = await send('POST', `${h.url}/api/tracks/edit`, { song: made.body.song, op: { kind: 'writeMelody' } });
  expect(edited.status).toBe(200);
  const task = (await send('POST', `${h.url}/api/tasks`, { kind: 'writeLyrics', songId: made.body.id, song: edited.body.song })).body.task as TaskJson;
  await h.tasks.idle();
  const applied = await send('POST', `${h.url}/api/tasks/${task.id}/apply`);
  expect(applied.status).toBe(200);
  const id = applied.body.songId as string;
  return { id, song: (await send('GET', `${h.url}/api/songs/${id}`)).body.song as Song };
}

const startSing = (h: Harness, songId: string, song: Song) => send('POST', `${h.url}/api/tasks`, { kind: 'sing', songId, song });

/** Saves a changed song over the project: its new id. */
async function save(h: Harness, id: string, song: Song): Promise<string> {
  const r = await send('PUT', `${h.url}/api/songs/${id}`, { song });
  expect(r.status).toBeLessThan(300);
  return r.body.id as string;
}

describe('the Sing task', { timeout: 60_000 }, () => {
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sing-task-'));
    svc = await startFakeVocalsService();
  });
  afterEach(async () => {
    for (const s of ['lead', 'repeats']) svc.release(s);
    for (const b of brains.splice(0)) await b.stop();
    await svc.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('runs both stages, lists every step in order with its state, and keeps the steps\' files', async () => {
    const h = await boot(openSongsStore({ path: ':memory:' }));
    const { id, song } = await songWithLyrics(h, 'sing-a');
    const started = await startSing(h, id, song);
    expect(started.status).toBe(201);
    const taskId = (started.body.task as TaskJson).id;
    await h.tasks.idle();

    const task = await taskOf(h, taskId);
    expect(task).toMatchObject({ kind: 'sing', state: 'ready' });
    const ids = task.steps.map((s) => s.id);
    expect(ids[0]).toBe('plan');
    expect(ids.at(-1)).toBe('store-takes');
    const backing = ids.indexOf('backing-lines');
    expect(ids.slice(1, backing).every((s) => /^(yue2|separate|chords|transcribe|choose):/u.test(s))).toBe(true);
    expect(ids).toContain('yue2:chorus1:s3');
    expect(ids.slice(backing + 1, -1)).toContain('levels');
    expect(ids.slice(1, backing).length).toBeGreaterThan(0);
    expect(task.steps.every((s) => s.state === 'done')).toBe(true);

    // The two jobs: the lead's units, then the repeats with the lead job and the chorus take as the voice.
    expect(svc.jobs.map((j) => j.stage)).toEqual(['lead', 'repeats']);
    const lead = svc.jobs[0]!.params;
    expect(lead).toMatchObject({ stage: 'lead', bpm: 110, key: song.key, seeds: 3, threshold: 0.7 });
    const repeats = svc.jobs[1]!.params as { lead_job: string; levels: { reference: string; backing_db: number; adlib_db: number } };
    expect(repeats.lead_job).toBe(svc.jobs[0]!.id);
    expect(repeats.levels).toEqual({ reference: 'chorus1_section.wav', backing_db: -6, adlib_db: -4 });
    const { copies, backings } = svc.jobs[1]!.params as { copies: { segment: string; voice: string }[]; backings: { track: string; voice: string }[] };
    expect(copies.length).toBeGreaterThan(0);
    expect(copies.every((c) => c.voice.endsWith('_section.wav'))).toBe(true);
    expect(backings.length).toBeGreaterThan(0);
    expect(backings.every((b) => /^Backing vocals [12]$/u.test(b.track) && b.voice === 'chorus1_section.wav')).toBe(true);

    // A step's file, copied when the step finished, under its stage.
    const choose = task.steps.find((s) => s.id === 'choose:chorus1')!;
    expect(choose.files).toEqual(['lead/chorus1_section.wav', 'lead/chorus1_melody.json']);
    const file = await fetch(`${h.url}/api/tasks/${taskId}/files/lead/chorus1_section.wav`);
    expect(file.status).toBe(200);
    expect(Buffer.from(await file.arrayBuffer()).toString('ascii', 0, 4)).toBe('RIFF');
    expect((await fetch(`${h.url}/api/tasks/${taskId}/files/repeats/chorus1_section.wav`)).status).toBe(404);
    expect((await fetch(`${h.url}/api/tasks/${taskId}/files/lead/nothing.wav`)).status).toBe(404);
    expect((await fetch(`${h.url}/api/tasks/${taskId}/files/lead/..%2Fsecret`)).status).toBe(400);
    expect((await fetch(`${h.url}/api/tasks/${taskId}/files/other/chorus1.abc`)).status).toBe(400);

    // A name several steps of one job list (the unit's score, in each seed's take step) is one file, fetched once;
    // the ad-lib unit's score in the repeats job is that job's own file.
    expect(task.steps.filter((s) => s.files?.includes('lead/chorus1.abc'))).toHaveLength(3);
    expect(svc.fileFetches.filter((f) => f === `${svc.jobs[0]!.id}/chorus1.abc`)).toHaveLength(1);
    expect(svc.fileFetches.filter((f) => f === `${svc.jobs[0]!.id}/chorus1_s1_vocals.wav`)).toHaveLength(1);
    expect(task.steps.find((s) => s.id === 'adlibs:yue2:s2')!.files).toContain('repeats/chorus1_adlibs.abc');
    expect(await (await fetch(`${h.url}/api/tasks/${taskId}/files/repeats/chorus1_adlibs.abc`)).text()).toBe(`chorus1_adlibs.abc of ${svc.jobs[1]!.id}`);
    // Copies are written whole under their name: no temporary file is left.
    for (const stage of ['lead', 'repeats']) expect(readdirSync(join(dir, 'files', taskId, stage)).some((f) => f.includes('.part-'))).toBe(false);
  });

  it('fails on apply when a sung section changed (a chord in chorus1)', async () => {
    const h = await boot(openSongsStore({ path: ':memory:' }));
    const { id, song } = await songWithLyrics(h, 'sing-a');
    const taskId = ((await startSing(h, id, song)).body.task as TaskJson).id;
    await h.tasks.idle();
    const changed = structuredClone(song);
    const chorus = changed.songStructure.find((s) => s.name === 'chorus1')!;
    chorus.bars[0]!.chords = chorus.bars[0]!.chords.map(() => 'F#');
    await save(h, id, changed);
    const applied = await send('POST', `${h.url}/api/tasks/${taskId}/apply`);
    expect(applied.status).toBe(409);
    expect(applied.body.message).toBe(CHANGED);
    expect(await taskOf(h, taskId)).toMatchObject({ state: 'failed', message: CHANGED });
    // Started again it would sing the old song: refused, pointing to Sing.
    const retried = await send('POST', `${h.url}/api/tasks/${taskId}/retry`);
    expect(retried).toMatchObject({ status: 409, body: { error: 'song_changed', message: 'The song changed since this sing started, so it cannot be started again: Sing again instead.' } });
  });

  it('refuses to sing while the song\'s lyrics are being written (running or waiting its turn)', async () => {
    const h = await boot(openSongsStore({ path: ':memory:' }));
    const { id, song } = await songWithLyrics(h, 'sing-a');
    // A Write lyrics task recorded as running (it runs, or waits for its turn behind another song's).
    h.store.insertTask({ id: 'lyrics-running', ownerId: DEV_OWNER_ID, songId: id, kind: 'writeLyrics', input: JSON.stringify(song), startedAt: new Date().toISOString() });
    expect(await startSing(h, id, song)).toMatchObject({ status: 409, body: { error: 'already_writing_lyrics', message: 'Already writing lyrics' } });
    expect(svc.jobs).toHaveLength(0);
  });

  it('applies after a drum edit: fresh takes on the vocal tracks and the sung melody recorded', async () => {
    const h = await boot(openSongsStore({ path: ':memory:' }));
    const { id, song } = await songWithLyrics(h, 'sing-a');
    const taskId = ((await startSing(h, id, song)).body.task as TaskJson).id;
    await h.tasks.idle();
    const edited = await send('POST', `${h.url}/api/tracks/edit`, { song, op: { kind: 'newPattern', track: 'Drums' } });
    expect(edited.status).toBe(200);
    expect(JSON.stringify(edited.body.song)).not.toBe(JSON.stringify(song));
    await save(h, id, edited.body.song as Song);

    const applied = await send('POST', `${h.url}/api/tasks/${taskId}/apply`);
    expect(applied.status).toBe(200);
    const saved = (await send('GET', `${h.url}/api/songs/${applied.body.songId as string}`)).body.song as Song;
    const takes = saved.aiArtifacts.filter((a) => (SUNG_TAKE_KINDS as readonly string[]).includes(a.kind));
    expect(takes.length).toBeGreaterThan(0);
    for (const t of takes) {
      expect(isTakeFresh(saved, t)).toBe(true);
      const file = t.output.uri.replace(/^vocal-take:/u, '');
      expect(existsSync(join(dir, 'takes', file))).toBe(true);
    }
    expect(takes.some((t) => t.kind === 'yue2-vocal' && t.attachedTo.scope === 'segment' && t.attachedTo.segment === 'chorus1')).toBe(true);
    expect(generatorParams(saved).params?.['sungMelody']).toBeDefined();
    // The ad-lib take records the YuE2 seed the service chose for it, as the lead takes do.
    const adlibs = takes.filter((t) => t.attachedTo.scope === 'segment' && t.attachedTo.instrument === 'Ad-libs');
    expect(adlibs.length).toBeGreaterThan(0);
    for (const t of adlibs) expect(t.seed).toBe(1);
  });

  it('cancels a queued and a running sing (the running one cancels its service job)', async () => {
    const h = await boot(openSongsStore({ path: ':memory:' }));
    const a = await songWithLyrics(h, 'sing-d');
    const b = await songWithLyrics(h, 'sing-e');
    svc.hold('lead');
    const runningId = ((await startSing(h, a.id, a.song)).body.task as TaskJson).id;
    const queuedId = ((await startSing(h, b.id, b.song)).body.task as TaskJson).id;
    await waitFor('the lead job', () => svc.jobs.length === 1);

    const q = await send('POST', `${h.url}/api/tasks/${queuedId}/cancel`);
    expect(q.status).toBe(200);
    expect(await taskOf(h, queuedId)).toMatchObject({ state: 'failed', message: 'Cancelled' });
    const r = await send('POST', `${h.url}/api/tasks/${runningId}/cancel`);
    expect(r.status).toBe(200);
    await h.tasks.idle();
    expect(await taskOf(h, runningId)).toMatchObject({ state: 'failed', message: 'Cancelled' });
    expect(svc.cancels).toEqual([svc.jobs[0]!.id]);
    expect(svc.jobs).toHaveLength(1);
    expect((await send('POST', `${h.url}/api/tasks/${runningId}/cancel`)).status).toBe(409);
  });

  it('fails when the vocal service lost the job', async () => {
    const h = await boot(openSongsStore({ path: ':memory:' }));
    const { id, song } = await songWithLyrics(h, 'sing-f');
    svc.hold('lead');
    const taskId = ((await startSing(h, id, song)).body.task as TaskJson).id;
    await waitFor('the lead job', () => svc.jobs.length === 1);
    svc.lose();
    await h.tasks.idle();
    expect(await taskOf(h, taskId)).toMatchObject({ state: 'failed', message: LOST });
  });

  it('a brain restart resumes the running sing, which finds its job lost', async () => {
    const store = openSongsStore({ path: ':memory:' });
    const first = await boot(store, 60_000);
    const { id, song } = await songWithLyrics(first, 'sing-g');
    svc.hold('lead');
    const taskId = ((await startSing(first, id, song)).body.task as TaskJson).id;
    await waitFor('the recorded job', () => (store.listRunningTasks().find((t) => t.id === taskId)?.jobs ?? null) !== null);
    const job = svc.jobs[0]!.id;
    svc.lose();
    // A second brain on the same database (the first one "crashed" with the task running).
    const second = await boot(store);
    const pollsBefore = svc.polls.length;
    second.tasks.resumeAll();
    await second.tasks.idle();
    expect(await taskOf(second, taskId)).toMatchObject({ state: 'failed', message: LOST });
    expect(svc.polls.slice(pollsBefore)).toContain(job);
  });

  it('Write lyrics and Write melody refuse while the song is being sung', async () => {
    const h = await boot(openSongsStore({ path: ':memory:' }));
    const { id, song } = await songWithLyrics(h, 'sing-h');
    svc.hold('lead');
    await startSing(h, id, song);
    await waitFor('the lead job', () => svc.jobs.length === 1);
    const lyrics = await send('POST', `${h.url}/api/tasks`, { kind: 'writeLyrics', songId: id, song });
    expect(lyrics.status).toBe(409);
    expect(lyrics.body.message).toBe('Already singing');
    const melody = await send('POST', `${h.url}/api/tracks/edit`, { song, songId: id, op: { kind: 'newMelody', section: 'verse1' } });
    expect(melody.status).toBe(409);
    expect(melody.body.message).toBe('Already singing');
    const again = await startSing(h, id, song);
    expect(again.status).toBe(409);
    expect(again.body.message).toBe('Already singing');
    svc.release('lead');
    await h.tasks.idle();
  });

  it('a failed sing is not started again while another sing runs on the song', async () => {
    const h = await boot(openSongsStore({ path: ':memory:' }));
    const { id, song } = await songWithLyrics(h, 'sing-a');
    svc.hold('lead');
    const first = ((await startSing(h, id, song)).body.task as TaskJson).id;
    await waitFor('the first lead job', () => svc.jobs.length === 1);
    expect((await send('POST', `${h.url}/api/tasks/${first}/cancel`)).status).toBe(200);
    await h.tasks.idle();
    const second = await startSing(h, id, song);
    expect(second.status).toBe(201);
    await waitFor('the second lead job', () => svc.jobs.length === 2);
    const retried = await send('POST', `${h.url}/api/tasks/${first}/retry`);
    expect(retried.status).toBe(409);
    expect(retried.body.message).toBe('Already singing');
    expect(await taskOf(h, first)).toMatchObject({ state: 'failed', message: 'Cancelled' });
    svc.release('lead');
    await h.tasks.idle();
    expect(svc.jobs.filter((j) => j.stage === 'lead')).toHaveLength(2);
  });

  it('refuses to sing without written lyrics', async () => {
    const h = await boot(openSongsStore({ path: ':memory:' }));
    const made = await send('POST', `${h.url}/api/songs/generate`, { genre: 'brightPop', key: 'C', bpm: 110, seed: 'sing-i' });
    const edited = await send('POST', `${h.url}/api/tracks/edit`, { song: made.body.song, op: { kind: 'writeMelody' } });
    const r = await startSing(h, made.body.id as string, edited.body.song as Song);
    expect(r.status).toBe(422);
    expect(r.body.message).toBe('Write lyrics first');
  });

  it('sings each backing line at its own octave, inside F3-A5 (edm: Backing vocals 1 in chorus1 below F3 goes up an octave)', async () => {
    const h = await boot(openSongsStore({ path: ':memory:' }));
    // edm, seed sing-j at 128 bpm: the chorus lead sits around D4-E5, Backing vocals 1 an octave and more under it.
    const { id, song } = await songWithLyrics(h, 'sing-j', 'edm', 128);
    const taskId = ((await startSing(h, id, song)).body.task as TaskJson).id;
    await h.tasks.idle();
    expect(await taskOf(h, taskId)).toMatchObject({ state: 'ready' });
    const lead = svc.jobs[0]!.params as { octave: number };
    const { backings } = svc.jobs[1]!.params as { backings: { track: string; segment: string; notes: { midi: number }[] }[] };
    expect(backings.length).toBeGreaterThan(0);
    for (const b of backings) for (const n of b.notes) expect(n.midi + lead.octave).toBeGreaterThanOrEqual(53);
    for (const b of backings) for (const n of b.notes) expect(n.midi + lead.octave).toBeLessThanOrEqual(81);
    const b1 = backings.find((b) => b.track === 'Backing vocals 1' && b.segment === 'chorus1')!;
    const lane = (song.arrangement['chorus1']!.overrides['Backing vocals 1']!.bars as { notes: Record<string, { type?: string; note: number }[]> }[])
      .flatMap((bar) => Object.values(bar.notes).flat())
      .filter((e) => e.type === 'vocalNote')
      .map((e) => e.note);
    expect(Math.min(...lane) + lead.octave).toBeLessThan(53);
    expect(Math.min(...b1.notes.map((n) => n.midi))).toBe(Math.min(...lane) + 12);
  });
});

describe('backingShift: a backing line\'s own octave', () => {
  it('moves a line below F3 up an octave, toward the lead', () => {
    expect(backingShift([43, 50, 55, 60], [60, 67, 72, 76], 0, 'Backing vocals 1 in chorus1')).toBe(12);
  });
  it('keeps a line that fits and sits nearest the lead where it is', () => {
    expect(backingShift([60, 62, 64], [64, 67, 69], 0, 'Backing vocals 2 in chorus1')).toBe(0);
  });
  it('takes the lower shift on a tie', () => {
    expect(backingShift([60], [66], 0, 'Backing vocals 1 in chorus1')).toBe(0);
    expect(backingShift([48], [54], 12, 'Backing vocals 1 in chorus1')).toBe(0);
  });
  it('fails naming the track, the section and the line\'s range when no shift fits', () => {
    expect(() => backingShift([40, 75], [60], 0, 'Backing vocals 2 in bridge1')).toThrow(
      'Backing vocals 2 in bridge1 spans E2-D#5, which no octave shift puts within the singable range F3-A5',
    );
  });
});

describe('stored takes get the headroom gain', () => {
  it(`a take is stored ${-TAKE_GAIN_DB} dB below the service's WAV (-3 dB: the unmastered render must not clip)`, async () => {
    expect(TAKE_GAIN_DB).toBe(-3);
    const tmp = mkdtempSync(join(tmpdir(), 'take-gain-'));
    try {
      // 1 s of a 440 Hz sine at half scale, 44.1 kHz mono 16-bit.
      const rate = 44100;
      const data = Buffer.alloc(rate * 2);
      for (let i = 0; i < rate; i++) data.writeInt16LE(Math.round(0.5 * 32767 * Math.sin((2 * Math.PI * 440 * i) / rate)), i * 2);
      const head = Buffer.alloc(44);
      head.write('RIFF', 0, 'ascii');
      head.writeUInt32LE(36 + data.length, 4);
      head.write('WAVEfmt ', 8, 'ascii');
      head.writeUInt32LE(16, 16);
      head.writeUInt16LE(1, 20);
      head.writeUInt16LE(1, 22);
      head.writeUInt32LE(rate, 24);
      head.writeUInt32LE(rate * 2, 28);
      head.writeUInt16LE(2, 32);
      head.writeUInt16LE(16, 34);
      head.write('data', 36, 'ascii');
      head.writeUInt32LE(data.length, 40);
      writeFileSync(join(tmp, 'in.wav'), Buffer.concat([head, data]));
      await encodeTake('ffmpeg', join(tmp, 'in.wav'), join(tmp, 'out.ogg'));
      const pcm = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', join(tmp, 'out.ogg'), '-f', 'f32le', '-ac', '1', '-']);
      let peak = 0;
      for (let i = 0; i + 4 <= pcm.length; i += 4) peak = Math.max(peak, Math.abs(pcm.readFloatLE(i)));
      expect(20 * Math.log10(peak / 0.5)).toBeCloseTo(-3, 0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
