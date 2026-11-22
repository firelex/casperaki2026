// Pattern lab routes: listing, review decisions, previews. Uses the
// committed proposals, an in-memory store and the stand-in playback service.

import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadPatternProposals } from '@casperaki/arrangement';

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
  });

  it('previews a keys / pad / strings / brass / synths / guitar proposal with a lane of its family', async () => {
    for (const family of ['keys', 'pad', 'popStrings', 'popBrass', 'synths', 'pluckedSynths', 'guitar']) {
      const p = loadPatternProposals().find((x) => x.family === family);
      if (!p) throw new Error(`no ${family} proposal on disk`);
      const res = await post(`${h.url}/api/patterns/${p.id}/preview`, { genre: p.genres[0], variant: 'proposal' });
      const body = (await res.json()) as { songId?: string; message?: string };
      expect(res.status, `${p.id}: ${body.message ?? ''}`).toBe(200);
      expect(body.songId).toBeTruthy();
    }
  });
});

