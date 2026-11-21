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

interface Harness {
  url: string;
  store: SongsStore;
  stop: () => Promise<void>;
}

async function boot(): Promise<Harness> {
  const store = openSongsStore({ path: ':memory:' });
  const app = createApp(loadConfig({} as NodeJS.ProcessEnv), { store, playback: fakePlayback() });
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
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
    const { id } = (await gen.json()) as { id: string };
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
});
