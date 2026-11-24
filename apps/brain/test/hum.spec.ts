// Hum to song: the brain's part (quantize and fit to bars, chords, completion, the song), with the two model
// services replaced by recorded answers. The transcription fixture is the real hum service's answer for a HumTrans
// test recording (F01_0024_0001_2, about 70 bpm, E minor).

import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { amtChords, chordAlternatives, keptBars, mergeCompletion, quantizeHum, songKeyOf, type Transcription } from '../src/hum/fit.js';
import { createHumRouter } from '../src/routes/hum.js';
import { fakeLyricModel } from './fakeLyricModel.js';
import { EventHub } from '../src/events.js';
import { LyricsTasks } from '../src/lyrics/tasks.js';
import { hashCanonical } from '../src/routes/songs.js';
import { openSongsStore, type SongsStore } from '../src/store.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const TRANSCRIPTION = JSON.parse(readFileSync(join(HERE, 'fixtures', 'hum-transcription.json'), 'utf8')) as Transcription;

describe('quantizeHum', () => {
  it('puts the hum on 8ths from bar 1 and rounds its length to 2, 4 or 8 bars', () => {
    const q = quantizeHum(TRANSCRIPTION);
    expect(q.notesHeard).toBe(18);
    expect(q.hummedBars).toBe(4);
    expect(q.melody[0]!.beat).toBeGreaterThanOrEqual(0);
    expect(q.melody[0]!.beat).toBeLessThan(4);
    for (const [i, n] of q.melody.entries()) {
      expect(n.beat * 2).toBe(Math.round(n.beat * 2));
      expect(n.duration).toBeGreaterThan(0);
      const next = q.melody[i + 1];
      if (next) expect(n.beat + n.duration).toBeLessThanOrEqual(next.beat);
      expect(n.beat + n.duration).toBeLessThanOrEqual(16);
    }
    expect(q.notesKept + q.pickupDropped).toBeLessThanOrEqual(q.notesHeard);
  });

  it('on a steady grid: exact beats, a pickup in the last beat dropped, 2 bars', () => {
    const spb = 0.5; // 120 bpm
    const beats = Array.from({ length: 16 }, (_, i) => 1 + i * spb);
    const t: Transcription = {
      bpm: 120, beats, downbeats: [1, 3, 5, 7], key: { tonic: 0, scale: 'major' }, tookMs: 1,
      notes: [
        { onsetSec: 1 + 3.5 * spb, offsetSec: 1 + 3.9 * spb, midi: 67 }, // pickup into bar 2
        { onsetSec: 1 + 4 * spb, offsetSec: 1 + 5 * spb, midi: 72 },
        { onsetSec: 1 + 5.02 * spb, offsetSec: 1 + 6 * spb, midi: 74 },
        { onsetSec: 1 + 6 * spb, offsetSec: 1 + 8 * spb, midi: 76 },
        { onsetSec: 1 + 9 * spb, offsetSec: 1 + 11.5 * spb, midi: 72 },
      ],
    };
    const q = quantizeHum(t);
    expect(q.pickupDropped).toBe(1);
    expect(q.hummedBars).toBe(2);
    expect(q.melody).toEqual([
      { beat: 0, midi: 72, duration: 1 },
      { beat: 1, midi: 74, duration: 1 },
      { beat: 2, midi: 76, duration: 2 },
      { beat: 5, midi: 72, duration: 2.5 },
    ]);
  });

  it('fails plainly with no notes or no beat', () => {
    expect(() => quantizeHum({ ...TRANSCRIPTION, notes: [] })).toThrow(/No notes were heard/u);
    expect(() => quantizeHum({ ...TRANSCRIPTION, beats: [1] })).toThrow(/No beat could be found/u);
  });
});

describe('chords and completion helpers', () => {
  it('three chord alternatives for 8 bars in the hum key (E minor: G major chords)', () => {
    const q = quantizeHum(TRANSCRIPTION);
    const alts = chordAlternatives(q.melody, q.hummedBars, TRANSCRIPTION.key);
    expect(alts).toHaveLength(3);
    for (const a of alts) expect(a.chords).toHaveLength(16);
    expect(songKeyOf(TRANSCRIPTION.key)).toBe('Em');
    const voiced = amtChords(alts[0]!.slots, TRANSCRIPTION.key);
    expect(voiced).toHaveLength(16);
    expect(voiced[1]!.beat).toBe(2);
    expect(voiced.every((c) => c.midi.length >= 2 && c.midi[0]! >= 48 && c.midi[0]! < 60)).toBe(true);
  });

  it('keeps the hummed bars and takes only later bars from a completion', () => {
    expect(keptBars(4)).toEqual([0, 1, 2, 3]);
    const merged = mergeCompletion([{ beat: 0, midi: 60, duration: 4 }], 2, [
      { beat: 0, midi: 50, duration: 1 }, // inside the hummed bars: ignored
      { beat: 8, midi: 62, duration: 2 },
      { beat: 31, midi: 64, duration: 4 }, // clipped at bar 8's end
    ]);
    expect(merged).toEqual([
      { beat: 0, midi: 60, duration: 4 },
      { beat: 8, midi: 62, duration: 2 },
      { beat: 31, midi: 64, duration: 1 },
    ]);
  });
});

describe('POST /api/hum/*', () => {
  let url = '';
  let store: SongsStore;
  let stop: () => Promise<void>;
  let dir = '';
  const calls: { url: string; body: unknown }[] = [];

  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = String(input);
    if (u.endsWith('/transcribe')) {
      calls.push({ url: u, body: Object.fromEntries([...(init!.body as FormData).entries()].filter(([k]) => k !== 'audio')) });
      return new Response(JSON.stringify(TRANSCRIPTION), { status: 200 });
    }
    if (u.endsWith('/complete')) {
      const body = JSON.parse(String(init!.body)) as { keepBars: number[]; totalBars: number };
      calls.push({ url: u, body });
      const notes = [];
      for (let beat = body.keepBars.length * 4; beat < body.totalBars * 4; beat += 2) notes.push({ beat, midi: 64 + (beat % 5), duration: 2 });
      return new Response(JSON.stringify({ completions: [{ notes, score: {} }], tookMs: 5 }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${u}`);
  }) as typeof fetch;

  beforeEach(async () => {
    calls.length = 0;
    dir = mkdtempSync(join(tmpdir(), 'hum-spec-'));
    store = openSongsStore({ path: ':memory:' });
    const app = express();
    app.use(express.json());
    app.use(createHumRouter({ humServiceUrl: 'http://hum.test', amtServiceUrl: 'http://amt.test', humLabDir: dir, store, lyrics: new LyricsTasks({ store, lyricModel: fakeLyricModel(), events: new EventHub(), hash: hashCanonical, clock: () => '2026-11-23T22:00:00.000Z' }), fetchImpl: fakeFetch, now: () => '2026-11-23T22:00:00.000Z' }));
    const server = await new Promise<ReturnType<typeof app.listen>>((r) => {
      const s = app.listen(0, '127.0.0.1', () => r(s));
    });
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    stop = () => new Promise<void>((r) => server.close(() => (store.close(), r())));
  });
  afterEach(() => stop());

  it('analyses a hum, completes it, keeps it, and makes a song with it as the chorus', async () => {
    const res = await fetch(`${url}/api/hum/analyse?mode=free`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: new Uint8Array([1, 2, 3]) });
    expect(res.status).toBe(200);
    const a = (await res.json()) as { id: string; bpm: number; songKey: string; hummedBars: number; alternatives: { chords: string[]; melody: { beat: number }[]; completed: boolean }[] };
    expect(a.bpm).toBe(70);
    expect(a.songKey).toBe('Em');
    expect(a.hummedBars).toBe(4);
    expect(a.alternatives).toHaveLength(3);
    // Not completed yet: the page completes one alternative per call, to show progress.
    for (const alt of a.alternatives) expect(alt.completed).toBe(false);
    expect(calls.filter((c) => c.url.endsWith('/complete'))).toHaveLength(0);
    expect(readdirSync(dir).sort()).toEqual([`${a.id}.json`, `${a.id}.wav`].sort());

    for (const alternative of [0, 1, 2]) {
      const done = await fetch(`${url}/api/hum/complete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ analysisId: a.id, alternative }) });
      expect(done.status).toBe(200);
      const after = (await done.json()) as typeof a;
      expect(after.alternatives[alternative]!.completed).toBe(true);
      expect(after.alternatives[alternative]!.melody.some((n) => n.beat >= 16)).toBe(true);
    }
    const completeCalls = calls.filter((c) => c.url.endsWith('/complete'));
    expect(completeCalls).toHaveLength(3);
    expect((completeCalls[0]!.body as { keepBars: number[]; samples: number }).keepBars).toEqual([0, 1, 2, 3]);
    expect((completeCalls[0]!.body as { samples: number }).samples).toBe(4);
    const reloaded = JSON.parse(readFileSync(join(dir, `${a.id}.json`), 'utf8')) as typeof a;
    expect(reloaded.alternatives.every((x) => x.completed)).toBe(true);

    const tooFast = await fetch(`${url}/api/hum/song`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ analysisId: a.id, alternative: 0, genre: 'edm' }) });
    expect(tooFast.status).toBe(400);
    expect(((await tooFast.json()) as { message: string }).message).toMatch(/70 bpm; edm songs are 115-150 bpm/u);

    const song = await fetch(`${url}/api/hum/song`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ analysisId: a.id, alternative: 0, genre: 'ballad' }) });
    expect(song.status).toBe(201);
    const { songId } = (await song.json()) as { songId: string };
    const stored = store.get(songId)!;
    expect(stored.song.key).toBe('Em');
    const chorus = stored.song.songStructure.find((s) => s.name.startsWith('chorus'))!;
    expect(chorus.bars[0]!.chords[0]).toBe(a.alternatives[0]!.chords[0]);
  });

  describe('with edits', () => {
    const post = (path: string, body: unknown) => fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const analyse = async () => {
      const res = await fetch(`${url}/api/hum/analyse?mode=free`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: new Uint8Array([1, 2, 3]) });
      return (await res.json()) as { id: string; alternatives: { chords: string[]; melody: { beat: number; midi: number; duration: number }[] }[] };
    };
    const edited = [
      { beat: 0, midi: 64, duration: 2 },
      { beat: 2, midi: 67, duration: 2 },
      { beat: 20, midi: 71, duration: 4 },
    ];
    const chords = Array.from({ length: 16 }, (_, i) => (i % 2 ? 'C' : 'Em'));

    it('makes the song from the edited melody and chords', async () => {
      const a = await analyse();
      const res = await post('/api/hum/song', { analysisId: a.id, alternative: 1, genre: 'ballad', melody: edited, chords });
      expect(res.status).toBe(201);
      const { songId } = (await res.json()) as { songId: string };
      const stored = store.get(songId)!;
      const chorus = stored.song.songStructure.find((s) => s.name.startsWith('chorus'))!;
      expect(chorus.bars[0]!.chords[0]).toBe('Em');
    });

    it('refuses half an edit, an unknown chord and an empty melody', async () => {
      const a = await analyse();
      expect((await post('/api/hum/song', { analysisId: a.id, alternative: 0, genre: 'ballad', melody: edited })).status).toBe(400);
      const badChord = await post('/api/hum/song', { analysisId: a.id, alternative: 0, genre: 'ballad', melody: edited, chords: ['Cxyz', ...chords.slice(1)] });
      expect(badChord.status).toBe(400);
      const empty = await post('/api/hum/song', { analysisId: a.id, alternative: 0, genre: 'ballad', melody: [], chords });
      expect(empty.status).toBe(400);
      expect(((await empty.json()) as { error: string }).error).toBe('empty_melody');
    });

    it('completes only the bars that are not kept, over the chords sent', async () => {
      const a = await analyse();
      const res = await post('/api/hum/complete', { analysisId: a.id, alternative: 2, melody: edited, chords, keepBars: [0, 5] });
      expect(res.status).toBe(200);
      const call = calls.filter((c) => c.url.endsWith('/complete'))[0]!.body as { keepBars: number[]; prompt: unknown[]; chords: { midi: number[] }[] };
      expect(call.keepBars).toEqual([0, 5]);
      expect(call.prompt).toEqual(edited);
      expect(call.chords[0]!.midi[0]! % 12).toBe(4); // Em: root E
      const after = (await res.json()) as typeof a;
      const mel = after.alternatives[2]!.melody;
      expect(mel.filter((n) => n.beat < 4)).toEqual(edited.slice(0, 2));
      expect(mel.filter((n) => n.beat >= 20 && n.beat < 24)).toEqual([edited[2]]);
      expect(mel.some((n) => n.beat >= 4 && n.beat < 20)).toBe(true);
      expect(after.alternatives[2]!.chords).toEqual(chords);
      // The stored version stays as Casperaki made it ("Back to the original", and a song without edits, use it).
      const stored = JSON.parse(readFileSync(join(dir, `${a.id}.json`), 'utf8')) as typeof a;
      expect(stored.alternatives[2]).toEqual(a.alternatives[2]);
      for (let i = 1; i < mel.length; i++) expect(mel[i - 1]!.beat + mel[i - 1]!.duration).toBeLessThanOrEqual(mel[i]!.beat);
    });

    it('refuses to complete when every bar is kept or no kept bar has a note', async () => {
      const a = await analyse();
      const all = await post('/api/hum/complete', { analysisId: a.id, alternative: 0, melody: edited, chords, keepBars: [0, 1, 2, 3, 4, 5, 6, 7] });
      expect(all.status).toBe(400);
      expect(((await all.json()) as { error: string }).error).toBe('nothing_to_complete');
      const none = await post('/api/hum/complete', { analysisId: a.id, alternative: 0, melody: edited, chords, keepBars: [3] });
      expect(none.status).toBe(400);
      expect(((await none.json()) as { error: string }).error).toBe('empty_melody');
    });

    it('re-fits chords and ranks the chords for one half bar', async () => {
      const a = await analyse();
      const refit = await post('/api/hum/refit', { analysisId: a.id, melody: edited });
      expect(refit.status).toBe(200);
      expect(((await refit.json()) as { chords: string[] }).chords).toHaveLength(16);
      const opts = await post('/api/hum/chord-options', { analysisId: a.id, melody: edited, slot: 3 });
      expect(opts.status).toBe(200);
      const { options } = (await opts.json()) as { options: { chord: string; fit: number }[] };
      expect(options.length).toBeGreaterThan(20);
      for (let i = 1; i < options.length; i++) expect(options[i - 1]!.fit).toBeGreaterThanOrEqual(options[i]!.fit);
      expect((await post('/api/hum/chord-options', { analysisId: a.id, melody: edited, slot: 16 })).status).toBe(400);
    });
  });

  it('names the click-mode inputs and the missing settings', async () => {
    const bad = await fetch(`${url}/api/hum/analyse?mode=click&bpm=100`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: new Uint8Array([1]) });
    expect(bad.status).toBe(400);
    const ok = await fetch(`${url}/api/hum/analyse?mode=click&bpm=100&firstBeatSec=0.6`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: new Uint8Array([1]) });
    expect(ok.status).toBe(200);
    expect(calls[0]!.body).toEqual({ mode: 'click', bpm: '100', firstBeatSec: '0.6' });
    expect(((await ok.json()) as { bpm: number }).bpm).toBe(100);

    const app = express();
    app.use(createHumRouter({ humServiceUrl: undefined, amtServiceUrl: undefined, humLabDir: dir, store }));
    const server = await new Promise<ReturnType<typeof app.listen>>((r) => {
      const s = app.listen(0, '127.0.0.1', () => r(s));
    });
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/hum/analyse?mode=free`, { method: 'POST', body: new Uint8Array([1]) });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { message: string }).message).toMatch(/HUM_SERVICE_URL/u);
    await new Promise<void>((r) => server.close(() => r()));
  });
});
