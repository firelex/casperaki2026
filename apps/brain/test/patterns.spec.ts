// Pattern lab routes: listing, review decisions, previews. Uses the
// committed proposals, an in-memory store and the stand-in playback service.

import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { laneFamilyOf, loadPatternProposals } from '@casperaki/arrangement';

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

const post = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('pattern lab', () => {
  let h: Harness;
  beforeEach(async () => { h = await boot(); });
  afterEach(async () => { await h.stop(); });

  it('lists proposals with no decisions yet', async () => {
    const body = (await (await fetch(`${h.url}/api/patterns`)).json()) as { proposals: Array<{ id: string; review: unknown; inLibrary: boolean }> };
    expect(body.proposals.map((p) => p.id)).toEqual(loadPatternProposals().map((p) => p.id));
    expect(body.proposals.every((p) => p.review === null)).toBe(true);
  });

  it('records, changes and clears a decision', async () => {
    const id = loadPatternProposals()[0]!.id;
    const a = (await (await post(`${h.url}/api/patterns/${id}/review`, { status: 'approved', note: 'good' })).json()) as { review: { status: string; note: string; reviewer: string } };
    expect(a.review).toMatchObject({ status: 'approved', note: 'good', reviewer: 'local-dev' });
    const r = (await (await post(`${h.url}/api/patterns/${id}/review`, { status: 'rejected' })).json()) as { review: { status: string } };
    expect(r.review.status).toBe('rejected');
    const c = (await (await post(`${h.url}/api/patterns/${id}/review`, { status: 'pending' })).json()) as { review: unknown };
    expect(c.review).toBeNull();
    expect((await post(`${h.url}/api/patterns/no-such/review`, { status: 'approved' })).status).toBe(404);
  });

  it('previews a proposal and the current library as different songs on the same seed', async () => {
    const p = loadPatternProposals()[0]!;
    const withP = (await (await post(`${h.url}/api/patterns/${p.id}/preview`, { genre: p.genres[0], variant: 'proposal' })).json()) as { songId: string; seed: string; samples: unknown[] };
    const current = (await (await post(`${h.url}/api/patterns/${p.id}/preview`, { genre: p.genres[0], variant: 'current' })).json()) as { songId: string; seed: string };
    expect(withP.seed).toBe(current.seed);
    expect(withP.songId).not.toBe(current.songId);
    expect(withP.samples.length).toBeGreaterThan(0);
    expect((withP as unknown as { lanes: string[] }).lanes.map(laneFamilyOf)).toContain(p.family);
  });

  it('previews one chosen pattern of a proposal, and refuses a pattern it does not have', async () => {
    const p = loadPatternProposals().find((x) => x.kind === 'chordTones' && x.patterns.length > 1)!;
    const body = (take: number) => ({ genre: p.genres[0], variant: 'proposal', take });
    const one = (await (await post(`${h.url}/api/patterns/${p.id}/preview`, body(0))).json()) as { songId: string };
    const two = (await (await post(`${h.url}/api/patterns/${p.id}/preview`, body(1))).json()) as { songId: string };
    expect(one.songId).not.toBe(two.songId);
    const bad = await post(`${h.url}/api/patterns/${p.id}/preview`, body(p.kind === 'chordTones' ? p.patterns.length : 99));
    expect(bad.status).toBe(400);
  });

  it('previews a keys / pad / strings / brass / synths / guitar proposal with a lane of its family', async () => {
    for (const family of ['keys', 'pad', 'popStrings', 'popBrass', 'synths', 'pluckedSynths', 'guitar']) {
      const p = loadPatternProposals().find((x) => x.family === family);
      if (!p) throw new Error(`no ${family} proposal on disk`);
      const res = await post(`${h.url}/api/patterns/${p.id}/preview`, { genre: p.genres[0], variant: 'proposal' });
      const body = (await res.json()) as { songId?: string; message?: string; lanes?: string[] };
      expect(res.status, `${p.id}: ${body.message ?? ''}`).toBe(200);
      expect(body.songId).toBeTruthy();
      // The tracks "Play solo" solos: at least one, all of the proposal's instrument.
      expect(body.lanes!.length, p.id).toBeGreaterThan(0);
      for (const lane of body.lanes!) expect(laneFamilyOf(lane), lane).toBe(family);
      // Sections back to back from 0, with verses quiet and choruses full.
      const sections = (body as unknown as { sections: { name: string; energy: string | null; start: number; end: number }[] }).sections;
      expect(sections[0]!.start).toBe(0);
      for (let i = 1; i < sections.length; i++) expect(sections[i]!.start).toBeCloseTo(sections[i - 1]!.end, 9);
      expect(sections.some((x) => x.name.startsWith('verse') && x.energy === 'low')).toBe(true);
      expect(sections.some((x) => x.name.startsWith('chorus') && x.energy === 'high')).toBe(true);
    }
  });

  it('opens the song as heard in the editor: a new project of the user', async () => {
    const p = loadPatternProposals().find((x) => x.family === 'popBrass')!;
    const sounds = ((await (await fetch(`${h.url}/api/patterns/${p.id}/sounds?genre=${p.genres[0]}`)).json()) as { sounds: { id: string }[] }).sounds;
    const body = { genre: p.genres[0], variant: 'proposal', take: 1, soundId: sounds[1]!.id };
    const preview = (await (await post(`${h.url}/api/patterns/${p.id}/preview`, body)).json()) as { songId: string };
    const res = await post(`${h.url}/api/patterns/${p.id}/project`, body);
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    expect(id).toBe(preview.songId); // the very song the preview played
    const project = (await (await fetch(`${h.url}/api/songs/${id}`)).json()) as { project: { title: string } };
    expect(project.project.title).toBe(`Pattern test: ${p.name}`);
    expect((await post(`${h.url}/api/patterns/no-such/project`, body)).status).toBe(404);
  });

  it('plays a proposal with another sound of its instrument (the instrument picker)', async () => {
    const p = loadPatternProposals().find((x) => x.family === 'popBrass')!;
    type Preview = { songId: string; message?: string; sounds: { id: string; name: string }[]; soundId: string | null };
    const first = (await (await post(`${h.url}/api/patterns/${p.id}/preview`, { genre: p.genres[0], variant: 'proposal' })).json()) as Preview;
    expect(first.sounds.length).toBeGreaterThan(1);
    const listed = (await (await fetch(`${h.url}/api/patterns/${p.id}/sounds?genre=${p.genres[0]}`)).json()) as { sounds: { id: string }[] };
    expect(listed.sounds.map((s) => s.id).sort()).toEqual(first.sounds.map((s) => s.id).sort());
    expect(first.sounds.map((s) => s.id)).toContain(first.soundId);
    // Beyond the generator's brass sections: the solo horns too (what Change sound accepts).
    expect((first.sounds as { inStyle: boolean }[]).some((s) => !s.inStyle)).toBe(true);
    const other = first.sounds.find((s) => s.id !== first.soundId && !(s as { inStyle?: boolean }).inStyle)!;
    for (const variant of ['proposal', 'current'] as const) {
      const res = await post(`${h.url}/api/patterns/${p.id}/preview`, { genre: p.genres[0], variant, soundId: other.id });
      const body = (await res.json()) as Preview;
      expect(res.status, body.message).toBe(200);
      expect(body.soundId).toBe(other.id);
    }
    // The proposal's pattern stays: same sound, proposal vs current differ.
    const withP = (await (await post(`${h.url}/api/patterns/${p.id}/preview`, { genre: p.genres[0], variant: 'proposal', soundId: other.id })).json()) as Preview;
    const current = (await (await post(`${h.url}/api/patterns/${p.id}/preview`, { genre: p.genres[0], variant: 'current', soundId: other.id })).json()) as Preview;
    expect(withP.songId).not.toBe(current.songId);
    // Guitars: no chords / effects recordings (parts of a Virtual Guitarist guitar, not sounds).
    const { loadValidatedCatalog } = await import('@casperaki/arrangement');
    const gp = loadPatternProposals().find((x) => x.family === 'guitar')!;
    const gs = (await (await fetch(`${h.url}/api/patterns/${gp.id}/sounds?genre=${gp.genres[0]}`)).json()) as { sounds: { id: string }[] };
    const presets = gs.sounds.map((s) => loadValidatedCatalog().entries.find((e) => e.id === s.id)?.preset);
    expect(presets).not.toContain('Default FX');
    expect(presets).not.toContain('Default Chords');
    // A sound of another instrument is refused; drums have no picker.
    const keysSound = 'ffffffffffffffff';
    expect((await post(`${h.url}/api/patterns/${p.id}/preview`, { genre: p.genres[0], variant: 'proposal', soundId: keysSound })).status).toBe(400);
    const drums = loadPatternProposals().find((x) => x.family === 'drums')!;
    const d = await post(`${h.url}/api/patterns/${drums.id}/preview`, { genre: drums.genres[0], variant: 'proposal', soundId: other.id });
    expect(d.status).toBe(400);
  });
});

