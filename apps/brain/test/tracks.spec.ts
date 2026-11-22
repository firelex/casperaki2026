// Sequencer track editing routes: options and edits over a generated song.

import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { orchestrate } from '@casperaki/arrangement';
import type { Song } from '@casperaki/song-schema';

import { createApp } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { openSongsStore, type SongsStore } from '../src/store.js';

interface Harness { url: string; stop: () => Promise<void> }

async function boot(): Promise<Harness> {
  const store: SongsStore = openSongsStore({ path: ':memory:' });
  const app = createApp(loadConfig({} as NodeJS.ProcessEnv), { store });
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    stop: () => new Promise<void>((resolve) => server.close(() => { store.close(); resolve(); })),
  };
}

const post = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const song = (): Song => orchestrate({ genre: 'edm', key: 'Am', bpm: 126, seed: 'tracks-route-1' });

interface Options {
  tracks: Record<string, { family: string | null; soundId: string | null; editable: boolean }>;
  families: { family: string; label: string; sounds: { id: string; name: string }[] }[];
}

describe('track editing routes', () => {
  let h: Harness;
  beforeEach(async () => { h = await boot(); });
  afterEach(async () => { await h.stop(); });

  it('lists each track and the sounds per family', async () => {
    const res = await post(`${h.url}/api/tracks/options`, { song: song() });
    expect(res.status).toBe(200);
    const o = (await res.json()) as Options;
    expect(o.tracks.Drums).toMatchObject({ family: 'drums', editable: true });
    expect(o.tracks.Vocal).toMatchObject({ family: null, soundId: null, editable: false });
    const bass = o.families.find((f) => f.family === 'bass')!;
    expect(bass.label).toBe('Bass');
    expect(bass.sounds.length).toBeGreaterThan(1);
    expect(bass.sounds.map((s) => s.id)).toContain(o.tracks.Bass!.soundId);
  });

  it('changes a sound, makes a new pattern and adds a track', async () => {
    const s0 = song();
    const o = (await (await post(`${h.url}/api/tracks/options`, { song: s0 })).json()) as Options;
    const other = o.families.find((f) => f.family === 'bass')!.sounds.find((x) => x.id !== o.tracks.Bass!.soundId)!;
    const a = (await (await post(`${h.url}/api/tracks/edit`, { song: s0, op: { kind: 'changeSound', track: 'Bass', soundId: other.id } })).json()) as { song: Song; track: string };
    expect(a.track).toBe('Bass');
    expect(a.song.instrumentDefinitions.find((d) => d.name === 'Bass')!.id).toBe(other.id);

    const b = await post(`${h.url}/api/tracks/edit`, { song: a.song, op: { kind: 'newPattern', track: 'Drums' } });
    expect(b.status).toBe(200);

    const chorus = s0.songStructure.filter((x) => x.name.startsWith('chorus')).map((x) => x.name);
    const c = (await (await post(`${h.url}/api/tracks/edit`, { song: ((await b.json()) as { song: Song }).song, op: { kind: 'addTrack', family: 'keys', segments: chorus } })).json()) as { song: Song; track: string };
    expect(c.track).toMatch(/^Keys( \d+)?$/u);
    for (const seg of s0.songStructure) expect(c.song.arrangement[seg.name]!.instruments[c.track]).toBe(chorus.includes(seg.name));
  });

  it('fails loudly on bad requests', async () => {
    const s0 = song();
    const o = (await (await post(`${h.url}/api/tracks/options`, { song: s0 })).json()) as Options;
    const keys = o.families.find((f) => f.family === 'keys')!.sounds[0]!;
    const wrongFamily = await post(`${h.url}/api/tracks/edit`, { song: s0, op: { kind: 'changeSound', track: 'Bass', soundId: keys.id } });
    expect(wrongFamily.status).toBe(400);
    expect(((await wrongFamily.json()) as { error: string }).error).toBe('sound_not_in_family');
    expect((await post(`${h.url}/api/tracks/edit`, { song: s0, op: { kind: 'newPattern', track: 'Nope' } })).status).toBe(400);
    expect((await post(`${h.url}/api/tracks/edit`, { song: s0, op: { kind: 'newPattern', track: 'Vocal' } })).status).toBe(400);
    expect((await post(`${h.url}/api/tracks/edit`, { song: s0, op: { kind: 'addTrack', family: 'keys', segments: ['nope'] } })).status).toBe(400);
    expect((await post(`${h.url}/api/tracks/edit`, { song: s0, op: { kind: 'explode' } })).status).toBe(400);
    expect((await post(`${h.url}/api/tracks/edit`, { song: { bogus: true }, op: { kind: 'newPattern', track: 'Drums' } })).status).toBe(400);
    const { generator: _g, ...bare } = s0;
    expect((await post(`${h.url}/api/tracks/edit`, { song: bare, op: { kind: 'newPattern', track: 'Drums' } })).status).toBe(409);
  });

  it('lists the drum kit and replaces one drum', async () => {
    const s = song();
    const kitRes = await post(`${h.url}/api/tracks/drum-kit`, { song: s });
    expect(kitRes.status).toBe(200);
    const { kit } = (await kitRes.json()) as { kit: { role: string; label: string; family: string; soundId: string; name: string; overridden: boolean }[] };
    expect(kit).toHaveLength(17);
    const snare = kit.find((k) => k.role === 'snareDrum1')!;
    expect(snare).toMatchObject({ label: 'Snare 1', family: 'snareDrums', overridden: false });
    expect(JSON.stringify(kit)).not.toMatch(/library|preset|matchedPath|\.mp3/);
    // Another snare from the Sounds catalog.
    const list = (await (await fetch(`${h.url}/api/sounds?family=snareDrums&limit=5`)).json()) as { items: { id: string; drumRoles: string[] }[] };
    const other = list.items.find((i) => i.id !== snare.soundId)!;
    expect(other.drumRoles).toEqual(['snareDrum1', 'snareDrum2']);
    const edit = await post(`${h.url}/api/tracks/edit`, { song: s, op: { kind: 'setDrumSound', role: 'snareDrum1', soundId: other.id } });
    expect(edit.status).toBe(200);
    const { song: edited, track } = (await edit.json()) as { song: Song; track: string };
    expect(track).toBe('Drums');
    const kit2 = ((await (await post(`${h.url}/api/tracks/drum-kit`, { song: edited })).json()) as { kit: typeof kit }).kit;
    expect(kit2.find((k) => k.role === 'snareDrum1')).toMatchObject({ soundId: other.id, overridden: true });
    // A kick is not a snare.
    const kick = kit.find((k) => k.role === 'bassDrum1')!.soundId;
    const bad = await post(`${h.url}/api/tracks/edit`, { song: s, op: { kind: 'setDrumSound', role: 'snareDrum1', soundId: kick } });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe('sound_not_in_family');
  });

});

describe('POST /api/transitions/set', () => {
  it('switches a transition on in sections and refuses unknown types', async () => {
    const { createTracksRouter } = await import('../src/routes/tracks.js');
    const express = (await import('express')).default;
    const app = express().use(express.json({ limit: '20mb' })).use(createTracksRouter());
    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/transitions/set`;
      const send = (body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const song = orchestrate({ genre: 'brightPop', key: 'C', bpm: 120, seed: 'tr-route' });
      const ok = await send({ song, segments: ['verse1', 'verse2'], type: 'fxUplifter', placement: 'endOfSegment', on: true });
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as { song: Song };
      expect(body.song.arrangement['verse2']!.transitions!['fxUplifter']).toMatchObject({ type: 'fxUplifter', placement: 'endOfSegment' });
      expect((body.song.arrangement['verse2']!.transitions!['fxUplifter'] as unknown as { soundId: string }).soundId).toMatch(/^[0-9a-f]{16}$/u);
      const bad = await send({ song, segments: ['verse1'], type: 'fxBoom', placement: 'endOfSegment', on: true });
      expect(bad.status).toBe(400);
      // Every chorus carries chorus1's transitions (legacy lockSegments), with sounds.
      const stateUrl = url.replace('/set', '/state');
      const st = await fetch(stateUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ song }) });
      expect(st.status).toBe(200);
      const state = (await st.json()) as {
        types: { type: string; swappable: boolean }[];
        sections: Record<string, { type: string; placement: string; soundId: string | null; soundName: string | null }[]>;
      };
      expect(state.types.find((t) => t.type === 'fxNoiseRise')!.swappable).toBe(false);
      const chorusTags = (n: string) => state.sections[n]!.filter((t) => t.type !== 'fxNoiseRise' && t.type !== 'cymbalsCrashHit').map((t) => t.type).sort();
      const choruses = song.songStructure.map((x) => x.name).filter((n) => n.startsWith('chorus'));
      for (const c of choruses) expect(chorusTags(c)).toEqual(chorusTags('chorus1'));
      for (const list of Object.values(state.sections)) {
        for (const t of list) {
          if (t.type === 'fxNoiseRise' || t.type === 'edmSnareDrumRoll') continue;
          expect(t.soundId).toMatch(/^[0-9a-f]{16}$/u);
          expect(typeof t.soundName).toBe('string');
          expect(JSON.stringify(t)).not.toMatch(/\.mp3|bigZ|kontakt/u);
        }
      }

    } finally {
      server.close();
    }
  });
});
