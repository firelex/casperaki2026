// Projects (per-owner song list, save, rename, delete) and per-song render
// jobs. The render pipeline runs against stand-in executables so the test
// exercises the job lifecycle and file serving without the native engine.

import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { RenderService } from '../src/render/renderService.js';
import { openSongsStore, type SongsStore } from '../src/store.js';
import { fakeLyricModel } from './fakeLyricModel.js';
import { settled } from './settled.js';
import type { Express } from 'express';

interface Harness {
  url: string;
  store: SongsStore;
  stop: () => Promise<void>;
}

/** Stand-in pipeline: the "emit script" writes a marker, the "renderer"
 *  writes a tiny valid WAV, the "ffmpeg" copies its input to its output. */
function fakeRenderService(opts: { failRender?: boolean } = {}): RenderService {
  const dir = mkdtempSync(join(tmpdir(), 'casperaki-render-test-'));
  // Laid out like apps/engine-spike: scripts/<emit> beside node_modules/@casperaki/<pkg>/dist,
  // which the playback service fingerprints to version its lowering cache.
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, 'node_modules', '@casperaki', 'engine-adapter', 'dist'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', '@casperaki', 'engine-adapter', 'dist', 'index.js'), 'export {};\n');
  const emit = join(dir, 'scripts', 'emit.mjs');
  writeFileSync(
    emit,
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.OUT_DIR + '/song.json', '{}');\n`,
  );
  const bin = join(dir, 'render.sh');
  writeFileSync(
    bin,
    opts.failRender
      ? '#!/bin/sh\necho "boom: no samples" >&2\nexit 3\n'
      : `#!/bin/sh\nnode -e "
const b=Buffer.alloc(44+800);b.write('RIFF',0);b.writeUInt32LE(36+800,4);b.write('WAVE',8);b.write('fmt ',12);
b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(8000,24);b.writeUInt32LE(16000,28);
b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(800,40);
for(let i=0;i<400;i++)b.writeInt16LE(Math.round(8000*Math.sin(i/5)),44+i*2);require('fs').writeFileSync(process.argv[1],b)" "$2"\n`,
  );
  chmodSync(bin, 0o755);
  const ffmpeg = join(dir, 'ffmpeg.sh');
  // args: -y -hide_banner -loglevel error -i <in> ... <out>
  writeFileSync(ffmpeg, '#!/bin/sh\nfor last; do :; done\ncp "$6" "$last"\n');
  chmodSync(ffmpeg, 0o755);
  // stand-in matchering: <in> <out> <style> -> copies in to out
  const matchering = join(dir, 'matchering.sh');
  writeFileSync(matchering, '#!/bin/sh\n[ "$3" = sergree ] || exit 9\ncp "$1" "$2"\n');
  chmodSync(matchering, 0o755);
  return new RenderService({
    masteringBin: matchering,
    rendersDir: join(dir, 'renders'),
    emitScript: emit,
    renderBin: bin,
    stubSamplesDir: dir,
    sampleLibraryRoot: dir,
    mix: false,
    ffmpegBin: ffmpeg,
    nodeBin: process.execPath,
  });
}

async function boot(renders?: RenderService): Promise<Harness> {
  const store = openSongsStore({ path: ':memory:' });
  const app = createApp(loadConfig({} as NodeJS.ProcessEnv), { lyricModel: fakeLyricModel(), store, ...(renders ? { renders } : {}) });
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    app,
    store,
    stop: () => new Promise<void>((resolve) => server.close(() => { store.close(); resolve(); })),
  };
}

const BODY = { genre: 'edm', key: 'A', bpm: 124, seed: 'projects-spec' } as const;

async function generate(h: Harness, extra: Record<string, unknown> = {}) {
  const res = await fetch(`${h.url}/api/songs/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...BODY, ...extra }),
  });
  expect(res.status).toBe(201);
  return settled<{ id: string; song: Record<string, unknown>; project: { title: string } }>(h.url, h.app);
}

async function waitForRender(h: Harness, id: string): Promise<{ state: string; error?: string; mp3Url?: string; wavUrl?: string; unmasteredMp3Url?: string; unmasteredWavUrl?: string }> {
  for (let i = 0; i < 200; i++) {
    const r = (await (await fetch(`${h.url}/api/songs/${id}/render`)).json()) as { state: string };
    if (r.state === 'done' || r.state === 'failed') return r;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error('render did not finish');
}

describe('projects', () => {
  let h: Harness;
  beforeEach(async () => { h = await boot(); });
  afterEach(async () => { await h.stop(); });

  it('lists generated songs with a default title', async () => {
    const { id, project } = await generate(h);
    expect(project.title).toBe('Edm in A');
    const list = (await (await fetch(`${h.url}/api/songs`)).json()) as { projects: Array<{ id: string; genre: string; bpm: number; render: { state: string } }> };
    expect(list.projects).toHaveLength(1);
    expect(list.projects[0]).toMatchObject({ id, genre: 'edm', bpm: 124, render: { state: 'none' } });
  });

  it('lists each song with its section outline', async () => {
    const { song } = await generate(h);
    const list = (await (await fetch(`${h.url}/api/songs`)).json()) as {
      projects: Array<{ sections: Array<{ name: string; type: string | null; bars: number }> }>;
    };
    const structure = (song as { songStructure: Array<{ name: string; bars: unknown[] }> }).songStructure;
    expect(list.projects[0]!.sections.map((s) => s.name)).toEqual(structure.map((s) => s.name));
    for (const s of list.projects[0]!.sections) expect(s.bars).toBeGreaterThan(0);
  });

  it('accepts a title and rejects a blank one', async () => {
    const { project } = await generate(h, { title: 'Night drive' });
    expect(project.title).toBe('Night drive');
    const bad = await fetch(`${h.url}/api/songs/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...BODY, title: '   ' }),
    });
    expect(bad.status).toBe(400);
  });

  it('renames and deletes', async () => {
    const { id } = await generate(h);
    const renamed = await fetch(`${h.url}/api/songs/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Renamed' }),
    });
    expect(((await renamed.json()) as { project: { title: string } }).project.title).toBe('Renamed');
    expect((await fetch(`${h.url}/api/songs/${id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await fetch(`${h.url}/api/songs/${id}`)).status).toBe(404);
    const list = (await (await fetch(`${h.url}/api/songs`)).json()) as { projects: unknown[] };
    expect(list.projects).toHaveLength(0);
  });

  it('saves an edit under a new content id and moves the project', async () => {
    const { id, song } = await generate(h, { title: 'Keep me' });
    const edited = { ...song, bpm: 126 };
    const res = await fetch(`${h.url}/api/songs/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ song: edited }),
    });
    expect(res.status).toBe(200);
    const saved = (await res.json()) as { id: string; song: { bpm: number }; project: { title: string } };
    expect(saved.id).not.toBe(id);
    expect(saved.song.bpm).toBe(126);
    expect(saved.project.title).toBe('Keep me');
    expect((await fetch(`${h.url}/api/songs/${id}`)).status).toBe(404);
    expect((await fetch(`${h.url}/api/songs/${saved.id}`)).status).toBe(200);
  });

  it('rejects saving an invalid song', async () => {
    const { id } = await generate(h);
    const res = await fetch(`${h.url}/api/songs/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ song: { nope: true } }),
    });
    expect(res.status).toBe(400);
  });

  it('answers 503 for render routes when rendering is not configured', async () => {
    const { id } = await generate(h);
    const res = await fetch(`${h.url}/api/songs/${id}/render`, { method: 'POST' });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe('render_not_configured');
  });

  it('answers JSON 404 for unknown /api routes', async () => {
    const res = await fetch(`${h.url}/api/nope`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });
});

describe('per-song render', () => {
  it('runs the pipeline and serves mp3, wav and peaks', async () => {
    const h = await boot(fakeRenderService());
    try {
      const { id } = await generate(h);
      expect((await fetch(`${h.url}/api/songs/${id}/render.mp3`)).status).toBe(404);
      const start = await fetch(`${h.url}/api/songs/${id}/render`, { method: 'POST' });
      expect(start.status).toBe(202);
      const done = await waitForRender(h, id);
      expect(done).toMatchObject({ state: 'done', mp3Url: `/api/songs/${id}/render.mp3`, wavUrl: `/api/songs/${id}/render.wav` });
      const wav = await fetch(`${h.url}${done.wavUrl}?download=1`);
      expect(wav.status).toBe(200);
      expect(wav.headers.get('content-disposition')).toContain('Edm-in-A.wav');
      expect((await wav.arrayBuffer()).byteLength).toBe(844);
      expect((await fetch(`${h.url}${done.mp3Url}`)).status).toBe(200);
      expect(done).toMatchObject({
        unmasteredMp3Url: `/api/songs/${id}/render-unmastered.mp3`,
        unmasteredWavUrl: `/api/songs/${id}/render-unmastered.wav`,
      });
      const raw = await fetch(`${h.url}${done.unmasteredWavUrl}?download=1`);
      expect(raw.status).toBe(200);
      expect(raw.headers.get('content-disposition')).toContain('Edm-in-A (unmastered).wav');
      expect((await fetch(`${h.url}${done.unmasteredMp3Url}`)).status).toBe(200);
      const peaks = (await (await fetch(`${h.url}/api/songs/${id}/render/peaks?bins=16`)).json()) as { peaks: number[] };
      expect(peaks.peaks).toHaveLength(16);
      const list = (await (await fetch(`${h.url}/api/songs`)).json()) as { projects: Array<{ render: { state: string } }> };
      expect(list.projects[0]!.render.state).toBe('done');
    } finally {
      await h.stop();
    }
  });

  it('reports a failed render with the renderer output, and allows a retry', async () => {
    const h = await boot(fakeRenderService({ failRender: true }));
    try {
      const { id } = await generate(h);
      await fetch(`${h.url}/api/songs/${id}/render`, { method: 'POST' });
      const failed = await waitForRender(h, id);
      expect(failed.state).toBe('failed');
      expect(failed.error).toContain('boom: no samples');
      const retry = await fetch(`${h.url}/api/songs/${id}/render`, { method: 'POST' });
      expect(['queued', 'running']).toContain(((await retry.json()) as { state: string }).state);
    } finally {
      await h.stop();
    }
  });
});
