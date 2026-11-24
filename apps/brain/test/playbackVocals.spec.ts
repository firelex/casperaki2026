// Playback of songs with sung vocals: takes are served as wave samples; stale or missing takes refuse playback.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SongSchema, type AIArtifact, type Song } from '@casperaki/song-schema';
import { afterAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { openSongsStore } from '../src/store.js';
import { sectionScore, takeFingerprint } from '../src/vocals/score.js';
import { fakePlayback } from './fakePlayback.js';

const GOLDEN = resolve(dirname(fileURLToPath(import.meta.url)), '../../../packages/arrangement/test/fixtures/golden/orchestrate/brightPop/brightPop-vertical-slice.song.json');
const tmp = mkdtempSync(join(tmpdir(), 'playback-vocals-'));
afterAll(() => rmSync(tmp, { recursive: true }));
const takesDir = join(tmp, 'takes');
mkdirSync(takesDir, { recursive: true });

/** The golden with vocals on and a current take for verse1 (a stand-in file at its fingerprint). */
function sungSong(): Song {
  const s: Song = { ...SongSchema.parse(JSON.parse(readFileSync(GOLDEN, 'utf8'))), vocals: { enabled: true, voice: 'en_prompt', takeNumbers: {} } };
  const fp = takeFingerprint(sectionScore(s, 'verse1')!, 'en_prompt', 1);
  writeFileSync(join(takesDir, `${fp}.wav`), 'wav');
  const take: AIArtifact = {
    id: 'vocal-verse1', kind: 'soulx-vocal', modelId: 'soulx-singer', modelVersion: 'steps-32', seed: 1, prompt: 'en_prompt',
    conditioning: { hashes: [fp] }, output: { uri: `vocal-take:${fp}.wav`, sha256: fp, durationSeconds: 9.6 },
    attachedTo: { scope: 'segment', segment: 'verse1', instrument: 'Vocal' },
  };
  return { ...s, aiArtifacts: [take] };
}
/** Only verse1 sung: the other vocal sections are missing, so a song for playing has only verse1 vocal notes. */
function onlyVerse1(s: Song): Song {
  const copy = structuredClone(s);
  for (const seg of copy.songStructure) if (seg.name !== 'verse1') delete copy.arrangement[seg.name]?.overrides?.['Vocal'];
  return copy;
}

async function boot(takeSourceOverride?: string) {
  const store = openSongsStore({ path: ':memory:' });
  const config = loadConfig({ BRAIN_MELODY_EDITS_PATH: join(tmp, 'edits.json'), SOULX_SERVICE_URL: 'http://soulx.test', BRAIN_VOCAL_TAKES_DIR: takesDir } as NodeJS.ProcessEnv);
  const app = createApp(config, { store, playback: fakePlayback({ vocalTakesDir: takesDir, ...(takeSourceOverride ? { takeSourceOverride } : {}) }) });
  const server = await new Promise<ReturnType<typeof app.listen>>((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const play = async (song: Song) => {
    const r = await fetch(`${url}/api/playback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ song }) });
    return { status: r.status, body: (await r.json()) as any };
  };
  return { url, play, stop: () => new Promise<void>((r) => server.close(() => { store.close(); r(); })) };
}

describe('playback with sung vocals', () => {
  it('a current take is a wave sample of the Vocal lane, cut from the take file', async () => {
    const h = await boot();
    const s = onlyVerse1(sungSong());
    const r = await h.play(s);
    expect(r.status).toBe(200);
    const fp = s.aiArtifacts[0]!.conditioning!.hashes![0]!;
    const take = r.body.samples.find((x: { key: string }) => x.key === `take-${fp}.wav`);
    expect(take).toMatchObject({ kind: 'wave' });
    const ogg = await fetch(h.url + take.url);
    expect(ogg.status).toBe(200);
    // The stand-in ffmpeg writes its arguments: the source is the take file.
    expect(await ogg.text()).toContain(join(takesDir, `${fp}.wav`));
    await h.stop();
  });

  it('a stale or missing take refuses playback, naming the sections', async () => {
    const h = await boot();
    const stale = { ...onlyVerse1(sungSong()), bpm: 140 };
    const r = await h.play(stale);
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: 'vocals_need_singing', sections: ['verse1'] });
    const missing = await h.play(sungSong());
    expect(missing.status).toBe(409);
    expect(missing.body.sections).not.toContain('verse1');
    expect(missing.body.sections.length).toBeGreaterThan(0);
    await h.stop();
  });

  it('a take file outside the takes directory is refused', async () => {
    const h = await boot('/etc/hostname');
    const r = await h.play(onlyVerse1(sungSong()));
    expect(r.status).toBe(500);
    expect(r.body.message).toMatch(/outside the vocal takes directory/);
    await h.stop();
  });

  it('vocals off: no take samples', async () => {
    const h = await boot();
    const s = { ...onlyVerse1(sungSong()), vocals: { enabled: false, voice: 'en_prompt', takeNumbers: {} } };
    const r = await h.play(s);
    expect(r.status).toBe(200);
    expect(r.body.samples.some((x: { key: string }) => x.key.startsWith('take-'))).toBe(false);
    await h.stop();
  });
});

describe('server render with sung vocals', () => {
  it('a saved song whose vocals are not sung as it is now is refused (409), not rendered without them', async () => {
    const store = openSongsStore({ path: ':memory:' });
    const config = loadConfig({ BRAIN_MELODY_EDITS_PATH: join(tmp, 'edits.json'), SOULX_SERVICE_URL: 'http://soulx.test', BRAIN_VOCAL_TAKES_DIR: takesDir } as NodeJS.ProcessEnv);
    let enqueued = 0;
    const renders = { enqueue: () => { enqueued++; }, status: () => undefined } as unknown as import('../src/render/renderService.js').RenderService;
    const app = createApp(config, { store, renders });
    const server = await new Promise<ReturnType<typeof app.listen>>((r) => {
      const s = app.listen(0, '127.0.0.1', () => r(s));
    });
    const song = { ...onlyVerse1(sungSong()), bpm: 141 };
    const { canonicalStringifySong } = await import('@casperaki/song-schema');
    const canonical = canonicalStringifySong(song, 2);
    store.put({ id: 'abcdef0123456789', song, canonical, hash: 'h', createdAt: '2026-11-24T00:00:00Z' });
    store.upsertProject({ ownerId: 'local-dev', songId: 'abcdef0123456789', title: 'T', createdAt: '2026-11-24T00:00:00Z', updatedAt: '2026-11-24T00:00:00Z' });
    const r = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/songs/abcdef0123456789/render`, { method: 'POST' });
    const body = (await r.json()) as { error: string; message: string };
    expect(r.status).toBe(409);
    expect(body.error).toBe('vocals_need_singing');
    expect(body.message).toMatch(/Open the song and play it/);
    expect(enqueued).toBe(0);
    await new Promise<void>((res) => server.close(() => { store.close(); res(); }));
  });
});
