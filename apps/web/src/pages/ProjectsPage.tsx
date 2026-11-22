import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Genre } from '@casperaki/song-schema/schemas';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@teamsuzie/ui';

import { playbackApi } from '../api/playback';
import { livePlayer } from '../audio/livePlayer';
import { useLivePosition, useLiveState } from '../audio/useLivePlayer';
import { AppHeader } from '../layout/AppHeader';
import { renderInFlight, renderLabel, songsApi, songsQueryKeys, type Project } from '../api/songs';
import type { LiveStatus } from '../audio/livePlayer';
import { GenerateDialog } from '../editor/GenerateDialog';
import { sectionColor } from '../editor/sectionColor';
import { GENRE_BLURBS, GENRE_LABELS, genreLabel } from '../types/genres';
import { CANONICAL_GENRES } from '../types/song';

type SortKey = 'updated' | 'created' | 'title' | 'bpm';
type View = 'grid' | 'list';
const VIEW_STORAGE = 'casperaki.songs.view';

/** The remembered grid/list choice (a per-browser convenience; storage may be unavailable). */
function readView(): View {
  try {
    return window.localStorage.getItem(VIEW_STORAGE) === 'list' ? 'list' : 'grid';
  } catch {
    return 'grid';
  }
}
function writeView(v: View): void {
  try {
    window.localStorage.setItem(VIEW_STORAGE, v);
  } catch {
    // Not remembered in this browser (private window, blocked storage): the choice still applies now.
  }
}

/** Length of a song in m:ss, from its sections and tempo. */
function songLength(p: Project): string {
  const bars = p.sections.reduce((n, s) => n + s.bars, 0);
  const sec = Math.round((bars * 4 * 60) / p.bpm);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

/**
 * Songs: the signed-in home screen. A grid of the user's songs, each drawn
 * as its section outline, with Play (live in the browser, no server render) and a
 * "…" menu for the rest. "New song" (header) opens the dialog via
 * ?create=1; a new user sees the genres as quick starts instead.
 */
export function ProjectsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortKey>('updated');
  const [create, setCreate] = useState<{ open: boolean; genre?: Genre }>({ open: false });
  const [view, setViewState] = useState<View>(readView);
  const setView = (v: View) => {
    setViewState(v);
    writeView(v);
  };
  const [genreFilter, setGenreFilter] = useState('');
  const [keyFilter, setKeyFilter] = useState('');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const live = useLiveState();
  const livePos = useLivePosition(live.status === 'playing');

  useEffect(() => {
    if (searchParams.get('create') === '1') {
      setCreate({ open: true });
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  const projectsQuery = useQuery({
    queryKey: songsQueryKeys.list,
    queryFn: ({ signal }) => songsApi.list(signal),
    // Poll while any render is queued or running so cards update by themselves.
    refetchInterval: (q) => (q.state.data?.projects.some((p) => renderInFlight(p.render)) ? 2000 : false),
  });
  const projects = projectsQuery.data?.projects ?? [];
  const invalidate = () => queryClient.invalidateQueries({ queryKey: songsQueryKeys.list });

  const removal = useMutation({
    mutationFn: (id: string) => songsApi.remove(id),
    onSuccess: (_d, id) => {
      if (live.key === id) livePlayer.stop();
      queryClient.removeQueries({ queryKey: songsQueryKeys.song(id) });
      void invalidate();
    },
  });
  const rename = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) => songsApi.rename(id, title),
    onSuccess: () => void invalidate(),
  });
  const render = useMutation({
    mutationFn: (id: string) => songsApi.render(id),
    onSuccess: () => void invalidate(),
  });
  // Bulk actions on the selected songs (each request on its own; the first failure is shown).
  const bulkDelete = useMutation({
    mutationFn: async (ids: string[]) => {
      const results = await Promise.allSettled(ids.map((id) => songsApi.remove(id)));
      const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (failed.length) throw new Error(`${failed.length} of ${ids.length} songs could not be deleted: ${String(failed[0]!.reason?.message ?? failed[0]!.reason)}`);
    },
    onSettled: (_d, _e, ids) => {
      if (live.key && ids.includes(live.key)) livePlayer.stop();
      for (const id of ids) queryClient.removeQueries({ queryKey: songsQueryKeys.song(id) });
      setSelected(new Set());
      setConfirmBulkDelete(false);
      void invalidate();
    },
  });
  const bulkRender = useMutation({
    mutationFn: async (ids: string[]) => {
      const results = await Promise.allSettled(ids.map((id) => songsApi.render(id)));
      const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (failed.length) throw new Error(`${failed.length} of ${ids.length} exports could not start: ${String(failed[0]!.reason?.message ?? failed[0]!.reason)}`);
    },
    onSettled: () => void invalidate(),
  });

  // Play renders the song live in the browser; no server render needed.
  const togglePlay = (p: Project) => {
    if (live.key === p.id && live.status === 'playing') {
      void livePlayer.pause();
      return;
    }
    void livePlayer.play(p.id, (signal) => playbackApi.forSaved(p.id, signal));
  };

  const needle = search.trim().toLowerCase();
  const filtered = projects
    .filter(
      (p) =>
        (!needle || p.title.toLowerCase().includes(needle) || (p.genre !== null && genreLabel(p.genre).toLowerCase().includes(needle))) &&
        (!genreFilter || p.genre === genreFilter) &&
        (!keyFilter || p.key === keyFilter),
    )
    .sort((a, b) =>
      sort === 'title'
        ? a.title.localeCompare(b.title)
        : sort === 'created'
          ? b.createdAt.localeCompare(a.createdAt)
          : sort === 'bpm'
            ? a.bpm - b.bpm || a.title.localeCompare(b.title)
            : b.updatedAt.localeCompare(a.updatedAt),
    );
  // Filter choices: only what the songs use, with counts.
  const genreCounts = new Map<string, number>();
  const keyCounts = new Map<string, number>();
  for (const p of projects) {
    if (p.genre !== null) genreCounts.set(p.genre, (genreCounts.get(p.genre) ?? 0) + 1);
    keyCounts.set(p.key, (keyCounts.get(p.key) ?? 0) + 1);
  }
  // Selection: only songs that still exist count.
  const selectedIds = projects.filter((p) => selected.has(p.id)).map((p) => p.id);
  const toggleSelected = (id: string) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const exportable = projects.filter((p) => selected.has(p.id) && p.render.state !== 'done' && !renderInFlight(p.render)).map((p) => p.id);
  const filtersOn = Boolean(needle || genreFilter || keyFilter);
  const actionError = removal.error ?? rename.error ?? render.error ?? bulkDelete.error ?? bulkRender.error;

  return (
    <div className="min-h-screen w-full bg-bg text-fg">
      <AppHeader />
      <main className="mx-auto w-full max-w-[1240px] px-4 pb-24 pt-10 sm:px-8 sm:pt-14">
        <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-5">
          <div>
            <h1 className="app-heading text-[30px] leading-tight text-white sm:text-[36px]">Your songs</h1>
            {projects.length > 0 ? (
              <p className="mt-1 text-[14px] text-white/50">
                {projects.length === 1 ? '1 song' : `${projects.length} songs`}
                {filtersOn ? ` · ${filtered.length} shown` : ''}
              </p>
            ) : null}
          </div>
          {projects.length > 0 ? (
            <div className="flex w-full flex-wrap items-center gap-3 sm:w-auto">
              <input
                type="search"
                placeholder="Search songs"
                aria-label="Search songs"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-10 min-w-0 flex-1 rounded-[8px] border border-line bg-panel px-3 text-[14px] text-white outline-none placeholder:text-white/40 focus:border-white/50 sm:w-[240px] sm:flex-none"
              />
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as SortKey)}
                aria-label="Sort songs"
                className="h-10 rounded-[8px] border border-line bg-panel px-3 text-[14px] text-white outline-none focus:border-white/50"
              >
                <option value="updated">Last edited</option>
                <option value="created">Newest</option>
                <option value="title">Title</option>
                <option value="bpm">Tempo</option>
              </select>
              <select
                value={genreFilter}
                onChange={(e) => setGenreFilter(e.target.value)}
                aria-label="Filter by style"
                className="h-10 rounded-[8px] border border-line bg-panel px-3 text-[14px] text-white outline-none focus:border-white/50"
              >
                <option value="">All styles</option>
                {[...genreCounts].sort((a, b) => genreLabel(a[0]).localeCompare(genreLabel(b[0]))).map(([g, n]) => (
                  <option key={g} value={g}>
                    {genreLabel(g)} ({n})
                  </option>
                ))}
              </select>
              <select
                value={keyFilter}
                onChange={(e) => setKeyFilter(e.target.value)}
                aria-label="Filter by key"
                className="h-10 rounded-[8px] border border-line bg-panel px-3 text-[14px] text-white outline-none focus:border-white/50"
              >
                <option value="">All keys</option>
                {[...keyCounts].sort((a, b) => a[0].localeCompare(b[0])).map(([k, n]) => (
                  <option key={k} value={k}>
                    {k} ({n})
                  </option>
                ))}
              </select>
              <div className="flex rounded-[8px] border border-line bg-panel p-0.5" role="group" aria-label="View">
                {(['grid', 'list'] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    aria-pressed={view === v}
                    onClick={() => setView(v)}
                    className={`h-9 rounded-[6px] px-3 text-[13px] ${view === v ? 'bg-white text-black' : 'text-white/70 hover:text-white'}`}
                  >
                    {v === 'grid' ? 'Grid' : 'List'}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        {actionError ? (
          <p className="mt-6 text-[14px] text-err" role="alert">
            {actionError.message}
          </p>
        ) : null}

        <div className="mt-8">
          {projectsQuery.isLoading ? (
            <p className="text-[15px] text-white/55">Loading your songs…</p>
          ) : projectsQuery.isError ? (
            <p className="text-[15px] text-err">Your songs could not be loaded: {projectsQuery.error.message}</p>
          ) : projects.length === 0 ? (
            <EmptyState onStart={(genre) => setCreate({ open: true, genre })} />
          ) : filtered.length === 0 ? (
            <p className="text-[15px] text-white/55">
              No song matches.{' '}
              <button
                type="button"
                className="underline hover:text-white"
                onClick={() => {
                  setSearch('');
                  setGenreFilter('');
                  setKeyFilter('');
                }}
              >
                Clear the filters
              </button>
            </p>
          ) : view === 'list' ? (
            <SongTable
              projects={filtered}
              selected={selected}
              onToggleSelected={toggleSelected}
              onToggleAll={(on) => setSelected(on ? new Set(filtered.map((p) => p.id)) : new Set())}
              liveKey={live.key}
              liveStatus={live.status}
              onOpen={(p) => navigate(`/editor/${p.id}/timeline`)}
              onTogglePlay={togglePlay}
              onPrepare={(p) => livePlayer.prepare(p.id, (signal) => playbackApi.forSaved(p.id, signal))}
            />
          ) : (
            <ul className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
              {filtered.map((p) => (
                <li key={p.id}>
                  <SongCard
                    project={p}
                    selected={selected.has(p.id)}
                    onToggleSelected={() => toggleSelected(p.id)}
                    live={live.key === p.id ? live.status : 'idle'}
                    liveStep={live.key === p.id ? live.step : ''}
                    liveError={live.key === p.id ? live.error : undefined}
                    progress={live.key === p.id && live.durationSec > 0 ? livePos / live.durationSec : 0}
                    onOpen={() => navigate(`/editor/${p.id}/timeline`)}
                    onDelete={() => removal.mutate(p.id)}
                    onRename={(title) => rename.mutate({ id: p.id, title })}
                    onRender={() => render.mutate(p.id)}
                    onTogglePlay={() => togglePlay(p)}
                    onPrepare={() => livePlayer.prepare(p.id, (signal) => playbackApi.forSaved(p.id, signal))}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      </main>

      {selectedIds.length > 0 ? (
        <div
          className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-panel/95 px-4 py-3 backdrop-blur sm:px-8"
          role="region"
          aria-label="Selected songs"
        >
          <div className="mx-auto flex max-w-[1240px] flex-wrap items-center gap-3">
            {confirmBulkDelete ? (
              <>
                <span className="text-[14px] text-white">
                  Delete {selectedIds.length === 1 ? 'this song' : `these ${selectedIds.length} songs`}? This cannot be undone.
                </span>
                <div className="ml-auto flex gap-2">
                  <button type="button" onClick={() => setConfirmBulkDelete(false)} className="h-9 rounded-full px-4 text-[14px] text-white/75 hover:text-white">
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={bulkDelete.isPending}
                    onClick={() => bulkDelete.mutate(selectedIds)}
                    className="h-9 rounded-full bg-err px-4 text-[14px] font-semibold text-white disabled:opacity-60"
                  >
                    {bulkDelete.isPending ? 'Deleting…' : `Delete ${selectedIds.length}`}
                  </button>
                </div>
              </>
            ) : (
              <>
                <span className="text-[14px] font-semibold text-white">{selectedIds.length} selected</span>
                <button type="button" onClick={() => setSelected(new Set(filtered.map((p) => p.id)))} className="h-9 rounded-full px-3 text-[14px] text-white/75 hover:text-white">
                  Select all shown ({filtered.length})
                </button>
                <button type="button" onClick={() => setSelected(new Set())} className="h-9 rounded-full px-3 text-[14px] text-white/75 hover:text-white">
                  Clear
                </button>
                <div className="ml-auto flex gap-2">
                  <button
                    type="button"
                    disabled={exportable.length === 0 || bulkRender.isPending}
                    onClick={() => bulkRender.mutate(exportable)}
                    title={exportable.length === 0 ? 'The selected songs are exported or exporting already' : undefined}
                    className="h-9 rounded-full border border-white/30 px-4 text-[14px] text-white hover:border-white/60 disabled:opacity-40"
                  >
                    Export WAV / MP3{exportable.length && exportable.length !== selectedIds.length ? ` (${exportable.length})` : ''}
                  </button>
                  <button type="button" onClick={() => setConfirmBulkDelete(true)} className="h-9 rounded-full bg-err/90 px-4 text-[14px] font-semibold text-white hover:bg-err">
                    Delete…
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}

      <GenerateDialog
        open={create.open}
        initialGenre={create.genre}
        onClose={() => setCreate({ open: false })}
        onCreated={(id) => {
          setCreate({ open: false });
          navigate(`/editor/${id}/timeline`);
        }}
      />
    </div>
  );
}

function EmptyState({ onStart }: { onStart(genre?: Genre): void }) {
  return (
    <section className="rounded-[16px] border border-line/60 bg-panel/60 px-6 py-10 sm:px-10 sm:py-14">
      <h2 className="app-heading max-w-[26ch] text-[28px] leading-tight text-white sm:text-[34px]">
        Your first song is a draft away.
      </h2>
      <p className="mt-3 max-w-[56ch] text-[16px] leading-relaxed text-white/65">
        Pick a genre and Casperaki writes a complete first draft from recorded instruments. Then shape it in the
        editor and render it to audio.
      </p>
      <ul className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {CANONICAL_GENRES.map((g) => (
          <li key={g}>
            <button
              type="button"
              onClick={() => onStart(g)}
              className="flex h-full w-full flex-col gap-1 rounded-[10px] border border-line bg-panel-2/60 px-4 py-4 text-left transition-colors hover:border-white/40"
            >
              <span className="text-[16px] font-semibold text-white">{GENRE_LABELS[g]}</span>
              <span className="text-[13px] leading-snug text-white/55">{GENRE_BLURBS[g]}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SongCard({
  project,
  selected,
  onToggleSelected,
  live,
  liveStep,
  liveError,
  progress,
  onOpen,
  onDelete,
  onRename,
  onRender,
  onTogglePlay,
  onPrepare,
}: {
  project: Project;
  selected: boolean;
  onToggleSelected(): void;
  live: LiveStatus;
  liveStep: string;
  liveError: string | undefined;
  progress: number;
  onOpen(): void;
  onDelete(): void;
  onRename(title: string): void;
  onRender(): void;
  onTogglePlay(): void;
  /** Hovered or focused: get the song ready so Play starts at once. */
  onPrepare(): void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(project.title);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const r = project.render;
  const meta = [project.genre === null ? null : genreLabel(project.genre), `${project.bpm} BPM`, project.key]
    .filter(Boolean)
    .join(' · ');

  return (
    <article
      className={`group relative flex h-full flex-col overflow-hidden rounded-[14px] border bg-panel transition-colors ${selected ? 'border-white/70' : 'border-line/60 hover:border-line-2'}`}
      onPointerEnter={onPrepare}
      onFocus={onPrepare}
    >
      {/* The whole card opens the song; controls sit above this layer. */}
      <button
        type="button"
        onClick={onOpen}
        className="absolute inset-0 z-0 rounded-[14px] outline-none focus-visible:ring-2 focus-visible:ring-white/70"
        aria-label={`Open ${project.title} in the editor`}
      />
      <label
        className={`absolute left-3 top-3 z-20 flex h-7 w-7 cursor-pointer items-center justify-center rounded-[6px] bg-black/50 ${selected ? '' : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100'}`}
        title={selected ? 'Deselect' : 'Select'}
      >
        <input type="checkbox" checked={selected} onChange={onToggleSelected} aria-label={`Select ${project.title}`} className="h-4 w-4 accent-white" />
      </label>
      <SectionStrip project={project} progress={progress} />
      <div className="pointer-events-none relative z-10 flex flex-1 flex-col gap-1 px-5 pb-4 pt-4">
        {editing ? (
          <form
            className="pointer-events-auto flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const t = draft.trim();
              if (t && t !== project.title) onRename(t);
              setEditing(false);
            }}
          >
            <input
              autoFocus
              value={draft}
              maxLength={120}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setDraft(project.title);
                  setEditing(false);
                }
              }}
              aria-label="Song title"
              className="h-9 min-w-0 flex-1 rounded-[6px] border border-line bg-bg px-2 text-[16px] text-white outline-none focus:border-white/50"
            />
            <button type="submit" className="rounded-[6px] bg-accent px-3 text-[13px] font-semibold text-white">
              Save
            </button>
          </form>
        ) : (
          <h3 className="truncate text-[18px] font-semibold text-white" title={project.title}>
            {project.title}
          </h3>
        )}
        <p className="text-[14px] text-white/60">{meta}</p>
        <p className="text-[13px] text-white/40">Edited {timeAgo(project.updatedAt)}</p>

        {confirmDelete ? (
          <div className="pointer-events-auto mt-4 flex items-center justify-between gap-3 rounded-[8px] bg-err/10 px-3 py-2">
            <span className="text-[14px] text-white">Delete this song?</span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className="h-8 rounded-full px-3 text-[13px] text-white/75 hover:text-white"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={onDelete}
                className="h-8 rounded-full bg-err px-3 text-[13px] font-semibold text-white"
              >
                Delete
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-4 flex items-center gap-3">
            <PlayButton project={project} live={live} onTogglePlay={onTogglePlay} />
            {live === 'loading' ? <span className="truncate text-[13px] text-white/55">{liveStep}</span> : null}
            <div className="ml-auto pointer-events-auto">
              <SongMenu
                project={project}
                onOpen={onOpen}
                onRename={() => {
                  setDraft(project.title);
                  setEditing(true);
                }}
                onDelete={() => setConfirmDelete(true)}
                onRender={onRender}
              />
            </div>
          </div>
        )}
        {live === 'error' && liveError ? (
          <p className="mt-2 text-[12px] text-err" role="alert">
            Playback failed: {liveError}
          </p>
        ) : null}
        {r.state === 'failed' && r.error ? (
          <p className="mt-2 truncate text-[12px] text-err" title={r.error}>
            Export failed: {r.error.split('\n')[0]}
          </p>
        ) : null}
      </div>
    </article>
  );
}

/** The song's sections as coloured blocks sized by length; while it plays
 *  the played part is shown brighter. */
function SectionStrip({ project, progress }: { project: Project; progress: number }) {
  const total = project.sections.reduce((n, s) => n + s.bars, 0);
  return (
    <div className="relative px-5 pt-5" aria-hidden="true">
      <div className="flex h-12 gap-[2px]">
        {project.sections.map((s, i) => (
          <div
            key={`${s.name}-${i}`}
            className="min-w-0 rounded-[3px]"
            style={{ flexGrow: s.bars, flexBasis: 0, background: sectionColor(s.type ?? s.name), opacity: 0.7 }}
          />
        ))}
      </div>
      {progress > 0 ? (
        <div className="pointer-events-none absolute bottom-0 left-5 right-5 top-5">
          <div className="h-full bg-white/25" style={{ width: `${progress * 100}%` }} />
        </div>
      ) : null}
      <p className="sr-only">
        {project.sections.length} sections, {total} bars
      </p>
    </div>
  );
}

function PlayButton({
  project,
  live,
  onTogglePlay,
}: {
  project: Project;
  live: LiveStatus;
  onTogglePlay(): void;
}) {
  const playing = live === 'playing';
  const loading = live === 'loading';
  return (
    <button
      type="button"
      onClick={onTogglePlay}
      disabled={loading}
      className="pointer-events-auto inline-flex h-10 shrink-0 items-center gap-2 rounded-full bg-white px-4 text-[14px] font-semibold text-black transition-colors hover:bg-white/85 disabled:opacity-70"
      aria-label={playing ? `Pause ${project.title}` : `Play ${project.title}`}
    >
      <span aria-hidden="true">{loading ? '…' : playing ? '❚❚' : '▶'}</span>
      {loading ? 'Loading' : playing ? 'Pause' : 'Play'}
    </button>
  );
}

function SongMenu({
  project,
  onOpen,
  onRename,
  onDelete,
  onRender,
}: {
  project: Project;
  onOpen(): void;
  onRename(): void;
  onDelete(): void;
  onRender(): void;
}) {
  const r = project.render;
  const item = 'cursor-pointer rounded-[6px] px-3 py-2 text-[14px] outline-none data-[highlighted]:bg-white/10';
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="flex h-10 w-10 items-center justify-center rounded-full text-[18px] text-white/70 outline-none hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-white/70"
        aria-label={`More actions for ${project.title}`}
      >
        …
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={6}
        className="z-50 min-w-[200px] rounded-[10px] border border-line bg-panel p-1 text-white shadow-2xl"
      >
        <DropdownMenuItem className={item} onSelect={onOpen}>
          Open in editor
        </DropdownMenuItem>
        <DropdownMenuItem className={item} onSelect={onRename}>
          Rename
        </DropdownMenuItem>
        {r.state === 'done' && r.wavUrl && r.mp3Url ? (
          <>
            <DropdownMenuItem className={item} asChild>
              <a href={`${r.wavUrl}?download=1`}>Download WAV</a>
            </DropdownMenuItem>
            <DropdownMenuItem className={item} asChild>
              <a href={`${r.mp3Url}?download=1`}>Download MP3</a>
            </DropdownMenuItem>
            {r.unmasteredWavUrl && r.unmasteredMp3Url ? (
              <>
                <DropdownMenuItem className={item} asChild>
                  <a href={`${r.unmasteredWavUrl}?download=1`}>Download WAV (unmastered)</a>
                </DropdownMenuItem>
                <DropdownMenuItem className={item} asChild>
                  <a href={`${r.unmasteredMp3Url}?download=1`}>Download MP3 (unmastered)</a>
                </DropdownMenuItem>
              </>
            ) : null}
          </>
        ) : renderInFlight(r) ? (
          <DropdownMenuItem className={`${item} text-white/50`} disabled>
            Exporting: {renderLabel(r)}
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem className={item} onSelect={onRender}>
            {r.state === 'failed' ? 'Retry export (WAV / MP3)' : 'Export WAV / MP3'}
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator className="my-1 h-px bg-line" />
        <DropdownMenuItem className={`${item} text-err`} onSelect={onDelete}>
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const RELATIVE = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/** "just now", "5 minutes ago", "yesterday", or a date for older edits. */
function timeAgo(iso: string): string {
  const then = new Date(iso);
  const seconds = (then.getTime() - Date.now()) / 1000;
  const abs = Math.abs(seconds);
  if (abs < 45) return 'just now';
  if (abs < 3600) return RELATIVE.format(Math.round(seconds / 60), 'minute');
  if (abs < 86400) return RELATIVE.format(Math.round(seconds / 3600), 'hour');
  if (abs < 7 * 86400) return RELATIVE.format(Math.round(seconds / 86400), 'day');
  return `on ${then.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

/** The songs as a compact table: select, play, title, style, key, tempo, length, edited, export. */
function SongTable({
  projects,
  selected,
  onToggleSelected,
  onToggleAll,
  liveKey,
  liveStatus,
  onOpen,
  onTogglePlay,
  onPrepare,
}: {
  projects: readonly Project[];
  selected: ReadonlySet<string>;
  onToggleSelected(id: string): void;
  onToggleAll(on: boolean): void;
  liveKey: string | undefined;
  liveStatus: LiveStatus;
  onOpen(p: Project): void;
  onTogglePlay(p: Project): void;
  onPrepare(p: Project): void;
}) {
  const allOn = projects.length > 0 && projects.every((p) => selected.has(p.id));
  const someOn = projects.some((p) => selected.has(p.id));
  const cell = 'px-3 py-2.5 text-[14px]';
  return (
    <div className="overflow-x-auto rounded-[12px] border border-line/60 bg-panel">
      <table className="w-full min-w-[760px] border-collapse">
        <thead>
          <tr className="border-b border-line/60 text-left text-[12px] text-white/50">
            <th className="w-10 px-3 py-2">
              <input
                type="checkbox"
                checked={allOn}
                ref={(el) => {
                  if (el) el.indeterminate = someOn && !allOn;
                }}
                onChange={(e) => onToggleAll(e.target.checked)}
                aria-label="Select all shown songs"
                className="h-4 w-4 accent-white"
              />
            </th>
            <th className="w-12 px-1 py-2" aria-label="Play" />
            <th className="px-3 py-2 font-normal">Title</th>
            <th className="px-3 py-2 font-normal">Style</th>
            <th className="px-3 py-2 font-normal">Key</th>
            <th className="px-3 py-2 text-right font-normal">Tempo</th>
            <th className="px-3 py-2 text-right font-normal">Length</th>
            <th className="px-3 py-2 font-normal">Edited</th>
            <th className="px-3 py-2 font-normal">Export</th>
          </tr>
        </thead>
        <tbody>
          {projects.map((p) => {
            const live = liveKey === p.id ? liveStatus : 'idle';
            const r = p.render;
            return (
              <tr
                key={p.id}
                className={`border-b border-line/40 last:border-0 ${selected.has(p.id) ? 'bg-white/[0.06]' : 'hover:bg-white/[0.03]'}`}
                onPointerEnter={() => onPrepare(p)}
              >
                <td className="px-3 py-2.5">
                  <input type="checkbox" checked={selected.has(p.id)} onChange={() => onToggleSelected(p.id)} aria-label={`Select ${p.title}`} className="h-4 w-4 accent-white" />
                </td>
                <td className="px-1 py-2.5">
                  <button
                    type="button"
                    onClick={() => onTogglePlay(p)}
                    disabled={live === 'loading'}
                    aria-label={live === 'playing' ? `Pause ${p.title}` : `Play ${p.title}`}
                    className="flex h-8 w-8 items-center justify-center rounded-full bg-white text-[11px] text-black hover:bg-white/85 disabled:opacity-60"
                  >
                    {live === 'loading' ? '…' : live === 'playing' ? '❚❚' : '▶'}
                  </button>
                </td>
                <td className={cell}>
                  <button type="button" onClick={() => onOpen(p)} className="max-w-[320px] truncate text-left font-semibold text-white hover:underline" title={`Open ${p.title}`}>
                    {p.title}
                  </button>
                </td>
                <td className={`${cell} text-white/70`}>{p.genre === null ? '—' : genreLabel(p.genre)}</td>
                <td className={`${cell} font-mono text-white/70`}>{p.key}</td>
                <td className={`${cell} text-right font-mono text-white/70`}>{p.bpm}</td>
                <td className={`${cell} text-right font-mono text-white/70`}>{songLength(p)}</td>
                <td className={`${cell} text-white/55`}>{timeAgo(p.updatedAt)}</td>
                <td className={`${cell} text-white/55`}>
                  {r.state === 'done' ? (
                    <span className="flex gap-2">
                      {r.wavUrl ? (
                        <a className="underline hover:text-white" href={`${r.wavUrl}?download=1`}>
                          WAV
                        </a>
                      ) : null}
                      {r.mp3Url ? (
                        <a className="underline hover:text-white" href={`${r.mp3Url}?download=1`}>
                          MP3
                        </a>
                      ) : null}
                    </span>
                  ) : renderInFlight(r) ? (
                    renderLabel(r)
                  ) : r.state === 'failed' ? (
                    <span className="text-err" title={r.error ?? undefined}>
                      Failed
                    </span>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
