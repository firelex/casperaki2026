// In-browser playback endpoints: lowering, the sample plan, sample slices.
// The emit script and ffmpeg are stand-ins: the "emit" writes a one-lane
// envelope (a bass multisample with two slots, one drum lane), the "ffmpeg"
// writes its arguments into the output file so slicing can be checked.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyLyricsFirst, orchestrate, wordlessMelodyAsPiano } from '@casperaki/arrangement';
import { canonicalStringifySong, parseSong } from '@casperaki/song-schema';

import { createApp } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { fakePlayback } from './fakePlayback.js';
import { songVersionKey } from '../src/render/songVersion.js';
import { openSongsStore, type SongsStore } from '../src/store.js';
import { settled } from './settled.js';
import type { Express } from 'express';

interface Harness {
  url: string;
  app: Express;
  store: SongsStore;
  stop: () => Promise<void>;
}

async function boot(probe?: string, playback = fakePlayback(probe ? { probe } : {})): Promise<Harness> {
  const store = openSongsStore({ path: ':memory:' });
  const app = createApp(loadConfig({} as NodeJS.ProcessEnv), { store, playback });
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    app,
    store,
    stop: () => new Promise<void>((resolve) => server.close(() => { store.close(); resolve(); })),
  };
}

interface Payload {
  songId: string;
  song: string;
  insts: string[];
  samples: Array<{ key: string; kind: string; url: string }>;
  stubs: string[];
  mixConfig: string;
  versionKey: string;
}

describe('in-browser playback', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await boot();
  });
  afterEach(async () => {
    await h.stop();
  });

  it('serves a saved song: envelope, sample plan and the slices', async () => {
    const gen = await fetch(`${h.url}/api/songs/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ genre: 'edm', key: 'A', bpm: 124, seed: 'playback-spec' }),
    });
    expect(gen.status).toBe(201);
    const { id } = await settled<{ id: string }>(h.url, h.app);
    const res = await fetch(`${h.url}/api/songs/${id}/playback`);
    expect(res.status).toBe(200);
    const pb = (await res.json()) as Payload;
    expect(pb.songId).toBe(id);
    expect(JSON.parse(pb.song)).toEqual({ song: true });
    expect(pb.insts).toHaveLength(1);
    expect(pb.samples.map((s) => [s.key, s.kind])).toEqual([
      ['900', 'tonal'],
      ['901', 'tonal'],
      ['bassDrum1', 'drum'],
    ]);
    expect(pb.stubs).toHaveLength(5);
    // The version the browser measures: the saved song text and the mix config it plays with.
    const stored = h.store.get(id)!;
    expect(pb.versionKey).toBe(songVersionKey(stored.canonical, pb.mixConfig));

    // A tonal slot is cut at its slice; a drum hit is the whole file.
    const slot = await (await fetch(h.url + pb.samples[0]!.url)).text();
    expect(slot).toContain('-ss 0.500000 -to 4.500000');
    expect(slot).toContain('basses/bass.mp3');
    const drum = await (await fetch(h.url + pb.samples[2]!.url)).text();
    expect(drum).not.toContain('-ss');
    expect((await fetch(h.url + pb.stubs[0]!)).status).toBe(200);
  });

  it('a library recording changed on disk gets new slice ids, so browsers fetch it again (owner 2026-11-28: a bass fixed in the library)', async () => {
    const svc = fakePlayback();
    const store = openSongsStore({ path: ':memory:' });
    const app = createApp(loadConfig({} as NodeJS.ProcessEnv), { store, playback: svc });
    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => { const x = app.listen(0, '127.0.0.1', () => resolve(x)); });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      await fetch(`${url}/api/songs/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ genre: 'edm', key: 'A', bpm: 124, seed: 'playback-spec' }) });
      const { id } = await settled<{ id: string }>(url, app);
      const urls = async () => Object.fromEntries(((await (await fetch(`${url}/api/songs/${id}/playback`)).json()) as Payload).samples.map((x) => [x.key, x.url]));
      const before = await urls();
      const lib = (svc as unknown as { config: { sampleLibraryRoot: string } }).config.sampleLibraryRoot;
      writeFileSync(join(lib, 'basses', 'bass.mp3'), 'mp3, fixed');
      const after = await urls();
      expect(after['900']).not.toBe(before['900']);
      expect(after['901']).not.toBe(before['901']);
      expect(after.bassDrum1).toBe(before.bassDrum1);
    } finally {
      await new Promise<void>((r) => server.close(() => { store.close(); r(); }));
    }
  });

  it('plays a pitch the recording does not reach as the highest recorded one, resampled up', async () => {
    await h.stop();
    h = await boot('4.48'); // the recording stops at 4.48 s: slot 901 (d#2, from 4.5 s) was never recorded
    const gen = await fetch(`${h.url}/api/songs/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ genre: 'edm', key: 'A', bpm: 124, seed: 'playback-spec-short' }),
    });
    expect(gen.status).toBe(201);
    const { id } = await settled<{ id: string }>(h.url, h.app);
    const pb = (await (await fetch(`${h.url}/api/songs/${id}/playback`)).json()) as Payload;
    const [c2, dSharp2] = [pb.samples[0]!, pb.samples[1]!];
    expect(dSharp2.url).not.toBe(c2.url);
    const shifted = await (await fetch(h.url + dSharp2.url)).text();
    // c2's slice, played 3 semitones faster (sample rate x 2^(3/12)).
    expect(shifted).toContain('atrim=start=0.500000:end=4.500000');
    expect(shifted).toContain(`asetrate=${(4.48 * 2 ** (3 / 12)).toFixed(3)},aresample=4.48`);
  });

  it('plays an unsaved song posted by the editor, and rejects unknown samples', async () => {
    const gen = await fetch(`${h.url}/api/songs/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ genre: 'edm', key: 'A', bpm: 124, seed: 'playback-spec-2' }),
    });
    const { song } = (await gen.json()) as { song: unknown };
    const res = await fetch(`${h.url}/api/playback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ song }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Payload).samples).toHaveLength(3);

    expect((await fetch(`${h.url}/api/playback/samples/${'0'.repeat(24)}.ogg`)).status).toBe(404);
    expect((await fetch(`${h.url}/api/playback/samples/..%2F..%2Fetc.ogg`)).status).toBe(404);
  });

  // Owner 2026-11-28: a melody without lyrics plays on the detail view's piano with the rest of the song.
  it('plays a melody without lyrics on the preview piano, on the Vocal track, and one with lyrics as it is', async () => {
    await h.stop();
    const service = fakePlayback();
    const lowered: string[] = [];
    const envelope = service.envelope.bind(service);
    service.envelope = (id, canonical) => {
      lowered.push(canonical);
      return envelope(id, canonical);
    };
    h = await boot(undefined, service);
    const song = orchestrate({ genre: 'brightPop', key: 'C', bpm: 110, seed: 'playback-piano' });
    const play = async (s: unknown) => {
      const res = await fetch(`${h.url}/api/playback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ song: s }) });
      expect(res.status).toBe(200);
      return (await res.json()) as Payload;
    };
    const piano = await play(song);
    const asPiano = wordlessMelodyAsPiano(parseSong(song));
    expect(asPiano.instrumentDefinitions.find((d) => d.name === 'Vocal')!.lowLevelType).toBe('keysAcousticPiano');
    expect(lowered.at(-1)).toBe(canonicalStringifySong(asPiano, 2));
    // the version is the song's own (the video checks levels against the saved song)
    expect(piano.versionKey).toBe(songVersionKey(canonicalStringifySong(parseSong(song), 2), piano.mixConfig));
    const withWords = applyLyricsFirst(song, {
      verse: ['Met you at the corner store', 'A name I do not know', 'You said it was nothing', 'But I could see it show'],
      chorus: ['Hold me closer in the light', 'We could stay up all the night', 'Every heartbeat feels so right', 'Hold me closer hold me tight'],
    });
    await play(withWords);
    expect(lowered.at(-1)).toBe(canonicalStringifySong(parseSong(withWords), 2));
  });

  it('refuses a saved song the caller does not own', async () => {
    expect((await fetch(`${h.url}/api/songs/${'a'.repeat(16)}/playback`)).status).toBe(404);
  });

  it('fails loudly, naming the file, when a guitar strum recording is missing', async () => {
    const make = async (present: boolean) => {
      const store = openSongsStore({ path: ':memory:' });
      const app = createApp(loadConfig({} as NodeJS.ProcessEnv), { store, playback: fakePlayback({ guitarStrumFile: present }) });
      const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
      });
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      try {
        const gen = await fetch(`${url}/api/songs/generate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ genre: 'rock', key: 'C', bpm: 120, seed: 'playback-guitar' }),
        });
        const { song } = (await gen.json()) as { song: unknown };
        const res = await fetch(`${url}/api/playback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ song }) });
        return { status: res.status, body: await res.text() };
      } finally {
        await new Promise<void>((resolve) => server.close(() => { store.close(); resolve(); }));
      }
    };
    const ok = await make(true);
    expect(ok.status).toBe(200);
    expect(ok.body).toContain('"950"');
    const missing = await make(false);
    expect(missing.status).toBeGreaterThanOrEqual(500);
    expect(missing.body).toContain('Short Strum Down.mp3');
  });
});
