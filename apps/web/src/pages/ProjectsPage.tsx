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

type SortKey = 'updated' | 'created' | 'title';

/**
 * Songs: the signed-in home screen. A grid of the user's songs, each drawn
 * as its section outline, with one main action (render, then play) and a
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
        !needle ||
        p.title.toLowerCase().includes(needle) ||
        (p.genre !== null && genreLabel(p.genre).toLowerCase().includes(needle)),
    )
    .sort((a, b) =>
      sort === 'title'
        ? a.title.localeCompare(b.title)
        : sort === 'created'
          ? b.createdAt.localeCompare(a.createdAt)
          : b.updatedAt.localeCompare(a.updatedAt),
    );
  const actionError = removal.error ?? rename.error ?? render.error;

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
              </select>
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
            <p className="text-[15px] text-white/55">No song matches “{search}”.</p>
          ) : (
            <ul className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
              {filtered.map((p) => (
                <li key={p.id}>
                  <SongCard
                    project={p}
                    live={live.key === p.id ? live.status : 'idle'}
                    liveStep={live.key === p.id ? live.step : ''}
                    liveError={live.key === p.id ? live.error : undefined}
                    progress={live.key === p.id && live.durationSec > 0 ? livePos / live.durationSec : 0}
                    onOpen={() => navigate(`/editor/${p.id}/timeline`)}
                    onDelete={() => removal.mutate(p.id)}
                    onRename={(title) => rename.mutate({ id: p.id, title })}
                    onRender={() => render.mutate(p.id)}
                    onTogglePlay={() => togglePlay(p)}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      </main>

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
  live,
  liveStep,
  liveError,
  progress,
  onOpen,
  onDelete,
  onRename,
  onRender,
  onTogglePlay,
}: {
  project: Project;
  live: LiveStatus;
  liveStep: string;
  liveError: string | undefined;
  progress: number;
  onOpen(): void;
  onDelete(): void;
  onRename(title: string): void;
  onRender(): void;
  onTogglePlay(): void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(project.title);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const r = project.render;
  const meta = [project.genre === null ? null : genreLabel(project.genre), `${project.bpm} BPM`, project.key]
    .filter(Boolean)
    .join(' · ');

  return (
    <article className="group relative flex h-full flex-col overflow-hidden rounded-[14px] border border-line/60 bg-panel transition-colors hover:border-line-2">
      {/* The whole card opens the song; controls sit above this layer. */}
      <button
        type="button"
        onClick={onOpen}
        className="absolute inset-0 z-0 rounded-[14px] outline-none focus-visible:ring-2 focus-visible:ring-white/70"
        aria-label={`Open ${project.title} in the editor`}
      />
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
