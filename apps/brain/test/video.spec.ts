// Music videos (only the 3D avatar video): the song → AvatarVideoInput adapter, and the routes with a fake renderer
// (no headless Chrome). The browser sends the levels it measured (the master and each track's, with its role); the
// brain adds the song's timing, words and audio, and the avatars.

import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { orchestrate } from '@casperaki/arrangement';
import { parseSong } from '@casperaki/song-schema';
import type { AvatarRenderRequest } from '@casperaki/video';
import { songVersionKey } from '../src/render/songVersion.js';

import { createApp } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';
import type { RenderService } from '../src/render/renderService.js';
import { openSongsStore, type SongsStore } from '../src/store.js';
import { lyricLines, sectionDisplayName, songTiming, songToAvatarInput, type VideoAvatar } from '../src/video/videoInput.js';
import { VideoService } from '../src/video/videoService.js';
import { settled } from './settled.js';
import type { Express } from 'express';

const recipe = { pack: 'drophunter', parts: { body: '0', eyes: 'regulareyes' }, textures: {}, colors: {} };
const track = (name: string, role: string, levels: number[]) => ({ name, role, levels });

describe('songToAvatarInput', () => {
  const song = orchestrate({ genre: 'brightPop', key: 'C', bpm: 120, seed: 'avatar-input-1' });
  const audio = { path: '/tmp/x.mp3', durationSeconds: 1 };
  it('takes the lead vocal level as the loudest lead-vocal strip per bin, the song timing and words, and letters-and-digits ids', () => {
    const levels = { binSeconds: 0.5, tracks: [track('Bass', 'track', [0.9, 0.9]), track('Lead', 'leadVocal', [0.2, 0]), track('Lead 2', 'leadVocal', [0.1, 0.4])], master: [0.7, 0.8] };
    const input = songToAvatarInput({ title: 'T', artist: 'A', song, audio, levels, avatars: [{ id: 'a-0123456789ab', name: 'Kai', recipe, sings: true }] });
    expect(input.voice).toEqual([0.2, 0.4]);
    expect(input.master).toEqual([0.7, 0.8]);
    expect(input.avatars[0]).toMatchObject({ id: 'a0123456789ab', name: 'Kai', sings: true });
    expect(input.lyrics).toEqual(lyricLines(song));
    expect(input.sections).toEqual(songTiming(song).sections);
    expect(input.genre).toBe('brightPop'); // a ballad is danced calmly (the engine's paceOf)
  });
  it('gives a silent voice to a song without lead vocals', () => {
    const levels = { binSeconds: 0.5, tracks: [track('Bass', 'track', [0.9, 0.9])], master: [0.7, 0.8] };
    const input = songToAvatarInput({ title: 'T', artist: 'A', song, audio, levels, avatars: [{ id: 'a-0123456789ab', name: 'Kai', recipe, sings: false }] });
    expect(input.voice).toEqual([0, 0]);
  });
  it('names sections and joins syllables into words, sections back to back', () => {
    expect(sectionDisplayName('preChorus2')).toBe('Pre-chorus 2');
    expect(sectionDisplayName('intro')).toBe('Intro');
    const { sections } = songTiming(song);
    expect(sections[0]!.startSeconds).toBe(0);
    for (let i = 1; i < sections.length; i++) expect(sections[i]!.startSeconds).toBe(sections[i - 1]!.endSeconds);
    const lines = lyricLines(song);
    expect(lines.length).toBeGreaterThan(4);
    for (const l of lines) expect(l.text).not.toMatch(/-( |$)/u);
  });
});

const STANDARD_MIX = '{"standard":true}';

interface Harness { url: string; app: Express; stop: () => Promise<void>; renders: AvatarRenderRequest[]; enqueued: unknown[][]; store: SongsStore }

/** `exported`: whether the song's mix export already exists (otherwise the fake export finishes on enqueue). */
async function boot(opts: { exported?: boolean; songMix?: (ownerId: string, songId: string) => string | undefined; onExport?: () => void; hold?: Promise<void> } = {}): Promise<Harness> {
  const store: SongsStore = openSongsStore({ path: ':memory:' });
  const dir = mkdtempSync(join(tmpdir(), 'video-spec-'));
  const mix = join(dir, 'out.mp3');
  writeFileSync(mix, 'not really audio');
  const renders: AvatarRenderRequest[] = [];
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
    renderAvatarVideo: async (r) => {
      await opts.hold;
      renders.push(r);
      r.onProgress?.(0.5);
      writeFileSync(r.outPath, 'avatars mp4 bytes');
    },
    avatars: { resolve: (_o, _s, ids): VideoAvatar[] => ids.map((id, i) => ({ id, name: `Avatar ${i}`, recipe, sings: i === 0 })), packsDir: '/tmp/packs' },
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
    enqueued,
    store,
    stop: () => new Promise<void>((resolve) => server.close(() => { store.close(); resolve(); })),
  };
}

const post = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// The fake export's audio is 200 s long, so 400 bins of 0.5 s cover it.
const levelsBody = (versionKey: string, bins = 400) => ({
  versionKey,
  binSeconds: 0.5,
  tracks: [track('Bass', 'track', Array.from({ length: bins }, () => 0.5)), track('Vocal', 'leadVocal', Array.from({ length: bins }, (_, i) => (i > 100 ? 0.3 : 0)))],
  master: Array.from({ length: bins }, () => 0.7),
});
const avatars = { avatarIds: ['a-0123456789ab'] };
const request = (key: string, extra: Record<string, unknown> = {}) => ({ orientation: 'landscape', artist: 'Me', levels: levelsBody(key), avatars, ...extra });

type Jobs = Record<string, Record<string, { state: string; url?: string; error?: string }>>;
async function waitFor<T>(h: Harness, id: string, pick: (jobs: Jobs) => T | undefined): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const body = (await (await fetch(`${h.url}/api/songs/${id}/video`)).json()) as { jobs: Jobs };
    const v = pick(body.jobs);
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out waiting for the video job');
}
const finished = (j: { state: string; url?: string; error?: string } | undefined) => (j && (j.state === 'done' || j.state === 'failed') ? j : undefined);

async function songOf(h: Harness, seed = 'video-1'): Promise<{ id: string; key: string }> {
  expect((await post(`${h.url}/api/songs/generate`, { genre: 'brightPop', key: 'C', bpm: 120, seed })).status).toBe(201);
  const { id } = await settled<{ id: string }>(h.url, h.app);
  return { id, key: songVersionKey(h.store.get(id)!.canonical, STANDARD_MIX) };
}

describe('avatar music videos', () => {
  let h: Harness;
  beforeEach(async () => { h = await boot(); });
  afterEach(async () => { await h.stop(); });

  it('makes a video with the measured levels and the song, and serves it; a quick preview is its own file', async () => {
    const { id, key } = await songOf(h);
    expect((await post(`${h.url}/api/songs/${id}/video`, { ...request(key), orientation: 'square' })).status).toBe(400);
    expect((await post(`${h.url}/api/songs/${id}/video`, request(key, { orientation: 'portrait' }))).status).toBe(202);
    const job = await waitFor(h, id, (j) => finished(j.avatars?.portrait));
    expect(job).toMatchObject({ state: 'done', url: `/api/songs/${id}/video/avatars-portrait.mp4` });
    const r = h.renders[0]!;
    expect(r.orientation).toBe('portrait');
    expect(r.input.artist).toBe('Me');
    expect(r.input.bpm).toBe(120);
    expect(r.input.audio.durationSeconds).toBe(200);
    expect(r.input.avatars[0]).toMatchObject({ id: 'a0123456789ab', sings: true });
    const song = parseSong(JSON.parse(h.store.get(id)!.canonical));
    expect(r.input.lyrics).toEqual(lyricLines(song));
    const file = await fetch(`${h.url}/api/songs/${id}/video/avatars-portrait.mp4?download=1`);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toContain('video/mp4');
    expect(file.headers.get('content-disposition')).toContain('(music video).mp4');

    expect((await post(`${h.url}/api/songs/${id}/video`, request(key, { orientation: 'portrait', quality: 'preview' }))).status).toBe(202);
    expect(await waitFor(h, id, (j) => finished(j.avatars?.['portrait-preview']))).toMatchObject({ state: 'done', url: `/api/songs/${id}/video/avatars-portrait-preview.mp4` });
    expect(h.renders[1]!.quality).toBe('preview');
    expect((await fetch(`${h.url}/api/songs/${id}/video/avatars-landscape.mp4`)).status).toBe(404);
    expect((await post(`${h.url}/api/songs/0000000000000000/video`, request(key))).status).toBe(404);
  });

  it('refuses the old styles, naming the only one', async () => {
    const { id, key } = await songOf(h);
    for (const style of ['cartoon', 'console']) {
      const res = await post(`${h.url}/api/songs/${id}/video`, request(key, { style }));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { message: string }).message).toBe('Only the 3D avatar video is made now.');
    }
    expect((await post(`${h.url}/api/songs/${id}/video`, request(key, { style: 'avatars' }))).status).toBe(202);
  });

  it('refuses a request without levels or avatars, or with the console data of old', async () => {
    const { id, key } = await songOf(h);
    const { levels, ...noLevels } = request(key);
    expect((await post(`${h.url}/api/songs/${id}/video`, noLevels)).status).toBe(400);
    expect((await post(`${h.url}/api/songs/${id}/video`, { ...noLevels, console: levels })).status).toBe(400);
    const { avatars: _a, ...noAvatars } = request(key);
    expect((await post(`${h.url}/api/songs/${id}/video`, noAvatars)).status).toBe(400);
  });

  it('refuses a track role it does not know, naming it, rather than leave the singer silent', async () => {
    const { id, key } = await songOf(h);
    const body = levelsBody(key);
    const res = await post(`${h.url}/api/songs/${id}/video`, request(key, { levels: { ...body, tracks: [body.tracks[0], { ...body.tracks[1], role: 'lead' }] } }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toMatch(/levels\.tracks\.1\.role/u);
  });

  it('refuses a stale version key with 409 song_changed', async () => {
    const { id } = await songOf(h);
    const res = await post(`${h.url}/api/songs/${id}/video`, request('0123456789abcdef'));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'song_changed' });
  });

  it('refuses a track whose levels are not as long as the master, naming it', async () => {
    const { id, key } = await songOf(h);
    const body = levelsBody(key);
    const res = await post(`${h.url}/api/songs/${id}/video`, request(key, { levels: { ...body, tracks: [{ ...body.tracks[0], levels: [0.5] }, body.tracks[1]] } }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toMatch(/Bass.*1 levels.*400/u);
  });

  it('fits levels within 2 s of the exported audio to its length', async () => {
    const { id, key } = await songOf(h);
    // 397 bins of 0.5 s = 198.5 s; the export is 200 s (the browser's render and the exported MP3 differ slightly).
    expect((await post(`${h.url}/api/songs/${id}/video`, request(key, { levels: levelsBody(key, 397) }))).status).toBe(202);
    expect(await waitFor(h, id, (j) => finished(j.avatars?.landscape))).toMatchObject({ state: 'done' });
    const r = h.renders[0]!;
    expect(r.input.master).toHaveLength(400);
    expect(r.input.master.slice(397)).toEqual([0, 0, 0]);
  });

  it('fails the job when the measured levels do not cover the song', async () => {
    const { id, key } = await songOf(h);
    expect((await post(`${h.url}/api/songs/${id}/video`, request(key, { levels: levelsBody(key, 100) }))).status).toBe(202);
    const job = await waitFor(h, id, (j) => finished(j.avatars?.landscape));
    expect(job!.state).toBe('failed');
    expect(job!.error).toMatch(/cover/u);
  });
});

describe('avatar music videos: one job at a time', () => {
  it('refuses a second video while one is being made', async () => {
    let release!: () => void;
    const h = await boot({ hold: new Promise<void>((r) => { release = r; }) });
    try {
      const { id, key } = await songOf(h);
      expect((await post(`${h.url}/api/songs/${id}/video`, request(key, { orientation: 'portrait' }))).status).toBe(202);
      const busy = await post(`${h.url}/api/songs/${id}/video`, request(key));
      expect(busy.status).toBe(409);
      expect(await busy.json()).toMatchObject({ error: 'video_in_progress' });
      release();
      await waitFor(h, id, (j) => finished(j.avatars?.portrait));
      expect((await post(`${h.url}/api/songs/${id}/video`, request(key))).status).toBe(202);
    } finally {
      await h.stop();
    }
  });
});

describe('avatar music videos: the export', () => {
  it("exports the song with its Pro-mode mix", async () => {
    const h = await boot({ exported: false, songMix: () => '{"pro":true}' });
    try {
      const { id } = await songOf(h);
      const key = songVersionKey(h.store.get(id)!.canonical, '{"pro":true}');
      expect((await post(`${h.url}/api/songs/${id}/video`, request(key))).status).toBe(202);
      for (let i = 0; i < 50 && h.renders.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
      expect(h.enqueued).toHaveLength(1);
      expect(h.enqueued[0]![0]).toBe(id);
      expect(h.enqueued[0]![2]).toBe('{"pro":true}');
    } finally {
      await h.stop();
    }
  });

  it('fails the job with song_changed when the song changes during the export', async () => {
    let mix: string | undefined;
    const h = await boot({ exported: false, songMix: () => mix, onExport: () => { mix = '{"pro":"changed meanwhile"}'; } });
    try {
      const { id, key } = await songOf(h);
      expect((await post(`${h.url}/api/songs/${id}/video`, request(key))).status).toBe(202);
      const job = await waitFor(h, id, (j) => finished(j.avatars?.landscape));
      expect(job!.state).toBe('failed');
      expect(job!.error).toMatch(/changed after its tracks were measured/u);
      expect(h.renders).toHaveLength(0);
    } finally {
      await h.stop();
    }
  });
});
