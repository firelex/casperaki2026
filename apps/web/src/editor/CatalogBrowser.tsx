import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import {
  catalogApi,
  catalogQueryKeys,
  type CatalogEntry,
  type CatalogListQuery,
  type CatalogLowLevelGroup,
  type CatalogLowLevelQuery,
  type CatalogSummary,
} from '../api/catalog';
import {
  filterOptionsFromCounts,
  filterOptionsFromVocabulary,
  projectEntry,
} from '../types/catalog';

/**
 * Read-only catalog browser.
 *
 * The main table shows one row per **unique `(family, lowLevel)`** so
 * noisy lowLevels (e.g. `acousticGuitarsNylonStereo`, which carries
 * four catalog rows) don't repeat. Selecting a row opens a detail rail
 * listing the underlying presets (full validated catalog entries),
 * and selecting one of those drills further to the row-level metadata.
 *
 * Backed entirely by `loadValidatedCatalog()` on the brain — no live
 * sample-folder access, no per-row file streaming, no upload / mutation.
 * Future instrument-replacement and admin-audit workflows hang off this
 * surface; see docs/54e-ui-catalog-browser.md for the deferred items.
 */

const PAGE_SIZE = 50;
const PRESETS_PAGE_SIZE = 200;

export interface CatalogBrowserProps {
  /** Optional initial focus on a concrete catalog entry id. The browser
   *  fetches the entry, derives its (family, lowLevel), and pre-selects
   *  that group + the entry inside it. */
  readonly initialFocusId?: string;
}

interface GroupKey {
  readonly family: string;
  readonly lowLevel: string;
}

function groupKeyEqual(a: GroupKey | undefined, b: GroupKey | undefined): boolean {
  if (!a || !b) return false;
  return a.family === b.family && a.lowLevel === b.lowLevel;
}

export function CatalogBrowser({ initialFocusId }: CatalogBrowserProps) {
  const [family, setFamily] = useState('');
  const [mainStyle, setMainStyle] = useState('');
  const [addStyle, setAddStyle] = useState('');
  const [library, setLibrary] = useState('');
  const [q, setQ] = useState('');
  const [cursor, setCursor] = useState(0);
  const [selectedGroup, setSelectedGroup] = useState<GroupKey | undefined>(undefined);
  const [selectedEntryId, setSelectedEntryId] = useState<string | undefined>(initialFocusId);

  const groupQuery: CatalogLowLevelQuery = useMemo(
    () => ({
      family: family || undefined,
      mainStyle: mainStyle || undefined,
      addStyle: addStyle || undefined,
      library: library || undefined,
      q: q || undefined,
      limit: PAGE_SIZE,
      cursor,
    }),
    [family, mainStyle, addStyle, library, q, cursor],
  );

  const summary = useQuery({
    queryKey: catalogQueryKeys.summary(),
    queryFn: ({ signal }) => catalogApi.summary(signal),
    staleTime: 5 * 60 * 1000,
  });

  const groups = useQuery({
    queryKey: catalogQueryKeys.lowLevels(groupQuery),
    queryFn: ({ signal }) => catalogApi.lowLevels(groupQuery, signal),
    placeholderData: (prev) => prev,
  });

  // When a `focus=<entryId>` lands on the URL, fetch the entry so we
  // can derive its (family, lowLevel) and pre-select the corresponding
  // group. Without this the rail would show the entry but the table
  // wouldn't reveal which group it lives under.
  const focusEntry = useQuery({
    queryKey: catalogQueryKeys.entry(initialFocusId ?? ''),
    queryFn: ({ signal }) => catalogApi.get(initialFocusId as string, signal),
    enabled: Boolean(initialFocusId) && !selectedGroup,
    retry: 0,
  });
  useEffect(() => {
    if (focusEntry.data && !selectedGroup) {
      setSelectedGroup({
        family: focusEntry.data.entry.family,
        lowLevel: focusEntry.data.entry.lowLevel,
      });
      setSelectedEntryId(focusEntry.data.entry.id);
    }
  }, [focusEntry.data, selectedGroup]);

  // Presets under the currently-selected group.
  const presetsQuery: CatalogListQuery | undefined = selectedGroup
    ? {
        family: selectedGroup.family,
        lowLevel: selectedGroup.lowLevel,
        limit: PRESETS_PAGE_SIZE,
        cursor: 0,
      }
    : undefined;
  const presets = useQuery({
    queryKey: catalogQueryKeys.list(presetsQuery ?? { limit: PRESETS_PAGE_SIZE }),
    queryFn: ({ signal }) => catalogApi.list(presetsQuery as CatalogListQuery, signal),
    enabled: Boolean(presetsQuery),
  });

  const entryDetail = useQuery({
    queryKey: catalogQueryKeys.entry(selectedEntryId ?? ''),
    queryFn: ({ signal }) => catalogApi.get(selectedEntryId as string, signal),
    enabled: Boolean(selectedEntryId),
    retry: 0,
  });

  const resetCursor = () => setCursor(0);

  const groupRows = groups.data?.groups ?? [];

  return (
    <div className="flex flex-col h-full w-full text-white">
      <SummaryStrip summary={summary.data} loading={summary.isLoading} />

      <FiltersRow
        summary={summary.data}
        family={family}
        onFamilyChange={(v) => {
          setFamily(v);
          resetCursor();
        }}
        mainStyle={mainStyle}
        onMainStyleChange={(v) => {
          setMainStyle(v);
          resetCursor();
        }}
        addStyle={addStyle}
        onAddStyleChange={(v) => {
          setAddStyle(v);
          resetCursor();
        }}
        library={library}
        onLibraryChange={(v) => {
          setLibrary(v);
          resetCursor();
        }}
        q={q}
        onQChange={(v) => {
          setQ(v);
          resetCursor();
        }}
      />

      <div className="flex-1 flex min-h-0">
        <div className="flex-1 min-w-0 flex flex-col border-r border-line/60">
          <ResultsHeader
            total={groups.data?.total ?? 0}
            cursor={cursor}
            limit={PAGE_SIZE}
            loading={groups.isFetching}
            label="lowLevels"
          />
          <div className="flex-1 overflow-auto">
            {groups.isError ? (
              <p className="p-6 text-err text-[13px]">
                {(groups.error as Error).message}
              </p>
            ) : groupRows.length === 0 ? (
              <p className="p-6 text-muted text-[13px]">
                No lowLevels match the current filters.
              </p>
            ) : (
              <table className="w-full text-[13px] text-left">
                <thead className="sticky top-0 bg-panel z-10 text-[11px] uppercase tracking-wider text-muted">
                  <tr>
                    <th className="px-4 py-2">lowLevel</th>
                    <th className="px-4 py-2">Family</th>
                    <th className="px-4 py-2">Presets</th>
                    <th className="px-4 py-2">Libraries</th>
                    <th className="px-4 py-2">Styles</th>
                  </tr>
                </thead>
                <tbody>
                  {groupRows.map((row) => {
                    const active = groupKeyEqual(selectedGroup, {
                      family: row.family,
                      lowLevel: row.lowLevel,
                    });
                    return (
                      <tr
                        key={`${row.family}/${row.lowLevel}`}
                        className={`border-b border-line/30 cursor-pointer transition-colors ${
                          active ? 'bg-accent/15 text-white' : 'hover:bg-white/5'
                        }`}
                        onClick={() => {
                          setSelectedGroup({
                            family: row.family,
                            lowLevel: row.lowLevel,
                          });
                          setSelectedEntryId(undefined);
                        }}
                      >
                        <td className="px-4 py-2 text-white font-mono">{row.lowLevel}</td>
                        <td className="px-4 py-2 text-white/70">{row.family}</td>
                        <td className="px-4 py-2 text-white/85 font-mono">
                          {row.presetCount}
                        </td>
                        <td className="px-4 py-2 text-white/70 truncate max-w-[260px]">
                          {summarizeChips(row.libraries)}
                        </td>
                        <td className="px-4 py-2 text-white/60 truncate max-w-[220px]">
                          {summarizeStyles(row)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          <Pagination
            cursor={cursor}
            limit={PAGE_SIZE}
            total={groups.data?.total ?? 0}
            nextCursor={groups.data?.nextCursor ?? null}
            onPrev={() => setCursor((c) => Math.max(0, c - PAGE_SIZE))}
            onNext={() => groups.data?.nextCursor != null && setCursor(groups.data.nextCursor)}
          />
        </div>

        <DetailRail
          selectedGroup={selectedGroup}
          presets={presets.data?.entries ?? []}
          presetsLoading={presets.isLoading}
          presetsError={presets.error as Error | undefined}
          selectedEntryId={selectedEntryId}
          selectedEntry={entryDetail.data?.entry}
          onClearGroup={() => {
            setSelectedGroup(undefined);
            setSelectedEntryId(undefined);
          }}
          onSelectEntry={(id) => setSelectedEntryId(id)}
        />
      </div>
    </div>
  );
}

function summarizeChips(values: readonly string[]): string {
  if (values.length === 0) return '—';
  if (values.length <= 3) return values.join(', ');
  return `${values.slice(0, 3).join(', ')} +${values.length - 3}`;
}

function summarizeStyles(group: CatalogLowLevelGroup): string {
  const main = group.mainStyles.length > 0 ? group.mainStyles.join(',') : '—';
  const add = group.addStyles.length > 0 ? ` +${group.addStyles.join(',')}` : '';
  return `${main}${add}`;
}

function SummaryStrip({
  summary,
  loading,
}: {
  summary: CatalogSummary | undefined;
  loading: boolean;
}) {
  if (loading) {
    return (
      <div className="px-6 py-4 text-muted text-[12px] border-b border-line/60">
        Loading catalog summary…
      </div>
    );
  }
  if (!summary) {
    return (
      <div className="px-6 py-4 text-err text-[12px] border-b border-line/60">
        No catalog summary available — is the brain running?
      </div>
    );
  }
  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-x-6 gap-y-2 px-6 py-4 border-b border-line/60">
      <Stat label="Validated entries" value={summary.validatedEntries.toLocaleString()} />
      <Stat
        label="Catalog total"
        value={`${summary.totalCatalogEntries.toLocaleString()} (–${summary.missingEntries})`}
      />
      <Stat label="Families" value={summary.families.length.toString()} />
      <Stat
        label="Catalog hash"
        value={summary.catalogContentHash.slice(0, 12)}
        mono
        title={summary.catalogContentHash}
      />
      <Stat
        label="Audit hash"
        value={summary.auditContentHash.slice(0, 12)}
        mono
        title={summary.auditContentHash}
      />
    </div>
  );
}

function Stat({
  label,
  value,
  mono,
  title,
}: {
  label: string;
  value: string;
  mono?: boolean;
  title?: string;
}) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-[0.16em] text-dim font-semibold">
        {label}
      </span>
      <span
        className={`text-[14px] text-white ${mono ? 'font-mono text-[12px]' : ''}`}
        title={title}
      >
        {value}
      </span>
    </div>
  );
}

interface FiltersRowProps {
  summary: CatalogSummary | undefined;
  family: string;
  onFamilyChange(value: string): void;
  mainStyle: string;
  onMainStyleChange(value: string): void;
  addStyle: string;
  onAddStyleChange(value: string): void;
  library: string;
  onLibraryChange(value: string): void;
  q: string;
  onQChange(value: string): void;
}

function FiltersRow(props: FiltersRowProps) {
  const summary = props.summary;
  const families = summary ? filterOptionsFromCounts(summary.families, 'All families') : [];
  const mainStyles = summary
    ? filterOptionsFromVocabulary(summary.mainStyles, 'All main styles')
    : [];
  const addStyles = summary
    ? filterOptionsFromVocabulary(summary.addStyles, 'All add styles')
    : [];
  const libraries = summary
    ? filterOptionsFromCounts(summary.libraries, 'All libraries')
    : [];

  return (
    <div className="flex flex-wrap items-end gap-3 px-6 py-3 border-b border-line/60">
      <FilterSelect
        label="Family"
        value={props.family}
        onChange={props.onFamilyChange}
        options={families}
      />
      <FilterSelect
        label="Main style"
        value={props.mainStyle}
        onChange={props.onMainStyleChange}
        options={mainStyles}
      />
      <FilterSelect
        label="Add style"
        value={props.addStyle}
        onChange={props.onAddStyleChange}
        options={addStyles}
      />
      <FilterSelect
        label="Library"
        value={props.library}
        onChange={props.onLibraryChange}
        options={libraries}
      />
      <div className="flex flex-col">
        <span className="text-[10px] uppercase tracking-[0.16em] text-dim font-semibold">
          Search
        </span>
        <input
          type="search"
          value={props.q}
          onChange={(e) => props.onQChange(e.target.value)}
          placeholder="name / lowLevel / preset / library / path…"
          className="h-9 mt-1 px-3 rounded-md bg-panel border border-line text-[13px] text-white placeholder:text-dim focus:outline-none focus:border-accent w-[240px]"
        />
      </div>
    </div>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
  disabled,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  options: readonly { value: string; label: string }[];
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-col">
      <label className="text-[10px] uppercase tracking-[0.16em] text-dim font-semibold">
        {label}
      </label>
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 mt-1 px-2 rounded-md bg-panel border border-line text-[13px] text-white disabled:opacity-50 focus:outline-none focus:border-accent min-w-[160px]"
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function ResultsHeader({
  total,
  cursor,
  limit,
  loading,
  label,
}: {
  total: number;
  cursor: number;
  limit: number;
  loading: boolean;
  label: string;
}) {
  const end = Math.min(total, cursor + limit);
  return (
    <div className="px-4 py-2 flex items-center justify-between border-b border-line/40 text-[12px] text-muted">
      <span>
        {total === 0
          ? `No ${label}`
          : `Showing ${cursor + 1}–${end} of ${total.toLocaleString()} ${label}`}
      </span>
      {loading ? <span className="text-dim font-mono">refreshing…</span> : null}
    </div>
  );
}

function Pagination({
  cursor,
  total,
  limit,
  nextCursor,
  onPrev,
  onNext,
}: {
  cursor: number;
  total: number;
  limit: number;
  nextCursor: number | null;
  onPrev(): void;
  onNext(): void;
}) {
  const page = Math.floor(cursor / limit) + 1;
  const lastPage = Math.max(1, Math.ceil(total / limit));
  return (
    <div className="flex items-center justify-between px-4 py-2 border-t border-line/40 text-[12px]">
      <button
        type="button"
        className="h-8 px-3 rounded-md bg-panel border border-line text-white/85 hover:border-accent disabled:opacity-40 disabled:cursor-not-allowed"
        disabled={cursor === 0}
        onClick={onPrev}
      >
        ← Prev
      </button>
      <span className="text-dim font-mono">
        page {page} / {lastPage}
      </span>
      <button
        type="button"
        className="h-8 px-3 rounded-md bg-panel border border-line text-white/85 hover:border-accent disabled:opacity-40 disabled:cursor-not-allowed"
        disabled={nextCursor === null}
        onClick={onNext}
      >
        Next →
      </button>
    </div>
  );
}

function DetailRail({
  selectedGroup,
  presets,
  presetsLoading,
  presetsError,
  selectedEntryId,
  selectedEntry,
  onClearGroup,
  onSelectEntry,
}: {
  selectedGroup: GroupKey | undefined;
  presets: readonly CatalogEntry[];
  presetsLoading: boolean;
  presetsError: Error | undefined;
  selectedEntryId: string | undefined;
  selectedEntry: CatalogEntry | undefined;
  onClearGroup(): void;
  onSelectEntry(id: string): void;
}) {
  return (
    <aside className="w-[420px] shrink-0 overflow-auto bg-panel/40">
      <header className="flex items-center justify-between px-5 py-3 border-b border-line/40">
        <h3 className="text-[14px] font-semibold uppercase tracking-wider text-muted">
          {selectedGroup ? `${selectedGroup.family} / ${selectedGroup.lowLevel}` : 'Detail'}
        </h3>
        {selectedGroup ? (
          <button
            type="button"
            onClick={onClearGroup}
            className="text-[11px] text-dim hover:text-white"
          >
            clear
          </button>
        ) : null}
      </header>

      {!selectedGroup ? (
        <p className="px-5 py-6 text-dim text-[12px]">
          Select a lowLevel to inspect the underlying preset entries.
        </p>
      ) : presetsLoading ? (
        <p className="px-5 py-6 text-muted text-[12px]">Loading presets…</p>
      ) : presetsError ? (
        <p className="px-5 py-6 text-err text-[12px]">{presetsError.message}</p>
      ) : (
        <div className="flex flex-col">
          <div className="px-5 py-2 text-[11px] text-dim font-mono">
            {presets.length} {presets.length === 1 ? 'preset' : 'presets'}
          </div>
          <ul className="flex flex-col">
            {presets.map((entry) => {
              const row = projectEntry(entry);
              const active = entry.id === selectedEntryId;
              return (
                <li key={entry.id}>
                  <button
                    type="button"
                    onClick={() => onSelectEntry(entry.id)}
                    className={`w-full text-left px-5 py-2 border-b border-line/30 transition-colors ${
                      active ? 'bg-accent/15 text-white' : 'hover:bg-white/5'
                    }`}
                  >
                    <div className="text-[12.5px] text-white truncate">
                      {row.displayName}
                    </div>
                    <div className="text-[10.5px] text-dim font-mono flex gap-2">
                      <span>{entry.id.slice(0, 8)}</span>
                      <span>{row.styleLabel}</span>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>

          {selectedEntry ? (
            <div className="border-t border-line/40 px-5 py-4 flex flex-col gap-3 text-[12px]">
              <DetailRow label="Catalog id" value={selectedEntry.id} mono />
              <DetailRow label="Name" value={selectedEntry.publicName} />
              <DetailRow label="Source preset" value={selectedEntry.preset ?? '—'} />
              <DetailRow label="Source library" value={selectedEntry.library ?? '—'} />
              <DetailRow
                label="Styles"
                value={`${selectedEntry.mainStyle ?? '—'}${
                  selectedEntry.addStyles.length > 0
                    ? ` +${selectedEntry.addStyles.join(',')}`
                    : ''
                }`}
              />
              <DetailRow
                label="Key / BPM"
                value={`${selectedEntry.key ?? '—'} · ${selectedEntry.bpm ?? '—'}`}
              />
              <DetailRow label="Status" value={selectedEntry.status ?? '—'} />
              <DetailRow label="Info" value={selectedEntry.info ?? '—'} />
              <DetailRow
                label="Source"
                value={`${selectedEntry.sourceSheet} row ${selectedEntry.sourceRow}`}
              />
              <div className="border-t border-line/30 pt-3 flex flex-col">
                <span className="text-[10px] uppercase tracking-[0.16em] text-dim font-semibold">
                  Audit match
                </span>
                <span className="text-[11px] font-mono text-white/85 mt-1">
                  rule = {selectedEntry.matchedRule}
                </span>
                <code className="text-[10.5px] font-mono text-white/70 break-all mt-2 leading-snug">
                  {selectedEntry.matchedPath}
                </code>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </aside>
  );
}

function DetailRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-[0.16em] text-dim font-semibold">
        {label}
      </span>
      <span className={`text-[13px] text-white/90 ${mono ? 'font-mono text-[12px]' : ''}`}>
        {value}
      </span>
    </div>
  );
}
