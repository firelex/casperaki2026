// Read-only catalog browser endpoints.
//
// Surfaces the audit-passing validated catalog plus the snapshot's
// vocabulary so the frontend Catalog tab can browse what the brain
// would actually pick from. Never walks the live sample folder; reads
// only `loadValidatedCatalog()` + `loadEffectiveCatalogSnapshot()`.
//
//   GET /api/catalog/summary
//     counts, hashes, vocabularies, top library list, matched/missing.
//   GET /api/catalog/instruments?family=&lowLevel=&mainStyle=&addStyle=&library=&q=&limit=&cursor=
//     paginated validated entries (page = `limit` rows starting at `cursor`).
//   GET /api/catalog/instruments/:id
//     one validated entry, with matchedPath/matchedRule + provenance hashes.
//   GET /api/catalog/audit-summary
//     audit summary counts + per-family + variant-pool count.
//
// Documented in docs/54e-ui-catalog-browser.md.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import {
  loadEffectiveCatalogSnapshot,
  loadValidatedCatalog,
  publicNameOf,
  type InstrumentCatalogSnapshot,
  type ValidatedCatalog,
  type ValidatedCatalogEntry,
} from '@casperaki/arrangement';

// The list query is the group query plus a `lowLevel` filter; derive it so
// the shared filter fields can't drift between the two.
const GroupQuerySchema = z
  .object({
    family: z.string().optional(),
    mainStyle: z.string().optional(),
    addStyle: z.string().optional(),
    library: z.string().optional(),
    q: z.string().optional(),
    limit: z.coerce.number().int().positive().max(500).optional(),
    cursor: z.coerce.number().int().nonnegative().optional(),
  })
  .strict();

const ListQuerySchema = GroupQuerySchema.extend({
  lowLevel: z.string().optional(),
}).strict();

export interface CatalogRouterDeps {
  /** Optional injection points for tests. Default to the package loaders. */
  readonly loadCatalog?: () => ValidatedCatalog;
  readonly loadSnapshot?: () => InstrumentCatalogSnapshot;
  /** Whether this request may browse the catalog (summary, lists). Single
   *  entries by id are always served. Defaults to everyone. */
  readonly canBrowse?: (req: Request) => boolean;
  /** Public name of an entry; defaults to the instrument-aliases registry. */
  readonly publicName?: (entry: ValidatedCatalogEntry) => string;
}

/** A catalog entry as the API sends it: with its public instrument name. */
export type PublicCatalogEntry = ValidatedCatalogEntry & { readonly publicName: string };

export function createCatalogRouter(deps: CatalogRouterDeps = {}): Router {
  const router = Router();
  const loadCat = deps.loadCatalog ?? loadValidatedCatalog;
  // The validated catalog is built from the effective snapshot (xlsx ∪ disk,
  // docs/58h), so totals and "missing" must be counted against that too.
  const loadSnap = deps.loadSnapshot ?? loadEffectiveCatalogSnapshot;
  const browseGate = (req: Request, res: Response, next: () => void) => {
    if (deps.canBrowse && !deps.canBrowse(req)) {
      res.status(403).json({ error: 'admin_only', message: 'Browsing the sound catalog is limited to admins.' });
      return;
    }
    next();
  };
  router.use(['/api/catalog/summary', '/api/catalog/low-levels', '/api/catalog/audit-summary'], browseGate);
  router.get('/api/catalog/instruments', browseGate);
  const nameOf = deps.publicName ?? ((e: ValidatedCatalogEntry) => publicNameOf(e));
  const withName = (e: ValidatedCatalogEntry): PublicCatalogEntry => ({ ...e, publicName: nameOf(e) });

  router.get('/api/catalog/summary', (_req: Request, res: Response) => {
    const catalog = loadCat();
    const snapshot = loadSnap();
    res.json(buildSummary(catalog, snapshot));
  });

  router.get('/api/catalog/instruments', (req, res) => {
    const parsed = ListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'invalid_query',
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
    }
    const catalog = loadCat();
    const limit = parsed.data.limit ?? 50;
    const cursor = parsed.data.cursor ?? 0;
    const filtered = filterEntries(catalog.entries, parsed.data, nameOf);
    const page = filtered.slice(cursor, cursor + limit).map(withName);
    const nextCursor = cursor + page.length < filtered.length ? cursor + page.length : null;
    return res.json({
      total: filtered.length,
      cursor,
      limit,
      nextCursor,
      entries: page,
      catalogContentHash: catalog.catalogContentHash,
      auditContentHash: catalog.auditContentHash,
    });
  });

  router.get('/api/catalog/low-levels', (req, res) => {
    const parsed = GroupQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'invalid_query',
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
    }
    const catalog = loadCat();
    const limit = parsed.data.limit ?? 50;
    const cursor = parsed.data.cursor ?? 0;
    // The frontend asks for "unique lowLevels". One row per (family,
    // lowLevel); we keep family in the key so e.g. the `keys` /
    // `synths` families never collide on a shared lowLevel name.
    const filtered = filterEntries(catalog.entries, { ...parsed.data, lowLevel: undefined }, nameOf);
    const groups = groupByLowLevel(filtered);
    const page = groups.slice(cursor, cursor + limit);
    const nextCursor = cursor + page.length < groups.length ? cursor + page.length : null;
    return res.json({
      total: groups.length,
      cursor,
      limit,
      nextCursor,
      groups: page,
      catalogContentHash: catalog.catalogContentHash,
      auditContentHash: catalog.auditContentHash,
    });
  });

  router.get('/api/catalog/instruments/:id', (req, res) => {
    const catalog = loadCat();
    const entry = catalog.byId.get(req.params.id);
    if (!entry) {
      return res.status(404).json({ error: 'not_found', id: req.params.id });
    }
    return res.json({
      entry: withName(entry),
      catalogContentHash: catalog.catalogContentHash,
      auditContentHash: catalog.auditContentHash,
    });
  });

  router.get('/api/catalog/audit-summary', (_req, res) => {
    const catalog = loadCat();
    const snapshot = loadSnap();
    const auditEntries = catalog.entries.length;
    const totalEntries = snapshot.entries.length;
    const missingCount = totalEntries - auditEntries;
    res.json({
      catalogContentHash: catalog.catalogContentHash,
      auditContentHash: catalog.auditContentHash,
      catalogRowsChecked: totalEntries,
      matched: auditEntries,
      missing: missingCount,
      perFamily: perFamilyCounts(catalog.entries, snapshot),
    });
  });

  return router;
}

interface FilterOptions {
  readonly family?: string;
  readonly lowLevel?: string;
  readonly mainStyle?: string;
  readonly addStyle?: string;
  readonly library?: string;
  readonly q?: string;
}

export function filterEntries(
  entries: readonly ValidatedCatalogEntry[],
  opts: FilterOptions,
  publicName?: (entry: ValidatedCatalogEntry) => string,
): readonly ValidatedCatalogEntry[] {
  const qLower = opts.q?.trim().toLowerCase();
  return entries.filter((e) => {
    if (opts.family && e.family !== opts.family) return false;
    if (opts.lowLevel && e.lowLevel !== opts.lowLevel) return false;
    if (opts.mainStyle) {
      if (opts.mainStyle === '__null__') {
        if (e.mainStyle !== null) return false;
      } else if (e.mainStyle !== opts.mainStyle) return false;
    }
    if (opts.addStyle && !e.addStyles.includes(opts.addStyle as never)) return false;
    if (opts.library) {
      if (opts.library === '__null__') {
        if (e.library !== null) return false;
      } else if (e.library !== opts.library) return false;
    }
    if (qLower) {
      const hay = [
        publicName?.(e),
        e.preset,
        e.library,
        e.lowLevel,
        e.family,
        e.info,
        e.matchedPath,
        e.id,
      ]
        .filter((x): x is string => typeof x === 'string')
        .join(' ')
        .toLowerCase();
      if (!hay.includes(qLower)) return false;
    }
    return true;
  });
}

/** One row per unique `(family, lowLevel)` across the supplied entries.
 *  Used by the browser to dedupe the catalog: the user sees one row per
 *  lowLevel, not one per preset/style/library variant. */
export interface LowLevelGroup {
  readonly family: string;
  readonly lowLevel: string;
  readonly presetCount: number;
  readonly libraries: readonly string[];
  readonly mainStyles: readonly string[];
  readonly addStyles: readonly string[];
  /** Stable id of one representative entry — lets the UI deep-link
   *  directly into a concrete preset when the user just wants "any" of
   *  the variants. */
  readonly sampleEntryId: string;
  /** matchedRule of the sample entry — handy when the rule varies
   *  across the group. */
  readonly sampleMatchedRule: string;
}

export function groupByLowLevel(
  entries: readonly ValidatedCatalogEntry[],
): readonly LowLevelGroup[] {
  const groups = new Map<string, {
    family: string;
    lowLevel: string;
    libraries: Set<string>;
    mainStyles: Set<string>;
    addStyles: Set<string>;
    presetIds: Set<string>;
    sample: ValidatedCatalogEntry;
  }>();
  for (const e of entries) {
    const key = `${e.family}/${e.lowLevel}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        family: e.family,
        lowLevel: e.lowLevel,
        libraries: new Set(),
        mainStyles: new Set(),
        addStyles: new Set(),
        presetIds: new Set(),
        sample: e,
      };
      groups.set(key, g);
    }
    g.presetIds.add(e.id);
    if (e.library) g.libraries.add(e.library);
    if (e.mainStyle) g.mainStyles.add(e.mainStyle);
    for (const s of e.addStyles) g.addStyles.add(s);
  }
  return [...groups.values()]
    .map((g) => ({
      family: g.family,
      lowLevel: g.lowLevel,
      presetCount: g.presetIds.size,
      libraries: [...g.libraries].sort(),
      mainStyles: [...g.mainStyles].sort(),
      addStyles: [...g.addStyles].sort(),
      sampleEntryId: g.sample.id,
      sampleMatchedRule: g.sample.matchedRule,
    }))
    .sort((a, b) => {
      if (a.family !== b.family) return a.family < b.family ? -1 : 1;
      return a.lowLevel < b.lowLevel ? -1 : a.lowLevel > b.lowLevel ? 1 : 0;
    });
}

export function buildSummary(
  catalog: ValidatedCatalog,
  snapshot: InstrumentCatalogSnapshot,
): CatalogSummary {
  const libraries = uniqueSortedLibraries(catalog.entries);
  const families = countByKey(catalog.entries, (e) => e.family);
  const lowLevels = countByKey(catalog.entries, (e) => e.lowLevel);
  return {
    catalogContentHash: catalog.catalogContentHash,
    auditContentHash: catalog.auditContentHash,
    totalCatalogEntries: snapshot.entries.length,
    validatedEntries: catalog.entries.length,
    missingEntries: snapshot.entries.length - catalog.entries.length,
    families,
    lowLevels,
    mainStyles: snapshot.vocabulary.mainStyles,
    addStyles: snapshot.vocabulary.addStyles,
    lowLevelByFamily: snapshot.vocabulary.lowLevelByFamily,
    libraries,
    extractedAt: snapshot.LEGACY_PROVENANCE.extractedAt,
    importer: snapshot.LEGACY_PROVENANCE.importer,
  };
}

export interface CatalogSummary {
  readonly catalogContentHash: string;
  readonly auditContentHash: string;
  readonly totalCatalogEntries: number;
  readonly validatedEntries: number;
  readonly missingEntries: number;
  readonly families: ReadonlyArray<{ readonly key: string; readonly count: number }>;
  readonly lowLevels: ReadonlyArray<{ readonly key: string; readonly count: number }>;
  readonly mainStyles: readonly string[];
  readonly addStyles: readonly string[];
  readonly lowLevelByFamily: Readonly<Record<string, readonly string[]>>;
  readonly libraries: ReadonlyArray<{ readonly key: string; readonly count: number }>;
  readonly extractedAt: string;
  readonly importer: string;
}

function uniqueSortedLibraries(
  entries: readonly ValidatedCatalogEntry[],
): ReadonlyArray<{ key: string; count: number }> {
  const counts = new Map<string, number>();
  for (const e of entries) {
    const key = e.library ?? '__null__';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

function countByKey<T>(
  entries: readonly T[],
  fn: (e: T) => string,
): ReadonlyArray<{ key: string; count: number }> {
  const counts = new Map<string, number>();
  for (const e of entries) {
    const k = fn(e);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

function perFamilyCounts(
  entries: readonly ValidatedCatalogEntry[],
  snapshot: InstrumentCatalogSnapshot,
): Readonly<Record<string, { rowsChecked: number; matched: number; missing: number }>> {
  const out: Record<string, { rowsChecked: number; matched: number; missing: number }> = {};
  for (const fam of snapshot.vocabulary.families) {
    out[fam] = { rowsChecked: 0, matched: 0, missing: 0 };
  }
  for (const e of snapshot.entries) {
    (out[e.family] ??= { rowsChecked: 0, matched: 0, missing: 0 }).rowsChecked++;
  }
  for (const e of entries) {
    (out[e.family] ??= { rowsChecked: 0, matched: 0, missing: 0 }).matched++;
  }
  for (const fam of Object.keys(out)) {
    out[fam]!.missing = out[fam]!.rowsChecked - out[fam]!.matched;
  }
  return out;
}
