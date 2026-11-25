// Transcribe melody through the brain (docs/superpowers/specs/2026-11-25-sing-and-transcribe-design.md): the user's
// recording of one section, sung along from the section's first beat, back into that section's Vocal lane. With
// written lyrics, the vocals service's transcribe stage finds the lane's note count (stubbed here); without, the hum
// service's pitch-only notes take the lane's words. Other sections keep their sung melody and takes.

import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { generatorParams, laneWordsOn, sungSections } from '@casperaki/arrangement';
import { isTakeFresh, type Song } from '@casperaki/song-schema';

import { createApp } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { laneNotes } from '../src/sing/plan.js';
import { humNotesOnGrid, laneOctaveShift } from '../src/sing/transcribeTask.js';
import { openSongsStore, type SongsStore } from '../src/store.js';
import type { BackgroundTasks } from '../src/tasks/tasks.js';
import { fakeLyricModel } from './fakeLyricModel.js';
import { startFakeVocalsService, toneWav, type FakeVocalsService } from './fakeVocalsService.js';

interface Harness { url: string; store: SongsStore; tasks: BackgroundTasks; stop: () => Promise<void> }
interface TaskJson { id: string; kind: string; songId: string; state: string; message?: string; steps: { id: string; state: string; files?: string[] }[] }

/** A stand-in for the hum service (POST /transcribe, multipart): the form fields it got, and fixed notes. */
interface FakeHum { url: string; forms: Record<string, string>[]; audioBytes: number[]; stop: () => Promise<void> }

/** What the stub hum service hears (seconds, sung pitch): three notes at 110 bpm (a beat is 60/110 s). */
const BEAT = 60 / 110;
const HUM_NOTES = [
  { onsetSec: 0.02, offsetSec: BEAT - 0.03, midi: 72 }, // beat 0, a beat long
  { onsetSec: BEAT * 1.5, offsetSec: BEAT * 2.5, midi: 75 }, // beat 1.5, a beat long; D#5 snaps to D5 in C
  { onsetSec: BEAT * 1.52, offsetSec: BEAT * 1.6, midi: 70 }, // the same 16th: the longer one is kept
  { onsetSec: BEAT * 4, offsetSec: BEAT * 6.1, midi: 76 }, // beat 4 (bar 2), two beats
];

async function startFakeHum(): Promise<FakeHum> {
  const forms: Record<string, string>[] = [];
  const audioBytes: number[] = [];
  const server: Server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const form = await new Response(Buffer.concat(chunks), { headers: { 'content-type': req.headers['content-type']! } }).formData();
      const fields: Record<string, string> = {};
      for (const [k, v] of form.entries()) {
        if (typeof v === 'string') fields[k] = v;
        else audioBytes.push(v.size);
      }
      forms.push(fields);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ bpm: 110, beats: [0, BEAT, 2 * BEAT], downbeats: [0], key: { tonic: 0, scale: 'major' }, notes: HUM_NOTES, tookMs: 5 }));
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    forms,
    audioBytes,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

let dir: string;
let svc: FakeVocalsService;
let hum: FakeHum;
const brains: Harness[] = [];

async function boot(store: SongsStore): Promise<Harness> {
  const env = {
    VOCALS_SERVICE_URL: svc.url,
    HUM_SERVICE_URL: hum.url,
    BRAIN_TASK_FILES_DIR: join(dir, 'files'),
    BRAIN_VOCAL_TAKES_DIR: join(dir, 'takes'),
  } as NodeJS.ProcessEnv;
  const app = createApp(loadConfig(env), { store, lyricModel: fakeLyricModel(), singPollMs: 5 });
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
const taskOf = async (h: Harness, id: string) => ((await send('GET', `${h.url}/api/tasks`)).body.tasks as TaskJson[]).find((t) => t.id === id)!;

const recording = (seconds = 2) => ({ name: 'take.wav', type: 'audio/wav', data: toneWav(seconds).toString('base64') });

/** A saved project with a melody, and with written lyrics unless `lyrics` is false. */
async function songOf(h: Harness, seed: string, lyrics: boolean): Promise<{ id: string; song: Song }> {
  const made = await send('POST', `${h.url}/api/songs/generate`, { genre: 'brightPop', key: 'C', bpm: 110, seed });
  const edited = await send('POST', `${h.url}/api/tracks/edit`, { song: made.body.song, op: { kind: 'writeMelody' } });
  expect(edited.status).toBe(200);
  if (!lyrics) {
    const id = (await send('PUT', `${h.url}/api/songs/${made.body.id as string}`, { song: edited.body.song })).body.id as string;
    return { id, song: edited.body.song as Song };
  }
  const task = (await send('POST', `${h.url}/api/tasks`, { kind: 'writeLyrics', songId: made.body.id, song: edited.body.song })).body.task as TaskJson;
  await h.tasks.idle();
  const applied = await send('POST', `${h.url}/api/tasks/${task.id}/apply`);
  expect(applied.status).toBe(200);
  const id = applied.body.songId as string;
  return { id, song: (await send('GET', `${h.url}/api/songs/${id}`)).body.song as Song };
}

/** Sings the song (fake service) and applies it: the saved song with sung melody and takes in every sung section. */
async function sung(h: Harness, id: string, song: Song): Promise<{ id: string; song: Song }> {
  const t = (await send('POST', `${h.url}/api/tasks`, { kind: 'sing', songId: id, song })).body.task as TaskJson;
  await h.tasks.idle();
  const applied = await send('POST', `${h.url}/api/tasks/${t.id}/apply`);
  expect(applied.status).toBe(200);
  const newId = applied.body.songId as string;
  return { id: newId, song: (await send('GET', `${h.url}/api/songs/${newId}`)).body.song as Song };
}

const startTranscribe = (h: Harness, songId: string, song: Song, segment: string, over: Record<string, unknown> = {}) =>
  send('POST', `${h.url}/api/tasks`, { kind: 'transcribe', songId, song, segment, recording: recording(), hasBacking: false, ...over });

const lane = (song: Song, segment: string) => laneNotes(song, segment, 'Vocal').map((n) => ({ ...n, phonemes: [...n.phonemes] }));
const sectionBeats = (song: Song, segment: string) => song.songStructure.find((s) => s.name === segment)!.bars.length * 4;

describe('the Transcribe melody task', { timeout: 60_000 }, () => {
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'transcribe-task-'));
    svc = await startFakeVocalsService();
    hum = await startFakeHum();
  });
  afterEach(async () => {
    for (const st of ['sing', 'transcribe']) svc.release(st);
    for (const b of brains.splice(0)) await b.stop();
    await svc.stop();
    await hum.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('with written lyrics: the section\'s Vocal lane becomes the transcription, the other sections keep their sung melody and takes', async () => {
    const h = await boot(openSongsStore({ path: ':memory:' }));
    const first = await songOf(h, 'sing-a', true);
    const { id, song } = await sung(h, first.id, first.song);
    const verse = sungSections(song).find((s) => s.type === 'verse')!.name;
    const before = lane(song, verse);
    const others = sungSections(song).map((s) => s.name).filter((n) => n !== verse);
    expect(song.aiArtifacts.some((a) => a.attachedTo.scope === 'segment' && a.attachedTo.segment === verse)).toBe(true);

    const started = await startTranscribe(h, id, song, verse);
    expect(started.status).toBe(201);
    const taskId = (started.body.task as TaskJson).id;
    await h.tasks.idle();
    const task = await taskOf(h, taskId);
    expect(task).toMatchObject({ kind: 'transcribe', state: 'ready' });
    expect(task.steps.map((s) => s.id)).toEqual(['recording', `recording:${verse}`, `transcribe:${verse}`, 'words']);
    expect(task.steps.every((s) => s.state === 'done')).toBe(true);

    // The stage's params: the lane's note count, the song's octave, the section's length, the recording as WAV.
    const job = svc.jobs.at(-1)!;
    expect(job.stage).toBe('transcribe');
    expect(job.params).toMatchObject({
      section: verse, bpm: 110, key: song.key, octave: 0, section_beats: sectionBeats(song, verse), count: before.length, has_backing: false,
    });
    expect(Buffer.from(job.params['audio'] as string, 'base64').toString('ascii', 0, 4)).toBe('RIFF');
    expect((await fetch(`${h.url}/api/tasks/${taskId}/files/transcribe/${verse}_melody.json`)).status).toBe(200);

    const applied = await send('POST', `${h.url}/api/tasks/${taskId}/apply`);
    expect(applied.status).toBe(200);
    const after = (await send('GET', `${h.url}/api/songs/${applied.body.songId as string}`)).body.song as Song;
    // The transcription (the fake: count 16ths spread over the section) with the lane's words in order.
    const n = before.length;
    const shift = laneOctaveShift(Array.from({ length: n }, (_, i) => 60 + (i % 5)), before.map((x) => x.midi));
    const expected = Array.from({ length: n }, (_, i) => ({
      start: Math.floor((i * sectionBeats(song, verse) * 4) / n) / 4,
      duration: 0.25,
      midi: 60 + (i % 5) + shift,
      word: before[i]!.word,
      phonemes: before[i]!.phonemes,
    }));
    expect(lane(after, verse)).toEqual(expected);
    for (const other of others) expect(lane(after, other)).toEqual(lane(song, other));
    const takesOf = (s: Song) => s.aiArtifacts.filter((a) => a.attachedTo.scope === 'segment').map((a) => a.id);
    expect(takesOf(after)).toEqual(takesOf(song).filter((t) => !t.includes(`:${verse}:`)));
    for (const a of after.aiArtifacts) expect(isTakeFresh(after, a)).toBe(true);
    const sungMelody = generatorParams(after).params?.['sungMelody'] as Record<string, unknown>;
    for (const other of others) expect(sungMelody[other]).toEqual((generatorParams(song).params?.['sungMelody'] as Record<string, unknown>)[other]);
  });

  it('without written lyrics: pitch-only notes from the hum service, carrying the lane\'s words', async () => {
    const h = await boot(openSongsStore({ path: ':memory:' }));
    const { id, song } = await songOf(h, 'sing-b', false);
    const verse = sungSections(song).find((s) => s.type === 'verse')!.name;
    const others = sungSections(song).map((s) => s.name).filter((n) => n !== verse);
    const started = await startTranscribe(h, id, song, verse);
    expect(started.status).toBe(201);
    const taskId = (started.body.task as TaskJson).id;
    await h.tasks.idle();
    const task = await taskOf(h, taskId);
    expect(task).toMatchObject({ state: 'ready' });
    expect(task.steps.map((s) => s.id)).toEqual(['recording', 'hum', 'words']);
    expect(svc.jobs).toHaveLength(0); // a clean recording without lyrics needs no vocals service
    expect(hum.forms).toEqual([{ mode: 'click', bpm: '110', firstBeatSec: '0' }]);
    expect(hum.audioBytes[0]).toBeGreaterThan(44);

    const applied = await send('POST', `${h.url}/api/tasks/${taskId}/apply`);
    expect(applied.status).toBe(200);
    const after = (await send('GET', `${h.url}/api/songs/${applied.body.songId as string}`)).body.song as Song;
    const laneMidis = lane(song, verse).map((x) => x.midi);
    const shift = laneOctaveShift([72, 74, 76], laneMidis);
    const pitchOnly = [
      { start: 0, duration: 1, midi: 72 + shift },
      { start: 1.5, duration: 1, midi: 74 + shift }, // snapped to the song's key (C)
      { start: 4, duration: 2, midi: 76 + shift },
    ];
    const bars = song.arrangement[verse]!.overrides['Vocal']!.bars!;
    expect(lane(after, verse)).toEqual(laneWordsOn(verse, bars, pitchOnly));
    // the words are the lane's own (its first line's first three)
    expect(lane(after, verse).map((x) => x.word)).toEqual(lane(song, verse).slice(0, 3).map((x) => x.word));
    for (const other of others) expect(lane(after, other)).toEqual(lane(song, other));
  });

  it('with backing and no lyrics: the vocals service separates the voice, the hum service reads it', async () => {
    const h = await boot(openSongsStore({ path: ':memory:' }));
    const { id, song } = await songOf(h, 'sing-b', false);
    const verse = sungSections(song).find((s) => s.type === 'verse')!.name;
    const t = (await startTranscribe(h, id, song, verse, { hasBacking: true })).body.task as TaskJson;
    await h.tasks.idle();
    const task = await taskOf(h, t.id);
    expect(task.state).toBe('ready');
    expect(task.steps.map((s) => s.id)).toEqual(['recording', `recording:${verse}`, `separate:${verse}`, 'hum', 'words']);
    expect(svc.jobs[0]!.params).toMatchObject({ count: null, has_backing: true });
    expect(hum.forms).toHaveLength(1);
  });

  it('a result merged into unsaved edits keeps the other sections\' takes (the web\'s applySung edit, partial)', async () => {
    const h = await boot(openSongsStore({ path: ':memory:' }));
    const first = await songOf(h, 'sing-a', true);
    const { id, song } = await sung(h, first.id, first.song);
    const verse = sungSections(song).find((s) => s.type === 'verse')!.name;
    const t = (await startTranscribe(h, id, song, verse)).body.task as TaskJson;
    await h.tasks.idle();
    const applied = await send('POST', `${h.url}/api/tasks/${t.id}/apply`);
    const saved = (await send('GET', `${h.url}/api/songs/${applied.body.songId as string}`)).body.song as Song;
    const merged = await send('POST', `${h.url}/api/tracks/edit`, { song, op: { kind: 'applySung', result: applied.body.result, sungOver: saved, partial: true } });
    expect(merged.status).toBe(200);
    expect((merged.body.song as Song).aiArtifacts.map((a) => a.id)).toEqual(saved.aiArtifacts.map((a) => a.id));
    expect(lane(merged.body.song as Song, verse)).toEqual(lane(saved, verse));
  });

  it('a recording sung an octave below the lane comes back in the lane\'s octave; one already in it is unchanged', async () => {
    const h = await boot(openSongsStore({ path: ':memory:' }));
    const made = await songOf(h, 'sing-a', true);
    let { id, song } = made;
    const verse = sungSections(song).find((s) => s.type === 'verse')!.name;
    const laneMidis = lane(song, verse).map((x) => x.midi);
    for (const offset of [-12, 0]) {
      svc.setTranscribeMidi((i) => laneMidis[i]! + offset);
      const t = (await startTranscribe(h, id, song, verse)).body.task as TaskJson;
      await h.tasks.idle();
      const ready = await taskOf(h, t.id);
      expect(ready.state).toBe('ready');
      const applied = await send('POST', `${h.url}/api/tasks/${t.id}/apply`);
      expect(applied.status).toBe(200);
      const melody = (applied.body.result as { melody: Record<string, { midi: number }[]> }).melody[verse]!;
      expect(melody.map((x) => x.midi)).toEqual(laneMidis);
      id = applied.body.songId as string;
      song = (await send('GET', `${h.url}/api/songs/${id}`)).body.song as Song;
      expect(lane(song, verse).map((x) => x.midi)).toEqual(laneMidis);
    }
  });

  it('octave shift: the whole octaves (-24..+24) putting the median nearest the lane\'s (a tie goes higher); pitch-only notes snap to the key', () => {
    expect(laneOctaveShift([48, 50, 52], [60, 62, 64])).toBe(12);
    expect(laneOctaveShift([60, 62, 64], [60, 62, 64])).toBe(0);
    expect(laneOctaveShift([84, 86], [60, 62])).toBe(-24);
    expect(laneOctaveShift([60], [66])).toBe(12); // 6 below vs 6 above: the higher
    const grid = humNotesOnGrid([{ onsetSec: 0, offsetSec: 0.5, midi: 61 }, { onsetSec: 0.6, offsetSec: 1, midi: 66 }], 120, 8, 'C', 'verse1');
    expect(grid.map((n) => n.midi)).toEqual([60, 65]); // C# -> C, F# -> F (down on a tie)
    expect(humNotesOnGrid([{ onsetSec: 0, offsetSec: 0.5, midi: 68 }], 120, 8, 'Am', 'verse1').map((n) => n.midi)).toEqual([67]); // G# -> G in A minor
  });

  it('Sing and Transcribe refuse each other while one runs on the song', async () => {
    const h = await boot(openSongsStore({ path: ':memory:' }));
    const { id, song } = await songOf(h, 'sing-a', true);
    const verse = sungSections(song).find((s) => s.type === 'verse')!.name;
    svc.hold('transcribe');
    const t = await startTranscribe(h, id, song, verse);
    expect(t.status).toBe(201);
    for (let i = 0; i < 500 && svc.jobs.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(svc.jobs.map((j) => j.stage)).toEqual(['transcribe']);
    expect(await send('POST', `${h.url}/api/tasks`, { kind: 'sing', songId: id, song })).toMatchObject({ status: 409, body: { message: 'Already transcribing' } });
    expect(await startTranscribe(h, id, song, verse)).toMatchObject({ status: 409, body: { message: 'Already transcribing' } });
    expect((await send('POST', `${h.url}/api/tasks/${(t.body.task as TaskJson).id}/cancel`)).status).toBe(200);
    svc.release('transcribe');
    await h.tasks.idle();
  });

  it('refuses: an unknown section, a recording too large, while singing, and a changed section on apply', async () => {
    const h = await boot(openSongsStore({ path: ':memory:' }));
    const { id, song } = await songOf(h, 'sing-a', true);
    const verse = sungSections(song).find((s) => s.type === 'verse')!.name;
    expect((await startTranscribe(h, id, song, 'nope9')).body).toMatchObject({ error: 'unknown_section' });
    // A section resized in the editor is not the generator's: its transcription could not go in (by generator name).
    const resized = structuredClone(song);
    const seg = resized.songStructure.find((s) => s.name === verse)!;
    const n = seg.bars.length;
    seg.bars = [...seg.bars, ...seg.bars.slice(0, 4)];
    for (const o of Object.values(resized.arrangement[verse]!.overrides)) if (o.bars) o.bars = [...o.bars, ...o.bars.slice(0, 4)];
    expect(await startTranscribe(h, id, resized, verse)).toMatchObject({
      status: 422,
      body: { error: 'section_not_generated', message: `The section ${verse} has ${n + 4} bars, but ${n} as the song was generated (resized in the editor), so it cannot be sung` },
    });
    const big = { name: 'big.wav', type: 'audio/wav', data: Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64') };
    const tooBig = await startTranscribe(h, id, song, verse, { recording: big });
    expect(tooBig.status).toBe(413);

    svc.hold('sing');
    const sing = await send('POST', `${h.url}/api/tasks`, { kind: 'sing', songId: id, song });
    expect(sing.status).toBe(201);
    const refused = await startTranscribe(h, id, song, verse);
    expect(refused).toMatchObject({ status: 409, body: { message: 'Already singing' } });
    expect((await send('POST', `${h.url}/api/tasks/${(sing.body.task as TaskJson).id}/cancel`)).status).toBe(200);
    svc.release('sing');
    await h.tasks.idle();

    const t = (await startTranscribe(h, id, song, verse)).body.task as TaskJson;
    await h.tasks.idle();
    // the verse's chords change before the result goes in
    const changed = {
      ...song,
      songStructure: song.songStructure.map((s) => (s.name === verse ? { ...s, bars: s.bars.map((b, i) => (i === 0 ? { ...b, chords: ['Dm', 'Dm', 'Dm', 'Dm'] } : b)) } : s)),
    } as Song;
    const projectId = (await taskOf(h, t.id)).songId;
    await send('PUT', `${h.url}/api/songs/${projectId}`, { song: changed });
    const applied = await send('POST', `${h.url}/api/tasks/${t.id}/apply`);
    expect(applied).toMatchObject({ status: 409, body: { message: 'The song changed while the recording was being transcribed: transcribe again' } });
  });
});
