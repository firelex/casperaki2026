// Music videos: the song → VideoInput adapter, and the routes with a fake
// planner and renderer (no language model, no headless Chrome).

import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { orchestrate } from '@casperaki/arrangement';
import type { ConsoleRenderRequest, RenderRequest, ScenePlan } from '@casperaki/video';
import { songVersionKey } from '../src/render/songVersion.js';

import { createApp } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';
import type { RenderService } from '../src/render/renderService.js';
import { openSongsStore, type SongsStore } from '../src/store.js';
import { lyricLines, sectionDisplayName, songToConsoleInput, songToVideoInput } from '../src/video/videoInput.js';
import { VideoService } from '../src/video/videoService.js';
import { settled } from './settled.js';
import type { Express } from 'express';

describe('songToConsoleInput', () => {
  const song = orchestrate({ genre: 'brightPop', key: 'C', bpm: 120, seed: 'console-input-1' });
  const body = {
    binSeconds: 0.5,
    tracks: [{ name: 'Bass', role: 'track' as const, color: '#4a8ae8', bus: 'bass', volumeDb: -6, levels: [0.5, 0.5], clips: [] }],
    master: [0.7, 0.7],
  };
  it('does not depend on the cartoon style\'s genres', () => {
    const noStyle = { ...song, genre: undefined } as unknown as typeof song;
    expect(() => songToVideoInput({ title: 'T', artist: 'A', song: noStyle, audio: { path: '/tmp/x.mp3', durationSeconds: 1 } })).toThrow(/styles/);
    const input = songToConsoleInput({ title: 'T', artist: 'A', song: noStyle, audio: { path: '/tmp/x.mp3', durationSeconds: 1 }, body });
    expect(input.tracks[0]!.name).toBe('Bass');
    expect(input.sections).toEqual(songToVideoInput({ title: 'T', artist: 'A', song, audio: { path: '/tmp/x.mp3', durationSeconds: 1 } }).sections);
  });
});

describe('songToVideoInput', () => {
  const song = orchestrate({ genre: 'brightPop', key: 'C', bpm: 120, seed: 'video-input-1' });
  it('describes the song: sections in seconds and the lead vocal as lyric lines', () => {
    const input = songToVideoInput({ title: 'My song', artist: 'Me', song, audio: { path: '/tmp/x.mp3', durationSeconds: 200 } });
    expect(input.genre).toBe('brightPop');
    expect(input.beatsPerBar).toBe(4);
    expect(input.sections[0]!.startSeconds).toBe(0);
    for (let i = 1; i < input.sections.length; i++) expect(input.sections[i]!.startSeconds).toBe(input.sections[i - 1]!.endSeconds);
    expect(input.sections.map((s) => s.name)).toContain('Verse 1');
    expect(input.lyrics.length).toBeGreaterThan(4);
    for (const l of input.lyrics) {
      expect(l.endSeconds).toBeGreaterThan(l.startSeconds);
      expect(l.text).not.toMatch(/-( |$)/u); // syllables joined into words
    }
  });
  it('joins syllables and names sections', () => {
    expect(sectionDisplayName('preChorus2')).toBe('Pre-chorus 2');
    expect(sectionDisplayName('intro')).toBe('Intro');
    const lines = lyricLines(song);
    expect(lines.some((l) => /[A-Za-z]{4,}/u.test(l.text))).toBe(true);
  });
});

interface Harness { url: string; app: Express; stop: () => Promise<void>; renders: RenderRequest[]; consoleRenders: ConsoleRenderRequest[]; enqueued: unknown[][]; videos: VideoService; store: SongsStore; plannerCalls: number }

/** `exported`: whether the song's mix export already exists (otherwise the fake export finishes on enqueue). */
async function boot(opts: { exported?: boolean; songMix?: (ownerId: string, songId: string) => string | undefined; onExport?: () => void; holdConsole?: Promise<void> } = {}): Promise<Harness> {
  const store: SongsStore = openSongsStore({ path: ':memory:' });
  const dir = mkdtempSync(join(tmpdir(), 'video-spec-'));
  const mix = join(dir, 'out.mp3');
  writeFileSync(mix, 'not really audio');
  const renders: RenderRequest[] = [];
  const consoleRenders: ConsoleRenderRequest[] = [];
  const counters = { planner: 0 };
  const enqueued: unknown[][] = [];
  let exported = opts.exported ?? true;
  const fakeRenders = {
    status: () => (exported ? { songId: 'x', state: 'done', queuedAt: '' } : undefined),
    enqueue: (...args: unknown[]) => {
      enqueued.push(args);
      opts.onExport?.();
      exported = true;
      return { songId: 'x', state: 'done', queuedAt: '' };
    },
    mp3Path: () => mix,
  } as unknown as RenderService;
  const videos = new VideoService({
    config: { videosDir: join(dir, 'videos'), ffmpegBin: 'ffmpeg' },
    store,
    renders: fakeRenders,
    planner: {
      plan: async () => {
        counters.planner++;
        return { shots: [] } as unknown as ScenePlan;
      },
    },
    renderConsoleVideo: async (r) => {
      await opts.holdConsole;
      consoleRenders.push(r);
      r.onProgress?.(0.5);
      writeFileSync(r.outPath, 'console mp4 bytes');
    },
    renderVideo: async (r) => {
      renders.push(r);
      r.onProgress?.(0.5);
      writeFileSync(r.outPath, 'mp4 bytes');
    },
    probeSeconds: async () => 200,
    songMix: opts.songMix ?? (() => undefined),
    standardMixConfig: () => STANDARD_MIX,
  });
  const app = createApp(loadConfig({} as NodeJS.ProcessEnv), { store, videos });
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    app,
    renders,
    consoleRenders,
    enqueued,
    videos,
    store,
    get plannerCalls() {
      return counters.planner;
    },
    stop: () => new Promise<void>((resolve) => server.close(() => { store.close(); resolve(); })),
  };
}

const post = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('music video routes', () => {
  let h: Harness;
  beforeEach(async () => { h = await boot(); });
  afterEach(async () => { await h.stop(); });

  it('makes a video for a song and serves it', async () => {
    const gen = await post(`${h.url}/api/songs/generate`, { genre: 'brightPop', key: 'C', bpm: 120, seed: 'video-route-1' });
    expect(gen.status).toBe(201);
    const { id } = await settled<{ id: string }>(h.url, h.app);
    const bad = await post(`${h.url}/api/songs/${id}/video`, { orientation: 'square', artist: 'Me' });
    expect(bad.status).toBe(400);
    const start = await post(`${h.url}/api/songs/${id}/video`, { orientation: 'portrait', artist: 'Me' });
    expect(start.status).toBe(202);
    let status: { jobs: { cartoon: { portrait?: { state: string; url?: string; error?: string } } } } | undefined;
    for (let i = 0; i < 50; i++) {
      status = (await (await fetch(`${h.url}/api/songs/${id}/video`)).json()) as typeof status;
      if (status!.jobs.cartoon.portrait?.state === 'done' || status!.jobs.cartoon.portrait?.state === 'failed') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(status!.jobs.cartoon.portrait).toMatchObject({ state: 'done', url: `/api/songs/${id}/video/portrait.mp4` });
    expect(h.renders[0]!.orientation).toBe('portrait');
    expect(h.renders[0]!.input.title).toBeTruthy();
    const file = await fetch(`${h.url}/api/songs/${id}/video/portrait.mp4?download=1`);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toContain('video/mp4');
    expect(file.headers.get('content-disposition')).toContain('(music video).mp4');

    // A quick preview is its own job and file (half size), beside the full video.
    const prev = await post(`${h.url}/api/songs/${id}/video`, { orientation: 'portrait', quality: 'preview', artist: 'Me' });
    expect(prev.status).toBe(202);
    let jobs: Record<string, { state: string; url?: string }> = {};
    for (let i = 0; i < 50; i++) {
      jobs = ((await (await fetch(`${h.url}/api/songs/${id}/video`)).json()) as { jobs: { cartoon: typeof jobs } }).jobs.cartoon;
      if (jobs['portrait-preview']?.state === 'done') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(jobs['portrait-preview']).toMatchObject({ state: 'done', url: `/api/songs/${id}/video/portrait-preview.mp4` });
    expect(jobs['portrait']?.state).toBe('done');
    expect(h.renders[1]!.quality).toBe('preview');
    expect(h.renders[1]!.orientation).toBe('portrait');
    expect((await fetch(`${h.url}/api/songs/${id}/video/landscape.mp4`)).status).toBe(404);
    expect((await post(`${h.url}/api/songs/0000000000000000/video`, { orientation: 'portrait', artist: 'Me' })).status).toBe(404);
  });
});

describe('music video export', () => {
  it("exports the song with its Pro-mode mix", async () => {
    const h = await boot({ exported: false, songMix: () => '{"pro":true}' });
    try {
      await post(`${h.url}/api/songs/generate`, { genre: 'brightPop', key: 'C', bpm: 120, seed: 'video-pro-mix' });
      const { id } = await settled<{ id: string }>(h.url, h.app);
      expect((await post(`${h.url}/api/songs/${id}/video`, { orientation: 'landscape', artist: 'Me' })).status).toBe(202);
      for (let i = 0; i < 50 && h.renders.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
      expect(h.enqueued).toHaveLength(1);
      expect(h.enqueued[0]![0]).toBe(id);
      expect(h.enqueued[0]![2]).toBe('{"pro":true}');
    } finally {
      await h.stop();
    }
  });
});

// The console style: the browser sends the tracks it measured (levels per bin, automation, clips); the brain adds the
// song's timing and audio. The fake export's audio is 200 s long, so 400 bins of 0.5 s cover it.
const STANDARD_MIX = '{"standard":true}';
const consoleBody = (versionKey: string, bins = 400) => ({
  versionKey,
  binSeconds: 0.5,
  tracks: [
    { name: 'Bass', role: 'track', color: '#4a8ae8', bus: 'bass', volumeDb: -6, levels: Array.from({ length: bins }, () => 0.5), clips: [] },
    { name: 'Riser', role: 'effects', bus: 'fx', volumeDb: null, levels: Array.from({ length: bins }, (_, i) => (i > 100 ? 0.3 : 0)), clips: [] },
  ],
  master: Array.from({ length: bins }, () => 0.7),
});

async function waitFor<T>(h: Harness, id: string, pick: (jobs: Record<string, Record<string, { state: string; url?: string; error?: string }>>) => T | undefined): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const body = (await (await fetch(`${h.url}/api/songs/${id}/video`)).json()) as { jobs: Record<string, Record<string, { state: string }>> };
    const v = pick(body.jobs);
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out waiting for the video job');
}
const finished = (j: { state: string } | undefined) => (j && (j.state === 'done' || j.state === 'failed') ? j : undefined);

async function songOf(h: Harness, genre = 'brightPop'): Promise<{ id: string; key: string }> {
  expect((await post(`${h.url}/api/songs/generate`, { genre, key: 'C', bpm: 120, seed: `console-${genre}` })).status).toBe(201);
  const { id } = await settled<{ id: string }>(h.url, h.app);
  return { id, key: songVersionKey(h.store.get(id)!.canonical, STANDARD_MIX) };
}

describe('console music videos', () => {
  let h: Harness;
  beforeEach(async () => { h = await boot(); });
  afterEach(async () => { await h.stop(); });

  it("renders with the measured tracks and the song's timing, without the planner", async () => {
    const { id, key } = await songOf(h);
    const start = await post(`${h.url}/api/songs/${id}/video`, { style: 'console', orientation: 'landscape', artist: 'Me', console: consoleBody(key) });
    expect(start.status).toBe(202);
    const job = await waitFor(h, id, (j) => finished(j.console?.landscape));
    expect(job).toMatchObject({ state: 'done', url: `/api/songs/${id}/video/console-landscape.mp4` });
    expect(h.plannerCalls).toBe(0);
    const r = h.consoleRenders[0]!;
    expect(r.orientation).toBe('landscape');
    expect(r.input.tracks.map((t) => t.name)).toEqual(['Bass', 'Riser']);
    expect(r.input.artist).toBe('Me');
    expect(r.input.bpm).toBe(120);
    expect(r.input.sections.length).toBeGreaterThan(1);
    expect(r.input.audio.durationSeconds).toBe(200);
    const file = await fetch(`${h.url}/api/songs/${id}/video/console-landscape.mp4?download=1`);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-disposition')).toContain('(console video).mp4');
  });

  it('refuses a stale version key with 409 song_changed', async () => {
    const { id } = await songOf(h);
    const res = await post(`${h.url}/api/songs/${id}/video`, { style: 'console', orientation: 'landscape', artist: 'Me', console: consoleBody('0123456789abcdef') });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'song_changed' });
  });

  it('rejects a console request without console data, and a cartoon request with it', async () => {
    const { id, key } = await songOf(h);
    expect((await post(`${h.url}/api/songs/${id}/video`, { style: 'console', orientation: 'landscape', artist: 'Me' })).status).toBe(400);
    expect((await post(`${h.url}/api/songs/${id}/video`, { orientation: 'landscape', artist: 'Me', console: consoleBody(key) })).status).toBe(400);
  });

  it('fits levels within 2 s of the exported audio to its length', async () => {
    const { id, key } = await songOf(h);
    // 397 bins of 0.5 s = 198.5 s; the export is 200 s (the browser's render and the exported MP3 differ slightly).
    expect((await post(`${h.url}/api/songs/${id}/video`, { style: 'console', orientation: 'landscape', artist: 'Me', console: consoleBody(key, 397) })).status).toBe(202);
    const fitJob = await waitFor(h, id, (j) => finished(j.console?.landscape));
    expect(fitJob).toMatchObject({ state: 'done' });
    const r = h.consoleRenders[0]!;
    expect(r.input.master).toHaveLength(400);
    expect(r.input.tracks[0]!.levels).toHaveLength(400);
    expect(r.input.master.slice(397)).toEqual([0, 0, 0]);
  });

  it('fails the job when the measured levels do not cover the song', async () => {
    const { id, key } = await songOf(h);
    expect((await post(`${h.url}/api/songs/${id}/video`, { style: 'console', orientation: 'landscape', artist: 'Me', console: consoleBody(key, 100) })).status).toBe(202);
    const job = await waitFor(h, id, (j) => finished(j.console?.landscape));
    expect(job.state).toBe('failed');
    expect(job.error).toMatch(/cover/);
  });
});

describe('console music videos: one job at a time', () => {
  it('keeps console and cartoon jobs apart, one job at a time per song', async () => {
    let release!: () => void;
    const h = await boot({ holdConsole: new Promise<void>((r) => { release = r; }) });
    try {
      const { id, key } = await songOf(h);
      expect((await post(`${h.url}/api/songs/${id}/video`, { style: 'console', orientation: 'portrait', artist: 'Me', console: consoleBody(key) })).status).toBe(202);
      const busy = await post(`${h.url}/api/songs/${id}/video`, { orientation: 'portrait', artist: 'Me' });
      expect(busy.status).toBe(409);
      expect(await busy.json()).toMatchObject({ error: 'video_in_progress' });
      release();
      await waitFor(h, id, (j) => finished(j.console?.portrait));
      expect((await post(`${h.url}/api/songs/${id}/video`, { orientation: 'portrait', artist: 'Me' })).status).toBe(202);
      const jobs = await waitFor(h, id, (j) => (finished(j.cartoon?.portrait) ? j : undefined));
      expect(jobs.console!.portrait).toMatchObject({ state: 'done', url: `/api/songs/${id}/video/console-portrait.mp4` });
      expect(jobs.cartoon!.portrait).toMatchObject({ state: 'done', url: `/api/songs/${id}/video/portrait.mp4` });
    } finally {
      await h.stop();
    }
  });
});

describe('console music videos: the song changes during the export', () => {
  it('fails the job with song_changed', async () => {
    let mix: string | undefined;
    const h = await boot({ exported: false, songMix: () => mix, onExport: () => { mix = '{"pro":"changed meanwhile"}'; } });
    try {
      const { id, key } = await songOf(h);
      expect((await post(`${h.url}/api/songs/${id}/video`, { style: 'console', orientation: 'landscape', artist: 'Me', console: consoleBody(key) })).status).toBe(202);
      const job = await waitFor(h, id, (j) => finished(j.console?.landscape));
      expect(job.state).toBe('failed');
      expect(job.error).toMatch(/changed after its tracks were measured/);
      expect(h.consoleRenders).toHaveLength(0);
    } finally {
      await h.stop();
    }
  });
});
