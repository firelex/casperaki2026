import { useEffect, useMemo, useState } from 'react';
import { useInfiniteQuery, useQueries, useQuery } from '@tanstack/react-query';

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

  // Which of the song's tracks a sound can go on (same family, offered for this genre).
  const tracksFor = (soundId: string): string[] => {
    const opts = edits.options.data;
    if (!opts) return [];
    const fam = opts.families.find((f) => f.sounds.some((s) => s.id === soundId))?.family;
    if (!fam) return [];
    return Object.entries(opts.tracks)
      .filter(([, t]) => t.family === fam && t.editable)
      .map(([name]) => name);
  };

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

        <div className="min-h-0 flex-1 overflow-y-auto">
          {list.isError ? (
            <p className="p-6 text-[13px] text-err">The sounds could not be loaded: {list.error.message}</p>
          ) : list.isLoading ? (
            <p className="p-6 text-[13px] text-white/55">Loading sounds…</p>
          ) : items.length === 0 ? (
            <p className="p-6 text-[13px] text-white/55">No sound matches. Try another word or style.</p>
          ) : (
            <div role="list">
              {items.map((s) => (
                <SoundRow key={s.id} s={s} highlighted={s.id === highlight} useOn={tracksFor(s.id)} onUse={(track) => void edits.run({ kind: 'changeSound', track, soundId: s.id }, `Putting ${s.name} on ${track}`)} />
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
function SoundRow({ s, highlighted, useOn, onUse }: { s: SoundItem; highlighted: boolean; useOn: string[]; onUse(track: string): void }) {
  const state = usePreviewState(s.id);
  const playing = state === 'playing';
  return (
    <div
      role="listitem"
      className={`grid grid-cols-[44px_minmax(160px,2fr)_minmax(120px,1.2fr)_minmax(120px,1.4fr)_90px_auto] items-center gap-3 border-b border-black/40 px-4 py-2 ${
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
      <div className="flex justify-end gap-1">
        {useOn.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => onUse(t)}
            className="h-7 rounded-full border border-white/25 px-3 text-[12px] text-white hover:border-white/60"
            title={`Put ${s.name} on the ${t} track of this song`}
          >
            Use on {t}
          </button>
        ))}
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

/** Start or stop a sound's preview (one at a time; the song pauses). */
async function togglePreview(s: SoundItem): Promise<void> {
  const key = `sound:${s.id}`;
  const pat = patternPlayer.getState();
  if (audition.playingId === s.id) return audition.stop();
  if (pat.key === key && pat.status === 'playing') return void patternPlayer.pause();
  void livePlayer.pause();
  audition.stop();
  if (pat.status === 'playing') await patternPlayer.pause();
  if (s.preview === 'audio') return audition.play(s.id, soundsApi.audioUrl(s.id), s.family);
  if (s.preview === 'pattern') {
    let loop: { start: number; end: number } | undefined;
    await patternPlayer.play(key, async (signal) => {
      const p = await soundsApi.preview(s.id, signal);
      loop = { start: 0, end: (p.bars * 4 * 60) / p.bpm };
      return p;
    });
    if (!loop) throw new Error('The pattern preview gave no length.');
    patternPlayer.setLoopRange(loop);
    patternPlayer.setLooping(true);
  }
}

/** Whether this sound's preview is loading, playing or idle (from both players). */
function usePreviewState(id: string): 'loading' | 'playing' | 'idle' {
  const pat = useLiveState(patternPlayer);
  const [aud, setAud] = useState<'loading' | 'playing' | 'idle'>(audition.playingId === id ? 'playing' : 'idle');
  useEffect(() => audition.onChange((which, st) => setAud(which === id ? st : 'idle')), [id]);
  if (pat.key === `sound:${id}`) return pat.status === 'playing' ? 'playing' : pat.status === 'loading' ? 'loading' : 'idle';
  return aud;
}

