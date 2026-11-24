// Melody library: the legacy banks (committed data) as remix patterns, and the hooks bank (fixture directories, with
// and without a hooks file): filters, paging, one entry at sung pitch with half-bar chords, 404s.

import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { PRECEDENTS_DIR } from '../src/melodies/melodyLibrary.js';
import { openSongsStore } from '../src/store.js';

interface Harness { url: string; stop: () => Promise<void> }

async function boot(melodyLibraryDir?: string): Promise<Harness> {
  const store = openSongsStore({ path: ':memory:' });
  const app = createApp(loadConfig({} as NodeJS.ProcessEnv), { store, ...(melodyLibraryDir ? { melodyLibraryDir } : {}) });
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    stop: () => new Promise<void>((resolve) => server.close(() => { store.close(); resolve(); })),
  };
}

const getter = (h: () => Harness) => async (path: string) => {
  const r = await fetch(h().url + path);
  return { status: r.status, body: (await r.json()) as any };
};

/** One hook in the bank format: 8 bars (or 9 with a lead-in), C for the first half of every bar, then G. */
function hook(id: string, o: { name: string; type: string; tempoMin: number; tempoMax: number; feel: string; leadIn?: boolean }) {
  const end = o.leadIn ? 9 : 8;
  const chords: Record<string, { chord: string }> = {};
  for (let b = 0; b < end * 4; b++) chords[`${b}.0`] = { chord: b % 4 < 2 ? 'C' : 'G' };
  return {
    id,
    properties: {
      name: o.name, originalKey: 'C', key: 'C', tempo: String((o.tempoMin + o.tempoMax) / 2), busyness: 1.5, type: o.type,
      start: o.leadIn ? 1 : 0, end, lowestNote: 48, highestNote: 55, medianNote: 52,
      kind: 'hook', tempoMin: o.tempoMin, tempoMax: o.tempoMax, feel: o.feel,
    },
    melody: { '0.5': [{ note: 'c4', midi: 48, duration: 1.5 }], '2.0': [{ note: 'g4', midi: 55, duration: 2 }] },
    chords,
  };
}

/** A copy of the committed banks plus, optionally, a hooks bank. */
function fixtureDir(withHooks: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'melody-library-'));
  for (const f of ['bank-index.json', 'mlDataRaw-stefan.json', 'mlDataRaw-drLuke.json', 'mlDataRaw-schlager.json', 'mlDataRaw-limitedRange.json',
    'mlDataRaw-rhythmic-ballad.json', 'mlDataRaw-rhythmic-dance.json', 'mlDataRaw-rhythmic-latin.json', 'mlDataRaw-rhythmic-organicVibes.json',
    'mlDataRaw-rhythmic-urban.json', 'mlDataRaw-rhythmic-rock.json']) copyFileSync(join(PRECEDENTS_DIR, f), join(dir, f));
  if (withHooks) {
    writeFileSync(join(dir, 'mlDataRaw-hooks.json'), JSON.stringify([
      hook('anthems-01', { name: 'Rising Call', type: 'Chorus', tempoMin: 90, tempoMax: 130, feel: 'anthem' }),
      hook('anthems-02', { name: 'Low Tide', type: 'Verse', tempoMin: 70, tempoMax: 95, feel: 'tender', leadIn: true }),
      hook('anthems-03', { name: 'Running Lights', type: 'Chorus', tempoMin: 115, tempoMax: 140, feel: 'driving' }),
    ]));
  }
  return dir;
}

describe('melody library: the committed banks', () => {
  let h: Harness;
  beforeAll(async () => { h = await boot(); });
  afterAll(async () => { await h.stop(); });
  const get = getter(() => h);

  it('pages the stefan bank (1201 entries)', async () => {
    const a = await get('/api/melody-library?kind=remix&bank=stefan&limit=50');
    expect(a.status).toBe(200);
    expect(a.body.total).toBe(1201);
    expect(a.body.items).toHaveLength(50);
    const last = await get('/api/melody-library?kind=remix&bank=stefan&limit=50&offset=1200');
    expect(last.body.items).toHaveLength(1);
    expect(last.body.items[0].id).not.toBe(a.body.items[0].id);
    expect(a.body.facets.banks).toContain('stefan');
    expect(a.body.facets.banks).not.toContain('hooks');
  });

  it('lists every legacy bank, sung pitch, one pre-chorus spelling', async () => {
    const all = await get('/api/melody-library?kind=remix&limit=1');
    expect(all.body.total).toBe(1493);
    const item = all.body.items[0];
    expect(Object.keys(item).sort()).toEqual(['bank', 'bars', 'busyness', 'highestNote', 'id', 'lowestNote', 'name', 'tempo', 'type'].sort());
    expect(all.body.facets.types).toContain('Pre-chorus');
    expect(all.body.facets.types).not.toContain('Prechorus');
    const pre = await get('/api/melody-library?kind=remix&bank=drLuke&type=Pre-chorus&limit=200');
    expect(pre.body.total).toBe(8);
  });

  it('filters by type, tempo (within 10 bpm) and text', async () => {
    const chorus = await get('/api/melody-library?kind=remix&bank=schlager&type=Chorus&limit=200');
    expect(chorus.body.total).toBe(37);
    expect(chorus.body.items.every((i: { type: string }) => i.type === 'Chorus')).toBe(true);
    const t = await get('/api/melody-library?kind=remix&tempo=120&limit=200');
    expect(t.body.total).toBeGreaterThan(0);
    expect(t.body.items.every((i: { tempo: number }) => Math.abs(i.tempo - 120) <= 10)).toBe(true);
    const q = await get('/api/melody-library?kind=remix&q=firework');
    expect(q.body.items.map((i: { name: string }) => i.name)).toContain('Firework');
  });

  it('gives one entry as notes an octave up and a chord per half bar', async () => {
    const list = await get('/api/melody-library?kind=remix&bank=drLuke&q=firework');
    const { id } = list.body.items[0];
    const e = await get(`/api/melody-library/drLuke/${id}`);
    expect(e.status).toBe(200);
    expect(e.body).toMatchObject({ bank: 'drLuke', name: 'Firework', type: 'Pre-chorus', tempo: 126, bars: 8, leadInBars: 0, lowestNote: 50, highestNote: 64 });
    // The bank writes d3 (midi 38) at beat 3: shown at 50.
    expect(e.body.melody[0]).toEqual({ beat: 3, midi: 50, duration: 0.5 });
    expect(e.body.chords).toHaveLength(16);
    expect(e.body.chords.slice(0, 3)).toEqual(['C', 'C', 'Dm7']);
  });

  it('a lead-in entry has 9 bars and 18 half-bar chords', async () => {
    const list = await get('/api/melody-library?kind=remix&bank=schlager&limit=200');
    const lead = list.body.items.find((i: { bars: number }) => i.bars === 9);
    const e = await get(`/api/melody-library/schlager/${lead.id}`);
    expect(e.body.leadInBars).toBe(1);
    expect(e.body.chords).toHaveLength(18);
  });

  it('reads every entry of the committed hooks bank', async () => {
    const list = await get('/api/melody-library?kind=hooks&limit=200');
    expect(list.body.noHooksYet).toBeUndefined();
    expect(list.body.total).toBeGreaterThanOrEqual(100);
    for (const i of list.body.items) {
      const e = await get(`/api/melody-library/hooks/${i.id}`);
      expect(e.status).toBe(200);
      expect(e.body.chords).toHaveLength(i.bars * 2);
      expect(e.body.melody.length).toBeGreaterThan(0);
    }
  });

  it('rejects bad queries and unknown banks or ids', async () => {
    expect((await get('/api/melody-library')).status).toBe(400);
    expect((await get('/api/melody-library?kind=remix&feel=anthem')).status).toBe(400);
    expect((await get('/api/melody-library?kind=remix&bank=nope')).body.error).toBe('unknown_bank');
    expect((await get('/api/melody-library/nope/1')).status).toBe(404);
    expect((await get('/api/melody-library/stefan/no-such-id')).status).toBe(404);
  });
});

describe('melody library: hooks', () => {
  let h: Harness;
  let none: Harness;
  const dirs: string[] = [];
  beforeAll(async () => {
    dirs.push(fixtureDir(true), fixtureDir(false));
    h = await boot(dirs[0]);
    none = await boot(dirs[1]);
  });
  afterAll(async () => {
    await h.stop();
    await none.stop();
    for (const d of dirs) rmSync(d, { recursive: true });
  });
  const get = getter(() => h);

  it('says plainly when there are no hooks yet', async () => {
    const r = await getter(() => none)('/api/melody-library?kind=hooks');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ total: 0, items: [], noHooksYet: true });
    expect((await getter(() => none)('/api/melody-library/hooks/anthems-01')).status).toBe(404);
  });

  it('lists hooks with their tempo range and feel; remix patterns leave them out', async () => {
    const r = await get('/api/melody-library?kind=hooks');
    expect(r.body.total).toBe(3);
    expect(r.body.noHooksYet).toBeUndefined();
    expect(r.body.items[0]).toMatchObject({ bank: 'hooks', id: 'anthems-01', name: 'Rising Call', tempoMin: 90, tempoMax: 130, feel: 'anthem', bars: 8, lowestNote: 60 });
    expect(r.body.facets.feels).toEqual(['anthem', 'driving', 'tender']);
    expect((await get('/api/melody-library?kind=remix&limit=1')).body.total).toBe(1493);
  });

  it('filters hooks by tempo inside their range, feel, type and text', async () => {
    const ids = async (qs: string) => (await get(`/api/melody-library?kind=hooks&${qs}`)).body.items.map((i: { id: string }) => i.id);
    expect(await ids('tempo=120')).toEqual(['anthems-01', 'anthems-03']);
    expect(await ids('tempo=80')).toEqual(['anthems-02']);
    expect(await ids('feel=driving')).toEqual(['anthems-03']);
    expect(await ids('type=Chorus')).toEqual(['anthems-01', 'anthems-03']);
    expect(await ids('q=tide')).toEqual(['anthems-02']);
    expect(await ids('type=Chorus&offset=1&limit=1')).toEqual(['anthems-03']);
    expect((await get('/api/melody-library?kind=hooks&bank=stefan')).status).toBe(400);
  });

  it('gives a hook with its lead-in bar', async () => {
    const e = await get('/api/melody-library/hooks/anthems-02');
    expect(e.body).toMatchObject({ bars: 9, leadInBars: 1, feel: 'tender', tempoMin: 70, tempoMax: 95 });
    expect(e.body.melody).toEqual([{ beat: 0.5, midi: 60, duration: 1.5 }, { beat: 2, midi: 67, duration: 2 }]);
    expect(e.body.chords).toHaveLength(18);
    expect(e.body.chords.slice(0, 2)).toEqual(['C', 'G']);
    expect((await get('/api/melody-library/hooks/anthems-99')).status).toBe(404);
  });
});
