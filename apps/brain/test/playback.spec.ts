// In-browser playback endpoints: lowering, the sample plan, sample slices.
// The emit script and ffmpeg are stand-ins: the "emit" writes a one-lane
// envelope (a bass multisample with two slots, one drum lane), the "ffmpeg"
// writes its arguments into the output file so slicing can be checked.

import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { PlaybackService } from '../src/render/playbackService.js';
import { openSongsStore, type SongsStore } from '../src/store.js';

function fakePlayback(): PlaybackService {
  const dir = mkdtempSync(join(tmpdir(), 'casperaki-playback-test-'));
  const lib = join(dir, 'library');
  mkdirSync(join(lib, 'basses'), { recursive: true });
  mkdirSync(join(lib, 'kicks'), { recursive: true });
  writeFileSync(join(lib, 'basses', 'bass.mp3'), 'mp3');
  writeFileSync(join(lib, 'kicks', 'kick.mp3'), 'mp3');
  const stubs = join(dir, 'stubs');
  mkdirSync(stubs);
  for (const n of ['kick.ogg', 'snare.ogg', 'hat.ogg', 'tone.ogg', 'bass-c2.ogg']) writeFileSync(join(stubs, n), 'ogg');
  const emit = join(dir, 'emit.mjs');
  writeFileSync(
    emit,
    `import { writeFileSync } from 'node:fs';
const o = process.env.OUT_DIR;
writeFileSync(o + '/song.json', JSON.stringify({ song: true }));
writeFileSync(o + '/inst-1.json', JSON.stringify({ id: 1, name: 'Bass', type: 'basses', samples: [{ id: 900 }] }));
writeFileSync(o + '/asset-manifest.json', JSON.stringify({
  Bass: { status: 'resolved', relativePath: 'basses/bass.mp3', multisample: { slots: [
    { status: 'resolved', slot: { id: 900 }, sliceStart: 0.5, sliceEnd: 4.5 },
    { status: 'resolved', slot: { id: 901 }, sliceStart: 4.5, sliceEnd: 8.5 },
  ] } },
  Drums: { lanes: { bassDrum1: { status: 'resolved', relativePath: 'kicks/kick.mp3' } } },
}));
`,
  );
  const ffmpeg = join(dir, 'ffmpeg.sh');
  writeFileSync(ffmpeg, '#!/bin/sh\nfor last; do :; done\necho "$@" > "$last"\n');
  chmodSync(ffmpeg, 0o755);
  return new PlaybackService({
    playbackDir: join(dir, 'playback'),
    sampleCacheDir: join(dir, 'cache'),
    emitScript: emit,
    nodeBin: process.execPath,
    sampleLibraryRoot: lib,
    ffmpegBin: ffmpeg,
    stubSamplesDir: stubs,
  });
}

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
