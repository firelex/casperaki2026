/**
 * Catalog view helpers.
 *
 * Pure projection functions used by the Catalog browser panel. They
 * turn the brain's `CatalogEntry` records into rows + filter labels
 * suitable for declarative rendering. Kept separate from `song.ts` so
 * the catalog surface stays self-contained.
 */

import type { CatalogCount, CatalogEntry } from '../api/catalog';

/** A single value used for a `<select>` option, sourced either from a
 *  string vocabulary (mainStyles) or from a `{key, count}` summary count. */
export interface FilterOption {
  readonly value: string;
  readonly label: string;
}

/** Sentinel used to filter for entries where the column is literally `null`. */
export const NULL_FILTER_VALUE = '__null__';
const NULL_FILTER_LABEL = '— none —';

/** Pretty label for a CatalogCount (the brain emits `__null__` for the
 *  "library was blank" bucket; we render that as `— none —`). */
export function labelForCount(count: CatalogCount): string {
  const label = count.key === NULL_FILTER_VALUE ? NULL_FILTER_LABEL : count.key;
  return `${label} (${count.count})`;
}

/** Build a `<select>` option list out of a `{key, count}` summary array.
 *  Always returns an empty-default option first. */
export function filterOptionsFromCounts(
  counts: readonly CatalogCount[],
  allLabel = 'All',
): readonly FilterOption[] {
  const all: FilterOption = { value: '', label: allLabel };
  const opts = counts.map((c) => ({ value: c.key, label: labelForCount(c) }));
  return [all, ...opts];
}

/** Build a `<select>` option list from a plain string vocabulary
 *  (mainStyles / addStyles). The all-option is first. */
export function filterOptionsFromVocabulary(
  values: readonly string[],
  allLabel = 'All',
): readonly FilterOption[] {
  return [
    { value: '', label: allLabel },
    ...values.map((v) => ({ value: v, label: v })),
  ];
}

/** Row projection consumed by the catalog table component. */
export interface CatalogEntryRow {
  readonly id: string;
  /** Display title: the entry's public instrument name. */
  readonly displayName: string;
  readonly family: string;
  readonly lowLevel: string;
  readonly familyLowLevel: string;
  readonly styleLabel: string;
  readonly libraryLabel: string;
  readonly availabilityLabel: string;
  readonly matchedPath: string;
  readonly sourceLabel: string;
  readonly matchedRule: string;
}

/** Project one validated entry to a row shape suitable for table/card rendering. */
export function projectEntry(entry: CatalogEntry): CatalogEntryRow {
  return {
    id: entry.id,
    displayName: entry.publicName,
    family: entry.family,
    lowLevel: entry.lowLevel,
    familyLowLevel: `${entry.family} / ${entry.lowLevel}`,
    styleLabel: formatStyleLabel(entry),
    libraryLabel: entry.library ?? '— none —',
    availabilityLabel: `audit:${entry.matchedRule}`,
    matchedPath: entry.matchedPath,
    sourceLabel: `${entry.sourceSheet} row ${entry.sourceRow}`,
    matchedRule: entry.matchedRule,
  };
}

/** Compose `mainStyle` + `addStyles` into a single human label, e.g.
 *  `brightPop +ballad,edm`. Empty for completely-unstyled rows. */
export function formatStyleLabel(entry: CatalogEntry): string {
  const main = entry.mainStyle ?? '—';
  const adds = entry.addStyles.length > 0 ? ` +${entry.addStyles.join(',')}` : '';
  return `${main}${adds}`;
}
