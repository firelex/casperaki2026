import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import { useSession } from '../state/session';
import {
  buildSegmentDetail,
  indexInstrumentDefinitions,
  patternTypesForInstrument,
  resolveInstrumentProvenance,
  soundLabel,
  type SegmentDetail,
  type InstrumentPatternSummary,
  type InstrumentProvenanceInfo,
} from '../types/song';
import {
  catalogApi,
  catalogQueryKeys,
  type CatalogEntry,
} from '../api/catalog';
import type { EditCommand } from '../state/song-edit';

/**
 * Segment Inspector — read-only side rail for the selected segment.
 *
 * Sits on the right edge of the editor body and reflects whatever the
 * session marks as `activeSegment`. The panel is intentionally
 * inspect-only for this slice (docs/54d): nothing here mutates the
 * song. Drums/Bass/Keys/Pad get a compact pattern preview; lead vocal
 * lyric lines render in segment order; fills, transitions, mutes, and
 * signal-processor blocks roll up to a chip strip so the user can see
 * at a glance whether the segment carries that kind of payload.
 */
export function SegmentInspector() {
  const {
    viewSong,
    activeSegment,
    activeBarIndex,
    setActiveBarIndex,
    applyEdit,
    editor,
  } = useSession();

  const detail = useMemo<SegmentDetail | undefined>(
    () => (viewSong ? buildSegmentDetail(viewSong, activeSegment) : undefined),
    [viewSong, activeSegment],
  );

  // Build the per-instrument provenance map for the active segment. The
  // catalog fetches piggy-back on the cache populated by the Sound Design
  // tab — same query keys, so flipping tabs is free.
  const defs = useMemo(() => indexInstrumentDefinitions(viewSong), [viewSong]);
  const provenanceBase = useMemo(() => {
    if (!viewSong || !detail) return new Map<string, InstrumentProvenanceInfo>();
    const map = new Map<string, InstrumentProvenanceInfo>();
    for (const name of detail.activeInstruments) {
      const info = resolveInstrumentProvenance(
        name,
        defs.get(name),
        patternTypesForInstrument(viewSong, name),
      );
      map.set(name, info);
    }
    return map;
  }, [viewSong, detail, defs]);
  const catalogIds = useMemo(
    () =>
      [...provenanceBase.values()]
        .map((p) => p.catalogId)
        .filter((x): x is string => Boolean(x)),
    [provenanceBase],
  );
  const catalogQueries = useQueries({
    queries: catalogIds.map((id) => ({
      queryKey: catalogQueryKeys.entry(id),
      queryFn: ({ signal }: { signal?: AbortSignal }) => catalogApi.get(id, signal),
      staleTime: 5 * 60_000,
    })),
  });
  const provenanceList = useMemo<readonly InstrumentProvenanceInfo[]>(() => {
    const byId = new Map<string, CatalogEntry>();
    catalogQueries.forEach((q, i) => {
      if (q.data?.entry) byId.set(catalogIds[i]!, q.data.entry);
    });
    return [...provenanceBase.values()].map((info) => {
      if (!info.catalogId) return info;
      const entry = byId.get(info.catalogId);
      if (!entry) return info;
      return {
        ...info,
        library: entry.library ?? info.library,
        preset: entry.preset ?? info.preset,
        family: entry.family ?? info.family,
        lowLevel: entry.lowLevel ?? info.lowLevel,
        mainStyle: entry.mainStyle ?? info.mainStyle,
        addStyles: entry.addStyles.length > 0 ? entry.addStyles : info.addStyles,
        matchedPath: entry.matchedPath ?? info.matchedPath,
        publicName: entry.publicName,
      } satisfies InstrumentProvenanceInfo;
    });
  }, [provenanceBase, catalogQueries, catalogIds]);

  if (!viewSong) return <InspectorShell><Empty>No song loaded.</Empty></InspectorShell>;
  if (!detail) return <InspectorShell><Empty>Select a segment.</Empty></InspectorShell>;

  const bpm = viewSong.bpm;
  const seconds = (detail.bars * 4 * 60) / bpm;
  const clampedBar = activeBarIndex !== undefined && activeBarIndex < detail.bars
    ? activeBarIndex
    : undefined;
  const run = (command: EditCommand) => applyEdit(command);
  const validationError = editor?.validation.ok === false ? editor.validation.error : undefined;
  const lastError = editor?.lastError;

  return (
    <InspectorShell>
      <Header detail={detail} seconds={seconds} />

      <Section title="Segment edits">
        <div className="flex flex-wrap gap-1.5">
          <EditButton
            label="− 1 bar"
            onClick={() =>
              run({
                kind: 'changeBarCount',
                segmentName: detail.name,
                delta: -1,
              })
            }
            disabled={detail.bars <= 1}
          />
          <EditButton
            label="+ 1 bar"
            onClick={() =>
              run({
                kind: 'changeBarCount',
                segmentName: detail.name,
                delta: 1,
              })
            }
          />
          <EditButton
            label="− 4 bars"
            onClick={() =>
              run({
                kind: 'changeBarCount',
                segmentName: detail.name,
                delta: -4,
              })
            }
            disabled={detail.bars <= 4}
          />
          <EditButton
            label="+ 4 bars"
            onClick={() =>
              run({
                kind: 'changeBarCount',
                segmentName: detail.name,
                delta: 4,
              })
            }
          />
          <EditButton
            label="Duplicate"
            onClick={() =>
              run({ kind: 'duplicateSegment', segmentName: detail.name })
            }
          />
          <EditButton
            label="Delete"
            danger
            onClick={() =>
              run({ kind: 'deleteSegment', segmentName: detail.name })
            }
          />
        </div>
        {lastError || validationError ? (
          <p className="mt-2 text-[11px] text-err leading-snug">
            {validationError ?? lastError}
          </p>
        ) : null}
      </Section>

      <Section title="Active instruments" count={detail.activeInstruments.length}>
        {provenanceList.length === 0 ? (
          <Empty inline>No instruments active.</Empty>
        ) : (
          <div className="flex flex-col gap-2">
            {provenanceList.map((info) => (
              <InstrumentProvenanceRow key={info.name} info={info} />
            ))}
          </div>
        )}
      </Section>

      <Section title="Chord progression" count={detail.chordProgression.unique.length}>
        <ChordProgression
          bars={detail.chordProgression.bars}
          activeBar={clampedBar}
          onSelectBar={setActiveBarIndex}
        />
        {detail.chordProgression.unique.length > 0 ? (
          <p className="mt-2 text-[11px] uppercase tracking-wider text-dim font-semibold">
            {detail.chordProgression.unique.length} distinct ·{' '}
            {detail.chordProgression.totalChanges} changes
          </p>
        ) : null}
      </Section>

      <Section title="Patterns" count={detail.patterns.length}>
        {detail.patterns.length === 0 ? (
          <Empty inline>No instrument overrides.</Empty>
        ) : (
          <div className="flex flex-col gap-2">
            {detail.patterns.map((p) => (
              <PatternRow key={p.instrument} pattern={p} />
            ))}
          </div>
        )}
      </Section>

      <Section
        title="Lead vocal"
        count={detail.leadVocalLines.length}
        rightLabel={detail.leadVocalLines.length === 0 ? 'silent' : undefined}
      >
        {detail.leadVocalLines.length === 0 ? (
          <Empty inline>No lyric events.</Empty>
        ) : (
          <ol className="flex flex-col gap-1 list-none">
            {detail.leadVocalLines.map((line, i) => (
              <li
                key={`${line.bar}-${line.beat}-${i}`}
                className="flex items-baseline gap-3 text-[12px]"
              >
                <span className="font-mono text-dim w-[44px] shrink-0">
                  {line.bar + 1}.{line.beat}
                </span>
                <span className="text-white/85 leading-snug">
                  {line.words.length > 0 ? line.words.join(' ') : '·'}
                  {line.endOfPhrase ? (
                    <span className="ml-1.5 text-dim text-[10px] uppercase tracking-wider">
                      eop
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ol>
        )}
      </Section>

      <Section title="Backing vocals" count={detail.backingVocals.length}>
        {detail.backingVocals.length === 0 ? (
          <Empty inline>None.</Empty>
        ) : (
          <ul className="flex flex-col gap-1 text-[12px]">
            {detail.backingVocals.map((bv) => (
              <li
                key={bv.name}
                className="flex items-center justify-between gap-3 px-2 py-1.5 rounded bg-white/[0.03]"
              >
                <span className="flex items-center gap-2">
                  <span
                    className={`h-2 w-2 rounded-full ${bv.active ? 'bg-ok' : 'bg-white/20'}`}
                    aria-hidden="true"
                  />
                  <span className="text-white/85 truncate">{bv.name}</span>
                </span>
                <span className="font-mono text-dim text-[10px] uppercase tracking-wider">
                  {bv.lyricLineCount} lines
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Fills" count={detail.fills.length}>
        {detail.fills.length === 0 ? (
          <Empty inline>None.</Empty>
        ) : (
          <div className="flex flex-col gap-1.5">
            {detail.fills.map((f) => (
              <div
                key={f.instrument}
                className="text-[12px] flex items-baseline gap-2"
              >
                <span className="text-white/85 truncate">{f.instrument}</span>
                <span className="font-mono text-dim text-[10px] uppercase tracking-wider">
                  {f.patternNames.length} pattern{f.patternNames.length === 1 ? '' : 's'}
                </span>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Transitions" count={detail.transitions.length}>
        {detail.transitions.length === 0 ? (
          <Empty inline>None.</Empty>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {detail.transitions.map((t) => (
              <Chip key={t}>{t}</Chip>
            ))}
          </div>
        )}
      </Section>

      <Section title="Signal processors" count={detail.signalProcessors.length}>
        {detail.signalProcessors.length === 0 ? (
          <Empty inline>None.</Empty>
        ) : (
          <ul className="flex flex-col gap-1.5 text-[12px]">
            {detail.signalProcessors.map((sp) => (
              <li
                key={sp.instrument}
                className="flex flex-col gap-0.5 px-2 py-1.5 rounded bg-white/[0.03]"
              >
                <span className="flex items-baseline justify-between gap-3">
                  <span className="text-white/85 truncate">{sp.instrument}</span>
                  <span className="font-mono text-dim text-[10px] uppercase tracking-wider">
                    {sp.type ?? '—'}
                  </span>
                </span>
                {sp.parameters.length > 0 ? (
                  <span className="text-dim text-[11px] font-mono">
                    {sp.parameters.join(' · ')}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {detail.mutes.length > 0 ? (
        <Section title="Mutes" count={detail.mutes.length}>
          <div className="flex flex-wrap gap-1.5">
            {detail.mutes.map((m) => (
              <Chip key={m}>{m}</Chip>
            ))}
          </div>
        </Section>
      ) : null}

      <div className="px-5 pb-5 pt-2 text-[10px] uppercase tracking-[0.18em] text-dim/80">
        Client-side edits — no backend save yet
      </div>
    </InspectorShell>
  );
}

function InstrumentProvenanceRow({ info }: { info: InstrumentProvenanceInfo }) {
  const color = familyColor(info.name);
  const isCatalog = info.provenance === 'catalog';
  const tone = isCatalog
    ? 'border-ok/40 bg-ok/10 text-ok'
    : info.provenance === 'unknown'
      ? 'border-line bg-white/[0.04] text-white/55'
      : 'border-yellow-500/40 bg-yellow-500/10 text-yellow-300';
  const presetLabel = soundLabel(info);
  return (
    <div className="flex flex-col gap-1 px-2.5 py-2 rounded-[10px] bg-white/[0.04]">
      <div className="flex items-center gap-2">
        <span
          className="h-2.5 w-2.5 rounded-full shrink-0"
          style={{ background: color }}
          aria-hidden="true"
        />
        <span className="text-[12px] text-white/90 truncate flex-1" title={info.name}>
          {info.name}
        </span>
        <span
          className={`px-1.5 py-0.5 rounded-full border text-[9px] uppercase tracking-[0.14em] font-semibold ${tone}`}
          title={info.catalogId ? `Catalog id ${info.catalogId}` : info.badge}
        >
          {isCatalog ? 'catalog' : info.provenance === 'unknown' ? 'no def' : 'fixture'}
        </span>
      </div>
      <div className="pl-4 text-[11px] font-mono text-white/75 truncate" title={presetLabel}>
        {presetLabel}
      </div>
      <div className="pl-4 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10.5px] text-dim">
        <KVRow label="family" value={info.family ?? '—'} />
        <KVRow label="lowLevel" value={info.lowLevel ?? '—'} />
        <KVRow
          label="style"
          value={
            info.mainStyle
              ? info.addStyles.length > 0
                ? `${info.mainStyle} +${info.addStyles.length}`
                : info.mainStyle
              : '—'
          }
          title={
            info.addStyles.length > 0
              ? `${info.mainStyle ?? ''} · ${info.addStyles.join(', ')}`
              : info.mainStyle ?? undefined
          }
        />
      </div>
      {isCatalog && info.catalogId ? (
        <Link
          to={`/catalog?focus=${info.catalogId}`}
          className="ml-4 mr-1 mt-1 inline-flex items-center justify-between gap-2 px-2.5 h-7 rounded text-[10.5px] text-white/85 hover:text-white border border-line hover:border-accent transition-colors"
          title={`Open catalog entry ${info.catalogId}`}
        >
          <span className="uppercase tracking-wider">View in catalog</span>
          <span className="font-mono text-dim text-[10px]">
            #{info.catalogId.slice(0, 8)}
          </span>
        </Link>
      ) : null}
    </div>
  );
}

function KVRow({
  label,
  value,
  title,
}: {
  label: string;
  value: string;
  title?: string | undefined;
}) {
  return (
    <span className="flex items-baseline gap-1.5 min-w-0" title={title}>
      <span className="text-dim/70 uppercase tracking-[0.14em] text-[9px] shrink-0">
        {label}
      </span>
      <span className="font-mono text-white/80 truncate">{value}</span>
    </span>
  );
}

function EditButton({
  label,
  onClick,
  disabled,
  danger,
}: {
  label: string;
  onClick(): void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`h-7 px-2.5 rounded text-[10.5px] uppercase tracking-wider font-semibold transition-colors ${
        disabled
          ? 'text-white/30 border border-line/60 cursor-not-allowed'
          : danger
            ? 'text-white border border-accent/60 bg-accent/10 hover:bg-accent/25'
            : 'text-white/85 border border-line hover:border-accent hover:text-white'
      }`}
    >
      {label}
    </button>
  );
}

function InspectorShell({ children }: { children: React.ReactNode }) {
  return (
    <aside
      className="h-full w-[320px] shrink-0 flex flex-col border-l border-line/80 bg-[#0d0d17]/95 overflow-y-auto no-scrollbar"
      aria-label="Segment Inspector"
    >
      {children}
    </aside>
  );
}

function Header({ detail, seconds }: { detail: SegmentDetail; seconds: number }) {
  return (
    <div className="px-5 pt-5 pb-4 border-b border-line/50">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[10px] uppercase tracking-[0.18em] text-dim font-semibold">
          Segment
        </span>
        {!detail.active ? (
          <span
            className="text-[10px] uppercase tracking-wider text-err font-semibold"
            title="No arrangement payload for this segment"
          >
            no arrangement
          </span>
        ) : null}
      </div>
      <h3 className="mt-1 text-[22px] text-white font-semibold leading-tight truncate">
        {detail.name}
      </h3>
      <div className="mt-1 flex items-center gap-3 text-[12px]">
        <span className="px-2 py-0.5 rounded-md bg-white/8 text-white/85 uppercase tracking-wide text-[11px]">
          {detail.kind ?? '—'}
        </span>
        <span className="font-mono text-dim">
          {detail.bars} bar{detail.bars === 1 ? '' : 's'} · {fmtDuration(seconds)}
        </span>
      </div>
    </div>
  );
}

function Section({
  title,
  count,
  rightLabel,
  children,
}: {
  title: string;
  count?: number;
  rightLabel?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="px-5 py-4 border-b border-line/40">
      <header className="flex items-baseline justify-between mb-2">
        <h4 className="text-[11px] uppercase tracking-[0.16em] text-dim font-semibold">
          {title}
        </h4>
        <span className="text-[11px] font-mono text-white/55">
          {rightLabel ?? (count === undefined ? '' : count)}
        </span>
      </header>
      {children}
    </section>
  );
}

function ChordProgression({
  bars,
  activeBar,
  onSelectBar,
}: {
  bars: readonly (readonly string[])[];
  activeBar: number | undefined;
  onSelectBar(barIndex: number | undefined): void;
}) {
  if (bars.length === 0) {
    return <Empty inline>No chords.</Empty>;
  }
  return (
    <div className="grid gap-1" style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}>
      {bars.map((row, i) => {
        const isActive = activeBar === i;
        return (
          <button
            key={i}
            type="button"
            onClick={() => onSelectBar(isActive ? undefined : i)}
            title={row.join(' · ')}
            className={`group flex flex-col items-start gap-0.5 px-2 py-1.5 rounded text-left transition-colors ${
              isActive
                ? 'bg-accent/20 ring-1 ring-accent/60'
                : 'bg-black/30 hover:bg-white/[0.06]'
            }`}
          >
            <span className="text-[9px] font-mono text-dim">{i + 1}</span>
            <span className="text-[11px] font-mono text-white/85 truncate w-full">
              {row[0] ?? '·'}
            </span>
            {row.length > 1 ? (
              <span className="text-[9px] font-mono text-dim/80 truncate w-full">
                +{row.length - 1}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

function PatternRow({ pattern }: { pattern: InstrumentPatternSummary }) {
  const color = familyColor(pattern.instrument);
  const drum = pattern.drumPattern;
  const drumPreview = drum
    ? Object.entries(drum)
        .slice(0, 2)
        .map(([k, grid]) => ({ k, grid: compactDrumGrid(grid) }))
    : null;
  return (
    <div className="flex flex-col gap-1 px-2.5 py-2 rounded-[10px] bg-white/[0.04]">
      <div className="flex items-center gap-2">
        <span
          className="h-2.5 w-2.5 rounded-full shrink-0"
          style={{ background: color }}
          aria-hidden="true"
        />
        <span className="text-[12px] text-white/90 truncate flex-1">{pattern.instrument}</span>
        <span className="text-[10px] font-mono text-dim uppercase tracking-wider">
          {pattern.totalEvents > 0
            ? `${pattern.totalEvents} ev`
            : pattern.drumPattern
              ? 'pattern'
              : '—'}
        </span>
      </div>
      {pattern.type ? (
        <div className="pl-4 text-[11px] font-mono text-dim truncate">{pattern.type}</div>
      ) : null}
      {drumPreview ? (
        <div className="pl-4 flex flex-col gap-0.5">
          {drumPreview.map(({ k, grid }) => (
            <div key={k} className="flex items-center gap-2">
              <span className="text-[9px] font-mono text-dim w-[64px] shrink-0 uppercase truncate">
                {k}
              </span>
              <span className="text-[11px] font-mono text-white/80 tracking-tighter">
                {grid}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Chip({
  children,
  color,
}: {
  children: React.ReactNode;
  color?: string;
}) {
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-white/8 text-white/85 text-[11px]"
      style={color ? { boxShadow: `inset 2px 0 0 ${color}` } : undefined}
    >
      {color ? (
        <span
          className="h-1.5 w-1.5 rounded-full shrink-0"
          style={{ background: color }}
          aria-hidden="true"
        />
      ) : null}
      <span className="truncate max-w-[140px]">{children}</span>
    </span>
  );
}

function Empty({
  children,
  inline,
}: {
  children: React.ReactNode;
  inline?: boolean;
}) {
  if (inline) {
    return <p className="text-[12px] text-dim">{children}</p>;
  }
  return (
    <div className="flex-1 flex items-center justify-center text-dim text-[12px] px-6 py-12 text-center">
      {children}
    </div>
  );
}

export function familyColor(name: string): string {
  const key = name.toLowerCase();
  if (key.startsWith('drum')) return 'var(--color-c0)';
  if (key.startsWith('bass')) return 'var(--color-c1)';
  if (key.startsWith('key')) return 'var(--color-c2)';
  if (key.startsWith('pad')) return 'var(--color-c3)';
  if (key.includes('vocal')) return 'var(--color-c4)';
  return 'var(--color-c5)';
}

/**
 * Drum grid is a 32nd-note ASCII string ("x...x...x...x..."). Render the
 * first 32 cells, mapping rest/hit to a compact glyph the inspector can
 * fit in a 200px column.
 */
function compactDrumGrid(grid: string): string {
  const cells = grid.replace(/\s+/g, '').slice(0, 32);
  let out = '';
  for (let i = 0; i < cells.length; i++) {
    const ch = cells[i];
    out += ch === 'x' || ch === 'X' ? '█' : '·';
    if ((i + 1) % 4 === 0 && i < cells.length - 1) out += ' ';
  }
  return out;
}

function fmtDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
