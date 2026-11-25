// The Sing task through the brain (docs/superpowers/specs/2026-11-25-sing-and-transcribe-design.md) against a fake
// vocals service: the sing stage runs with every step recorded in order and its files fetchable; the result (every
// take SoulX's, the melody as written) goes in only while the sung sections are as they were sung; cancel (queued and
// running), a lost job, a restart that finds the job lost; Write lyrics and Write melody refuse while a song is being
// sung.

import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { generatorParams, sungSections } from '@casperaki/arrangement';
import { isTakeFresh, SUNG_TAKE_KINDS, type Song } from '@casperaki/song-schema';

import { createApp } from '../src/bootstrap.js';
import { DEV_OWNER_ID } from '../src/routes/songs.js';
import { integratedLoudness, integratedLoudnessOf } from '../src/audio/loudness.js';
import { encodeTake, LEAD_TAKE_LUFS } from '../src/sing/singTask.js';
import { loadConfig } from '../src/config.js';
import { openSongsStore, type SongsStore } from '../src/store.js';
import type { BackgroundTasks } from '../src/tasks/tasks.js';
import { fakeLyricModel } from './fakeLyricModel.js';
import { startFakeVocalsService, toneWav, type FakeVocalsService } from './fakeVocalsService.js';

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

// Seed 'sing-a' gives a brightPop song with backing vocal lines; the tests that only need a sing under way use other
// seeds.

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

type LaneBars = { notes?: Record<string, { type?: string; note: number; duration: number; fullWord?: string }[]> }[];

/** A lane's vocal notes in a section (bar, beat, pitch, length, word), in order. */
function laneNotesOf(song: Song, section: string, track: string): [number, string, number, number, string | undefined][] {
  const bars = (song.arrangement[section]?.overrides?.[track]?.bars ?? []) as unknown as LaneBars;
  return bars.flatMap((bar, i) =>
    Object.entries(bar.notes ?? {}).flatMap(([k, evs]) => evs.filter((e) => e.type === 'vocalNote').map((e) => [i, k, e.note, e.duration, e.fullWord] as [number, string, number, number, string | undefined])),
  );
}

/** A lane's vocal note pitches in a section, in time order. */
function laneMidi(song: Song, section: string, track: string): number[] {
  return laneNotesOf(song, section, track)
    .map(([bar, beat, note]) => [bar * 4 + Number.parseFloat(beat), note] as const)
    .sort((a, b) => a[0] - b[0])
    .map(([, note]) => note);
}

describe('the Sing task', { timeout: 60_000 }, () => {
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sing-task-'));
    svc = await startFakeVocalsService();
  });
  afterEach(async () => {
    svc.release('sing');
    for (const b of brains.splice(0)) await b.stop();
    await svc.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('runs the sing stage, lists every step in order with its state, and keeps the steps\' files', async () => {
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
    expect(ids.at(-2)).toBe('levels');
    expect(ids.slice(1, -2).every((s) => /^(soulx|harmony|chain):/u.test(s))).toBe(true);
    expect(ids).toContain('soulx:chorus1');
    expect(ids).toContain('harmony:Backing vocals 1:chorus1');
    expect(task.steps.every((s) => s.state === 'done')).toBe(true);
    expect(task.steps[0]!.text).toMatch(/^SoulX sings verse1, .*chorus1.*; backing vocals: Backing vocals 1 in chorus1/u);

    // One job: every sung section from its Vocal lane as written, the backing lanes' lines, backings 9 dB under.
    expect(svc.jobs.map((j) => j.stage)).toEqual(['sing']);
    const params = svc.jobs[0]!.params as {
      bpm: number;
      backing_db: number;
      sections: { segment: string; section_bars: number; notes: { start: number; midi: number; word: string; phonemes: string[] }[] }[];
      backings: { track: string; segment: string; notes: { midi: number }[] }[];
    };
    expect(params).toMatchObject({ stage: 'sing', bpm: 110, backing_db: -9 });
    expect(Object.keys(params).sort()).toEqual(['backing_db', 'backings', 'bpm', 'sections', 'stage']);
    expect(params.sections.map((s) => s.segment)).toEqual(sungSections(song).map((s) => s.name));
    const chorus = params.sections.find((s) => s.segment === 'chorus1')!;
    expect(chorus.section_bars).toBe(song.songStructure.find((s) => s.name === 'chorus1')!.bars.length);
    expect(chorus.notes.map((n) => n.midi)).toEqual(laneMidi(song, 'chorus1', 'Vocal'));
    expect(chorus.notes.every((n) => n.word.length > 0 && n.phonemes.length > 0)).toBe(true);
    expect(params.backings.length).toBeGreaterThan(0);
    for (const b of params.backings) {
      expect(b.track).toMatch(/^Backing vocals [12]$/u);
      const lane = laneMidi(song, b.segment, b.track);
      const shift = b.notes[0]!.midi - lane[0]!;
      expect(shift % 12).toBe(0);
      expect(b.notes.map((n) => n.midi)).toEqual(lane.map((m) => m + shift));
      for (const n of b.notes) expect(n.midi).toBeGreaterThanOrEqual(53);
      for (const n of b.notes) expect(n.midi).toBeLessThanOrEqual(81);
    }

    // A step's file, copied when the step finished, under its stage.
    const sung = task.steps.find((s) => s.id === 'soulx:chorus1')!;
    expect(sung.files).toEqual(['sing/chorus1_soulx.wav']);
    const file = await fetch(`${h.url}/api/tasks/${taskId}/files/sing/chorus1_soulx.wav`);
    expect(file.status).toBe(200);
    expect(Buffer.from(await file.arrayBuffer()).toString('ascii', 0, 4)).toBe('RIFF');
    expect(task.steps.find((s) => s.id === 'levels')!.files).toContain('sing/take_chorus1_vocal.wav');
    expect((await fetch(`${h.url}/api/tasks/${taskId}/files/lead/chorus1_soulx.wav`)).status).toBe(404);
    expect((await fetch(`${h.url}/api/tasks/${taskId}/files/sing/nothing.wav`)).status).toBe(404);
    expect((await fetch(`${h.url}/api/tasks/${taskId}/files/sing/..%2Fsecret`)).status).toBe(400);
    expect((await fetch(`${h.url}/api/tasks/${taskId}/files/other/chorus1_soulx.wav`)).status).toBe(400);
    // Copies are written whole under their name: no temporary file is left.
    expect(readdirSync(join(dir, 'files', taskId, 'sing')).some((f) => f.includes('.part-'))).toBe(false);

    // The stored takes: the leads together at LEAD_TAKE_LUFS (the approved demo's level), every take by one gain (the
    // fake service sends the same tone for every take, so a backing comes out as loud as a lead).
    const takes = (h.store.getTask(DEV_OWNER_ID, taskId)!.result as { takes: { track: string; sha256: string }[] }).takes;
    const path = (t: { sha256: string }) => join(dir, 'takes', `${t.sha256}.ogg`);
    const leads = takes.filter((t) => t.track === 'Vocal');
    expect(await integratedLoudnessOf('ffmpeg', leads.map(path), 'leads')).toBeCloseTo(LEAD_TAKE_LUFS, 0);
    const backing = takes.find((t) => t.track !== 'Vocal')!;
    expect(await integratedLoudness('ffmpeg', path(backing))).toBeCloseTo(await integratedLoudness('ffmpeg', path(leads[0]!)), 0);
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
    // Every take is SoulX's: a lead take for every sung section, a take for every backing line, no ad-libs.
    expect(takes.every((t) => t.kind === 'soulx-vocal' && t.modelId === 'Soul-AILab/SoulX-Singer' && t.seed === undefined)).toBe(true);
    const at = (t: (typeof takes)[number]) => (t.attachedTo.scope === 'segment' ? `${t.attachedTo.segment}/${t.attachedTo.instrument}` : '');
    const sung = sungSections(song).map((s) => s.name);
    expect(takes.filter((t) => t.attachedTo.scope === 'segment' && t.attachedTo.instrument === 'Vocal').map(at).sort()).toEqual(sung.map((s) => `${s}/Vocal`).sort());
    expect(takes.some((t) => at(t) === 'chorus1/Backing vocals 1')).toBe(true);
    expect(takes.some((t) => at(t).endsWith('/Ad-libs'))).toBe(false);
    // The melody stays exactly as written: the sung melody recorded is the lane's notes, and the vocal lanes of the
    // sung sections (lead and backings, which were sung as they are) come out of the apply unchanged.
    const melody = generatorParams(saved).params?.['sungMelody'] as Record<string, { midi: number }[]>;
    expect(Object.keys(melody).sort()).toEqual([...sung].sort());
    expect(melody['chorus1']!.map((n) => n.midi)).toEqual(laneMidi(song, 'chorus1', 'Vocal'));
    for (const name of sung) {
      for (const track of ['Vocal', 'Backing vocals 1', 'Backing vocals 2']) {
        expect({ name, track, lane: laneNotesOf(saved, name, track) }).toEqual({ name, track, lane: laneNotesOf(song, name, track) });
      }
    }
  });

  it('cancels a queued and a running sing (the running one cancels its service job)', async () => {
    const h = await boot(openSongsStore({ path: ':memory:' }));
    const a = await songWithLyrics(h, 'sing-d');
    const b = await songWithLyrics(h, 'sing-e');
    svc.hold('sing');
    const runningId = ((await startSing(h, a.id, a.song)).body.task as TaskJson).id;
    const queuedId = ((await startSing(h, b.id, b.song)).body.task as TaskJson).id;
    await waitFor('the sing job', () => svc.jobs.length === 1);

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
    svc.hold('sing');
    const taskId = ((await startSing(h, id, song)).body.task as TaskJson).id;
    await waitFor('the sing job', () => svc.jobs.length === 1);
    svc.lose();
    await h.tasks.idle();
    expect(await taskOf(h, taskId)).toMatchObject({ state: 'failed', message: LOST });
  });

  it('a brain restart resumes the running sing, which finds its job lost', async () => {
    const store = openSongsStore({ path: ':memory:' });
    const first = await boot(store, 60_000);
    const { id, song } = await songWithLyrics(first, 'sing-g');
    svc.hold('sing');
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
    svc.hold('sing');
    await startSing(h, id, song);
    await waitFor('the sing job', () => svc.jobs.length === 1);
    const lyrics = await send('POST', `${h.url}/api/tasks`, { kind: 'writeLyrics', songId: id, song });
    expect(lyrics.status).toBe(409);
    expect(lyrics.body.message).toBe('Already singing');
    const melody = await send('POST', `${h.url}/api/tracks/edit`, { song, songId: id, op: { kind: 'newMelody', section: 'verse1' } });
    expect(melody.status).toBe(409);
    expect(melody.body.message).toBe('Already singing');
    const again = await startSing(h, id, song);
    expect(again.status).toBe(409);
    expect(again.body.message).toBe('Already singing');
    svc.release('sing');
    await h.tasks.idle();
  });

  it('a failed sing is not started again while another sing runs on the song', async () => {
    const h = await boot(openSongsStore({ path: ':memory:' }));
    const { id, song } = await songWithLyrics(h, 'sing-a');
    svc.hold('sing');
    const first = ((await startSing(h, id, song)).body.task as TaskJson).id;
    await waitFor('the first sing job', () => svc.jobs.length === 1);
    expect((await send('POST', `${h.url}/api/tasks/${first}/cancel`)).status).toBe(200);
    await h.tasks.idle();
    const second = await startSing(h, id, song);
    expect(second.status).toBe(201);
    await waitFor('the second sing job', () => svc.jobs.length === 2);
    const retried = await send('POST', `${h.url}/api/tasks/${first}/retry`);
    expect(retried.status).toBe(409);
    expect(retried.body.message).toBe('Already singing');
    expect(await taskOf(h, first)).toMatchObject({ state: 'failed', message: 'Cancelled' });
    svc.release('sing');
    await h.tasks.idle();
    expect(svc.jobs.filter((j) => j.stage === 'sing')).toHaveLength(2);
  });

  it('refuses to sing without written lyrics', async () => {
    const h = await boot(openSongsStore({ path: ':memory:' }));
    const made = await send('POST', `${h.url}/api/songs/generate`, { genre: 'brightPop', key: 'C', bpm: 110, seed: 'sing-i' });
    const edited = await send('POST', `${h.url}/api/tracks/edit`, { song: made.body.song, op: { kind: 'writeMelody' } });
    const r = await startSing(h, made.body.id as string, edited.body.song as Song);
    expect(r.status).toBe(422);
    expect(r.body.message).toBe('Write lyrics first');
  });

  it('a restart that finds a sing started before Sing was SoulX-only (a YuE2 lead job) fails it, saying to sing again', async () => {
    const store = openSongsStore({ path: ':memory:' });
    const h = await boot(store);
    const { id, song } = await songWithLyrics(h, 'sing-a');
    store.insertTask({ id: 'old-sing', ownerId: DEV_OWNER_ID, songId: id, kind: 'sing', input: JSON.stringify(song), startedAt: new Date().toISOString() });
    store.setTaskJobs('old-sing', { lead: 'job-from-before' } as never);
    h.tasks.resumeAll();
    await h.tasks.idle();
    expect(await taskOf(h, 'old-sing')).toMatchObject({
      state: 'failed',
      message: 'this sing was started by an earlier version of Sing (with YuE2), which cannot be resumed: sing again',
    });
    expect(svc.jobs).toHaveLength(0);
  });
});

describe('encodeTake', () => {
  it('stores a take as Ogg Vorbis with the gain it is given', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'take-gain-'));
    try {
      writeFileSync(join(tmp, 'in.wav'), toneWav(2));
      await encodeTake('ffmpeg', join(tmp, 'in.wav'), join(tmp, 'out.ogg'), -5);
      expect((await integratedLoudness('ffmpeg', join(tmp, 'out.ogg'))) - (await integratedLoudness('ffmpeg', join(tmp, 'in.wav')))).toBeCloseTo(-5, 0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
