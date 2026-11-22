import { useEffect, useState, type ReactNode } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';

import { soundsApi, soundsQueryKeys, type SoundItem } from '../../api/sounds';
import { livePlayer, patternPlayer } from '../../audio/livePlayer';
import { useLiveState } from '../../audio/useLivePlayer';
import { GENRE_LABELS } from '../../types/genres';

const STYLES = ['brightPop', 'edm', 'latin', 'urban', 'ballad', 'rock', 'schlager', '8bit'] as const;
/** The results table's columns (header and rows share them). */
const ROW = 'grid grid-cols-[44px_minmax(160px,2fr)_minmax(120px,1.2fr)_minmax(120px,1.4fr)_100px_96px] items-center gap-3';

/** Which sounds to list: one library family, or every sound a track kind can use. */
export type SoundSource =
  | { readonly family: string }
  | { readonly useAs: NonNullable<SoundItem['useAs']> }
  /** The sounds a transition type can play (e.g. fxDownlifter). */
  | { readonly transition: string };

/**
 * A sound browser (the Sounds page, Change sound): search, style filter and
 * the sounds as a table. Click a sound to hear it: a tonal sound plays a
 * pattern generated for it (pick its style or a new pattern in the Now
 * playing bar), a drum hit a groove of its kind, a loop loops, an effect
 * plays once. `action` renders each row's last column (Use, Use ▾ …).
 */
export function SoundBrowser({
  source,
  title,
  actionLabel,
  action,
  highlight,
  status,
  autoFocus,
  songStyle,
  usage,
}: {
  source: SoundSource;
  title: string;
  actionLabel: string;
  action(s: SoundItem): ReactNode;
  highlight?: string | undefined;
  /** Shown at the right of the toolbar (busy / error of the caller's edits). */
  status?: ReactNode;
  autoFocus?: boolean;
  /** In a song: its style (genre). "Suits this song" is then on to start with. */
  songStyle?: string | undefined;
  /** Where the open song uses a sound ("Keys track", "Snare 1 in the kit"). */
  usage?: (s: SoundItem) => string[];
}) {
  const [query, setQuery] = useState('');
  const [q, setQ] = useState('');
  const [style, setStyle] = useState('');
  const [suits, setSuits] = useState(Boolean(songStyle));
  const suitsStyle = suits && songStyle ? songStyle : undefined;
  const sourceKey = 'family' in source ? `family:${source.family}` : 'useAs' in source ? `useAs:${source.useAs}` : `transition:${source.transition}`;

  // Search as you type, a moment after typing stops.
  useEffect(() => {
    const t = setTimeout(() => setQ(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  const list = useInfiniteQuery({
    queryKey: [...soundsQueryKeys.list(sourceKey, q, style), suitsStyle ?? ''],
    queryFn: ({ pageParam, signal }) => soundsApi.list({ ...source, q, style, suits: suitsStyle, cursor: pageParam }, signal),
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const total = list.data?.pages[0]?.total;
  const noneTagged = list.data?.pages[0]?.noneTagged === true;
  const songStyleLabel = songStyle ? (GENRE_LABELS[songStyle as keyof typeof GENRE_LABELS] ?? songStyle) : '';

  // Space plays / stops the current sound (the song is not played from here).
  // Typing in a field keeps its keys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return;
      e.preventDefault();
      e.stopPropagation();
      const s = lastSound ?? items.find((i) => i.preview !== 'none');
      if (s) void togglePreview(s, style);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [items, style]);

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col" data-owns-space="" data-sound-browser="">
      <header className="flex flex-wrap items-center gap-3 border-b border-black/60 px-5 py-3">
        <div className="mr-2">
          <h1 className="text-[18px] font-semibold text-white">{title}</h1>
          <p className="text-[12px] text-white/50">
            {total === undefined ? 'Loading…' : `${total.toLocaleString('en-GB')} sound${total === 1 ? '' : 's'}`}
            {q ? ` matching “${q}”` : ''}
            {style ? ` · ${GENRE_LABELS[style as keyof typeof GENRE_LABELS] ?? style}` : ''}
            {suitsStyle ? (noneTagged ? ` · none is tagged ${songStyleLabel}, so all suit it` : ` · suit ${songStyleLabel}`) : ''}
          </p>
        </div>
        <input
          value={query}
          autoFocus={autoFocus}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Search ${title.toLowerCase()}`}
          aria-label="Search sounds"
          className="h-8 w-[200px] rounded-[7px] border border-black/60 bg-[#151619] px-3 text-[13px] text-white outline-none placeholder:text-white/35 focus:border-white/40"
        />
        <div className="flex flex-wrap gap-1" role="group" aria-label="Style">
          {songStyle ? (
            <button
              type="button"
              onClick={() => setSuits((v) => !v)}
              aria-pressed={suits}
              title={`Only the sounds that suit this ${songStyleLabel} song (tagged ${songStyleLabel}; all, when none is)`}
              className={`mr-2 h-7 rounded-full border px-3 text-[12px] ${suits ? 'border-emerald-300 bg-emerald-300 text-black' : 'border-black/60 bg-[#2a2b30] text-white/75 hover:text-white'}`}
            >
              Suits this song
            </button>
          ) : null}
          <StyleChip label="All styles" active={style === ''} onClick={() => setStyle('')} />
          {STYLES.map((s) => (
            <StyleChip key={s} label={GENRE_LABELS[s as keyof typeof GENRE_LABELS] ?? (s === '8bit' ? '8-bit' : s)} active={style === s} onClick={() => setStyle(s)} />
          ))}
        </div>
        {status ? <div className="ml-auto text-[12px]">{status}</div> : null}
      </header>

        <NowPlaying />
      <div className="flex min-h-0 flex-1">
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
              <span role="columnheader" className="text-right">{actionLabel}</span>
            </div>
          <div role="list">
            {items.map((s) => (
              <SoundRow key={s.id} s={s} highlighted={s.id === highlight} prefer={style} action={action(s)} />
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
      <SoundDetailsPanel usage={usage} songStyle={songStyle} />
      </div>
    </section>
  );
}

/**
 * What the engine applies when the selected sound plays (the last one played
 * or clicked): its volume, octave, loudness, bus, inserts and sends, plus
 * facts like tempo and key, and where this song uses it. Read-only.
 */
function SoundDetailsPanel({ usage, songStyle }: { usage: ((s: SoundItem) => string[]) | undefined; songStyle: string | undefined }) {
  const s = useLastSound();
  const details = useQuery({
    queryKey: ['sound-details', s?.id, songStyle ?? ''],
    queryFn: ({ signal }) => soundsApi.details(s!.id, songStyle, signal),
    enabled: Boolean(s),
    staleTime: Infinity,
  });
  const d = details.data;
  const db = (v: number | null) => (v === null ? '—' : `${v > 0 ? '+' : ''}${+v.toFixed(1)} dB`);
  const used = s && usage ? usage(s) : [];
  return (
    <aside className="w-[280px] shrink-0 overflow-y-auto border-l border-black/60 bg-[#202124] px-4 py-4" aria-label="Sound details">
      {!s ? (
        <p className="text-[12px] text-white/45">Click or play a sound to see what the song does with it: volume, octave, effects.</p>
      ) : (
        <>
          <div className="text-[15px] font-semibold text-white">{s.name}</div>
          <div className="mb-3 text-[12px] text-white/50">
            {s.familyLabel} · {s.type}
          </div>
          {used.length ? (
            <div className="mb-3 rounded-[8px] bg-emerald-400/10 px-3 py-2 text-[12px] text-emerald-200">In this song: {used.join(', ')}</div>
          ) : null}
          {details.isError ? (
            <p className="text-[12px] text-err">{details.error.message}</p>
          ) : !d ? (
            <p className="text-[12px] text-white/45">Reading…</p>
          ) : (
            <dl className="grid grid-cols-[96px_1fr] gap-x-3 gap-y-2 text-[12px]">
              {d.genre ? (
                <>
                  <dt className="text-white/50">For style</dt>
                  <dd className="text-white/90">{GENRE_LABELS[d.genre as keyof typeof GENRE_LABELS] ?? d.genre}</dd>
                </>
              ) : null}
              <dt className="text-white/50">Volume</dt>
              <dd className="font-mono text-white/90">{db(d.volumeDb)}</dd>
              <dt className="text-white/50">Octave</dt>
              <dd className="font-mono text-white/90">{d.octaveShift === null ? '—' : d.octaveShift === 0 ? 'as recorded' : `${d.octaveShift > 0 ? '+' : ''}${d.octaveShift}`}</dd>
              <dt className="text-white/50">Loudness</dt>
              <dd className="text-white/90">{d.loudness}</dd>
              {d.bpm !== null || d.key !== null ? (
                <>
                  <dt className="text-white/50">Tempo · key</dt>
                  <dd className="font-mono text-white/90">
                    {d.bpm !== null ? `${d.bpm} BPM` : '—'}
                    {d.key !== null ? ` · ${d.key}` : ''}
                  </dd>
                </>
              ) : null}
              <dt className="text-white/50">Bus</dt>
              <dd className="text-white/90">{d.bus ?? '—'}</dd>
              <dt className="text-white/50">Inserts</dt>
              <dd className="flex flex-col gap-1">
                {d.inserts.length === 0 ? (
                  <span className="text-white/45">none</span>
                ) : (
                  d.inserts.map((n, i) => (
                    <span key={`${n}-${i}`} className="rounded-[4px] bg-[#2d4a6b] px-2 py-0.5 text-[11px] text-white/90">
                      {n}
                    </span>
                  ))
                )}
              </dd>
              <dt className="text-white/50">Sends</dt>
              <dd className="font-mono text-white/90">
                Reverb {db(d.sends.reverb)}
                <br />
                Delay {db(d.sends.delay)}
                <br />
                Chorus {db(d.sends.chorus)}
              </dd>
            </dl>
          )}
          {d?.notes.length ? (
            <ul className="mt-4 flex list-disc flex-col gap-1 pl-4 text-[12px] text-white/60">
              {d.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          ) : null}
          <p className="mt-4 text-[11px] text-white/35">The preview plays the sound with these settings, as the song does.</p>
        </>
      )}
    </aside>
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

/** One sound: play, name, type, styles, tempo/key, and the caller's action. */
function SoundRow({ s, highlighted, prefer, action }: { s: SoundItem; highlighted: boolean; prefer: string; action: ReactNode }) {
  const selected = useLastSound()?.id === s.id;
  const state = usePreviewState(s.id);
  const playing = state === 'playing';
  return (
    <div
      role="listitem"
      onClick={(e) => {
        if (!(e.target as HTMLElement).closest('button')) setLastSound(s);
      }}
      className={`${ROW} cursor-default border-b border-black/40 px-4 py-2 ${
        highlighted ? 'bg-[#2f3a48]' : playing ? 'bg-white/[0.06]' : 'hover:bg-white/[0.03]'
      } ${selected ? 'shadow-[inset_3px_0_0_#7dffb0]' : ''}`}
      aria-current={selected ? 'true' : undefined}
    >
      <button
        type="button"
        onClick={() => void togglePreview(s, prefer)}
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
      <div className="flex justify-end">{action}</div>
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

/** The preview playing (or last played): its sound, and for patterns the style and pattern number. */
interface PreviewNow {
  readonly sound: SoundItem;
  /** 'pattern': styles and New pattern apply; 'sample': a loop or a one-shot. */
  readonly kind: 'pattern' | 'sample';
  readonly loop: boolean;
  readonly genre: string;
  readonly genres: readonly string[];
  readonly variant: number;
  /** The sound that wrote the part (another sound when the pattern was kept). */
  readonly writer: string;
  /** Whether the click kept the pattern playing before (false: a different kind of sound, so it got its own; undefined: nothing to keep). */
  readonly kept: boolean | undefined;
}
let previewNow: PreviewNow | undefined;
const nowListeners = new Set<() => void>();
function setPreviewNow(n: PreviewNow | undefined) {
  previewNow = n;
  for (const fn of nowListeners) fn();
}
function usePreviewNow(): PreviewNow | undefined {
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force((x) => x + 1);
    nowListeners.add(fn);
    return () => void nowListeners.delete(fn);
  }, []);
  return previewNow;
}

const keyOf = (id: string) => `sound:${id}:`;

/** The sound last started (Space plays / stops it; the details panel shows it). */
let lastSound: SoundItem | undefined;
function setLastSound(s: SoundItem) {
  lastSound = s;
  for (const fn of nowListeners) fn();
}

/**
 * Start or stop a sound's preview (one at a time; the song pauses). Every
 * preview is played by the engine, as the song would play the sound: its mix
 * volume, octave and effects included.
 */
async function togglePreview(s: SoundItem, prefer: string): Promise<void> {
  setLastSound(s);
  const pat = patternPlayer.getState();
  if (pat.key?.startsWith(keyOf(s.id)) && pat.status === 'playing') return void patternPlayer.pause();
  void livePlayer.pause();
  if (pat.status === 'playing') await patternPlayer.pause();
  if (s.preview === 'none') return;
  // Keep the pattern playing (or last played) while comparing sounds.
  const keep =
    s.preview === 'pattern' && previewNow?.kind === 'pattern'
      ? { soundId: previewNow.writer, genre: previewNow.genre, variant: previewNow.variant }
      : undefined;
  return playPreview(s, undefined, 0, prefer || undefined, keep);
}

/** Play `s` through the engine: a pattern in `genre` (default: its own style) and number `variant`, or its sample. */
async function playPreview(
  s: SoundItem,
  genre: string | undefined,
  variant: number,
  prefer?: string,
  keep?: { soundId: string; genre: string; variant: number },
): Promise<void> {
  let info: { loop: boolean; end: number } | undefined;
  const k = keep ? `keep-${keep.soundId}-${keep.genre}-${keep.variant}` : `${genre ?? ''}:${variant}`;
  await patternPlayer.play(`${keyOf(s.id)}${k}`, async (signal) => {
    const p = await soundsApi.preview(s.id, s.preview === 'pattern' ? { genre, variant, prefer, keep } : {}, signal);
    info = { loop: p.loop, end: (p.bars * 4 * 60) / p.bpm };
    setPreviewNow({
      sound: s,
      kind: s.preview === 'pattern' ? 'pattern' : 'sample',
      loop: p.loop,
      genre: p.genre,
      genres: p.genres,
      variant: p.variant,
      writer: p.writer,
      kept: keep ? p.kept : undefined,
    });
    return p;
  });
  if (!info) throw new Error('The preview gave no length.');
  if (info.loop) {
    patternPlayer.setLoopRange({ start: 0, end: info.end });
    patternPlayer.setLooping(true);
  } else {
    patternPlayer.setLooping(false);
  }
}

/** Play or stop one sound by id (e.g. a transition's sound), through the engine. */
export async function toggleSoundById(id: string): Promise<void> {
  const s = await soundsApi.get(id);
  return togglePreview(s, '');
}

/** Above the list: what plays; for patterns its style (pick another) and New pattern. */
export function NowPlaying() {
  const now = usePreviewNow();
  const pat = useLiveState(patternPlayer);
  const [error, setError] = useState<string | undefined>(undefined);
  const LINE = 'flex min-h-[46px] flex-wrap items-center gap-3 border-b border-black/60 px-5 py-2';
  if (!now || !pat.key?.startsWith(keyOf(now.sound.id))) {
    return (
      <div className={`${LINE} bg-[#202a32]`} role="region" aria-label="Now playing">
        <span className="text-[12px] text-white/55">Press play on a sound to hear it. Space plays and stops the last one.</span>
      </div>
    );
  }
  const busy = pat.status === 'loading';
  const state = pat.status === 'playing' ? 'Playing' : busy ? (now.kind === 'pattern' ? 'Writing a pattern for' : 'Loading') : pat.status === 'ended' ? 'Played' : 'Paused';
  if (now.kind === 'sample') {
    return (
      <div className={`${LINE} bg-[#24303a]`} role="region" aria-label="Now playing">
        <span className="text-[12px] text-white/60">
          {state} <span className="font-semibold text-white">{now.sound.name}</span> · {now.loop ? 'looping' : 'once'} · Space to {pat.status === 'playing' ? 'stop' : 'play'}
        </span>
      </div>
    );
  }
  const run = (genre: string, variant: number) => {
    setError(undefined);
    playPreview(now.sound, genre, variant).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  };
  return (
    <div className={`${LINE} bg-[#24303a]`} role="region" aria-label="Now playing">
      <span className="text-[12px] text-white/60">
        {state} <span className="font-semibold text-white">{now.sound.name}</span> · pattern {now.variant + 1}
        {now.writer !== now.sound.id ? <span className="text-white/45"> (kept while you compare sounds)</span> : null}
        {now.kept === false ? <span className="text-white/45"> (a new part: this is a different kind of sound)</span> : null}
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

/** Whether this sound's preview is loading, playing or idle. */
export function usePreviewState(id: string | undefined): 'loading' | 'playing' | 'idle' {
  const pat = useLiveState(patternPlayer);
  if (id && pat.key?.startsWith(keyOf(id))) return pat.status === 'playing' ? 'playing' : pat.status === 'loading' ? 'loading' : 'idle';
  return 'idle';
}

/** The sound the details panel describes: the last one played or clicked. */
export function useLastSound(): SoundItem | undefined {
  usePreviewNow();
  return lastSound;
}
export { setLastSound };

/** Stop whatever sound preview is playing (e.g. when a dialog closes). */
export function stopSoundPreview(): void {
  if (patternPlayer.getState().key?.startsWith('sound:')) void patternPlayer.pause();
}
