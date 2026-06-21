/**
 * Brain `catalog` API.
 *
 * Read-only browser for the validated catalog. Matches:
 *   GET /api/catalog/summary
 *   GET /api/catalog/instruments
 *   GET /api/catalog/instruments/:id
 *   GET /api/catalog/audit-summary
 *
 * The browser never walks the live sample folder. The shapes here are
 * the brain's serialised projections of `loadValidatedCatalog()` +
 * `loadInstrumentCatalogSnapshot()`. See docs/54e-ui-catalog-browser.md.
 */

import { BrainClient, defaultBrainClient } from './client';

export interface CatalogCount {
  readonly key: string;
  readonly count: number;
}

export interface CatalogSummary {
  readonly catalogContentHash: string;
  readonly auditContentHash: string;
  readonly totalCatalogEntries: number;
  readonly validatedEntries: number;
  readonly missingEntries: number;
  readonly families: readonly CatalogCount[];
  readonly lowLevels: readonly CatalogCount[];
  readonly mainStyles: readonly string[];
  readonly addStyles: readonly string[];
  readonly lowLevelByFamily: Readonly<Record<string, readonly string[]>>;
  readonly libraries: readonly CatalogCount[];
  readonly extractedAt: string;
  readonly importer: string;
}

/** One audit-passing catalog row, identical to the brain's
 *  `ValidatedCatalogEntry`. */
export interface CatalogEntry {
  readonly id: string;
  readonly family: string;
  readonly lowLevel: string;
  readonly mainStyle: string | null;
  readonly addStyles: readonly string[];
  readonly library: string | null;
  readonly preset: string | null;
  readonly info: string | null;
  readonly addPlugins: string | null;
  readonly bpm: number | null;
  readonly key: string | null;
  readonly normalisation: string | null;
  readonly status: string | null;
  readonly legacyReplacement: string | null;
  readonly sourceSheet: string;
  readonly sourceRow: number;
  readonly matchedPath: string;
  readonly matchedRule: string;
}

export interface CatalogListResponse {
  readonly total: number;
  readonly cursor: number;
  readonly limit: number;
  readonly nextCursor: number | null;
  readonly entries: readonly CatalogEntry[];
  readonly catalogContentHash: string;
  readonly auditContentHash: string;
}

/** A unique (family, lowLevel) row from `GET /api/catalog/low-levels`.
 *  The browser shows one of these per row rather than one
 *  `CatalogEntry` so noisy lowLevels (e.g. `acousticGuitarsNylonStereo`)
 *  don't repeat. The detail rail expands into the underlying presets. */
export interface CatalogLowLevelGroup {
  readonly family: string;
  readonly lowLevel: string;
  readonly presetCount: number;
  readonly libraries: readonly string[];
  readonly mainStyles: readonly string[];
  readonly addStyles: readonly string[];
  readonly sampleEntryId: string;
  readonly sampleMatchedRule: string;
}

export interface CatalogLowLevelListResponse {
  readonly total: number;
  readonly cursor: number;
  readonly limit: number;
  readonly nextCursor: number | null;
  readonly groups: readonly CatalogLowLevelGroup[];
  readonly catalogContentHash: string;
  readonly auditContentHash: string;
}

export interface CatalogLowLevelQuery {
  readonly family?: string;
  readonly mainStyle?: string;
  readonly addStyle?: string;
  readonly library?: string;
  readonly q?: string;
  readonly limit?: number;
  readonly cursor?: number;
}

export interface CatalogEntryResponse {
  readonly entry: CatalogEntry;
  readonly catalogContentHash: string;
  readonly auditContentHash: string;
}

export interface CatalogAuditSummary {
  readonly catalogContentHash: string;
  readonly auditContentHash: string;
  readonly catalogRowsChecked: number;
  readonly matched: number;
  readonly missing: number;
  readonly perFamily: Readonly<
    Record<string, { readonly rowsChecked: number; readonly matched: number; readonly missing: number }>
  >;
}

export interface CatalogListQuery {
  readonly family?: string;
  readonly lowLevel?: string;
  readonly mainStyle?: string;
  readonly addStyle?: string;
  readonly library?: string;
  readonly q?: string;
  readonly limit?: number;
  readonly cursor?: number;
}

export class CatalogApi {
  constructor(private readonly client: BrainClient = defaultBrainClient) {}

  summary(signal?: AbortSignal): Promise<CatalogSummary> {
    return this.client.get<CatalogSummary>('/api/catalog/summary', { signal });
  }

  list(query: CatalogListQuery = {}, signal?: AbortSignal): Promise<CatalogListResponse> {
    const qs = buildQueryString(query);
    const path = qs ? `/api/catalog/instruments?${qs}` : '/api/catalog/instruments';
    return this.client.get<CatalogListResponse>(path, { signal });
  }

  lowLevels(
    query: CatalogLowLevelQuery = {},
    signal?: AbortSignal,
  ): Promise<CatalogLowLevelListResponse> {
    const qs = buildQueryString({ ...query });
    const path = qs ? `/api/catalog/low-levels?${qs}` : '/api/catalog/low-levels';
    return this.client.get<CatalogLowLevelListResponse>(path, { signal });
  }

  get(id: string, signal?: AbortSignal): Promise<CatalogEntryResponse> {
    return this.client.get<CatalogEntryResponse>(
      `/api/catalog/instruments/${encodeURIComponent(id)}`,
      { signal },
    );
  }

  auditSummary(signal?: AbortSignal): Promise<CatalogAuditSummary> {
    return this.client.get<CatalogAuditSummary>('/api/catalog/audit-summary', { signal });
  }
}

/** Build a stable URL-encoded query string from a CatalogListQuery /
 *  CatalogLowLevelQuery. Empty / undefined values are dropped so the
 *  brain never sees `family=`. */
export function buildQueryString(
  query: CatalogListQuery | CatalogLowLevelQuery,
): string {
  const parts: string[] = [];
  const push = (key: string, value: string | number | undefined) => {
    if (value === undefined) return;
    const str = typeof value === 'number' ? String(value) : value;
    if (str.length === 0) return;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(str)}`);
  };
  const list = query as CatalogListQuery;
  push('family', list.family);
  push('lowLevel', list.lowLevel);
  push('mainStyle', list.mainStyle);
  push('addStyle', list.addStyle);
  push('library', list.library);
  push('q', list.q);
  push('limit', list.limit);
  push('cursor', list.cursor);
  return parts.join('&');
}

export const catalogApi = new CatalogApi();

export const catalogQueryKeys = {
  summary: () => ['catalog', 'summary'] as const,
  list: (query: CatalogListQuery) => ['catalog', 'list', query] as const,
  lowLevels: (query: CatalogLowLevelQuery) =>
    ['catalog', 'lowLevels', query] as const,
  entry: (id: string) => ['catalog', 'entry', id] as const,
  auditSummary: () => ['catalog', 'audit-summary'] as const,
};
