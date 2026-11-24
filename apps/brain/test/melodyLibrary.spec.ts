// Melody library: the committed banks (hooks and remix patterns) and a fixture folder without hooks: filters, paging,
// one entry at sung pitch with half-bar chords, 404s; edits (saved to a temporary edits file, checked, used by the
// generator at once, loaded at startup, back to the stored version); chord options for any melody.

import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadPrecedentBank } from '@casperaki/arrangement';

import { createApp } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { PRECEDENTS_DIR } from '../src/melodies/melodyLibrary.js';
import { openSongsStore } from '../src/store.js';

interface Harness { url: string; stop: () => Promise<void> }

async function boot(o: { melodyLibraryDir?: string; editsPath: string }): Promise<Harness> {
  const store = openSongsStore({ path: ':memory:' });
  const config = loadConfig({ BRAIN_MELODY_EDITS_PATH: o.editsPath } as NodeJS.ProcessEnv);
  const app = createApp(config, { store, ...(o.melodyLibraryDir ? { melodyLibraryDir: o.melodyLibraryDir } : {}) });
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    stop: () => new Promise<void>((resolve) => server.close(() => { store.close(); resolve(); })),
  };
}

const call = (h: () => Harness) => async (path: string, init?: { method: string; body?: unknown }) => {
  const r = await fetch(h().url + path, init ? { method: init.method, headers: { 'content-type': 'application/json' }, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) } : undefined);
  return { status: r.status, body: (await r.json()) as any };
};

const tmp = mkdtempSync(join(tmpdir(), 'melody-library-'));
afterAll(() => rmSync(tmp, { recursive: true }));

describe('melody library: the committed banks', () => {
  let h: Harness;
  beforeAll(async () => { h = await boot({ editsPath: join(tmp, 'read-only-edits.json') }); });
  afterAll(async () => { await h.stop(); });
  const get = call(() => h);

  it('pages the remix patterns (1201 Melody Sauce imports among them)', async () => {
    const a = await get('/api/melody-library?kind=remix&source=melodySauce&limit=50');
    expect(a.status).toBe(200);
    expect(a.body.total).toBe(1201);
    expect(a.body.items).toHaveLength(50);
    const last = await get('/api/melody-library?kind=remix&source=melodySauce&limit=50&offset=1200');
    expect(last.body.items).toHaveLength(1);
    expect(a.body.facets.sources).toEqual(['melodySauce', 'song']);
    expect((await get('/api/melody-library?kind=remix&limit=1')).body.total).toBe(1493);
  });

  it('gives each entry its source, flags, range in semitones; one pre-chorus spelling', async () => {
    const { body } = await get('/api/melody-library?kind=remix&q=firework');
    const fw = body.items.find((i: { bank: string }) => i.bank === 'drLuke');
    expect(fw).toMatchObject({ name: 'Firework', type: 'Pre-chorus', source: { kind: 'song', title: 'Firework' }, useOriginal: false, useRemix: true, edited: false, range: 14 });
    const all = await get('/api/melody-library?kind=remix&limit=1');
    expect(all.body.facets.types).toContain('Pre-chorus');
    expect(all.body.facets.types).not.toContain('Prechorus');
  });

  it('filters by source, range band, flags, type, tempo and text (name, song, feel)', async () => {
    const songs = await get('/api/melody-library?kind=remix&source=song&limit=200');
    expect(songs.body.total).toBe(1493 - 1201);
    const narrow = await get('/api/melody-library?kind=remix&range=narrow&limit=200');
    expect(narrow.body.items.every((i: { range: number }) => i.range <= 9)).toBe(true);
    const wide = await get('/api/melody-library?kind=remix&range=wide&limit=200');
    expect(wide.body.items.every((i: { range: number }) => i.range >= 15)).toBe(true);
    expect((await get('/api/melody-library?kind=remix&remix=0')).body.total).toBe(0);
    expect((await get('/api/melody-library?kind=hooks&original=1')).body.total).toBe(106);
    const t = await get('/api/melody-library?kind=remix&tempo=120&limit=200');
    expect(t.body.items.every((i: { tempo: number }) => Math.abs(i.tempo - 120) <= 10)).toBe(true);
    const chorus = await get('/api/melody-library?kind=hooks&type=Chorus&limit=200');
    expect(chorus.body.items.every((i: { type: string }) => i.type === 'Chorus')).toBe(true);
    expect((await get('/api/melody-library?kind=remix&q=titanium')).body.items.map((i: { name: string }) => i.name)).toContain('Titanium');
    const tender = await get('/api/melody-library?kind=hooks&q=tender&limit=200');
    expect(tender.body.total).toBeGreaterThan(0);
    expect(tender.body.items.every((i: { feel: string; name: string }) => i.feel === 'tender' || i.name.toLowerCase().includes('tender'))).toBe(true);
  });

  it('gives one entry as notes an octave up and a chord per half bar', async () => {
    const e = await get('/api/melody-library/drLuke/18');
    expect(e.status).toBe(200);
    expect(e.body).toMatchObject({ bank: 'drLuke', name: 'Firework', tempo: 126, bars: 8, leadInBars: 0, lowestNote: 50, highestNote: 64 });
    expect(e.body.melody[0]).toEqual({ beat: 3, midi: 50, duration: 0.5 });
    expect(e.body.chords).toHaveLength(16);
    expect(e.body.chords.slice(0, 3)).toEqual(['C', 'C', 'Dm7']);
  });

  it('a rhythmic pattern has no chords; a lead-in entry has 9 bars', async () => {
    const r = await get('/api/melody-library/rhythmic-dance/7');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ name: 'Titanium', chords: [] });
    expect(r.body.melody.length).toBeGreaterThan(0);
    const list = await get('/api/melody-library?kind=remix&q=geboren');
    const lead = list.body.items.find((i: { bars: number }) => i.bars === 9);
    const e = await get(`/api/melody-library/${lead.bank}/${lead.id}`);
    expect(e.body.leadInBars).toBe(1);
    expect(e.body.chords).toHaveLength(18);
  });

  it('reads every hook', async () => {
    const list = await get('/api/melody-library?kind=hooks&limit=200');
    expect(list.body.total).toBeGreaterThanOrEqual(100);
    for (const i of list.body.items) {
      const e = await get(`/api/melody-library/hooks/${i.id}`);
      expect(e.status).toBe(200);
      expect(e.body.chords).toHaveLength(i.bars * 2);
    }
  });

  it('ranks chords for a half bar of any melody, 9 bars too', async () => {
    const melody = [{ beat: 32, midi: 60, duration: 0.5 }, { beat: 32.5, midi: 64, duration: 0.5 }, { beat: 33, midi: 67, duration: 1 }];
    const r = await get('/api/melody-library/chord-options', { method: 'POST', body: { melody, bars: 9, slot: 16 } });
    expect(r.status).toBe(200);
    expect(r.body.options.length).toBeGreaterThan(5);
    expect(r.body.options[0].chord).toMatch(/^C/u);
    expect((await get('/api/melody-library/chord-options', { method: 'POST', body: { melody, bars: 8, slot: 16 } })).status).toBe(400);
  });

  it('rejects bad queries and unknown banks or ids', async () => {
    expect((await get('/api/melody-library')).status).toBe(400);
    expect((await get('/api/melody-library?kind=remix&feel=anthem')).status).toBe(400);
    expect((await get('/api/melody-library?kind=remix&source=nope')).status).toBe(400);
    expect((await get('/api/melody-library/nope/1')).status).toBe(404);
    expect((await get('/api/melody-library/stefan/no-such-id')).status).toBe(404);
  });
});

describe('melody library: no hooks yet', () => {
  let h: Harness;
  const dir = mkdtempSync(join(tmpdir(), 'melody-library-nohooks-'));
  beforeAll(async () => {
    for (const f of readdirSync(PRECEDENTS_DIR).filter((n) => n !== 'mlDataRaw-hooks.json')) copyFileSync(join(PRECEDENTS_DIR, f), join(dir, f));
    h = await boot({ melodyLibraryDir: dir, editsPath: join(tmp, 'nohooks-edits.json') });
  });
  afterAll(async () => {
    await h.stop();
    rmSync(dir, { recursive: true });
  });

  it('says plainly when there are no hooks yet', async () => {
    const r = await call(() => h)('/api/melody-library?kind=hooks');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ total: 0, items: [], noHooksYet: true });
    expect((await call(() => h)('/api/melody-library/hooks/01-choruses-bright-01')).status).toBe(404);
  });
});

describe('melody library: edits', () => {
  const editsPath = join(tmp, 'edits', 'melody-edits.json');
  let h: Harness;
  beforeAll(async () => { h = await boot({ editsPath }); });
  afterAll(async () => {
    // Leave the generator without edits for the other test files.
    for (const key of ['drLuke/18', 'rhythmic-dance/7']) await call(() => h)(`/api/melody-library/${key}/edit`, { method: 'DELETE' });
    await h.stop();
  });
  const req = call(() => h);

  it('saves an edit (stored an octave lower), marks it, hands it to the generator and loads it at startup', async () => {
    const before = (await req('/api/melody-library/drLuke/18')).body;
    const melody = [...before.melody.slice(1), { beat: 30, midi: 60, duration: 2 }];
    const chords = before.chords.map((c: string, s: number) => (s === 15 ? 'G' : c));
    const saved = await req('/api/melody-library/drLuke/18', { method: 'PUT', body: { melody, chords, artist: 'Katy Perry', useOriginal: true, useRemix: false } });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ edited: true, useOriginal: true, useRemix: false, source: { kind: 'song', title: 'Firework', artist: 'Katy Perry' } });
    expect(saved.body.melody).toEqual(melody);
    expect(saved.body.chords[15]).toBe('G');
    expect(saved.body.editedBy).toBe('local-dev');

    const file = JSON.parse(readFileSync(editsPath, 'utf8'));
    expect(Object.keys(file)).toEqual(['drLuke/18']);
    expect(file['drLuke/18'].melody['30.0'] ?? file['drLuke/18'].melody['30']).toEqual([{ note: 'c4', midi: 48, duration: 2 }]);
    // An untouched half bar keeps its stored beat-by-beat chords; the changed one has the new chord on both beats.
    expect(file['drLuke/18'].chords['30.0'] ?? file['drLuke/18'].chords['30']).toEqual({ chord: 'G' });

    const gen = loadPrecedentBank('drLuke').find((e) => String(e.id) === '18')!;
    expect(gen.properties.useOriginal).toBe(true);
    expect(Object.values(gen.melody).flat().some((n) => n.midi === 48)).toBe(true);

    const listed = await req('/api/melody-library?kind=remix&q=firework');
    expect(listed.body.items.find((i: { bank: string }) => i.bank === 'drLuke')).toMatchObject({ edited: true, useOriginal: true });
    expect((await req('/api/melody-library?kind=remix&source=song&original=1')).body.items.map((i: { id: string }) => i.id)).toEqual(['18']);

    const again = await boot({ editsPath });
    try {
      expect((await call(() => again)('/api/melody-library/drLuke/18')).body).toMatchObject({ edited: true, useOriginal: true });
    } finally {
      await again.stop();
    }
  });

  it('refuses an entry the check finds wrong, with the problems in words', async () => {
    const before = (await req('/api/melody-library/drLuke/18')).body;
    const overlapping = [{ beat: 0, midi: 60, duration: 4 }, { beat: 2, midi: 62, duration: 1 }];
    const r = await req('/api/melody-library/drLuke/18', { method: 'PUT', body: { melody: overlapping, chords: before.chords, artist: '', useOriginal: false, useRemix: true } });
    expect(r.status).toBe(422);
    expect(r.body.problems.join(' ')).toMatch(/overlaps/u);
    const empty = await req('/api/melody-library/drLuke/18', { method: 'PUT', body: { melody: [], chords: before.chords, artist: '', useOriginal: false, useRemix: true } });
    expect(empty.status).toBe(422);
    const wrongChords = await req('/api/melody-library/drLuke/18', { method: 'PUT', body: { melody: before.melody, chords: ['C', 'G'], artist: '', useOriginal: false, useRemix: true } });
    expect(wrongChords.status).toBe(400);
    // Still the saved edit.
    expect((await req('/api/melody-library/drLuke/18')).body.useOriginal).toBe(true);
  });

  it('saves a pattern without chords, and goes back to the stored version', async () => {
    const r = (await req('/api/melody-library/rhythmic-dance/7')).body;
    const saved = await req('/api/melody-library/rhythmic-dance/7', { method: 'PUT', body: { melody: r.melody.slice(1), chords: [], artist: '', useOriginal: false, useRemix: false } });
    if (saved.status !== 200) throw new Error(JSON.stringify(saved.body));
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ edited: true, chords: [], useRemix: false });
    expect((await req('/api/melody-library/rhythmic-dance/7', { method: 'PUT', body: { melody: r.melody, chords: ['C', 'C'], artist: '', useOriginal: false, useRemix: true } })).status).toBe(400);

    const back = await req('/api/melody-library/rhythmic-dance/7/edit', { method: 'DELETE' });
    expect(back.status).toBe(200);
    expect(back.body).toMatchObject({ edited: false, useRemix: true });
    expect(back.body.melody).toEqual(r.melody);
    expect((await req('/api/melody-library/rhythmic-dance/7/edit', { method: 'DELETE' })).status).toBe(404);
    expect(Object.keys(JSON.parse(readFileSync(editsPath, 'utf8')))).toEqual(['drLuke/18']);
    expect(existsSync(`${editsPath}.tmp`)).toBe(false);
  });
});
