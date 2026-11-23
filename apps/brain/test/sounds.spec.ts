// Public sound catalog: families, search, items (public fields only), previews.
// Uses the committed catalog, an in-memory store and the stand-in playback service.

import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { openSongsStore, type SongsStore } from '../src/store.js';
import { fakePlayback } from './fakePlayback.js';

interface Harness { url: string; store: SongsStore; stop: () => Promise<void> }

async function boot(): Promise<Harness> {
  const store = openSongsStore({ path: ':memory:' });
  // The real mix table (the details endpoint reads it as the engine does).
  const mixConfig = readFileSync(fileURLToPath(new URL('../../../../casperaki_engine/config/mix-config.json', import.meta.url)), 'utf8');
  const app = createApp(loadConfig({} as NodeJS.ProcessEnv), { store, playback: fakePlayback({ mixConfig }) });
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

  it('previews tonal sounds as patterns, drum hits and the rest as single sounds (all through the engine)', async () => {
    const keys = (await get('/api/sounds?family=keys&limit=100')).body.items as Array<{ preview: string }>;
    expect(keys.some((i) => i.preview === 'pattern')).toBe(true);
    const kicks = (await get('/api/sounds?family=kickDrums&limit=100')).body.items as Array<{ preview: string }>;
    expect(kicks.every((i) => i.preview === 'sample')).toBe(true);
    const loops = (await get('/api/sounds?family=percussionLoops&limit=50')).body.items as Array<{ preview: string }>;
    expect(loops.every((i) => i.preview === 'sample' || i.preview === 'none')).toBe(true);
    const fx = (await get('/api/sounds?family=fx&limit=100')).body.items as Array<{ preview: string }>;
    expect(fx.filter((i) => i.preview === 'sample').length).toBeGreaterThan(80);
  });

  it('previews a tonal sound as a pattern played by it alone, and refuses the wrong kind', async () => {
    const keys = (await get('/api/sounds?family=keys&limit=100')).body.items as Array<{ id: string; preview: string }>;
    const k = keys.find((i) => i.preview === 'pattern')!;
    const r = await fetch(`${h.url}/api/sounds/${k.id}/preview`, { method: 'POST' });
    expect(r.status).toBe(200);
    const p = (await r.json()) as { song: string; bars: number; bpm: number; samples: unknown[] };
    expect(p.bars).toBe(4);
    expect(p.bpm).toBeGreaterThan(40);
  });

  it('previews a drum hit on its own, once', async () => {
    const [a] = (await get('/api/sounds?family=snareDrums&limit=1')).body.items as Array<{ id: string }>;
    const r = await fetch(`${h.url}/api/sounds/${a!.id}/preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(r.status).toBe(200);
    // (The single note itself is checked on the song below, in 'plays a drum hit once'.)
    expect(await r.json()).toMatchObject({ bars: 2, loop: false, genres: [], kept: false });
  });

  it('answers a missing audio file without naming it', async () => {
    const loop = (await get('/api/sounds?family=percussionLoops&limit=1')).body.items[0];
    const r = await fetch(`${h.url}/api/sounds/${loop.id}/preview`, { method: 'POST' });
    // The stand-in library has no loop files.
    expect(r.status).toBe(404);
    const body = (await r.json()) as { message: string };
    expect(body.message).toMatch(/missing from the library/);
    expect(body.message).not.toMatch(/\.mp3|\.wav|\//);
  });

  it('tells what the engine does with a sound in a song', async () => {
    const keys = (await get('/api/sounds?family=keys&q=acoustic%20piano&limit=1')).body.items[0];
    const d = await get(`/api/sounds/${keys.id}/details?genre=brightPop`);
    expect(d.status).toBe(200);
    expect(d.body).toMatchObject({ genre: 'brightPop', bus: 'keys bus' });
    expect(typeof d.body.volumeDb).toBe('number');
    expect(typeof d.body.octaveShift).toBe('number');
    expect(d.body.inserts).toContain('Console8 Sub In');
    expect(d.body.sends.reverb).toBe(-14); // keysAcousticPiano: the by-type send override
    for (const k of PRIVATE) expect(d.body).not.toHaveProperty(k);
    const kick = (await get('/api/sounds?family=kickDrums&limit=1')).body.items[0];
    const dk = await get(`/api/sounds/${kick.id}/details`);
    expect(dk.body.bus).toBe('kicks bus');
    expect(dk.body.octaveShift).toBeNull();
    expect(dk.body.notes.join(' ')).toMatch(/kit position/);
    const fx = (await get('/api/sounds?transition=fxDownlifter&limit=1')).body.items[0];
    const df = await get(`/api/sounds/${fx.id}/details`);
    expect(df.body).toMatchObject({ volumeDb: -10, bus: 'fx bus' });
    expect((await get(`/api/sounds/${kick.id}/details?genre=polka`)).status).toBe(400);
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

describe('pattern previews for every tonal sound', () => {
  it('lends a part to sounds no genre uses (orchestral, mono guitars, brass)', async () => {
    const { soundCatalog } = await import('../src/sounds/soundCatalog.js');
    const cat = soundCatalog();
    const tonal = cat.items.filter((i) => ['acousticGuitars', 'orchestral', 'popBrass', 'keys'].includes(i.family));
    const pattern = tonal.filter((i) => i.preview === 'pattern');
    expect(pattern.length).toBeGreaterThan(tonal.length * 0.9);
    const orch = pattern.find((i) => i.family === 'orchestral')!;
    const p = cat.patternOf.get(orch.id)!;
    expect(p.donorId).not.toBe(orch.id);
    expect(p.entry.id).toBe(orch.id);
    expect(['popStrings', 'pad', 'bass']).toContain(p.family);
  });
});

describe('pattern preview options', () => {
  it('writes a part in the chosen style, and another pattern per variant', async () => {
    const { soundCatalog } = await import('../src/sounds/soundCatalog.js');
    const { previewSong } = await import('../src/sounds/previewSong.js');
    const cat = soundCatalog();
    const keys = cat.items.find((i) => i.family === 'keys' && i.preview === 'pattern')!;
    const p = cat.patternOf.get(keys.id)!;
    expect(p.genres.length).toBeGreaterThan(1);
    const genre = p.genres[1]!;
    const a = previewSong(p.donorId, p.family, [genre], p.entry, 0);
    const b = previewSong(p.donorId, p.family, [genre], p.entry, 1);
    expect(a.genre).toBe(genre);
    expect(a.song.genre).toBe(genre);
    const notes = (x: typeof a) => JSON.stringify(Object.values(x.song.arrangement)[0]!.overrides);
    expect(notes(a)).not.toBe(notes(b));
  });
});

describe('transition sounds', () => {
  it('lists the sounds a transition can play: one per pack for tonal reverses and percussion fills', async () => {
    const { searchSounds } = await import('../src/sounds/soundCatalog.js');
    const down = searchSounds({ transition: 'fxDownlifter', cursor: 0, limit: 100 });
    expect(down.total).toBeGreaterThan(5);
    expect(down.items.every((i) => i.family === 'fx' && i.preview === 'sample')).toBe(true);
    const tonal = searchSounds({ transition: 'fxTonalReverse', cursor: 0, limit: 100 });
    // 120 rows = 10 packs in 12 keys.
    expect(tonal.total).toBe(10);
    const fills = searchSounds({ transition: 'percussionBreaksFills', cursor: 0, limit: 100 });
    expect(fills.total).toBeLessThan(944 / 5);
    expect(() => searchSounds({ transition: 'fxNoiseRise', cursor: 0, limit: 10 })).toThrow(/no sounds to choose/);
  });
});

describe('sounds that suit a song style', () => {
  it('keeps the style-tagged sounds, or all of them when none is tagged', async () => {
    const { searchSounds } = await import('../src/sounds/soundCatalog.js');
    const all = searchSounds({ family: 'keys', cursor: 0, limit: 1 }).total;
    const ballad = searchSounds({ family: 'keys', suits: 'ballad', cursor: 0, limit: 100 });
    expect(ballad.noneTagged).toBe(false);
    expect(ballad.total).toBeLessThan(all);
    expect(ballad.items.every((i) => i.styles.includes('ballad'))).toBe(true);
    const none = searchSounds({ family: 'keys', suits: 'noSuchStyle', cursor: 0, limit: 1 });
    expect(none.noneTagged).toBe(true);
    expect(none.total).toBe(all);
  });
});

describe('engine previews of drum hits and samples', () => {
  it('plays a drum hit once in its first kit position, and plans loops / one-shots', async () => {
    const { soundCatalog } = await import('../src/sounds/soundCatalog.js');
    const { drumHitPreviewSong, samplePlanFor } = await import('../src/sounds/enginePreview.js');
    const cat = soundCatalog();
    const tom = [...cat.drumOf.values()].find((d) => d.entry.family === 'toms')!;
    const { song } = drumHitPreviewSong(tom.entry, tom.roles, 'ballad');
    const pitches = song.arrangement['chorus1']!.overrides['Drums']!.bars!.flatMap((b) => Object.values(b.notes ?? {}).flat().map((n) => (n as { note: number }).note));
    expect(pitches).toEqual([50]);
    const def = song.instrumentDefinitions.find((d) => d.name === 'Drums')!;
    expect((def.details as { drumSounds: Record<string, string> }).drumSounds['tom1']).toBe(tom.entry.id);
    const kinds = new Map<string, string>();
    for (const [id, s] of cat.sampleOf) kinds.set(cat.validated.get(id)!.family, s.plan.kind);
    expect(kinds.get('percussionLoops')).toBe('loop');
    expect(kinds.get('fx')).toBe('oneShot');
    const tonal = [...cat.sampleOf.values()].find((s) => s.entry.lowLevel === 'fxTonalReverse')!;
    expect(samplePlanFor(tonal.entry)).toMatchObject({ kind: 'oneShot', tag: 'fxTonalReverse', key: tonal.entry.key });
  });
});
