// Songs with sung vocals: stored takes are found by fingerprint whenever a song goes to the engine (play, render,
// DAW export), whether or not it records them; sections without a take play no vocal (never refused); takes only
// an old saved version used are deleted when the song is saved again or deleted.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalStringifySong, SongSchema, type Song } from '@casperaki/song-schema';
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

const base = (): Song => ({ ...SongSchema.parse(JSON.parse(readFileSync(GOLDEN, 'utf8'))), vocals: { enabled: true, voice: 'en_prompt', takeNumbers: {} } });
const fpOf = (s: Song, seg = 'verse1') => takeFingerprint(sectionScore(s, seg)!, s.vocals!.voice, s.vocals!.takeNumbers[seg] ?? 1);
/** A stand-in stored take for a section of the song (as the take store writes them). */
function storeTake(s: Song, seg = 'verse1'): string {
  const fp = fpOf(s, seg);
  writeFileSync(join(takesDir, `${fp}.ogg`), 'ogg');
  writeFileSync(join(takesDir, `${fp}.json`), JSON.stringify({ lufs: -17, durationSeconds: 9.6, sha256: fp, voice: s.vocals!.voice }));
  return fp;
}
/** Only verse1 has lead vocal notes. */
function onlyVerse1(s: Song): Song {
  const copy = structuredClone(s);
  for (const seg of copy.songStructure) if (seg.name !== 'verse1') delete copy.arrangement[seg.name]?.overrides?.['Vocal'];
  return copy;
}
const env = () => ({ BRAIN_MELODY_EDITS_PATH: join(tmp, 'edits.json'), SOULX_SERVICE_URL: 'http://soulx.test', BRAIN_VOCAL_TAKES_DIR: takesDir }) as NodeJS.ProcessEnv;

async function boot(deps: Parameters<typeof createApp>[1] extends infer D ? Partial<D> : never = {}, takeSourceOverride?: string) {
  const store = openSongsStore({ path: ':memory:' });
  const app = createApp(loadConfig(env()), { store, playback: fakePlayback({ vocalTakesDir: takesDir, ...(takeSourceOverride ? { takeSourceOverride } : {}) }), ...deps });
  const server = await new Promise<ReturnType<typeof app.listen>>((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const req = async (path: string, method = 'GET', body?: unknown) => {
    const r = await fetch(url + path, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
    return { status: r.status, body: r.status === 204 ? undefined : ((await r.json()) as any) };
  };
  const save = (id: string, song: Song) => {
    store.put({ id, song, canonical: canonicalStringifySong(song, 2), hash: id, createdAt: '2026-11-24T00:00:00Z' });
    store.upsertProject({ ownerId: 'local-dev', songId: id, title: 'T', createdAt: '2026-11-24T00:00:00Z', updatedAt: '2026-11-24T00:00:00Z' });
  };
  return { url, req, save, store, stop: () => new Promise<void>((r) => server.close(() => { store.close(); r(); })) };
}

describe('playback with sung vocals', () => {
  it('a stored take is found by fingerprint and played (not recorded on the song), cut from the take file', async () => {
    const h = await boot();
    const s = onlyVerse1(base());
    const fp = storeTake(s);
    expect(s.aiArtifacts.some((a) => a.kind === 'soulx-vocal')).toBe(false);
    const r = await h.req('/api/playback', 'POST', { song: s });
    expect(r.status).toBe(200);
    const take = r.body.samples.find((x: { key: string }) => x.key === `take-${fp}.ogg`);
    expect(take).toMatchObject({ kind: 'wave' });
    const ogg = await fetch(h.url + take.url);
    expect(ogg.status).toBe(200);
    expect(await ogg.text()).toContain(join(takesDir, `${fp}.ogg`));
    await h.stop();
  });

  it('takes play with the Vocals switch off too (it only decides whether Play sings)', async () => {
    const h = await boot();
    const s = onlyVerse1(base());
    const fp = storeTake(s);
    const off = { ...s, vocals: { ...s.vocals!, enabled: false } };
    const r = await h.req('/api/playback', 'POST', { song: off });
    expect(r.body.samples.some((x: { key: string }) => x.key === `take-${fp}.ogg`)).toBe(true);
    await h.stop();
  });

  it('a section without a take plays without a vocal (never refused)', async () => {
    const h = await boot();
    const r = await h.req('/api/playback', 'POST', { song: { ...onlyVerse1(base()), bpm: 151 } });
    expect(r.status).toBe(200);
    expect(r.body.samples.some((x: { key: string }) => x.key.startsWith('take-'))).toBe(false);
    await h.stop();
  });

  it('a take file outside the takes directory is refused', async () => {
    const h = await boot({}, '/etc/hostname');
    const s = onlyVerse1(base());
    storeTake(s);
    const r = await h.req('/api/playback', 'POST', { song: s });
    expect(r.status).toBe(500);
    expect(r.body.message).toMatch(/outside the vocal takes directory/);
    await h.stop();
  });
});

describe('render and DAW export with sung vocals', () => {
  it('a render gets the stored takes, and is made again once a section has been sung', async () => {
    const calls: { canonical: string; takes?: string }[] = [];
    const renders = { enqueue: (_id: string, canonical: string, _mix?: string, takes?: string) => { calls.push({ canonical, takes }); return { songId: 'x', state: 'queued' }; }, status: () => undefined, queuePosition: () => undefined } as never;
    const h = await boot({ renders });
    const s = { ...onlyVerse1(base()), bpm: 133 };
    h.save('abcdef0123456789', s);
    await h.req('/api/songs/abcdef0123456789/render', 'POST');
    const fp = storeTake(s);
    await h.req('/api/songs/abcdef0123456789/render', 'POST');
    expect(calls[0]!.canonical).not.toContain('vocal-take:');
    expect(calls[1]!.canonical).toContain(`vocal-take:${fp}.ogg`);
    expect(calls[1]!.takes).toBe(fp);
    await h.stop();
  });

  it('a DAW export gets the stored takes', async () => {
    let canonical = '';
    const dawExports = { start: (_o: string, song: { canonical: string }) => { canonical = song.canonical; return {}; } } as never;
    const h = await boot({ dawExports });
    const s = { ...onlyVerse1(base()), bpm: 134 };
    h.save('bbcdef0123456789', s);
    const fp = storeTake(s);
    expect((await h.req('/api/songs/bbcdef0123456789/daw-export', 'POST', { format: 'stems', tracks: [] })).status).toBe(202);
    expect(canonical).toContain(`vocal-take:${fp}.ogg`);
    await h.stop();
  });
});

describe('take clean-up', () => {
  it('saving a new version deletes the takes only the old version used; a take another saved song uses stays', async () => {
    const h = await boot();
    const v1 = { ...onlyVerse1(base()), bpm: 120 };
    const other = { ...v1, title: 'copy' };
    const oldFp = storeTake(v1);
    h.save('cccdef0123456789', v1);
    h.save('dddddd0123456789', other); // another saved song singing the same verse1 take
    const v2 = { ...v1, vocals: { ...v1.vocals!, takeNumbers: { verse1: 2 } } };
    const newFp = storeTake(v2);
    expect((await h.req('/api/songs/cccdef0123456789', 'PUT', { song: v2 })).status).toBe(200);
    expect(existsSync(join(takesDir, `${oldFp}.ogg`))).toBe(true); // still used by the copy
    expect((await h.req('/api/songs/dddddd0123456789', 'DELETE')).status).toBe(204);
    expect(existsSync(join(takesDir, `${oldFp}.ogg`))).toBe(false);
    expect(existsSync(join(takesDir, `${oldFp}.json`))).toBe(false);
    expect(existsSync(join(takesDir, `${newFp}.ogg`))).toBe(true); // the saved version's take
    await h.stop();
  });

  it('deleting a song deletes its takes', async () => {
    const h = await boot();
    const s = { ...onlyVerse1(base()), bpm: 121 };
    const fp = storeTake(s);
    h.save('eeedef0123456789', s);
    expect((await h.req('/api/songs/eeedef0123456789', 'DELETE')).status).toBe(204);
    expect(existsSync(join(takesDir, `${fp}.ogg`))).toBe(false);
    await h.stop();
  });
});
