// Music videos: the song → VideoInput adapter, and the routes with a fake
// planner and renderer (no language model, no headless Chrome).

import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { orchestrate } from '@casperaki/arrangement';
import type { RenderRequest, ScenePlan } from '@casperaki/video';

import { createApp } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';
import type { RenderService } from '../src/render/renderService.js';
import { openSongsStore, type SongsStore } from '../src/store.js';
import { lyricLines, sectionDisplayName, songToVideoInput } from '../src/video/videoInput.js';
import { VideoService } from '../src/video/videoService.js';
import { fakeLyricModel } from './fakeLyricModel.js';

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

interface Harness { url: string; stop: () => Promise<void>; renders: RenderRequest[] }

async function boot(): Promise<Harness> {
  const store: SongsStore = openSongsStore({ path: ':memory:' });
  const dir = mkdtempSync(join(tmpdir(), 'video-spec-'));
  const mix = join(dir, 'out.mp3');
  writeFileSync(mix, 'not really audio');
  const renders: RenderRequest[] = [];
  const fakeRenders = {
    status: () => ({ songId: 'x', state: 'done', queuedAt: '' }),
    enqueue: () => {
      throw new Error('the export is already done in this test');
    },
    mp3Path: () => mix,
  } as unknown as RenderService;
  const videos = new VideoService({
    config: { videosDir: join(dir, 'videos'), ffmpegBin: 'ffmpeg' },
    store,
    renders: fakeRenders,
    planner: { plan: async () => ({ shots: [] }) as unknown as ScenePlan },
    renderVideo: async (r) => {
      renders.push(r);
      r.onProgress?.(0.5);
      writeFileSync(r.outPath, 'mp4 bytes');
    },
    probeSeconds: async () => 200,
  });
  const app = createApp(loadConfig({} as NodeJS.ProcessEnv), { lyricModel: fakeLyricModel(), store, videos });
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    renders,
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
    const { id } = (await gen.json()) as { id: string };
    const bad = await post(`${h.url}/api/songs/${id}/video`, { orientation: 'square', artist: 'Me' });
    expect(bad.status).toBe(400);
    const start = await post(`${h.url}/api/songs/${id}/video`, { orientation: 'portrait', artist: 'Me' });
    expect(start.status).toBe(202);
    let status: { jobs: { portrait?: { state: string; url?: string; error?: string } } } | undefined;
    for (let i = 0; i < 50; i++) {
      status = (await (await fetch(`${h.url}/api/songs/${id}/video`)).json()) as typeof status;
      if (status!.jobs.portrait?.state === 'done' || status!.jobs.portrait?.state === 'failed') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(status!.jobs.portrait).toMatchObject({ state: 'done', url: `/api/songs/${id}/video/portrait.mp4` });
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
      jobs = ((await (await fetch(`${h.url}/api/songs/${id}/video`)).json()) as { jobs: typeof jobs }).jobs;
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
