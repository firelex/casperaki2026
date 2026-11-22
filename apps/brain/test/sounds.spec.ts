// Public sound catalog: families, search, items (public fields only), previews.
// Uses the committed catalog, an in-memory store and the stand-in playback service.

import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { openSongsStore, type SongsStore } from '../src/store.js';
import { fakePlayback } from './fakePlayback.js';

interface Harness { url: string; store: SongsStore; stop: () => Promise<void> }

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

const PRIVATE = ['library', 'preset', 'matchedPath', 'matchedRule', 'sourceSheet', 'sourceRow', 'info', 'addPlugins', 'legacyReplacement'];

describe('sounds', () => {
  let h: Harness;
  beforeAll(async () => { h = await boot(); });
  afterAll(async () => { await h.stop(); });
  const get = async (path: string) => {
    const r = await fetch(h.url + path);
    return { status: r.status, body: (await r.json()) as any };
  };

  it('lists the families in display order with counts', async () => {
    const { body } = await get('/api/sounds/families');
    const ids = body.families.map((f: { id: string }) => f.id);
    expect(ids.slice(0, 2)).toEqual(['keys', 'synths']);
    expect(ids).toContain('percussionLoops');
    expect(ids).not.toContain('vocals');
    expect(body.families.find((f: { id: string }) => f.id === 'kickDrums')).toMatchObject({ label: 'Kicks', group: 'Drum hits' });
    expect(body.families.every((f: { count: number }) => f.count > 0)).toBe(true);
  });

  it('pages a family and filters by text and style', async () => {
    const a = await get('/api/sounds?family=keys&limit=10');
    expect(a.body.items).toHaveLength(10);
    expect(a.body.nextCursor).toBe(10);
    const b = await get(`/api/sounds?family=keys&limit=10&cursor=10`);
    expect(b.body.items[0].id).not.toBe(a.body.items[0].id);
    expect(a.body.total).toBe(b.body.total);
    const name = a.body.items[0].name as string;
    const q = await get(`/api/sounds?q=${encodeURIComponent(name)}`);
    expect(q.body.items.some((i: { id: string }) => i.id === a.body.items[0].id)).toBe(true);
    const s = await get('/api/sounds?family=percussionLoops&style=latin&limit=5');
    expect(s.body.items.every((i: { styles: string[] }) => i.styles.includes('latin'))).toBe(true);
    expect((await get('/api/sounds?family=nope')).status).toBe(400);
  });

  it('serves items with public fields only and readable types', async () => {
    const { body } = await get('/api/sounds?family=keys&limit=100');
    for (const item of body.items) for (const k of PRIVATE) expect(item).not.toHaveProperty(k);
    const one = await get(`/api/sounds/${body.items[0].id}`);
    expect(one.body).toEqual(body.items[0]);
    expect(body.items.some((i: { type: string }) => i.type === 'Acoustic piano')).toBe(true);
    expect((await get('/api/sounds/deadbeefdeadbeef')).status).toBe(404);
  });

  it('marks tonal sounds the generator uses as pattern previews, hits and loops as audio', async () => {
    const keys = (await get('/api/sounds?family=keys&limit=100')).body.items as Array<{ preview: string }>;
    expect(keys.some((i) => i.preview === 'pattern')).toBe(true);
    const kicks = (await get('/api/sounds?family=kickDrums&limit=100')).body.items as Array<{ preview: string }>;
    expect(kicks.every((i) => i.preview === 'audio')).toBe(true);
  });

  it('previews a tonal sound as a pattern played by it alone, and refuses the wrong kind', async () => {
    const keys = (await get('/api/sounds?family=keys&limit=100')).body.items as Array<{ id: string; preview: string }>;
    const k = keys.find((i) => i.preview === 'pattern')!;
    const r = await fetch(`${h.url}/api/sounds/${k.id}/preview`, { method: 'POST' });
    expect(r.status).toBe(200);
    const p = (await r.json()) as { song: string; bars: number; bpm: number; samples: unknown[] };
    expect(p.bars).toBe(4);
    expect(p.bpm).toBeGreaterThan(40);
    const kick = (await get('/api/sounds?family=kickDrums&limit=1')).body.items[0];
    expect((await fetch(`${h.url}/api/sounds/${kick.id}/preview`, { method: 'POST' })).status).toBe(409);
    expect((await fetch(`${h.url}/api/sounds/${k.id}/audio`)).status).toBe(409);
  });

  it('answers a missing audio file without naming it', async () => {
    const kick = (await get('/api/sounds?family=kickDrums&limit=1')).body.items[0];
    const r = await fetch(`${h.url}/api/sounds/${kick.id}/audio`);
    // The stand-in library has no drum files.
    expect(r.status).toBe(404);
    const body = (await r.json()) as { message: string };
    expect(body.message).toMatch(/missing from the library/);
    expect(body.message).not.toMatch(/\.mp3|\.wav|\//);
  });
});

describe('diskPathOf', () => {
  it('translates the folders the disk names differently', async () => {
    const { diskPathOf } = await import('../src/sounds/soundCatalog.js');
    expect(diskPathOf('percussionLoops/percussionLoopsElectronic_120-150bpm/percussionLoops - percussionLoopsElectronic_120-150bpm - edm - x.mp3')).toBe(
      'percussionLoops/percussionLoopsElectronic_120-160bpm/percussionLoops - percussionLoopsElectronic_120-160bpm - edm - x.mp3',
    );
    expect(diskPathOf('fx/fx8bitArcade/fx - fx8bitArcade - 8bit - y.mp3')).toBe('fx/fxOther/fx - fxOther - 8bit - y.mp3');
    expect(diskPathOf('keys/keysAcousticPiano/z.mp3')).toBe('keys/keysAcousticPiano/z.mp3');
  });
});
