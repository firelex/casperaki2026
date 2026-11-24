import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';

import { melodiesApi, type MelodyFilters, type MelodyKind, type MelodyListItem } from '../api/melodies';
import { midiName } from '../editor/sequencerModel';
import { Score } from '../editor/sequencer/Score';
import { scoreChordsOf } from '../hum/halfBars';
import { HumChordRow } from '../hum/HumChordRow';
import { HumPianoRoll } from '../hum/HumPianoRoll';
import { playPhrase } from '../hum/playPhrase';
import { AppHeader } from '../layout/AppHeader';

const KINDS: readonly { kind: MelodyKind; label: string }[] = [
  { kind: 'hooks', label: 'Hooks' },
  { kind: 'remix', label: 'Remix patterns' },
];
const FIELD = 'h-8 rounded-[7px] border border-black/60 bg-[#151619] px-2 text-[13px] text-white outline-none placeholder:text-white/35 focus:border-white/40';

/**
 * The melody library (read-only): our own hooks and the legacy remix patterns that sung melodies are made from. A
 * filtered, paged list on the left (above on a phone); the selected entry on the right in the hum editor's chord row,
 * piano roll and score, with Play. Pitches are shown and played at sung pitch (the brain lifts the banks by an octave).
 */
export function MelodyLibraryPage() {
  const [kind, setKind] = useState<MelodyKind>('hooks');
  const [type, setType] = useState('');
  const [bank, setBank] = useState('');
  const [feel, setFeel] = useState('');
  const [tempoText, setTempoText] = useState('');
  const [query, setQuery] = useState('');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<{ bank: string; id: string } | undefined>(undefined);

  // Search as you type, a moment after typing stops.
  useEffect(() => {
    const t = setTimeout(() => setQ(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  const tempo = /^\d{2,3}$/u.test(tempoText.trim()) ? Number(tempoText.trim()) : undefined;
  const filters: MelodyFilters = { kind, type, bank: kind === 'remix' ? bank : '', feel: kind === 'hooks' ? feel : '', tempo, q };
  const list = useInfiniteQuery({
    queryKey: ['melody-library', filters],
    queryFn: ({ pageParam, signal }) => melodiesApi.list(filters, pageParam, signal),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.items.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
    staleTime: 60_000,
  });
  const first = list.data?.pages[0];
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const facets = first?.facets;

  // The first entry is shown until one is picked (and again when the picked one leaves the list).
  useEffect(() => {
    if (!list.data) return;
    if (!selected || !items.some((i) => i.bank === selected.bank && i.id === selected.id)) {
      const top = items[0];
      setSelected(top ? { bank: top.bank, id: top.id } : undefined);
    }
  }, [list.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const switchKind = (k: MelodyKind) => {
    setKind(k);
    setType('');
    setSelected(undefined);
  };

  return (
    <div className="flex min-h-screen w-full flex-col bg-bg text-white md:h-screen md:overflow-hidden">
      <AppHeader />
      <header className="flex flex-wrap items-center gap-3 border-b border-black/60 bg-[#1b1c1f] px-4 py-3 md:px-5">
        <div className="mr-2">
          <h1 className="text-[18px] font-semibold text-white">Melodies</h1>
          <p className="text-[12px] text-white/50">
            {list.isError ? 'Not loaded' : first === undefined ? 'Loading…' : first.noHooksYet ? 'No hooks yet' : `${first.total.toLocaleString('en-GB')} ${kind === 'hooks' ? 'hook' : 'pattern'}${first.total === 1 ? '' : 's'}`}
          </p>
        </div>
        <div className="flex gap-1" role="tablist" aria-label="Kind">
          {KINDS.map((k) => (
            <button
              key={k.kind}
              type="button"
              role="tab"
              aria-selected={kind === k.kind}
              onClick={() => switchKind(k.kind)}
              className={`h-7 rounded-full border px-3 text-[12px] ${kind === k.kind ? 'border-white bg-white text-black' : 'border-black/60 bg-[#2a2b30] text-white/75 hover:text-white'}`}
            >
              {k.label}
            </button>
          ))}
        </div>
        <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Section" className={FIELD}>
          <option value="">All sections</option>
          {(facets?.types ?? []).map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        {kind === 'remix' ? (
          <select value={bank} onChange={(e) => setBank(e.target.value)} aria-label="Bank" className={FIELD}>
            <option value="">All banks</option>
            {(facets?.banks ?? []).map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        ) : (
          <select value={feel} onChange={(e) => setFeel(e.target.value)} aria-label="Feel" className={FIELD}>
            <option value="">All feels</option>
            {(facets?.feels ?? []).map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        )}
        <input
          value={tempoText}
          onChange={(e) => setTempoText(e.target.value)}
          inputMode="numeric"
          placeholder="Tempo (bpm)"
          aria-label="Tempo in bpm"
          aria-invalid={tempoText.trim() !== '' && tempo === undefined}
          title={tempoText.trim() !== '' && tempo === undefined ? 'A tempo is a whole number of bpm (e.g. 120); not filtering by tempo' : kind === 'hooks' ? 'Hooks whose tempo range takes this tempo' : 'Patterns within 10 bpm of this tempo'}
          className={`${FIELD} w-[110px] aria-[invalid=true]:border-err`}
        />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search names" aria-label="Search melodies" className={`${FIELD} w-[180px] px-3`} />
      </header>

      <div className="flex min-h-0 flex-1 flex-col bg-[#1b1c1f] md:flex-row">
        <aside className="max-h-[40vh] shrink-0 overflow-y-auto border-b border-black/70 bg-[#202124] md:max-h-none md:w-[340px] md:border-b-0 md:border-r" aria-label="Melody list">
          {list.isError ? (
            <p className="p-4 text-[13px] text-err" role="alert">
              The melodies could not be loaded: {list.error.message}
            </p>
          ) : list.isLoading ? (
            <p className="p-4 text-[13px] text-white/55">Loading…</p>
          ) : first?.noHooksYet ? (
            <p className="p-4 text-[13px] text-white/55">No hooks yet: the hooks bank has not been written.</p>
          ) : items.length === 0 ? (
            <p className="p-4 text-[13px] text-white/55">Nothing matches. Try another section, tempo or word.</p>
          ) : (
            <div role="list">
              {items.map((i) => (
                <MelodyRow key={`${i.bank}/${i.id}`} item={i} active={selected?.bank === i.bank && selected.id === i.id} onClick={() => setSelected({ bank: i.bank, id: i.id })} />
              ))}
              {list.hasNextPage ? (
                <div className="flex justify-center p-3">
                  <button
                    type="button"
                    onClick={() => void list.fetchNextPage()}
                    disabled={list.isFetchingNextPage}
                    className="h-9 rounded-full border border-white/25 px-5 text-[13px] text-white hover:border-white/60 disabled:opacity-50"
                  >
                    {list.isFetchingNextPage ? 'Loading…' : `Show more (${(first?.total ?? 0) - items.length} left)`}
                  </button>
                </div>
              ) : null}
            </div>
          )}
        </aside>
        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">{selected ? <MelodyDetail key={`${selected.bank}/${selected.id}`} bank={selected.bank} id={selected.id} /> : null}</main>
      </div>
    </div>
  );
}

function MelodyRow({ item: i, active, onClick }: { item: MelodyListItem; active: boolean; onClick(): void }) {
  return (
    <button
      type="button"
      role="listitem"
      onClick={onClick}
      aria-current={active ? 'true' : undefined}
      className={`block w-full border-b border-black/40 px-4 py-2 text-left ${active ? 'bg-white/[0.06] shadow-[inset_3px_0_0_#7dffb0]' : 'hover:bg-white/[0.03]'}`}
    >
      <div className="truncate text-[14px] font-semibold text-white">{i.name}</div>
      <div className="truncate text-[11px] text-white/45">
        {i.type} · {i.tempoMin !== undefined ? `${i.tempoMin}–${i.tempoMax} bpm` : `${i.tempo} bpm`} · {i.feel ?? i.bank}
        {i.bars === 9 ? ' · lead-in' : ''}
      </div>
    </button>
  );
}

function MelodyDetail({ bank, id }: { bank: string; id: string }) {
  const entry = useQuery({ queryKey: ['melody-library', bank, id], queryFn: ({ signal }) => melodiesApi.entry(bank, id, signal), staleTime: Infinity });
  const [playBeat, setPlayBeat] = useState<number | undefined>(undefined);
  const [playing, setPlaying] = useState(false);
  const [playError, setPlayError] = useState<string | undefined>(undefined);
  const stop = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => stop.current?.(), []);
  const e = entry.data;
  const scoreNotes = useMemo(() => (e ? e.melody.map((n) => ({ pitch: n.midi, start: n.beat, length: n.duration })) : []), [e]);
  const scoreChords = useMemo(() => scoreChordsOf(e?.chords ?? []), [e]);

  if (entry.isError) {
    return (
      <p className="p-5 text-[13px] text-err" role="alert">
        This melody could not be loaded: {entry.error.message}
      </p>
    );
  }
  if (!e) return <p className="p-5 text-[13px] text-white/55">Loading…</p>;

  const togglePlay = () => {
    if (playing) {
      stop.current?.();
      return;
    }
    setPlayError(undefined);
    try {
      stop.current = playPhrase(
        e.melody,
        e.chords,
        e.tempo,
        () => {
          setPlaying(false);
          setPlayBeat(undefined);
          stop.current = undefined;
        },
        setPlayBeat,
      );
      setPlaying(true);
    } catch (err) {
      setPlayError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <section className="px-4 py-4 md:px-5" aria-label={e.name}>
      <div className="flex flex-wrap items-center gap-3">
        <div className="mr-auto min-w-0">
          <h2 className="truncate text-[18px] font-semibold text-white">{e.name}</h2>
          <p className="text-[12px] text-white/50">
            {e.type} · {e.tempoMin !== undefined ? `${e.tempoMin}–${e.tempoMax} bpm (plays at ${e.tempo})` : `${e.tempo} bpm`}
            {e.feel ? ` · ${e.feel}` : ` · ${e.bank} bank`} · {e.bars} bars{e.leadInBars ? ` (${e.leadInBars} lead-in)` : ''} · {midiName(e.lowestNote)}–{midiName(e.highestNote)} · key C
          </p>
        </div>
        <button
          type="button"
          onClick={togglePlay}
          className="h-9 rounded-full bg-accent px-5 text-[14px] font-semibold text-white transition-colors hover:bg-[#e00000]"
        >
          {playing ? 'Stop' : 'Play'}
        </button>
      </div>
      {playError ? (
        <p className="mt-2 text-[13px] text-err" role="alert">
          {playError}
        </p>
      ) : null}
      <div className="mt-4 overflow-x-auto">
        <div className="min-w-[640px]">
          <HumChordRow readOnly chords={e.chords} />
          <HumPianoRoll readOnly melody={e.melody} playBeat={playBeat} totalBeats={e.bars * 4} />
        </div>
      </div>
      <div className="mt-6 border-t border-line/60 pt-3">
        <h3 className="px-4 text-[14px] font-semibold text-white/80">Score</h3>
        <Score
          notes={scoreNotes}
          beats={e.bars * 4}
          songKey="C"
          bpm={e.tempo}
          beat={playBeat}
          chords={scoreChords}
          caption="The melody at sung pitch and its chords, rounded to 16ths."
        />
      </div>
    </section>
  );
}
