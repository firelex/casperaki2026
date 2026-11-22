import { useEffect, useMemo, useState } from 'react';
import { useInfiniteQuery, useQueries, useQuery } from '@tanstack/react-query';

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@teamsuzie/ui';
import { soundsApi, soundsQueryKeys, type SoundFamily, type SoundItem } from '../api/sounds';
import { audition } from '../audio/audition';
import { livePlayer, patternPlayer } from '../audio/livePlayer';
import { useLiveState } from '../audio/useLivePlayer';
import { useLiveTransport } from '../audio/useLiveTransport';
import { useSession } from '../state/session';
import { GENRE_LABELS } from '../types/genres';
import { indexInstrumentDefinitions } from '../types/song';
import { buildSequencerModel } from './sequencerModel';
import { useTrackEdits } from './sequencer/useTrackEdits';

const STYLES = ['brightPop', 'edm', 'latin', 'urban', 'ballad', 'rock', 'schlager', '8bit'] as const;
const GROUPS = ['Instruments', 'Drum hits', 'Loops & breaks', 'FX'] as const;
const CATALOG_ID = /^[0-9a-f]{16}$/u;
/** The results table's columns (header and rows share them). */
const ROW = 'grid grid-cols-[44px_minmax(160px,2fr)_minmax(120px,1.2fr)_minmax(120px,1.4fr)_100px_80px] items-center gap-3';

/**
 * The sound library (Sounds tab), as a DAW's sound browser: every sound by
 * family, searchable and filterable by style. Click a sound to hear it: a
 * tonal sound plays a short pattern written for it, a drum hit a groove of
 * its kind, a loop loops, an effect plays once. "Use on <track>" puts it on
 * a track of this song (as Change sound does). Public names only.
 */
export function SoundsView() {
  const { viewSong } = useSession();
  const { liveKey } = useLiveTransport();
  const edits = useTrackEdits(liveKey);
  const families = useQuery({ queryKey: soundsQueryKeys.families, queryFn: ({ signal }) => soundsApi.families(signal), staleTime: Infinity });
  const [family, setFamily] = useState<string>('keys');
  const [query, setQuery] = useState('');
  const [q, setQ] = useState('');
  const [style, setStyle] = useState('');
  const [highlight, setHighlight] = useState<string | undefined>(undefined);

  // Search as you type, a moment after typing stops.
  useEffect(() => {
    const t = setTimeout(() => setQ(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  const list = useInfiniteQuery({
    queryKey: soundsQueryKeys.list(family, q, style),
    queryFn: ({ pageParam, signal }) => soundsApi.list({ family, q, style, cursor: pageParam }, signal),
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const total = list.data?.pages[0]?.total;
  const famInfo = families.data?.families.find((f) => f.id === family);

  // The song's tracks and their sounds.
  const model = useMemo(() => (viewSong ? buildSequencerModel(viewSong) : undefined), [viewSong]);
  const defs = useMemo(() => indexInstrumentDefinitions(viewSong), [viewSong]);
  const songTracks = (model?.tracks ?? []).map((t) => {
    const id = defs.get(t.name)?.id;
    return { name: t.name, color: t.color, soundId: typeof id === 'string' && CATALOG_ID.test(id) ? id : undefined };
  });
  const songSounds = useQueries({
    queries: songTracks.map((t) => ({
      queryKey: soundsQueryKeys.item(t.soundId ?? ''),
      queryFn: ({ signal }: { signal: AbortSignal }) => soundsApi.get(t.soundId!, signal),
      enabled: Boolean(t.soundId),
      staleTime: Infinity,
    })),
  });

  // Where a sound can go in this song: replace the sound of a track of its
  // kind (the one whose current sound is of the same type first), or a new track.
  const soundOfTrack = new Map(songTracks.map((t, i) => [t.name, songSounds[i]?.data]));
  const sections = model?.sections.map((x) => x.name) ?? [];
  const useOptions = (s: SoundItem): UseOption[] => {
    const opts = edits.options.data;
    if (!opts || !s.useAs) return [];
    const replace = Object.entries(opts.tracks)
      .filter(([, t]) => t.family === s.useAs && t.editable && t.soundId !== s.id)
      .map(([track]) => {
        const current = soundOfTrack.get(track);
        return { kind: 'replace' as const, track, current: current?.name, suggested: current?.type === s.type };
      })
      .sort((a, b) => Number(b.suggested) - Number(a.suggested));
    if (replace.length > 0 && !replace.some((r) => r.suggested)) replace[0] = { ...replace[0]!, suggested: true };
    const fam = opts.families.find((f) => f.family === s.useAs);
    const add = fam && sections.length ? [{ kind: 'add' as const, family: s.useAs, label: fam.label }] : [];
    return [...replace, ...add];
  };
  const useSound = (s: SoundItem, o: UseOption) =>
    o.kind === 'replace'
      ? void edits.run({ kind: 'changeSound', track: o.track, soundId: s.id }, `Putting ${s.name} on ${o.track}`)
      : void edits.run({ kind: 'addTrack', family: o.family, segments: sections, soundId: s.id }, `Adding a ${o.label.toLowerCase()} track with ${s.name}`);

  return (
    <div className="flex h-full min-h-0 bg-[#1b1c1f] text-white">
      {/* Browser sidebar. */}
      <aside className="flex w-[260px] shrink-0 flex-col border-r border-black/70 bg-[#202124]">
        <div className="border-b border-black/60 p-3">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${famInfo ? famInfo.label.toLowerCase() : 'sounds'}`}
            aria-label="Search sounds"
            className="h-9 w-full rounded-[7px] border border-black/60 bg-[#151619] px-3 text-[13px] text-white outline-none placeholder:text-white/35 focus:border-white/40"
          />
        </div>
        <nav className="min-h-0 flex-1 overflow-y-auto p-2" aria-label="Sound families">
          {families.isError ? <p className="p-2 text-[12px] text-err">{families.error.message}</p> : null}
          {GROUPS.map((g) => {
            const fams = (families.data?.families ?? []).filter((f) => f.group === g);
            if (fams.length === 0) return null;
            return (
              <div key={g} className="mb-3">
                <div className="px-2 pb-1 text-[10px] font-semibold text-[#8f9098]">{g.toUpperCase()}</div>
                {fams.map((f) => (
                  <FamilyButton key={f.id} f={f} active={f.id === family} onClick={() => setFamily(f.id)} />
                ))}
              </div>
            );
          })}
          {songTracks.length ? (
            <div className="mt-2 border-t border-black/50 pt-3">
              <div className="px-2 pb-1 text-[10px] font-semibold text-[#8f9098]">IN THIS SONG</div>
              {songTracks.map((t, i) => {
                const s = songSounds[i]?.data;
                return (
                  <button
                    key={t.name}
                    type="button"
                    disabled={!s}
                    onClick={() => {
                      if (!s) return;
                      setFamily(s.family);
                      setQuery('');
                      setStyle('');
                      setHighlight(s.id);
                    }}
                    className="flex w-full items-center gap-2 rounded-[6px] px-2 py-1.5 text-left hover:bg-white/6 disabled:opacity-50"
                    title={s ? `Show ${s.familyLabel.toLowerCase()}` : 'Not a library sound'}
                  >
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: t.color }} aria-hidden="true" />
                    <span className="flex min-w-0 flex-col leading-tight">
                      <span className="truncate text-[12px] text-white/90">{t.name}</span>
                      <span className="truncate text-[11px] text-white/45">{s?.name ?? '—'}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          ) : null}
        </nav>
      </aside>

      {/* Results. */}
      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center gap-3 border-b border-black/60 px-5 py-3">
          <div className="mr-2">
            <h1 className="text-[18px] font-semibold text-white">{famInfo?.label ?? 'Sounds'}</h1>
            <p className="text-[12px] text-white/50">
              {total === undefined ? 'Loading…' : `${total.toLocaleString('en-GB')} sound${total === 1 ? '' : 's'}`}
              {q ? ` matching “${q}”` : ''}
              {style ? ` · ${GENRE_LABELS[style as keyof typeof GENRE_LABELS] ?? style}` : ''}
            </p>
          </div>
          <div className="flex flex-wrap gap-1" role="group" aria-label="Style">
            <StyleChip label="All styles" active={style === ''} onClick={() => setStyle('')} />
            {STYLES.map((s) => (
              <StyleChip key={s} label={GENRE_LABELS[s as keyof typeof GENRE_LABELS] ?? (s === '8bit' ? '8-bit' : s)} active={style === s} onClick={() => setStyle(s)} />
            ))}
          </div>
          {edits.busy ? <span className="ml-auto text-[12px] text-white/60" role="status">{edits.busy}…</span> : null}
          {edits.error ? <span className="ml-auto text-[12px] text-err" role="alert">{edits.error}</span> : null}
        </header>

        <NowPlaying />
        <div className="min-h-0 flex-1 overflow-y-auto">
          {list.isError ? (
            <p className="p-6 text-[13px] text-err">The sounds could not be loaded: {list.error.message}</p>
          ) : list.isLoading ? (
            <p className="p-6 text-[13px] text-white/55">Loading sounds…</p>
          ) : items.length === 0 ? (
            <p className="p-6 text-[13px] text-white/55">No sound matches. Try another word or style.</p>
          ) : (
            <div role="table" aria-label="Sounds">
              <div role="row" className={`${ROW} sticky top-0 z-10 border-b border-black/70 bg-[#232428] px-4 py-2 text-[11px] font-semibold text-[#8f9098] shadow-[0_2px_6px_rgba(0,0,0,0.35)]`}>
                <span role="columnheader" aria-label="Play" />
                <span role="columnheader">Sound</span>
                <span role="columnheader">Type</span>
                <span role="columnheader">Styles</span>
                <span role="columnheader">Tempo · key</span>
                <span role="columnheader" className="text-right">Use</span>
              </div>
            <div role="list">
              {items.map((s) => (
                <SoundRow key={s.id} s={s} highlighted={s.id === highlight} useOptions={useOptions(s)} onUse={(o) => useSound(s, o)} />
              ))}
              {list.hasNextPage ? (
                <div className="flex justify-center p-4">
                  <button
                    type="button"
                    onClick={() => void list.fetchNextPage()}
                    disabled={list.isFetchingNextPage}
                    className="h-9 rounded-full border border-white/25 px-5 text-[13px] text-white hover:border-white/60 disabled:opacity-50"
                  >
                    {list.isFetchingNextPage ? 'Loading…' : `Show more (${(total ?? 0) - items.length} left)`}
                  </button>
                </div>
              ) : null}
            </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function FamilyButton({ f, active, onClick }: { f: SoundFamily; active: boolean; onClick(): void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'true' : undefined}
      className={`flex w-full items-center justify-between rounded-[6px] px-2 py-1.5 text-left text-[13px] ${active ? 'bg-[#3a3c43] text-white' : 'text-white/75 hover:bg-white/6 hover:text-white'}`}
    >
      <span className="truncate">{f.label}</span>
      <span className="ml-2 font-mono text-[11px] text-white/40">{f.count.toLocaleString('en-GB')}</span>
    </button>
  );
}

function StyleChip({ label, active, onClick }: { label: string; active: boolean; onClick(): void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`h-7 rounded-full border px-3 text-[12px] ${active ? 'border-white bg-white text-black' : 'border-black/60 bg-[#2a2b30] text-white/75 hover:text-white'}`}
    >
      {label}
    </button>
  );
}

/** One sound: play, name, type, styles, tempo/key, and where it can go in this song. */
type UseOption =
  | { kind: 'replace'; track: string; current: string | undefined; suggested: boolean }
  | { kind: 'add'; family: NonNullable<SoundItem['useAs']>; label: string };

function SoundRow({ s, highlighted, useOptions, onUse }: { s: SoundItem; highlighted: boolean; useOptions: UseOption[]; onUse(o: UseOption): void }) {
  const state = usePreviewState(s.id);
  const playing = state === 'playing';
  return (
    <div
      role="listitem"
      className={`${ROW} border-b border-black/40 px-4 py-2 ${
        highlighted ? 'bg-[#2f3a48]' : playing ? 'bg-white/[0.06]' : 'hover:bg-white/[0.03]'
      }`}
    >
      <button
        type="button"
        onClick={() => void togglePreview(s)}
        disabled={s.preview === 'none'}
        aria-label={playing ? `Stop ${s.name}` : `Play ${s.name}`}
        title={s.preview === 'none' ? 'No preview for this sound yet' : s.preview === 'pattern' ? 'Hear a pattern played with it' : 'Hear it'}
        className={`flex h-8 w-8 items-center justify-center rounded-full border border-black/60 text-[11px] ${
          playing ? 'bg-emerald-400 text-black' : 'bg-gradient-to-b from-[#3b3d43] to-[#2b2c31] text-white hover:from-[#4a4c53]'
        } disabled:opacity-30`}
      >
        {state === 'loading' ? '…' : playing ? <Bars /> : '▶'}
      </button>
      <div className="min-w-0">
        <div className="truncate text-[14px] font-semibold text-white">{s.name}</div>
        <div className="truncate text-[11px] text-white/40">{s.familyLabel}</div>
      </div>
      <div className="truncate text-[13px] text-white/70">{s.type}</div>
      <div className="flex flex-wrap gap-1">
        {s.styles.slice(0, 3).map((st) => (
          <span key={st} className="rounded-full bg-white/8 px-2 py-0.5 text-[11px] text-white/70">
            {GENRE_LABELS[st as keyof typeof GENRE_LABELS] ?? st}
          </span>
        ))}
      </div>
      <div className="font-mono text-[11px] text-white/50">
        {s.bpm ? `${s.bpm} BPM` : ''}
        {s.key ? ` ${s.key}` : ''}
      </div>
      <div className="flex justify-end">
        <DropdownMenu>
          <DropdownMenuTrigger asChild disabled={useOptions.length === 0}>
            <button
              type="button"
              className="h-7 rounded-full border border-white/25 px-3 text-[12px] text-white hover:border-white/60 disabled:opacity-30"
              title={
                useOptions.length
                  ? `Use ${s.name} in this song`
                  : s.useAs
                    ? 'This song has no track of this kind, and its style writes none'
                    : 'Sounds of this kind cannot go on a track yet'
              }
            >
              Use ▾
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="z-50 min-w-[260px] rounded-[10px] border border-line bg-panel p-1 text-white shadow-2xl">
            <DropdownMenuLabel className="px-3 py-2 text-[12px] font-normal text-white/50">Use {s.name} in this song</DropdownMenuLabel>
            {useOptions.map((o) => (
              <DropdownMenuItem
                key={o.kind === 'replace' ? o.track : 'add'}
                onSelect={() => onUse(o)}
                className="flex cursor-pointer items-center gap-2 rounded-[6px] px-3 py-2 text-[13px] outline-none data-[highlighted]:bg-white/10"
              >
                {o.kind === 'replace' ? (
                  <>
                    <span className="flex min-w-0 flex-col leading-tight">
                      <span>Replace on {o.track}</span>
                      <span className="truncate text-[11px] text-white/45">instead of {o.current ?? 'its current sound'}</span>
                    </span>
                    {o.suggested ? <span className="ml-auto rounded-full bg-emerald-400/15 px-2 py-0.5 text-[10px] text-emerald-300">Suggested</span> : null}
                  </>
                ) : (
                  <span>Add as a new {o.label.toLowerCase()} track</span>
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

function Bars() {
  return (
    <span className="flex h-3 items-end gap-[2px]" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <span key={i} className="w-[3px] animate-pulse rounded-sm bg-black" style={{ height: `${6 + ((i * 3) % 7)}px`, animationDelay: `${i * 120}ms` }} />
      ))}
    </span>
  );
}

/** The pattern preview playing (or last played): its sound, style and pattern number. */
interface PatternNow {
  readonly sound: SoundItem;
  readonly genre: string;
  readonly genres: readonly string[];
  readonly variant: number;
}
let patternNow: PatternNow | undefined;
const nowListeners = new Set<() => void>();
function setPatternNow(n: PatternNow | undefined) {
  patternNow = n;
  for (const fn of nowListeners) fn();
}
function usePatternNow(): PatternNow | undefined {
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force((x) => x + 1);
    nowListeners.add(fn);
    return () => void nowListeners.delete(fn);
  }, []);
  return patternNow;
}

const keyOf = (id: string) => `sound:${id}:`;

/** Start or stop a sound's preview (one at a time; the song pauses). */
async function togglePreview(s: SoundItem): Promise<void> {
  const pat = patternPlayer.getState();
  if (audition.playingId === s.id) return audition.stop();
  if (pat.key?.startsWith(keyOf(s.id)) && pat.status === 'playing') return void patternPlayer.pause();
  void livePlayer.pause();
  audition.stop();
  if (pat.status === 'playing') await patternPlayer.pause();
  if (s.preview === 'audio') {
    setPatternNow(undefined);
    return audition.play(s.id, soundsApi.audioUrl(s.id), s.family);
  }
  if (s.preview === 'pattern') {
    const same = patternNow?.sound.id === s.id ? patternNow : undefined;
    return playPattern(s, same?.genre, same?.variant ?? 0);
  }
}

/** Play a generated pattern for `s`: in `genre` (default: its own style) and pattern number `variant`. */
async function playPattern(s: SoundItem, genre: string | undefined, variant: number): Promise<void> {
  audition.stop();
  let loop: { start: number; end: number } | undefined;
  await patternPlayer.play(`${keyOf(s.id)}${genre ?? ''}:${variant}`, async (signal) => {
    const p = await soundsApi.preview(s.id, { genre, variant }, signal);
    loop = { start: 0, end: (p.bars * 4 * 60) / p.bpm };
    setPatternNow({ sound: s, genre: p.genre, genres: p.genres, variant: p.variant });
    return p;
  });
  if (!loop) throw new Error('The pattern preview gave no length.');
  patternPlayer.setLoopRange(loop);
  patternPlayer.setLooping(true);
}

/** Above the list while a pattern plays: its style (pick another) and New pattern. */
function NowPlaying() {
  const now = usePatternNow();
  const pat = useLiveState(patternPlayer);
  const [error, setError] = useState<string | undefined>(undefined);
  if (!now || !pat.key?.startsWith(keyOf(now.sound.id))) return null;
  const busy = pat.status === 'loading';
  const run = (genre: string, variant: number) => {
    setError(undefined);
    playPattern(now.sound, genre, variant).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  };
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-black/60 bg-[#24303a] px-5 py-2" role="region" aria-label="Now playing">
      <span className="text-[12px] text-white/60">
        {pat.status === 'playing' ? 'Playing' : busy ? 'Writing a pattern for' : 'Paused'}{' '}
        <span className="font-semibold text-white">{now.sound.name}</span> · pattern {now.variant + 1}
      </span>
      <div className="flex flex-wrap gap-1" role="group" aria-label="Pattern style">
        {now.genres.map((g) => (
          <button
            key={g}
            type="button"
            disabled={busy}
            aria-pressed={g === now.genre}
            onClick={() => run(g, now.variant)}
            className={`h-6 rounded-full border px-2.5 text-[11px] ${g === now.genre ? 'border-white bg-white text-black' : 'border-white/20 text-white/75 hover:text-white'} disabled:opacity-50`}
          >
            {GENRE_LABELS[g as keyof typeof GENRE_LABELS] ?? g}
          </button>
        ))}
      </div>
      <button
        type="button"
        disabled={busy}
        onClick={() => run(now.genre, now.variant + 1)}
        className="ml-auto h-7 rounded-full border border-white/30 px-3 text-[12px] text-white hover:border-white/60 disabled:opacity-50"
        title="Generate another pattern in this style"
      >
        ↻ New pattern
      </button>
      {error ? <span className="w-full text-[12px] text-err" role="alert">{error}</span> : null}
    </div>
  );
}

/** Whether this sound's preview is loading, playing or idle (from both players). */
function usePreviewState(id: string): 'loading' | 'playing' | 'idle' {
  const pat = useLiveState(patternPlayer);
  const [aud, setAud] = useState<'loading' | 'playing' | 'idle'>(audition.playingId === id ? 'playing' : 'idle');
  useEffect(() => audition.onChange((which, st) => setAud(which === id ? st : 'idle')), [id]);
  if (pat.key?.startsWith(keyOf(id))) return pat.status === 'playing' ? 'playing' : pat.status === 'loading' ? 'loading' : 'idle';
  return aud;
}

