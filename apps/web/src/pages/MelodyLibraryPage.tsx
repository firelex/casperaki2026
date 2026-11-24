import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { GENRE_LABELS } from '../types/genres';

import { BrainError } from '../api/client';
import {
  melodiesApi,
  rangeBand,
  sourceLabel,
  type MelodyEntry,
  type MelodyFilters,
  type MelodyKind,
  type MelodyListItem,
  type MelodyRange,
  type MelodySource,
} from '../api/melodies';
import { midiName } from '../editor/sequencerModel';
import { Score } from '../editor/sequencer/Score';
import { scoreChordsOf } from '../hum/halfBars';
import { HumChordRow, KEY_COL_W } from '../hum/HumChordRow';
import { HumPianoRoll } from '../hum/HumPianoRoll';
import { addNote, deleteNote, moveNote, resizeNote, setChord, startEdit, undo, type VersionEdit } from '../hum/melodyEdit';
import { playPhrase, previewNote } from '../hum/playPhrase';
import { AppHeader } from '../layout/AppHeader';

const KINDS: readonly { kind: MelodyKind; label: string }[] = [
  { kind: 'hooks', label: 'Casperaki' },
  { kind: 'remix', label: 'Precedents' },
];
const SOURCES: readonly { kind: MelodySource['kind']; label: string }[] = [
  { kind: 'song', label: 'Curated songs' },
  { kind: 'casperaki', label: 'Casperaki originals' },
];
const RANGES: readonly { range: MelodyRange; label: string }[] = [
  { range: 'narrow', label: 'Narrow (up to 9 semitones)' },
  { range: 'medium', label: 'Medium (10–14)' },
  { range: 'wide', label: 'Wide (15+)' },
];
const FIELD = 'h-8 rounded-[7px] border border-black/60 bg-[#151619] px-2 text-[13px] text-white outline-none placeholder:text-white/35 focus:border-white/40';
/** Piano roll zoom (pixels per beat), as the editor's pattern window. */
const MIN_PX_PER_BEAT = 8;
const MAX_PX_PER_BEAT = 160;
const ZOOM_STEP = 1.4;

/**
 * The melody library: our own hooks and the remix patterns that sung melodies are made from. A filtered, paged list on
 * the left (above on a phone); the selected entry on the right, editable with the hum editor's chord row and piano
 * roll (or read as a score), with Play, its Original and Remix switches, Save and Discard. Pitches are shown, played
 * and saved at sung pitch (the brain stores them an octave lower, in the banks' register).
 */
/** A style (genre id) as the app names it elsewhere. */
const genreLabel = (id: string): string => {
  const label = (GENRE_LABELS as Record<string, string>)[id];
  if (!label) throw new Error(`melody library: unknown style "${id}"`);
  return label;
};

export function MelodyLibraryPage() {
  const [kind, setKind] = useState<MelodyKind>('hooks');
  const [type, setType] = useState('');
  const [source, setSource] = useState<MelodyFilters['source']>('');
  const [range, setRange] = useState<MelodyFilters['range']>('');
  const [feel, setFeel] = useState('');
  const [style, setStyle] = useState('');
  const [substyle, setSubstyle] = useState('');
  const [original, setOriginal] = useState<MelodyFilters['original']>('');
  const [remix, setRemix] = useState<MelodyFilters['remix']>('');
  const [tempoText, setTempoText] = useState('');
  const [query, setQuery] = useState('');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<{ bank: string; id: string } | undefined>(undefined);
  /** The open entry has unsaved changes (switching asks first). */
  const dirty = useRef(false);
  const setDirty = useCallback((d: boolean) => {
    dirty.current = d;
  }, []);

  // Search as you type, a moment after typing stops.
  useEffect(() => {
    const t = setTimeout(() => setQ(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  const tempo = /^\d{2,3}$/u.test(tempoText.trim()) ? Number(tempoText.trim()) : undefined;
  const tempoInvalid = tempoText.trim() !== '' && tempo === undefined;
  const filters: MelodyFilters = { kind, type, source: kind === 'remix' ? source : '', range, feel: kind === 'hooks' ? feel : '', style: kind === 'hooks' ? style : '', substyle: kind === 'hooks' ? substyle : '', tempo, q, original, remix };
  const list = useInfiniteQuery({
    queryKey: ['melody-library', 'list', filters],
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
    if (!list.data || dirty.current) return;
    if (!selected || !items.some((i) => i.bank === selected.bank && i.id === selected.id)) {
      const top = items[0];
      setSelected(top ? { bank: top.bank, id: top.id } : undefined);
    }
  }, [list.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const leaveOk = () => !dirty.current || window.confirm('This melody has unsaved changes. Discard them?');
  const pick = (next: { bank: string; id: string }) => {
    if (selected && next.bank === selected.bank && next.id === selected.id) return;
    if (!leaveOk()) return;
    dirty.current = false;
    setSelected(next);
  };
  const switchKind = (k: MelodyKind) => {
    if (k === kind || !leaveOk()) return;
    dirty.current = false;
    setKind(k);
    setType('');
    setSelected(undefined);
  };
  const flagSelect = (label: string, value: MelodyFilters['original'], set: (v: MelodyFilters['original']) => void) => (
    <select value={value} onChange={(e) => set(e.target.value as MelodyFilters['original'])} aria-label={label} className={FIELD}>
      <option value="">{label}: any</option>
      <option value="on">{label}: on</option>
      <option value="off">{label}: off</option>
    </select>
  );

  return (
    <div className="flex min-h-screen w-full flex-col bg-bg text-white md:h-screen md:overflow-hidden">
      <AppHeader />
      <header className="flex flex-wrap items-center gap-2 border-b border-black/60 bg-[#1b1c1f] px-4 py-3 md:gap-3 md:px-5">
        <div className="mr-2">
          <h1 className="text-[18px] font-semibold text-white">Melodies</h1>
          <p className="text-[12px] text-white/50">
            {list.isError ? 'Not loaded' : first === undefined ? 'Loading…' : first.noHooksYet ? 'No hooks yet' : `${first.total.toLocaleString('en-GB')} ${kind === 'hooks' ? (first.total === 1 ? 'melody' : 'melodies') : first.total === 1 ? 'precedent' : 'precedents'}`}
          </p>
        </div>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search melodies"
          aria-label="Search melodies"
          title="Searches names, song titles, artists and feels"
          className="h-9 w-full rounded-[8px] border border-white/25 bg-[#151619] px-3 text-[14px] text-white outline-none placeholder:text-white/45 focus:border-white/60 sm:w-[280px]"
        />
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
          <select value={source} onChange={(e) => setSource(e.target.value as MelodyFilters['source'])} aria-label="Source" className={FIELD}>
            <option value="">All sources</option>
            {SOURCES.filter((s) => facets?.sources.includes(s.kind)).map((s) => (
              <option key={s.kind} value={s.kind}>
                {s.label}
              </option>
            ))}
          </select>
        ) : (
          <>
            <select value={style} onChange={(e) => setStyle(e.target.value)} aria-label="Style" className={FIELD}>
              <option value="">All styles</option>
              {(facets?.styles ?? []).map((s) => (
                <option key={s} value={s}>
                  {genreLabel(s)}
                </option>
              ))}
              <option value="none">No particular style</option>
            </select>
            {(facets?.substyles ?? []).length ? (
              <select value={substyle} onChange={(e) => setSubstyle(e.target.value)} aria-label="Sub-style" className={FIELD}>
                <option value="">All sub-styles</option>
                {(facets?.substyles ?? []).map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            ) : null}
            <select value={feel} onChange={(e) => setFeel(e.target.value)} aria-label="Feel" className={FIELD}>
              <option value="">All feels</option>
              {(facets?.feels ?? []).map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </>
        )}
        <select value={range} onChange={(e) => setRange(e.target.value as MelodyFilters['range'])} aria-label="Range" className={FIELD}>
          <option value="">Any range</option>
          {RANGES.map((r) => (
            <option key={r.range} value={r.range}>
              {r.label}
            </option>
          ))}
        </select>
        {flagSelect('Original', original, setOriginal)}
        {flagSelect('Remix', remix, setRemix)}
        <input
          value={tempoText}
          onChange={(e) => setTempoText(e.target.value)}
          inputMode="numeric"
          placeholder="Tempo (bpm)"
          aria-label="Tempo in bpm"
          aria-invalid={tempoInvalid}
          title={tempoInvalid ? 'A tempo is a whole number of bpm (e.g. 120); not filtering by tempo' : kind === 'hooks' ? 'Hooks whose tempo range takes this tempo' : 'Patterns within 10 bpm of this tempo'}
          className={`${FIELD} w-[110px] aria-[invalid=true]:border-err`}
        />
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
            <p className="p-4 text-[13px] text-white/55">Nothing matches. Try another filter or word.</p>
          ) : (
            <div role="list">
              {items.map((i) => (
                <MelodyRow key={`${i.bank}/${i.id}`} item={i} active={selected?.bank === i.bank && selected.id === i.id} onClick={() => pick({ bank: i.bank, id: i.id })} />
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
        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          {selected ? <MelodyDetail key={`${selected.bank}/${selected.id}`} bank={selected.bank} id={selected.id} onDirty={setDirty} /> : null}
        </main>
      </div>
    </div>
  );
}

function FlagBadge({ on, children }: { on: boolean; children: string }) {
  return (
    <span className={`rounded-full px-1.5 py-px text-[10px] font-semibold ${on ? 'bg-emerald-300/90 text-black' : 'bg-white/[0.06] text-white/30 line-through'}`}>{children}</span>
  );
}

function MelodyRow({ item: i, active, onClick }: { item: MelodyListItem; active: boolean; onClick(): void }) {
  // Used by the generator neither whole nor in mixing: shown, greyed.
  const off = !i.useOriginal && !i.useRemix;
  return (
    <button
      type="button"
      role="listitem"
      onClick={onClick}
      aria-current={active ? 'true' : undefined}
      className={`block w-full border-b border-black/40 px-4 py-2 text-left ${active ? 'bg-white/[0.06] shadow-[inset_3px_0_0_#7dffb0]' : 'hover:bg-white/[0.03]'}`}
    >
      <div className={off ? 'opacity-45' : ''}>
        <div className="flex items-center gap-2">
          <span className="min-w-0 truncate text-[14px] font-semibold text-white">{i.name}</span>
          {i.edited ? <span className="shrink-0 rounded-full bg-[#f5b942]/90 px-1.5 py-px text-[10px] font-semibold text-black" title={`Edited by ${i.editedBy} on ${i.editedAt?.slice(0, 10)}`}>edited</span> : null}
        </div>
        <div className="truncate text-[11px] text-white/55">{sourceLabel(i.source)}{i.source.artist ? ` · ${i.source.artist}` : ''}</div>
        <div className="mt-0.5 flex items-center gap-1.5">
          <span className="min-w-0 truncate text-[11px] text-white/40">
            {i.type} · {i.tempoMin !== undefined ? `${i.tempoMin}–${i.tempoMax} bpm` : `${i.tempo} bpm`} · {i.range} st{i.style ? ` · ${genreLabel(i.style)}${i.substyle ? ` / ${i.substyle}` : ''}` : ''}{i.feel ? ` · ${i.feel}` : ''}
            {i.bars === 9 ? ' · lead-in' : ''}
          </span>
          <span className="ml-auto flex shrink-0 gap-1">
            <FlagBadge on={i.useOriginal}>Original</FlagBadge>
            <FlagBadge on={i.useRemix}>Remix</FlagBadge>
          </span>
        </div>
      </div>
    </button>
  );
}

interface Draft {
  readonly edit: VersionEdit;
  readonly artist: string;
  readonly useOriginal: boolean;
  readonly useRemix: boolean;
}

const draftOf = (e: MelodyEntry): Draft => ({
  edit: startEdit(e.melody, e.chords, e.bars * 4),
  artist: e.source.artist ?? '',
  useOriginal: e.useOriginal,
  useRemix: e.useRemix,
});

function MelodyDetail({ bank, id, onDirty }: { bank: string; id: string; onDirty(dirty: boolean): void }) {
  const client = useQueryClient();
  const entryKey = ['melody-library', 'entry', bank, id];
  const entry = useQuery({ queryKey: entryKey, queryFn: ({ signal }) => melodiesApi.entry(bank, id, signal), staleTime: Infinity });
  const [draft, setDraft] = useState<Draft | undefined>(undefined);
  const [view, setView] = useState<'roll' | 'score'>('score');
  const [playBeat, setPlayBeat] = useState<number | undefined>(undefined);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [problems, setProblems] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const stop = useRef<(() => void) | undefined>(undefined);
  const lastLength = useRef(1);
  useEffect(() => () => stop.current?.(), []);
  const e = entry.data;

  // A fresh draft for each loaded version of the entry (first load, after Save or Back to the stored version).
  useEffect(() => {
    if (e) setDraft(draftOf(e));
  }, [e]);

  const dirty = Boolean(
    e && draft && (draft.edit.history.length > 0 || draft.artist.trim() !== (e.source.artist ?? '') || draft.useOriginal !== e.useOriginal || draft.useRemix !== e.useRemix),
  );
  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);
  const cur = draft?.edit;
  const change = (next: VersionEdit) => {
    if (cur && next !== cur) setDraft((d) => (d ? { ...d, edit: next } : d));
  };

  // Ctrl+Z (Cmd+Z) undoes the last change of the notes or chords.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key.toLowerCase() !== 'z' || !(ev.ctrlKey || ev.metaKey) || ev.shiftKey) return;
      const t = ev.target as HTMLElement | null;
      if (t && ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return;
      if (busy || !cur || cur.history.length === 0) return;
      ev.preventDefault();
      change(undo(cur));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const scoreNotes = useMemo(() => (cur ? cur.melody.map((n) => ({ pitch: n.midi, start: n.beat, length: n.duration })) : []), [cur]);
  const scoreChords = useMemo(() => scoreChordsOf(cur?.chords ?? []), [cur]);

  if (entry.isError) {
    return (
      <p className="p-5 text-[13px] text-err" role="alert">
        This melody could not be loaded: {entry.error.message}
      </p>
    );
  }
  if (!e || !draft || !cur) return <p className="p-5 text-[13px] text-white/55">Loading…</p>;

  const togglePlay = () => {
    if (playing) {
      stop.current?.();
      return;
    }
    setError(undefined);
    try {
      stop.current = playPhrase(
        cur.melody,
        cur.chords,
        e.tempo,
        () => {
          setPlaying(false);
          setPlayBeat(undefined);
          stop.current = undefined;
        },
        setPlayBeat,
        cur.beats,
      );
      setPlaying(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const done = (next: MelodyEntry) => {
    client.setQueryData(entryKey, next);
    void client.invalidateQueries({ queryKey: ['melody-library', 'list'] });
  };
  const run = async (label: string, fn: () => Promise<MelodyEntry>) => {
    stop.current?.();
    setBusy(label);
    setError(undefined);
    setProblems([]);
    try {
      done(await fn());
    } catch (err) {
      const body = err instanceof BrainError ? (err.body as { problems?: string[] } | undefined) : undefined;
      if (body?.problems?.length) setProblems(body.problems);
      else setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(undefined);
    }
  };
  const save = () =>
    run('Saving…', () => melodiesApi.save(bank, id, { melody: cur.melody, chords: cur.chords, artist: draft.artist, useOriginal: draft.useOriginal, useRemix: draft.useRemix }));
  const backToStored = () => {
    if (window.confirm('Remove the saved edit and go back to the stored version of this melody?')) void run('Going back…', () => melodiesApi.revert(bank, id));
  };
  const discard = () => {
    setDraft(draftOf(e));
    setProblems([]);
    setError(undefined);
  };

  const range = cur.melody.length ? Math.max(...cur.melody.map((n) => n.midi)) - Math.min(...cur.melody.map((n) => n.midi)) : 0;
  const songWarning = draft.useOriginal && e.source.kind === 'song';

  return (
    <section className="px-4 py-4 md:px-5" aria-label={e.name}>
      <div className="flex flex-wrap items-start gap-3">
        <div className="mr-auto min-w-0">
          <h2 className="flex items-center gap-2 text-[18px] font-semibold text-white">
            <span className="truncate">{e.name}</span>
            {e.edited ? <span className="rounded-full bg-[#f5b942]/90 px-2 py-px text-[11px] font-semibold text-black">edited</span> : null}
          </h2>
          <p className="text-[13px] text-white/70">{sourceLabel(e.source)}</p>
          <p className="text-[12px] text-white/50">
            {e.type} · {e.tempoMin !== undefined ? `${e.tempoMin}–${e.tempoMax} bpm (plays at ${e.tempo})` : `${e.tempo} bpm`}
            {e.style ? ` · ${genreLabel(e.style)}${e.substyle ? ` / ${e.substyle}` : ''}` : ''}{e.feel ? ` · ${e.feel}` : ''} · {e.bars} bars{e.leadInBars ? ` (${e.leadInBars} lead-in)` : ''} ·{' '}
            {cur.melody.length ? `${midiName(Math.min(...cur.melody.map((n) => n.midi)))}–${midiName(Math.max(...cur.melody.map((n) => n.midi)))}, ${range} semitones (${rangeBand(range)})` : 'no notes'} · key C
          </p>
          <p className="mt-0.5 font-mono text-[10px] text-white/30">
            {e.bank}/{e.id}
            {e.edited ? ` · edited by ${e.editedBy} on ${e.editedAt?.slice(0, 16).replace('T', ' ')}` : ''}
          </p>
        </div>
        <div className="flex gap-1 rounded-full border border-line p-0.5" role="tablist" aria-label="View">
          {(
            [
              ['score', 'Score'],
              ['roll', 'Piano roll'],
            ] as const
          ).map(([v, label]) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={view === v}
              onClick={() => setView(v)}
              className={`h-8 rounded-full px-3 text-[13px] ${view === v ? 'bg-white/15 text-white' : 'text-white/55 hover:text-white'}`}
            >
              {label}
            </button>
          ))}
        </div>
        <button type="button" onClick={togglePlay} className="h-9 rounded-full bg-accent px-5 text-[14px] font-semibold text-white transition-colors hover:bg-[#e00000]">
          {playing ? 'Stop' : 'Play'}
        </button>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px]">
        <label className="flex items-center gap-2">
          <span className="text-white/55">Artist</span>
          <input
            value={draft.artist}
            onChange={(ev) => setDraft({ ...draft, artist: ev.target.value })}
            placeholder={e.source.kind === 'song' ? 'Who wrote or sang it' : 'Optional'}
            aria-label="Artist"
            className={`${FIELD} w-[200px]`}
          />
        </label>
        <Switch label="Original" hint="Used whole, exactly as written" on={draft.useOriginal} onChange={(v) => setDraft({ ...draft, useOriginal: v })} />
        <Switch label="Remix" hint="Used in mixing: the rhythm of one melody with the shape and chords of another" on={draft.useRemix} onChange={(v) => setDraft({ ...draft, useRemix: v })} />
      </div>
      {songWarning ? (
        <p className="mt-2 rounded-[8px] border border-[#f5b942]/60 bg-[#f5b942]/10 px-3 py-2 text-[13px] text-[#ffd98a]" role="alert">
          This melody is a section of a real song{e.source.title ? ` (${e.source.title}${draft.artist.trim() ? `, ${draft.artist.trim()}` : ''})` : ''}. With Original on, generated songs will
          contain that song’s melody exactly as written. Using it is your responsibility.
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void save()}
          disabled={!dirty || Boolean(busy)}
          className="h-8 rounded-full bg-white px-4 text-[13px] font-semibold text-black disabled:opacity-40"
        >
          Save
        </button>
        <button type="button" onClick={discard} disabled={!dirty || Boolean(busy)} className="h-8 rounded-full border border-white/30 px-4 text-[13px] text-white disabled:opacity-40">
          Discard
        </button>
        <button type="button" onClick={() => change(undo(cur))} disabled={cur.history.length === 0 || Boolean(busy)} className="h-8 rounded-full border border-white/30 px-4 text-[13px] text-white disabled:opacity-40">
          Undo
        </button>
        {e.edited ? (
          <button type="button" onClick={backToStored} disabled={Boolean(busy)} className="h-8 rounded-full border border-white/30 px-4 text-[13px] text-white disabled:opacity-40">
            Back to the stored version
          </button>
        ) : null}
        {busy ? <span className="text-[12px] text-white/55">{busy}</span> : dirty ? <span className="text-[12px] text-[#f5b942]">Unsaved changes</span> : null}
      </div>
      {error ? (
        <p className="mt-2 text-[13px] text-err" role="alert">
          {error}
        </p>
      ) : null}
      {problems.length ? (
        <div className="mt-2 rounded-[8px] border border-err/60 bg-err/10 px-3 py-2 text-[13px] text-red-100" role="alert">
          <p className="font-semibold">Not saved. Please fix:</p>
          <ul className="mt-1 list-disc pl-5">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mt-4">
      {view === 'roll' ? (
        <ZoomedRoll beats={cur.beats}>
          {(scrollable) => (
            <>
              {cur.chords.length ? (
                <HumChordRow
                chords={cur.chords}
                onPick={(slot, chord) => change(setChord(cur, slot, chord))}
                loadOptions={(slot) => melodiesApi.chordOptions(cur.melody, e.bars, slot)}
                disabled={Boolean(busy)}
                scrollable={scrollable}
                />
              ) : (
                <p className="py-1.5 pl-[44px] text-[12px] text-white/45">This rhythm pattern has no chords: it gives the rhythm only.</p>
              )}
              <HumPianoRoll
                melody={cur.melody}
                totalBeats={cur.beats}
                scrollable={scrollable}
                hummedBars={0}
                editedBars={cur.editedBars}
                playBeat={playBeat}
                onAdd={(beat, midi) => {
                  const next = addNote(cur, beat, midi, lastLength.current);
                  if (next !== cur) previewNote(midi);
                  change(next);
                }}
                onDelete={(i) => change(deleteNote(cur, i))}
                onMove={(i, beat, midi) => change(moveNote(cur, i, beat, midi))}
                onResize={(i, length) => {
                  const next = resizeNote(cur, i, length);
                  if (next !== cur) {
                    previewNote(cur.melody[i]!.midi);
                    lastLength.current = next.melody.find((n) => n.beat === cur.melody[i]!.beat)!.duration;
                  }
                  change(next);
                }}
                onPitch={previewNote}
                disabled={Boolean(busy)}
              />
            </>
          )}
        </ZoomedRoll>
      ) : (
        <Score notes={scoreNotes} beats={cur.beats} songKey="C" bpm={e.tempo} beat={playBeat} chords={scoreChords} caption="The melody at sung pitch and its chords, rounded to 16ths." />
      )}
      </div>
      {view === 'roll' ? (
        <p className="mt-2 text-[11px] text-white/45">
          Click to add a note · right click to delete · drag to move · hold, then drag to change the length · click a chord to change it · Ctrl+Z to undo. Blue: as
          stored · amber: bars you changed.
        </p>
      ) : null}
    </section>
  );
}

function Switch({ label, hint, on, onChange }: { label: string; hint: string; on: boolean; onChange(on: boolean): void }) {
  return (
    <button type="button" role="switch" aria-checked={on} onClick={() => onChange(!on)} title={hint} className="flex items-center gap-2">
      <span className={`relative h-5 w-9 rounded-full transition-colors ${on ? 'bg-emerald-400' : 'bg-white/20'}`}>
        <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${on ? 'left-[18px]' : 'left-0.5'}`} />
      </span>
      <span className={on ? 'text-white' : 'text-white/55'}>{label}</span>
    </button>
  );
}

/**
 * The chord row and piano roll in a box that scrolls sideways, with the pattern window's zoom: − and + (or Ctrl and
 * the mouse wheel) change the width per beat, Fit shows the whole pattern. `children` gets whether the box scrolls.
 */
function ZoomedRoll({ beats, children }: { beats: number; children(scrollable: boolean): ReactNode }) {
  const boxRef = useRef<HTMLDivElement>(null);
  /** Pixels per beat; undefined: fit the box's width. */
  const [px, setPx] = useState<number | undefined>(undefined);
  const fitPx = () => {
    const box = boxRef.current;
    if (!box) throw new Error('The piano roll is not mounted.');
    return (box.clientWidth - KEY_COL_W) / beats;
  };
  const clamp = (v: number) => Math.min(MAX_PX_PER_BEAT, Math.max(MIN_PX_PER_BEAT, v));
  const zoomBy = (f: number) => setPx((p) => clamp((p ?? fitPx()) * f));

  // Ctrl + wheel zooms (the page must not zoom instead, so the listener is not passive).
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const onWheel = (ev: WheelEvent) => {
      if (!ev.ctrlKey) return;
      ev.preventDefault();
      zoomBy(ev.deltaY < 0 ? 1.15 : 1 / 1.15);
    };
    box.addEventListener('wheel', onWheel, { passive: false });
    return () => box.removeEventListener('wheel', onWheel);
  });

  const zoomBtn = 'h-7 min-w-7 rounded-[6px] border border-line px-2 text-[13px] text-white/85 hover:border-white/50';
  return (
    <div className="mt-2">
      <div className="mb-1 flex items-center justify-end gap-1 text-[12px]">
        <span className="mr-1 text-white/55">Zoom</span>
        <button type="button" className={zoomBtn} aria-label="Zoom out" title="Zoom out" onClick={() => zoomBy(1 / ZOOM_STEP)}>
          −
        </button>
        <button type="button" className={zoomBtn} aria-label="Zoom in" title="Zoom in (or Ctrl + mouse wheel)" onClick={() => zoomBy(ZOOM_STEP)}>
          +
        </button>
        <button type="button" className={zoomBtn} title="Fit the whole pattern" onClick={() => setPx(undefined)}>
          Fit
        </button>
      </div>
      <div ref={boxRef} className="overflow-x-auto rounded-[8px]">
        <div className={px === undefined ? 'min-w-[560px]' : ''} style={px === undefined ? undefined : { width: KEY_COL_W + beats * px }}>
          {children(true)}
        </div>
      </div>
    </div>
  );
}
