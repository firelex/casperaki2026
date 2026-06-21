// Step 9 — brain slice songs API.
//
// Tests use supertest-style raw fetch against `app.listen(0)` so the
// route wiring is exercised end-to-end. The store is in-memory; no
// disk I/O.

import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_BPM_BY_GENRE,
  GenreSchema,
  canonicalStringifySong,
  parseSong,
} from '@casperaki/song-schema';

import { createApp } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { openSongsStore, type SongsStore } from '../src/store.js';

interface Harness {
  url: string;
  store: SongsStore;
  stop: () => Promise<void>;
}

async function boot(): Promise<Harness> {
  const store = openSongsStore({ path: ':memory:' });
  const app = createApp(loadConfig({} as NodeJS.ProcessEnv), {
    store,
    // Pin createdAt so any future timestamp-related assertions stay stable.
  });
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    store,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          store.close();
          resolve();
        });
      }),
  };
}

// Canonical brain genre. Phase-3 used `pop` as slice placeholder language;
// post-step-4 the brain only accepts canonical workbook-derived styles,
// of which `brightPop` is the relevant pop variant. There is NO `pop` →
// `brightPop` alias — `pop` is rejected at the Zod body boundary.
const BRIGHTPOP_BODY = {
  genre: 'brightPop',
  key: 'C',
  bpm: 120,
  seed: 'brightPop-vertical-slice',
} as const;

describe('POST /api/songs/generate', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await boot();
  });
  afterEach(async () => {
    await h.stop();
  });

  it('returns 201 with id + song + hash, song is parseSong-valid', async () => {
    const res = await fetch(`${h.url}/api/songs/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(BRIGHTPOP_BODY),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; song: unknown; hash: string };
    expect(body.id).toMatch(/^[a-f0-9]{16}$/u);
    expect(body.hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(() => parseSong(body.song)).not.toThrow();
  });

  it('same seed → same canonical hash + id (idempotent)', async () => {
    const post = () =>
      fetch(`${h.url}/api/songs/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(BRIGHTPOP_BODY),
      }).then((r) => r.json() as Promise<{ id: string; hash: string }>);
    const a = await post();
    const b = await post();
    expect(a.hash).toBe(b.hash);
    expect(a.id).toBe(b.id);
  });

  it('returns 400 on invalid body (missing required fields)', async () => {
    const res = await fetch(`${h.url}/api/songs/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ genre: 'brightPop' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_body');
  });

  it('rejects non-canonical genre `pop` at the Zod boundary (no compatibility alias)', async () => {
    // Phase-3 slice used `pop` as placeholder language; post-step-4 it
    // is NOT a brain genre and the endpoint must NOT silently alias it
    // to brightPop. The Zod body schema rejects it.
    const res = await fetch(`${h.url}/api/songs/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...BRIGHTPOP_BODY, genre: 'pop' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues?: readonly { path: string; message: string }[] };
    expect(body.error).toBe('invalid_body');
    expect(body.issues?.some((i) => i.path === 'genre')).toBe(true);
  });

  it('rejects workbook main-styles without per-style rules (8bit, gospel)', async () => {
    for (const genre of ['8bit', 'gospel']) {
      const res = await fetch(`${h.url}/api/songs/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...BRIGHTPOP_BODY, genre }),
      });
      expect(res.status, `genre=${genre}`).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('invalid_body');
    }
  });

  it('returns 201 for every canonical brain genre (docs/56c — all 8 supported)', { timeout: 60_000 }, async () => {
    // docs/56c — every canonical GenreSchema entry now has a
    // GENRE_ROLES + GENRE_ACTIVITY table, intersected with the
    // validated catalog audit. The brain orchestrates a full song
    // for each; structure / chords / selection / patterns / vocals
    // all handle every genre.
    for (const genre of GenreSchema.options) {
      const bpm = DEFAULT_BPM_BY_GENRE[genre];
      const res = await fetch(`${h.url}/api/songs/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...BRIGHTPOP_BODY,
          genre,
          bpm,
          seed: `${genre}-coverage-smoke`,
        }),
      });
      expect(res.status, `genre=${genre} bpm=${bpm}`).toBe(201);
    }
  });

  it('rejects a tempo outside the legacy genre range', async () => {
    const res = await fetch(`${h.url}/api/songs/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...BRIGHTPOP_BODY, genre: 'latin', bpm: 120 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: string;
      issues?: readonly { path: string; message: string }[];
    };
    expect(body.error).toBe('invalid_body');
    expect(body.issues?.some((i) => i.path === 'bpm' && i.message.includes('90-104 bpm'))).toBe(true);
  });

  it('returns 400 on unknown key (chord/scale parse fails)', async () => {
    const res = await fetch(`${h.url}/api/songs/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...BRIGHTPOP_BODY, key: 'not-a-key' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('orchestrate_failed');
  });

  it('returns 400 when body field types are wrong', async () => {
    const res = await fetch(`${h.url}/api/songs/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...BRIGHTPOP_BODY, bpm: 'fast' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_body');
  });
});

describe('GET /api/songs/:id', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await boot();
  });
  afterEach(async () => {
    await h.stop();
  });

  it('returns the byte-identical canonical Song that was stored', async () => {
    const post = await fetch(`${h.url}/api/songs/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(BRIGHTPOP_BODY),
    });
    const created = (await post.json()) as { id: string; song: unknown; hash: string };
    const get = await fetch(`${h.url}/api/songs/${created.id}`);
    expect(get.status).toBe(200);
    const fetched = (await get.json()) as { id: string; song: unknown; hash: string };
    expect(fetched.id).toBe(created.id);
    expect(fetched.hash).toBe(created.hash);
    // canonical bytes round-trip
    const a = canonicalStringifySong(parseSong(created.song), 2);
    const b = canonicalStringifySong(parseSong(fetched.song), 2);
    expect(a).toBe(b);
  });

  it('returns 404 for an unknown id', async () => {
    const res = await fetch(`${h.url}/api/songs/0000000000000000`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('not_found');
  });
});

describe('POST /api/songs/:id/replay', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await boot();
  });
  afterEach(async () => {
    await h.stop();
  });

  it('returns ok=true and matching hashes for a freshly generated song', async () => {
    const post = await fetch(`${h.url}/api/songs/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(BRIGHTPOP_BODY),
    });
    const created = (await post.json()) as { id: string; hash: string };
    const res = await fetch(`${h.url}/api/songs/${created.id}/replay`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; ok: boolean; hash: string; replayHash: string };
    expect(body.ok).toBe(true);
    expect(body.hash).toBe(created.hash);
    expect(body.replayHash).toBe(created.hash);
  });

  it('returns 404 for an unknown id', async () => {
    const res = await fetch(`${h.url}/api/songs/0000000000000000/replay`, { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('replay is deterministic across many calls', async () => {
    const post = await fetch(`${h.url}/api/songs/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(BRIGHTPOP_BODY),
    });
    const { id, hash } = (await post.json()) as { id: string; hash: string };
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${h.url}/api/songs/${id}/replay`, { method: 'POST' });
      const body = (await res.json()) as { ok: boolean; replayHash: string };
      expect(body.ok).toBe(true);
      expect(body.replayHash).toBe(hash);
    }
  });
});

describe('store hardening', () => {
  it('store.get() validates the stored canonical via parseSong on retrieval', async () => {
    const h = await boot();
    try {
      // Generate a real row, then overwrite its canonical bytes with
      // payload that isn't Song-shaped. get() must throw rather than
      // silently hand back garbage as a Song.
      const post = await fetch(`${h.url}/api/songs/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(BRIGHTPOP_BODY),
      });
      const { id } = (await post.json()) as { id: string };
      const stored = h.store.get(id)!;
      h.store.put({
        id,
        song: stored.song,
        canonical: '{"not":"a song"}',
        hash: stored.hash,
        createdAt: stored.createdAt,
      });
      expect(() => h.store.get(id)).toThrow();
    } finally {
      await h.stop();
    }
  });

  it('replay returns 409 when stored generator.seed is non-scalar (no silent empty-seed substitution)', async () => {
    const h = await boot();
    try {
      // Generate normally first.
      const post = await fetch(`${h.url}/api/songs/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(BRIGHTPOP_BODY),
      });
      const { id } = (await post.json()) as { id: string };

      // Reach into the store and overwrite that row with a canonical
      // payload whose generator.seed is missing/non-scalar. parseSong
      // accepts the resulting song (generator/seed are both optional);
      // the route layer must still 409.
      const original = h.store.get(id)!;
      const songNoSeed = { ...original.song, generator: { ...original.song.generator, seed: undefined } };
      const { canonicalStringifySong } = await import('@casperaki/song-schema');
      const canonical = canonicalStringifySong(songNoSeed, 2);
      h.store.put({ id, song: songNoSeed, canonical, hash: original.hash, createdAt: original.createdAt });

      const replay = await fetch(`${h.url}/api/songs/${id}/replay`, { method: 'POST' });
      expect(replay.status).toBe(409);
      const body = (await replay.json()) as { error: string };
      expect(body.error).toBe('replay_missing_params');
    } finally {
      await h.stop();
    }
  });
});

describe('determinism guard', () => {
  it('songs router source contains no Math.random / AI/model imports', async () => {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { resolve, dirname } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const sources = await Promise.all(
      ['../src/routes/songs.ts', '../src/store.ts', '../src/bootstrap.ts'].map((p) =>
        readFile(resolve(here, p), 'utf8'),
      ),
    );
    for (const s of sources) {
      expect(s).not.toMatch(/Math\.random/u);
      // No AI / model wiring lives in the deterministic path.
      expect(s.toLowerCase()).not.toMatch(/ace[-_ ]?step|soulx|matchering|inference/u);
    }
  });
});
