import { describe, it, expect, vi } from 'vitest';
import type { Mock } from 'vitest';

import { BrainClient, BrainError } from '../src/api/client';
import { LATEST_RENDER_WAV_URL, RendersApi } from '../src/api/renders';
import { SongsApi } from '../src/api/songs';
import { CatalogApi, buildQueryString } from '../src/api/catalog';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeFetchMock(handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  const fn = vi.fn(handler) as Mock<typeof fetch>;
  return fn;
}

describe('BrainClient', () => {
  it('serializes POST bodies as JSON and parses responses', async () => {
    const fetchMock = makeFetchMock(async () =>
      jsonResponse(201, { id: 'x', hash: 'h', song: {} }),
    );
    const client = new BrainClient({ fetch: fetchMock });
    const api = new SongsApi(client);
    const out = await api.generate({ genre: 'brightPop', key: 'C', bpm: 120, seed: 'demo' });

    expect(out).toMatchObject({ id: 'x', hash: 'h' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe('/api/songs/generate');
    expect(call[1]?.method).toBe('POST');
    expect(JSON.parse(call[1]?.body as string)).toEqual({
      genre: 'brightPop',
      key: 'C',
      bpm: 120,
      seed: 'demo',
    });
  });

  it('throws a BrainError on non-2xx with surfaced issues', async () => {
    const fetchMock = makeFetchMock(async () =>
      jsonResponse(400, {
        error: 'invalid_body',
        issues: [{ path: 'genre', message: 'Invalid enum value' }],
      }),
    );
    const client = new BrainClient({ fetch: fetchMock });
    const api = new SongsApi(client);

    await expect(
      api.generate({ genre: 'pop', key: 'C', bpm: 120, seed: 'x' }),
    ).rejects.toBeInstanceOf(BrainError);

    try {
      await api.generate({ genre: 'pop', key: 'C', bpm: 120, seed: 'x' });
    } catch (e) {
      const err = e as BrainError;
      expect(err.status).toBe(400);
      expect(err.body?.error).toBe('invalid_body');
      expect(err.body?.issues?.[0]?.path).toBe('genre');
    }
  });

  it('encodes ids in GET /api/songs/:id', async () => {
    const fetchMock = makeFetchMock(async () =>
      jsonResponse(200, { id: 'abc/def', hash: 'h', song: {} }),
    );
    const client = new BrainClient({ fetch: fetchMock });
    const api = new SongsApi(client);
    await api.get('abc/def');
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/songs/abc%2Fdef');
  });
});

describe('RendersApi', () => {
  it('parses an exists:false metadata payload (missing artifact)', async () => {
    const fetchMock = makeFetchMock(async () => jsonResponse(200, { exists: false }));
    const client = new BrainClient({ fetch: fetchMock });
    const api = new RendersApi(client);
    const meta = await api.latest();
    expect(meta).toEqual({ exists: false });
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/renders/latest');
    expect(fetchMock.mock.calls[0]![1]?.method).toBe('GET');
  });

  it('parses a populated metadata payload (artifact present)', async () => {
    const fetchMock = makeFetchMock(async () =>
      jsonResponse(200, {
        exists: true,
        durationSec: 210.0,
        peakDb: -3.42,
        rmsDb: -19.58,
        sampleRate: 44100,
        bitDepth: 24,
        channels: 2,
        sizeBytes: 55566816,
        updatedAt: '2026-06-06T22:33:00.000Z',
        url: '/api/renders/latest.wav',
      }),
    );
    const client = new BrainClient({ fetch: fetchMock });
    const api = new RendersApi(client);
    const meta = await api.latest();
    expect(meta.exists).toBe(true);
    expect(meta.durationSec).toBe(210.0);
    expect(meta.sampleRate).toBe(44100);
    expect(meta.bitDepth).toBe(24);
    expect(meta.channels).toBe(2);
    expect(meta.url).toBe('/api/renders/latest.wav');
  });

  it('exposes a stable WAV URL suitable for an <audio src>', () => {
    const api = new RendersApi();
    expect(api.latestWavUrl()).toBe(LATEST_RENDER_WAV_URL);
    expect(LATEST_RENDER_WAV_URL).toBe('/api/renders/latest.wav');
  });
});

describe('CatalogApi', () => {
  it('buildQueryString drops undefined/empty values and encodes', () => {
    expect(
      buildQueryString({
        family: 'kickDrums',
        mainStyle: 'brightPop',
        q: 'kick &',
        limit: 25,
        cursor: 0,
        library: '',
      }),
    ).toBe('family=kickDrums&mainStyle=brightPop&q=kick%20%26&limit=25&cursor=0');
    expect(buildQueryString({})).toBe('');
  });

  it('summary() hits /api/catalog/summary', async () => {
    const fetchMock = makeFetchMock(async () =>
      jsonResponse(200, {
        catalogContentHash: 'a'.repeat(64),
        auditContentHash: 'b'.repeat(64),
        totalCatalogEntries: 100,
        validatedEntries: 90,
        missingEntries: 10,
        families: [{ key: 'kickDrums', count: 5 }],
        lowLevels: [],
        mainStyles: ['brightPop'],
        addStyles: ['edm'],
        lowLevelByFamily: {},
        libraries: [],
        extractedAt: '2026-06-06',
        importer: 'cli',
      }),
    );
    const client = new BrainClient({ fetch: fetchMock });
    const api = new CatalogApi(client);
    const sum = await api.summary();
    expect(sum.validatedEntries).toBe(90);
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/catalog/summary');
    expect(fetchMock.mock.calls[0]![1]?.method).toBe('GET');
  });

  it('list() appends query string and falls back to bare path when empty', async () => {
    const fetchMock = makeFetchMock(async () =>
      jsonResponse(200, {
        total: 1,
        cursor: 0,
        limit: 10,
        nextCursor: null,
        entries: [],
        catalogContentHash: 'x',
        auditContentHash: 'y',
      }),
    );
    const client = new BrainClient({ fetch: fetchMock });
    const api = new CatalogApi(client);

    await api.list({ family: 'basses', limit: 10 });
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/catalog/instruments?family=basses&limit=10');

    await api.list();
    expect(fetchMock.mock.calls[1]![0]).toBe('/api/catalog/instruments');
  });

  it('get() encodes the id segment', async () => {
    const fetchMock = makeFetchMock(async () =>
      jsonResponse(200, {
        entry: {
          id: 'a/b',
          family: 'basses',
          lowLevel: 'bassesSynth',
          mainStyle: null,
          addStyles: [],
          library: null,
          preset: null,
          info: null,
          addPlugins: null,
          bpm: null,
          key: null,
          normalisation: null,
          status: null,
          legacyReplacement: null,
          sourceSheet: 'basses',
          sourceRow: 2,
          matchedPath: 'basses/x/y.mp3',
          matchedRule: 'simple',
        },
        catalogContentHash: 'a',
        auditContentHash: 'b',
      }),
    );
    const client = new BrainClient({ fetch: fetchMock });
    const api = new CatalogApi(client);
    await api.get('a/b');
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/catalog/instruments/a%2Fb');
  });

  it('lowLevels() hits /api/catalog/low-levels with filter query', async () => {
    const fetchMock = makeFetchMock(async () =>
      jsonResponse(200, {
        total: 1,
        cursor: 0,
        limit: 10,
        nextCursor: null,
        groups: [
          {
            family: 'basses',
            lowLevel: 'bassesSynthDistorted',
            presetCount: 4,
            libraries: ['serum'],
            mainStyles: ['brightPop'],
            addStyles: ['edm', 'rock'],
            sampleEntryId: '0123456789abcdef',
            sampleMatchedRule: 'simple',
          },
        ],
        catalogContentHash: 'a',
        auditContentHash: 'b',
      }),
    );
    const client = new BrainClient({ fetch: fetchMock });
    const api = new CatalogApi(client);
    const res = await api.lowLevels({ family: 'basses', limit: 10 });
    expect(res.groups[0]?.presetCount).toBe(4);
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/catalog/low-levels?family=basses&limit=10');
  });

  it('auditSummary() hits /api/catalog/audit-summary', async () => {
    const fetchMock = makeFetchMock(async () =>
      jsonResponse(200, {
        catalogContentHash: 'a',
        auditContentHash: 'b',
        catalogRowsChecked: 100,
        matched: 90,
        missing: 10,
        perFamily: {},
      }),
    );
    const client = new BrainClient({ fetch: fetchMock });
    const api = new CatalogApi(client);
    const s = await api.auditSummary();
    expect(s.matched).toBe(90);
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/catalog/audit-summary');
  });
});
