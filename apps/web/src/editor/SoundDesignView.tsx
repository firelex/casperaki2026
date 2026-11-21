import { useAuth } from '../auth/AuthContext';
import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import { useSession } from '../state/session';
import {
  catalogApi,
  catalogQueryKeys,
  type CatalogEntry,
} from '../api/catalog';
import {
  indexInstrumentDefinitions,
  patternTypesForInstrument,
  resolveInstrumentProvenance,
  soundLabel,
  summarizeStructure,
  type InstrumentProvenanceInfo,
} from '../types/song';

/**
 * Sound Design tab.
 *
 * Mirrors `rory-fe/src/views/SoundDesign.vue`: a horizontally
 * scrollable strip of instrument cards. Each card carries the
 * rory-fe colour-icon dot plus a real-catalog provenance block when
 * the brain landed on a validated row, or an honest "adapter
 * fixture" / "render fixture" badge otherwise.
 *
 * docs/54g — the per-card "Sound library / Playing style" pair no
 * longer fabricates a `brainRoundtrip` label as if it were a real
 * library. Catalog rows surface preset, library, family / lowLevel,
 * main + add styles, the matched disk path, and a deep-link into
 * `/catalog?focus=<id>`. Fixture cards carry a distinct badge so
 * "this is not actually selected from the catalog" is visible.
 */
export function SoundDesignView() {
  const { viewSong } = useSession();

  const baseCards = useMemo(() => buildCards(viewSong), [viewSong]);

  // Pull the full validated-catalog entry for every card that carries a
  // 16-hex id (i.e. the brain's selectInstruments pass landed on a
  // catalog row). For 4-5 cards × 1 cached GET per id this is cheap;
  // TanStack Query dedupes against the catalog browser's own fetches.
  const catalogIds = useMemo(
    () => baseCards.map((c) => c.provenance.catalogId).filter((x): x is string => Boolean(x)),
    [baseCards],
  );
  const catalogQueries = useQueries({
    queries: catalogIds.map((id) => ({
      queryKey: catalogQueryKeys.entry(id),
      queryFn: ({ signal }: { signal?: AbortSignal }) => catalogApi.get(id, signal),
      staleTime: 5 * 60_000,
    })),
  });
  const catalogById = useMemo(() => {
    const map = new Map<string, CatalogEntry>();
    catalogQueries.forEach((q, i) => {
      if (q.data?.entry) map.set(catalogIds[i]!, q.data.entry);
    });
    return map;
  }, [catalogQueries, catalogIds]);

  const cards = useMemo(() => {
    if (catalogById.size === 0) return baseCards;
    return baseCards.map((card) => {
      const id = card.provenance.catalogId;
      const entry = id ? catalogById.get(id) : undefined;
      if (!entry) return card;
      return {
        ...card,
        provenance: {
          ...card.provenance,
          library: entry.library ?? card.provenance.library,
          preset: entry.preset ?? card.provenance.preset,
          family: entry.family ?? card.provenance.family,
          lowLevel: entry.lowLevel ?? card.provenance.lowLevel,
          mainStyle: entry.mainStyle ?? card.provenance.mainStyle,
          addStyles: entry.addStyles.length > 0 ? entry.addStyles : card.provenance.addStyles,
          matchedPath: entry.matchedPath ?? card.provenance.matchedPath,
          publicName: entry.publicName,
        },
      } satisfies CardData;
    });
  }, [baseCards, catalogById]);

  if (!viewSong) {
    return <EmptyMessage />;
  }

  const summary = summarizeStructure(viewSong);

  return (
    <div className="flex flex-col h-full justify-between text-white">
      <div className="px-[8vw] pt-[5vh] pb-3">
        <h2 className="text-[28px] font-semibold leading-tight">
          Edit instruments to define your sound
        </h2>
        <div className="flex items-end gap-[60px] mt-6 text-white/85">
          <Option label="Genre" value={viewSong.genre ?? '—'} />
          <Option label="Tempo" value={`${viewSong.bpm} bpm`} />
          <Option label="Key" value={viewSong.key} />
          <Option label="Segments" value={`${summary.length}`} />
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-x-auto overflow-y-hidden px-[8vw] no-scrollbar">
        <div className="flex h-full items-stretch gap-10 py-6">
          {cards.length === 0 ? (
            <p className="text-muted text-[15px] self-center">
              Song has no instrument overrides yet.
            </p>
          ) : (
            cards.map((card) => <InstrumentCard key={card.name} card={card} />)
          )}
        </div>
      </div>

      <div className="flex items-center justify-center gap-10 px-[8vw] py-6">
        <BottomBtn label="Get a brand new vibe" glyph="⟳" disabled />
        <BottomBtn label="Pause" glyph="⏸" disabled iconOnly />
        <BottomBtn label="Add New Instrument" glyph="+" disabled flip />
      </div>
    </div>
  );
}

interface CardData {
  name: string;
  color: string;
  inSegments: number;
  totalSegments: number;
  patternTypes: readonly string[];
  totalEvents: number;
  provenance: InstrumentProvenanceInfo;
}

function buildCards(song: import('@casperaki/song-schema').Song | undefined): CardData[] {
  if (!song) return [];
  const colorByFamily: Record<string, string> = {
    Drums: 'var(--color-c0)',
    Bass: 'var(--color-c1)',
    Keys: 'var(--color-c2)',
    Pad: 'var(--color-c3)',
    Vocal: 'var(--color-c4)',
  };
  const totalSegments = song.songStructure.length;
  const defs = indexInstrumentDefinitions(song);
  const map = new Map<string, CardData>();

  for (const seg of song.songStructure) {
    const payload = song.arrangement[seg.name];
    if (!payload) continue;
    const instruments = payload.instruments ?? {};
    const overrides = payload.overrides ?? {};
    for (const [name, on] of Object.entries(instruments)) {
      if (!on) continue;
      let card = map.get(name);
      if (!card) {
        card = {
          name,
          color: colorByFamily[name] ?? colorVariantByIndex(map.size),
          inSegments: 0,
          totalSegments,
          patternTypes: [],
          totalEvents: 0,
          provenance: resolveInstrumentProvenance(
            name,
            defs.get(name),
            patternTypesForInstrument(song, name),
          ),
        };
        map.set(name, card);
      }
      card.inSegments += 1;
      const override = overrides[name];
      if (override) {
        if (override.type && !card.patternTypes.includes(override.type)) {
          card.patternTypes = [...card.patternTypes, override.type];
        }
        for (const bar of override.bars ?? []) {
          for (const evs of Object.values(bar.notes ?? {})) {
            card.totalEvents += (evs as unknown[]).length;
          }
        }
      }
    }
  }
  return [...map.values()].sort((a, b) => b.inSegments - a.inSegments);
}

function colorVariantByIndex(i: number): string {
  const palette = [
    'var(--color-c0)',
    'var(--color-c1)',
    'var(--color-c2)',
    'var(--color-c3)',
    'var(--color-c4)',
    'var(--color-c5)',
  ];
  return palette[i % palette.length]!;
}

function InstrumentCard({ card }: { card: CardData }) {
  const activity =
    card.totalSegments > 0 ? Math.min(1, card.inSegments / card.totalSegments) : 0;
  const { provenance } = card;
  const isCatalog = provenance.provenance === 'catalog';
  const isAdmin = useAuth().user?.isAdmin === true;
  return (
    <article
      className="shrink-0 w-[300px] flex flex-col rounded-[15px] overflow-hidden"
      style={{
        background: 'rgba(215, 216, 236, 0.06)',
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06)',
      }}
    >
      <div className="flex items-center justify-between px-7 pt-6">
        <div className="flex items-center gap-4 min-w-0">
          <span
            className="h-3 w-3 rounded-full shrink-0"
            style={{ background: card.color }}
            aria-hidden="true"
          />
          <h3 className="text-white text-[22px] font-semibold truncate">{card.name}</h3>
        </div>
        <div className="flex items-center gap-3 text-white/60">
          <span aria-label="solo" title="solo">◑</span>
          <span aria-label="volume" title="volume">◧</span>
          <span aria-label="remove" title="remove">✕</span>
        </div>
      </div>

      <div className="px-7 pt-4">
        <ProvenanceBadge info={provenance} />
      </div>

      <div className="px-7 pt-3 flex flex-col gap-2">
        <CardKV label="Sound" value={soundLabel(provenance)} />
        <CardKV
          label="Family / lowLevel"
          value={
            provenance.family || provenance.lowLevel
              ? `${provenance.family ?? '—'} / ${provenance.lowLevel ?? '—'}`
              : '—'
          }
        />
        <CardKV
          label="Styles"
          value={
            provenance.mainStyle || provenance.addStyles.length > 0
              ? `${provenance.mainStyle ?? '—'}${
                  provenance.addStyles.length > 0
                    ? ` · +${provenance.addStyles.join(', ')}`
                    : ''
                }`
              : '—'
          }
        />
      </div>

      <div className="px-7 pt-4">
        <div className="text-[11px] uppercase tracking-wider text-white/45 font-semibold mb-1.5">
          Busyness
        </div>
        <div className="relative h-2 rounded-full bg-black/40 overflow-hidden">
          <div
            className="h-full rounded-full"
            style={{ width: `${activity * 100}%`, background: card.color, opacity: 0.6 }}
          />
          <div
            className="absolute top-1/2 -translate-y-1/2 h-[14px] w-[14px] rounded-full bg-white shadow"
            style={{ left: `calc(${activity * 100}% - 7px)` }}
          />
        </div>
        <div className="flex items-center justify-between mt-1.5 text-[10.5px] text-white/40 font-mono">
          <span>{card.inSegments}/{card.totalSegments} segments</span>
          <span>{card.totalEvents} events</span>
        </div>
      </div>


      <div className="mt-auto" />
      {isCatalog && provenance.catalogId && !isAdmin ? null : isCatalog && provenance.catalogId ? (
        <Link
          to={`/catalog?focus=${provenance.catalogId}`}
          className="mx-5 mt-4 mb-2 px-5 h-10 rounded-lg flex items-center justify-between text-[12px] text-white/85 hover:text-white border border-line hover:border-accent transition-colors"
          title={`Open catalog entry ${provenance.catalogId}`}
        >
          <span>View in catalog</span>
          <span className="font-mono text-[10.5px] text-dim">#{provenance.catalogId.slice(0, 8)}</span>
        </Link>
      ) : (
        <div
          className="mx-5 mt-4 mb-2 px-5 h-10 rounded-lg flex items-center justify-between text-[12px] text-white/40 border border-line/40 cursor-not-allowed"
          title="No validated catalog id — instrument is not a real catalog selection"
        >
          <span>No catalog entry</span>
          <span className="font-mono text-[10.5px] text-dim">—</span>
        </div>
      )}
      <button
        type="button"
        disabled
        className="flex items-center justify-between mx-5 mb-5 mt-2 px-5 h-12 rounded-lg text-[14px] text-white/55 hover:text-white border-t border-white/5 cursor-not-allowed"
        style={{ background: 'rgba(0,0,0,0.12)' }}
        title="Piano Roll / Drum Machine — pattern editing lands in a later slice"
      >
        <span>
          {card.name === 'Drums' ? 'Open Drum Machine' : 'Open Piano Roll'}
        </span>
        <span>→</span>
      </button>
    </article>
  );
}

function ProvenanceBadge({ info }: { info: InstrumentProvenanceInfo }) {
  const tone =
    info.provenance === 'catalog'
      ? 'border-ok/40 bg-ok/10 text-ok'
      : info.provenance === 'unknown'
        ? 'border-line bg-white/[0.04] text-white/55'
        : 'border-yellow-500/40 bg-yellow-500/10 text-yellow-300';
  return (
    <div
      className={`inline-flex items-center gap-2 px-2.5 py-1 rounded-full text-[10px] uppercase tracking-[0.16em] font-semibold border ${tone}`}
      title={info.catalogId ? `Catalog id ${info.catalogId}` : info.badge}
    >
      <span
        className="h-1.5 w-1.5 rounded-full"
        style={{
          background:
            info.provenance === 'catalog'
              ? 'currentColor'
              : info.provenance === 'unknown'
                ? 'currentColor'
                : 'currentColor',
        }}
        aria-hidden="true"
      />
      <span>{info.badge}</span>
    </div>
  );
}

function CardKV({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 h-[28px] px-3 rounded-md bg-black/30">
      <span className="text-[9.5px] uppercase tracking-[0.16em] text-white/40 shrink-0">
        {label}
      </span>
      <span
        className="text-[12px] font-mono text-white/85 truncate text-right"
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

function Option({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-[13px] text-white/35 uppercase tracking-[0.14em] font-semibold">
        {label}
      </span>
      <span className="text-[24px] text-white leading-tight mt-0.5">{value}</span>
    </div>
  );
}

function BottomBtn({
  label,
  glyph,
  disabled,
  iconOnly,
  flip,
}: {
  label: string;
  glyph: string;
  disabled?: boolean;
  iconOnly?: boolean;
  flip?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      className={`h-12 flex items-center gap-3 px-6 rounded-full text-white text-[14px] font-semibold uppercase tracking-wide transition-colors ${
        disabled
          ? 'text-white/30 cursor-not-allowed border border-line/40'
          : 'bg-white/5 hover:bg-white/10'
      } ${flip ? 'flex-row-reverse' : ''}`}
    >
      <span className="text-[20px]">{glyph}</span>
      {iconOnly ? null : <span>{label}</span>}
    </button>
  );
}

function EmptyMessage() {
  return (
    <div className="h-full flex items-center justify-center text-muted text-[15px]">
      No song loaded.
    </div>
  );
}
