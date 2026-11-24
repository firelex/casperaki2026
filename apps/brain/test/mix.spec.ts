// Pro-mode mix: saving a song's mix changes, playback with them, edits that
// remove a track, and the suggestions page's per-genre summary.

import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { openSongsStore, type SongsStore } from '../src/store.js';
import { fakePlayback } from './fakePlayback.js';

// Every sound type routes to a bus (as in the real config); the rest is small.
const REAL_ROUTES = (JSON.parse(readFileSync(fileURLToPath(new URL('../../../../casperaki_engine/config/mix-config.json', import.meta.url)), 'utf8')) as { typeToFxGroup: Record<string, string> }).typeToFxGroup;
const MIX_CONFIG = JSON.stringify({
  constants: { masterVolumeDb: -1, transitionsTrimDb: -10 },
  typeToFxGroup: REAL_ROUTES,
  instrumentTargetVolume: [],
  instrumentFxSends: { drums: { reverb: -25, delay: -100, chorus: -100 } },
  laneSendOverrides: { byType: [], byGroupGenre: [] },
  rackChains: [{ bus: 'bass', plugins: [{ factory: 'makeConsole8SubIn', params: [] }, { factory: 'makeLogical4', params: [0.1, 0.2, 0.3, 0.4, 1] }] }],
});

interface Harness { url: string; store: SongsStore; stop: () => Promise<void> }

async function boot(): Promise<Harness> {
  const store = openSongsStore({ path: ':memory:' });
  const app = createApp(loadConfig({} as NodeJS.ProcessEnv), { store, playback: fakePlayback({ mixConfig: MIX_CONFIG }) });
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    store,
    stop: () => new Promise<void>((resolve) => server.close(() => { store.close(); resolve(); })),
  };
}

const json = (method: string, body: unknown) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function generate(h: Harness, opts: { genre: string; seed: string } = { genre: 'edm', seed: 'mix-spec' }) {
  const res = await fetch(`${h.url}/api/songs/generate`, json('POST', { genre: opts.genre, key: 'A', bpm: 124, seed: opts.seed }));
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; song: { instrumentDefinitions: { name: string; lowLevelType?: string; type?: string }[] } };
}

/** A song with two lead synth tracks of the same sound type. */
const TWO_OF_A_TYPE = { genre: 'brightPop', seed: 'dup-0' };

describe('Pro-mode mix', () => {
  let h: Harness;
  beforeEach(async () => { h = await boot(); });
  afterEach(async () => { await h.stop(); });

  it('saves a song\'s mix, plays it back with it, and resets it', async () => {
    const { id, song } = await generate(h);
    const lane = song.instrumentDefinitions[0]!.name;
    const mix = { lanes: { [lane]: { volumeDb: -4, reverb: -18 } }, buses: { bass: { '1': [0.5, 0.2, 0.3, 0.4, 1] } } };
    const saved = await fetch(`${h.url}/api/songs/${id}/mix`, json('PUT', { mixOverrides: mix }));
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as { project: { mixOverrides: unknown } }).project.mixOverrides).toEqual(mix);

    const play = (await (await fetch(`${h.url}/api/songs/${id}/playback`)).json()) as { mixConfig: string };
    const cfg = JSON.parse(play.mixConfig);
    expect(cfg.laneOverrides).toEqual(mix.lanes);
    expect(cfg.rackChains[0].plugins[1].params).toEqual([0.5, 0.2, 0.3, 0.4, 1]);

    const reset = await fetch(`${h.url}/api/songs/${id}/mix`, json('PUT', { mixOverrides: null }));
    expect(((await reset.json()) as { project: { mixOverrides: unknown } }).project.mixOverrides).toBeNull();
    expect((await (await fetch(`${h.url}/api/songs/${id}/playback`)).json() as { mixConfig: string }).mixConfig).toBe(MIX_CONFIG);
  });

  it('refuses a mix for tracks or plugins the song does not have', async () => {
    const { id } = await generate(h);
    const put = (mixOverrides: unknown) => fetch(`${h.url}/api/songs/${id}/mix`, json('PUT', { mixOverrides }));
    expect((await put({ lanes: { 'No Such Track': { volumeDb: -3 } } })).status).toBe(400);
    expect((await put({ buses: { keys: { '1': [0.5] } } })).status).toBe(400);
    expect((await put({ buses: { bass: { '1': [0.5] } } })).status).toBe(400);
    expect((await put({ lanes: { Bass: { pan: 1 } } })).status).toBe(400);
  });

  it('keeps the mix through an edit and drops changes for a removed track', async () => {
    const { id, song } = await generate(h);
    const [first, second] = song.instrumentDefinitions;
    await fetch(`${h.url}/api/songs/${id}/mix`, json('PUT', { mixOverrides: { lanes: { [first!.name]: { volumeDb: -2 }, [second!.name]: { delay: -12 } } } }));
    const edited = { ...song, instrumentDefinitions: song.instrumentDefinitions.filter((d) => d.name !== second!.name) };
    const arr = (edited as unknown as { arrangement: Record<string, { instruments: Record<string, unknown>; overrides: Record<string, unknown> }> }).arrangement;
    for (const seg of Object.values(arr)) { delete seg.instruments[second!.name]; delete seg.overrides[second!.name]; }
    const res = await fetch(`${h.url}/api/songs/${id}`, json('PUT', { song: edited }));
    expect(res.status).toBe(200);
    const moved = (await res.json()) as { project: { mixOverrides: { lanes: Record<string, unknown> } } };
    expect(moved.project.mixOverrides.lanes).toEqual({ [first!.name]: { volumeDb: -2 } });
  });

  it('counts tracks of the same type in one song as one value (their average)', async () => {
    const { id, song } = await generate(h, TWO_OF_A_TYPE);
    const typeOf = (d: { lowLevelType?: string; type?: string }) => d.lowLevelType ?? d.type;
    const a = song.instrumentDefinitions.find((d) => song.instrumentDefinitions.some((o) => o !== d && typeOf(o) === typeOf(d)))!;
    expect(a, 'the test song has two tracks of one type').toBeDefined();
    const b = song.instrumentDefinitions.find((o) => o !== a && typeOf(o) === typeOf(a))!;
    await fetch(`${h.url}/api/songs/${id}/mix`, json('PUT', { mixOverrides: { lanes: { [a.name]: { volumeDb: -2, fxGroup: 'bass' }, [b.name]: { volumeDb: -4, fxGroup: 'bass' } } } }));
    const body = (await (await fetch(`${h.url}/api/suggestions/mix`)).json()) as {
      genres: { changes: { kind: string; target: string; average: number; detail?: { bus?: string }; values: { value: number; lane?: string }[] }[] }[];
    };
    const vol = body.genres[0]!.changes.find((c) => c.kind === 'volume' && c.target === typeOf(a))!;
    expect(vol.values).toEqual([expect.objectContaining({ value: -3, lane: `${a.name}, ${b.name}` })]);
    expect(vol.average).toBe(-3);
    const route = body.genres[0]!.changes.find((c) => c.kind === 'route')!;
    expect(route).toMatchObject({ target: typeOf(a), detail: { bus: 'bass' }, average: 1 });
    expect(route.values).toHaveLength(1);
  });

  it('approves a change into the standard mix; songs keep sounding the same', async () => {
    const { id, song } = await generate(h, TWO_OF_A_TYPE);
    const typeOf = (d: { lowLevelType?: string; type?: string }) => (d.lowLevelType ?? d.type)!;
    const a = song.instrumentDefinitions.find((d) => song.instrumentDefinitions.some((o) => o !== d && typeOf(o) === typeOf(d)))!;
    const b = song.instrumentDefinitions.find((o) => o !== a && typeOf(o) === typeOf(a))!;
    const type = typeOf(a);
    await fetch(`${h.url}/api/songs/${id}/mix`, json('PUT', { mixOverrides: {
      lanes: { [a.name]: { volumeDb: -2, fxGroup: 'bass', reverb: -12 }, [b.name]: { volumeDb: -4, fxGroup: 'bass', reverb: -12 }, 'Sample Transitions FX': { delay: -6 }, Drums: { volumeDb: 2, reverb: -10 } },
      buses: { bass: { '1': [0.1, 0.2, 0.3, 0.6, 1] } },
    } }));
    const approve = (key: string) => fetch(`${h.url}/api/suggestions/mix/approve`, json('POST', { genre: 'brightPop', key }));
    const standardMix = async () => {
      const other = await fetch(`${h.url}/api/songs/generate`, json('POST', { genre: 'brightPop', key: 'C', bpm: 120, seed: `std-${Math.random()}` }));
      const { id: otherId } = (await other.json()) as { id: string };
      return JSON.parse(((await (await fetch(`${h.url}/api/songs/${otherId}/playback`)).json()) as { mixConfig: string }).mixConfig) as {
        typeToFxGroup: Record<string, string>; instrumentTargetVolume: { type: string; genres?: string[]; db: number }[];
        laneSendOverrides: { byType: { types: string[]; op: string; reverb?: number; delay?: number; chorus?: number }[] }; rackChains: { bus: string; plugins: { params: number[] }[] }[];
      };
    };

    const vol = await approve(`volume|${type}`);
    expect(vol.status).toBe(200);
    let cfg = await standardMix();
    expect(cfg.instrumentTargetVolume.find((r) => r.type === type)).toEqual({ type, genres: ['brightPop'], db: -3 });
    // The trims drop by the 3 dB the standard dropped: -2 -> +1, -4 -> -1.
    const lanes = ((await (await fetch(`${h.url}/api/songs/${id}`)).json()) as { project: { mixOverrides: { lanes: Record<string, { volumeDb?: number }> } } }).project.mixOverrides.lanes;
    expect([lanes[a.name]!.volumeDb, lanes[b.name]!.volumeDb]).toEqual([1, -1]);

    expect((await approve(`route|${type}|bass`)).status).toBe(200);
    expect((await approve(`send|${type}|reverb`)).status).toBe(200);
    expect((await approve('plugin|bass|1|3')).status).toBe(200);
    cfg = await standardMix();
    expect(cfg.typeToFxGroup[type]).toBe('bass');
    expect(cfg.laneSendOverrides.byType[0]).toMatchObject({ types: [type], op: 'set', reverb: -12 });
    expect(cfg.rackChains.find((c) => c.bus === 'bass')!.plugins[1]!.params).toEqual([0.1, 0.2, 0.3, 0.6, 1]);

    // The transitions track has no single standard send to change, nor has the kit.
    expect((await approve('send|fxTransitions|delay')).status).toBe(409);
    expect((await approve('send|drumKit|reverb')).status).toBe(409);
    // The kit's level moves every kit position's level in the genre.
    expect((await approve('volume|drumKit')).status).toBe(200);
    cfg = await standardMix();
    expect(cfg.instrumentTargetVolume.find((r) => r.type === 'snareDrumsElectronic' && r.genres?.includes('brightPop'))?.db).toBe(2);
    // Approved rows are gone (the songs now match the standard), with a note in the comments.
    const body = (await (await fetch(`${h.url}/api/suggestions/mix`)).json()) as { genres: { changes: { key: string; scope: string }[] }[] };
    expect(body.genres[0]!.changes.map((c) => c.key).sort()).toEqual([`volume|${type}`, 'send|fxTransitions|delay', 'send|drumKit|reverb'].sort());
  });

  it('summarises every song\'s changes per genre for the suggestions page', async () => {
    const { id, song } = await generate(h);
    const def = song.instrumentDefinitions[0]!;
    await fetch(`${h.url}/api/songs/${id}/mix`, json('PUT', { mixOverrides: { lanes: { [def.name]: { volumeDb: 3 } }, buses: { bass: { '1': [0.1, 0.2, 0.3, 0.6, 1] } } } }));
    const body = (await (await fetch(`${h.url}/api/suggestions/mix`)).json()) as {
      genres: { genre: string; songs: number; changes: { kind: string; target: string; standard: number; average: number; detail?: { param?: number } }[] }[];
    };
    expect(body.genres).toHaveLength(1);
    expect(body.genres[0]).toMatchObject({ genre: 'edm', songs: 1 });
    const kinds = body.genres[0]!.changes.map((c) => [c.kind, c.target, c.standard, c.average]);
    expect(def.name).toBe('Drums');
    expect(kinds).toContainEqual(['volume', 'drumKit', 0, 3]); // the kit's fader trims every kit position
    expect(kinds).toContainEqual(['plugin', 'bass', 0.4, 0.6]);
    expect(body.genres[0]!.changes.filter((c) => c.kind === 'plugin')).toHaveLength(1); // unchanged params are not listed

    // Delete hides a change; the song keeps its mix; a later save shows it again.
    const plugin = (body.genres[0]!.changes as unknown as { key: string; kind: string }[]).find((c) => c.kind === 'plugin')!;
    const del = await fetch(`${h.url}/api/suggestions/mix?${new URLSearchParams({ genre: 'edm', key: plugin.key })}`, { method: 'DELETE' });
    expect(del.status).toBe(204);
    const after = (await (await fetch(`${h.url}/api/suggestions/mix`)).json()) as typeof body;
    expect(after.genres[0]!.changes.map((c) => c.kind)).toEqual(['volume']);
    expect(((await (await fetch(`${h.url}/api/songs/${id}`)).json()) as { project: { mixOverrides: { buses: unknown } } }).project.mixOverrides.buses).toEqual({ bass: { '1': [0.1, 0.2, 0.3, 0.6, 1] } });
    await new Promise((r) => setTimeout(r, 5));
    await fetch(`${h.url}/api/songs/${id}/mix`, json('PUT', { mixOverrides: { lanes: {}, buses: { bass: { '1': [0.1, 0.2, 0.3, 0.7, 1] } } } }));
    const again = (await (await fetch(`${h.url}/api/suggestions/mix`)).json()) as typeof body;
    expect(again.genres[0]!.changes.map((c) => [c.kind, c.average])).toEqual([['plugin', 0.7]]);
    expect((await fetch(`${h.url}/api/suggestions/mix?genre=edm`, { method: 'DELETE' })).status).toBe(400);

    // Comments: kept on the change, oldest first, without changing it.
    const c1 = await fetch(`${h.url}/api/suggestions/mix/comments`, json('POST', { genre: 'edm', key: plugin.key, body: 'Try this as the standard' }));
    expect(c1.status).toBe(201);
    await fetch(`${h.url}/api/suggestions/mix/comments`, json('POST', { genre: 'edm', key: plugin.key, body: 'Too loud on laptops' }));
    const withComments = (await (await fetch(`${h.url}/api/suggestions/mix`)).json()) as { genres: { changes: { key: string; comments: { body: string; author: string }[] }[] }[] };
    const commented = withComments.genres[0]!.changes.find((c) => c.key === plugin.key)!;
    expect(commented.comments.map((c) => c.body)).toEqual(['Try this as the standard', 'Too loud on laptops']);
    expect(commented.comments[0]!.author).toBe('local-dev');
    expect((await fetch(`${h.url}/api/suggestions/mix/comments`, json('POST', { genre: 'edm', key: plugin.key, body: '  ' }))).status).toBe(400);
  });
});
