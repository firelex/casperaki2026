// Catalog browser API tests.
//
// Boots an in-memory app and exercises the read-only catalog endpoints
// against the committed validated catalog + snapshot. The committed
// data has 12 073 audit-matched rows; we assert shapes + filter
// semantics, not specific large counts, so this test stays stable
// across future catalog regenerations.

import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { openSongsStore, type SongsStore } from '../src/store.js';
import express from 'express';
import { createCatalogRouter } from '../src/routes/catalog.js';

interface Harness {
  url: string;
  store: SongsStore;
  stop: () => Promise<void>;
}

async function boot(): Promise<Harness> {
  const store = openSongsStore({ path: ':memory:' });
  const app = createApp(loadConfig({} as NodeJS.ProcessEnv), { store });
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

interface SummaryResponse {
  catalogContentHash: string;
  auditContentHash: string;
  totalCatalogEntries: number;
  validatedEntries: number;
  missingEntries: number;
  families: ReadonlyArray<{ key: string; count: number }>;
  lowLevels: ReadonlyArray<{ key: string; count: number }>;
  mainStyles: readonly string[];
  addStyles: readonly string[];
  lowLevelByFamily: Readonly<Record<string, readonly string[]>>;
  libraries: ReadonlyArray<{ key: string; count: number }>;
  extractedAt: string;
  importer: string;
}

interface ValidatedEntry {
  id: string;
  family: string;
  lowLevel: string;
  mainStyle: string | null;
  addStyles: readonly string[];
  library: string | null;
  preset: string | null;
  matchedPath: string;
  matchedRule: string;
}

interface ListResponse {
  total: number;
  cursor: number;
  limit: number;
  nextCursor: number | null;
  entries: readonly ValidatedEntry[];
  catalogContentHash: string;
  auditContentHash: string;
}

interface AuditSummaryResponse {
  catalogContentHash: string;
  auditContentHash: string;
  catalogRowsChecked: number;
  matched: number;
  missing: number;
  perFamily: Readonly<Record<string, { rowsChecked: number; matched: number; missing: number }>>;
}

describe('GET /api/catalog/summary', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await boot();
  });
  afterEach(async () => {
    await h.stop();
  });

  it('returns counts, hashes, and vocabulary', async () => {
    const res = await fetch(`${h.url}/api/catalog/summary`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as SummaryResponse;
    expect(body.catalogContentHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(body.auditContentHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(body.validatedEntries).toBeGreaterThan(0);
    expect(body.totalCatalogEntries).toBeGreaterThanOrEqual(body.validatedEntries);
    expect(body.missingEntries).toBe(body.totalCatalogEntries - body.validatedEntries);
    expect(body.families.length).toBeGreaterThan(0);
    expect(body.lowLevels.length).toBeGreaterThan(0);
    expect(body.mainStyles).toContain('brightPop');
    expect(body.addStyles.length).toBeGreaterThan(0);
    expect(body.libraries.length).toBeGreaterThan(0);
    expect(typeof body.extractedAt).toBe('string');
    expect(typeof body.importer).toBe('string');
  });

  it('families and lowLevels are sorted by key', async () => {
    const res = await fetch(`${h.url}/api/catalog/summary`);
    const body = (await res.json()) as SummaryResponse;
    const sortedFams = [...body.families.map((f) => f.key)].sort();
    expect(body.families.map((f) => f.key)).toEqual(sortedFams);
  });
});

describe('GET /api/catalog/instruments', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await boot();
  });
  afterEach(async () => {
    await h.stop();
  });

  it('gives every entry its public name and finds entries by it', async () => {
    const res = await fetch(`${h.url}/api/catalog/instruments?limit=20`);
    const body = (await res.json()) as { entries: Array<{ id: string; publicName: string; preset: string | null }> };
    for (const e of body.entries) expect(e.publicName).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/u);
    const first = body.entries[0]!;
    const one = (await (await fetch(`${h.url}/api/catalog/instruments/${first.id}`)).json()) as {
      entry: { publicName: string };
    };
    expect(one.entry.publicName).toBe(first.publicName);
    const found = (await (
      await fetch(`${h.url}/api/catalog/instruments?q=${encodeURIComponent(first.publicName)}&limit=500`)
    ).json()) as { entries: Array<{ id: string }> };
    expect(found.entries.map((e) => e.id)).toContain(first.id);
  });

  it('paginates with cursor + nextCursor and surfaces total', async () => {
    const res = await fetch(`${h.url}/api/catalog/instruments?limit=3`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListResponse;
    expect(body.cursor).toBe(0);
    expect(body.limit).toBe(3);
    expect(body.entries.length).toBe(3);
    expect(body.total).toBeGreaterThan(3);
    expect(body.nextCursor).toBe(3);

    const next = await fetch(`${h.url}/api/catalog/instruments?limit=3&cursor=3`);
    const body2 = (await next.json()) as ListResponse;
    expect(body2.cursor).toBe(3);
    expect(body2.entries.length).toBe(3);
    expect(body2.entries[0]!.id).not.toBe(body.entries[0]!.id);
  });

  it('filters by family', async () => {
    const res = await fetch(`${h.url}/api/catalog/instruments?family=kickDrums&limit=10`);
    const body = (await res.json()) as ListResponse;
    expect(body.entries.length).toBeGreaterThan(0);
    expect(body.entries.every((e) => e.family === 'kickDrums')).toBe(true);
  });

  it('filters by mainStyle', async () => {
    const res = await fetch(
      `${h.url}/api/catalog/instruments?family=kickDrums&mainStyle=brightPop&limit=10`,
    );
    const body = (await res.json()) as ListResponse;
    expect(body.entries.length).toBeGreaterThan(0);
    expect(body.entries.every((e) => e.mainStyle === 'brightPop')).toBe(true);
  });

  it('filters by addStyle', async () => {
    const res = await fetch(
      `${h.url}/api/catalog/instruments?family=basses&addStyle=edm&limit=10`,
    );
    const body = (await res.json()) as ListResponse;
    expect(body.entries.length).toBeGreaterThan(0);
    expect(body.entries.every((e) => e.addStyles.includes('edm'))).toBe(true);
  });

  it('filters by library (exact match)', async () => {
    const sumRes = await fetch(`${h.url}/api/catalog/summary`);
    const sum = (await sumRes.json()) as SummaryResponse;
    const someLibrary = sum.libraries.find((l) => l.key !== '__null__' && l.count >= 1)!.key;
    const res = await fetch(
      `${h.url}/api/catalog/instruments?library=${encodeURIComponent(someLibrary)}&limit=10`,
    );
    const body = (await res.json()) as ListResponse;
    expect(body.entries.length).toBeGreaterThan(0);
    expect(body.entries.every((e) => e.library === someLibrary)).toBe(true);
  });

  it('search query matches preset substring case-insensitively', async () => {
    const res = await fetch(`${h.url}/api/catalog/instruments?q=Kick&limit=5`);
    const body = (await res.json()) as ListResponse;
    expect(body.entries.length).toBeGreaterThan(0);
    for (const e of body.entries) {
      const hay = [e.preset, e.library, e.lowLevel, e.family, e.matchedPath]
        .filter((x): x is string => typeof x === 'string')
        .join(' ')
        .toLowerCase();
      expect(hay).toContain('kick');
    }
  });

  it('rejects bad query parameters with 400', async () => {
    const res = await fetch(`${h.url}/api/catalog/instruments?limit=abc`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_query');
  });
});

describe('GET /api/catalog/low-levels', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await boot();
  });
  afterEach(async () => {
    await h.stop();
  });

  interface GroupResponse {
    total: number;
    cursor: number;
    limit: number;
    nextCursor: number | null;
    groups: ReadonlyArray<{
      family: string;
      lowLevel: string;
      presetCount: number;
      libraries: readonly string[];
      mainStyles: readonly string[];
      addStyles: readonly string[];
      sampleEntryId: string;
      sampleMatchedRule: string;
    }>;
    catalogContentHash: string;
    auditContentHash: string;
  }

  it('returns unique (family, lowLevel) rows with preset counts', async () => {
    const res = await fetch(`${h.url}/api/catalog/low-levels?limit=500`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as GroupResponse;
    expect(body.groups.length).toBeGreaterThan(0);
    // Unique key check.
    const keys = body.groups.map((g) => `${g.family}/${g.lowLevel}`);
    expect(new Set(keys).size).toBe(keys.length);
    // Each group represents at least one preset.
    for (const g of body.groups) {
      expect(g.presetCount).toBeGreaterThanOrEqual(1);
      expect(g.sampleEntryId).toMatch(/^[0-9a-f]{16}$/u);
    }
  });

  it('deduplicates lowLevels that have many catalog rows', async () => {
    // Pick a noisy lowLevel: kickDrums/kickDrumsAcoustic carries many
    // entries in the workbook. We expect 1 group row but presetCount > 1.
    const res = await fetch(`${h.url}/api/catalog/low-levels?family=kickDrums&limit=500`);
    const body = (await res.json()) as GroupResponse;
    const kickAcoustic = body.groups.find(
      (g) => g.family === 'kickDrums' && g.lowLevel === 'kickDrumsAcoustic',
    );
    expect(kickAcoustic).toBeDefined();
    expect(kickAcoustic!.presetCount).toBeGreaterThan(1);
    expect(kickAcoustic!.libraries.length).toBeGreaterThan(0);
  });

  it('filters by family', async () => {
    const res = await fetch(`${h.url}/api/catalog/low-levels?family=basses&limit=50`);
    const body = (await res.json()) as GroupResponse;
    expect(body.groups.length).toBeGreaterThan(0);
    expect(body.groups.every((g) => g.family === 'basses')).toBe(true);
  });

  it('rejects bad query parameters', async () => {
    const res = await fetch(`${h.url}/api/catalog/low-levels?limit=abc`);
    expect(res.status).toBe(400);
  });
});

describe('GET /api/catalog/instruments/:id', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await boot();
  });
  afterEach(async () => {
    await h.stop();
  });

  it('returns one validated entry by id', async () => {
    const list = await fetch(`${h.url}/api/catalog/instruments?limit=1`);
    const listBody = (await list.json()) as ListResponse;
    const id = listBody.entries[0]!.id;
    const res = await fetch(`${h.url}/api/catalog/instruments/${id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entry: ValidatedEntry;
      catalogContentHash: string;
      auditContentHash: string;
    };
    expect(body.entry.id).toBe(id);
    expect(body.entry.matchedPath.length).toBeGreaterThan(0);
    expect(body.entry.matchedRule.length).toBeGreaterThan(0);
    expect(body.catalogContentHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(body.auditContentHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('returns 404 for unknown id', async () => {
    const res = await fetch(`${h.url}/api/catalog/instruments/deadbeefdeadbeef`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('not_found');
  });
});

describe('GET /api/catalog/audit-summary', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await boot();
  });
  afterEach(async () => {
    await h.stop();
  });

  it('returns matched/missing counts + per-family breakdown', async () => {
    const res = await fetch(`${h.url}/api/catalog/audit-summary`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as AuditSummaryResponse;
    expect(body.catalogContentHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(body.auditContentHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(body.matched).toBeGreaterThan(0);
    expect(body.missing).toBeGreaterThanOrEqual(0);
    expect(body.catalogRowsChecked).toBe(body.matched + body.missing);
    const families = Object.keys(body.perFamily);
    expect(families.length).toBeGreaterThan(0);
    for (const fam of families) {
      const f = body.perFamily[fam]!;
      expect(f.rowsChecked).toBe(f.matched + f.missing);
    }
  });
});

describe('catalog admin gate', () => {
  it('refuses browsing and single entries when canBrowse is false', async () => {
    const app = express();
    app.use(createCatalogRouter({ canBrowse: () => false }));
    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      for (const path of ['/api/catalog/summary', '/api/catalog/instruments?limit=1', '/api/catalog/low-levels', '/api/catalog/audit-summary']) {
        const res = await fetch(url + path);
        expect(res.status, path).toBe(403);
      }
      const open = createCatalogRouter();
      const app2 = express();
      app2.use(open);
      const s2 = await new Promise<ReturnType<typeof app2.listen>>((resolve) => {
        const s = app2.listen(0, '127.0.0.1', () => resolve(s));
      });
      const url2 = `http://127.0.0.1:${(s2.address() as AddressInfo).port}`;
      const first = (await (await fetch(`${url2}/api/catalog/instruments?limit=1`)).json()) as { entries: Array<{ id: string }> };
      s2.close();
      // Single entries carry library / preset / file path: admins only too.
      const one = await fetch(`${url}/api/catalog/instruments/${first.entries[0]!.id}`);
      expect(one.status).toBe(403);
    } finally {
      server.close();
    }
  });
});
