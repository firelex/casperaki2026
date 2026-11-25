// In-browser playback endpoints: lowering, the sample plan, sample slices.
// The emit script and ffmpeg are stand-ins: the "emit" writes a one-lane
// envelope (a bass multisample with two slots, one drum lane), the "ffmpeg"
// writes its arguments into the output file so slicing can be checked.

import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { fakePlayback } from './fakePlayback.js';
import { openSongsStore, type SongsStore } from '../src/store.js';
import { settled } from './settled.js';
import type { Express } from 'express';

interface Harness {
  url: string;
  app: Express;
  store: SongsStore;
  stop: () => Promise<void>;
}

async function boot(probe?: string): Promise<Harness> {
  const store = openSongsStore({ path: ':memory:' });
  const app = createApp(loadConfig({} as NodeJS.ProcessEnv), { store, playback: fakePlayback(probe ? { probe } : {}) });
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

    // A tonal slot is cut at its slice; a drum hit is the whole file.
    const slot = await (await fetch(h.url + pb.samples[0]!.url)).text();
    expect(slot).toContain('-ss 0.500000 -to 4.500000');
    expect(slot).toContain('basses/bass.mp3');
    const drum = await (await fetch(h.url + pb.samples[2]!.url)).text();
    expect(drum).not.toContain('-ss');
    expect((await fetch(h.url + pb.stubs[0]!)).status).toBe(200);
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
