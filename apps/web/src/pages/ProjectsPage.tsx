import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { AppHeader } from '../layout/AppHeader';
import { defaultBrainClient } from '../api/client';
import {
  renderInFlight,
  renderLabel,
  songsApi,
  songsQueryKeys,
  type Project,
} from '../api/songs';
import { GenerateDialog } from '../editor/GenerateDialog';

type SortKey = 'updated' | 'created' | 'title';

/**
 * Projects screen.
 *
 * Mirrors `rory-fe/src/views/ProjectsView.vue`: header + 20%/70% split
 * between sidebar nav and listing main. The list is the signed-in user's
 * projects from the brain (GET /api/songs). Each card can open the
 * editor, render the song on the server, play the render, download it as
 * WAV, rename and delete. Bottom-left has the circular Create FAB with
 * rory's red-magenta-blue gradient, which opens the generate dialog.
 */
export function ProjectsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [showPage, setShowPage] = useState(false);
  const [searchActive, setSearchActive] = useState(false);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortKey>('updated');
  const [createOpen, setCreateOpen] = useState(false);
  const [playingId, setPlayingId] = useState<string | undefined>(undefined);
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setShowPage(true), 80);
    return () => clearTimeout(t);
  }, []);

  // The header's Create button links here with ?create=1.
  useEffect(() => {
    if (searchParams.get('create') === '1') {
      setCreateOpen(true);
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  const health = useQuery({
    queryKey: ['health'],
    queryFn: () => defaultBrainClient.get<{ ok: boolean; service: string }>('/healthz'),
    refetchInterval: 15_000,
    retry: 0,
  });
  const brainOk = health.data?.ok === true;

  const projectsQuery = useQuery({
    queryKey: songsQueryKeys.list,
    queryFn: ({ signal }) => songsApi.list(signal),
    // Poll while any render is queued or running so cards update by themselves.
    refetchInterval: (q) =>
      q.state.data?.projects.some((p) => renderInFlight(p.render)) ? 2000 : false,
  });
  const projects = projectsQuery.data?.projects ?? [];

  const invalidate = () => queryClient.invalidateQueries({ queryKey: songsQueryKeys.list });

  const removal = useMutation({
    mutationFn: (id: string) => songsApi.remove(id),
    onSuccess: (_d, id) => {
      if (playingId === id) setPlayingId(undefined);
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

  const togglePlay = (p: Project) => {
    const audio = audioRef.current;
    if (!audio || !p.render.mp3Url) return;
    if (playingId === p.id && !audio.paused) {
      audio.pause();
      return;
    }
    if (playingId !== p.id) {
      audio.src = p.render.mp3Url;
      setPlayingId(p.id);
    }
    void audio.play();
  };
  const [paused, setPaused] = useState(true);

  const needle = search.trim().toLowerCase();
  const filtered = projects
    .filter(
      (p) =>
        !needle ||
        p.title.toLowerCase().includes(needle) ||
        (p.genre ?? '').toLowerCase().includes(needle) ||
        p.key.toLowerCase().includes(needle) ||
        p.id.includes(needle),
    )
    .sort((a, b) =>
      sort === 'title'
        ? a.title.localeCompare(b.title)
        : sort === 'created'
          ? b.createdAt.localeCompare(a.createdAt)
          : b.updatedAt.localeCompare(a.updatedAt),
    );

  return (
    <div
      className={`min-h-screen w-full bg-bg text-fg transition-opacity duration-400 ${
        showPage ? 'opacity-100' : 'opacity-0'
      }`}
    >
      <div className="max-w-[1800px] mx-auto px-[6vw]">
        <AppHeader />

        <section className="flex flex-col md:flex-row justify-between pt-[3vw] md:pt-[5vw] gap-8 md:gap-12">
          {/* Sidebar */}
          <aside className="w-full md:w-1/5 md:min-w-[180px] flex md:flex-col flex-row flex-wrap items-center md:items-start gap-x-5 gap-y-1 md:sticky md:top-6 md:self-start">
            <SidebarLink active>Projects</SidebarLink>
            <SidebarLink onClick={() => navigate('/catalog')}>Catalog</SidebarLink>

            <div className="hidden md:block mt-12 text-[11px] uppercase tracking-[0.18em] text-dim/70 w-full">
              brain
            </div>
            <div className="md:mt-2 flex items-center gap-2 text-[12px]">
              <span
                className={`h-2 w-2 rounded-full ${
                  health.isLoading ? 'bg-dim' : brainOk ? 'bg-ok' : 'bg-err'
                }`}
                aria-hidden="true"
              />
              <span className="text-muted">
                {health.isLoading ? 'connecting' : brainOk ? 'connected' : 'unreachable'}
              </span>
            </div>
          </aside>

          {/* Main */}
          <main className="flex-1 flex flex-col mr-0 lg:mr-[60px] min-h-[60vh] pb-32">
            <header className="flex items-center justify-between gap-6 mb-2">
              <div
                className={`relative transition-all duration-300 ${
                  searchActive ? 'w-[34%]' : 'w-[22%]'
                } min-w-[160px]`}
              >
                <input
                  type="text"
                  placeholder="Search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onFocus={() => setSearchActive(true)}
                  onBlur={() => setSearchActive(false)}
                  className={`w-full h-[45px] rounded-lg text-[15px] px-5 outline-none transition-colors text-white placeholder:text-dim/70 ${
                    searchActive ? 'bg-[#22252c]' : 'bg-[#14171b]'
                  }`}
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-dim text-[16px]">
                  ⌕
                </span>
              </div>

              <div className="flex items-center gap-3">
                <label
                  htmlFor="projects-sort"
                  className="text-[13px] uppercase tracking-[0.12em] text-muted font-semibold"
                >
                  Sort by
                </label>
                <select
                  id="projects-sort"
                  value={sort}
                  onChange={(e) => setSort(e.target.value as SortKey)}
                  className="h-[45px] rounded-lg bg-[#14171b] text-white text-[15px] px-5 pr-10 outline-none border-0"
                >
                  <option value="updated">Last updated</option>
                  <option value="created">Date created</option>
                  <option value="title">Title</option>
                </select>
              </div>
            </header>

            <div
              className={`flex flex-col gap-6 pt-12 transition-opacity ${
                searchActive ? 'opacity-60' : 'opacity-100'
              }`}
            >
              {projectsQuery.isLoading ? (
                <p className="text-muted text-[15px]">Loading projects…</p>
              ) : projectsQuery.isError ? (
                <p className="text-err text-[14px]">
                  Could not load projects: {projectsQuery.error.message}
                </p>
              ) : filtered.length === 0 ? (
                projects.length === 0 ? (
                  <EmptyState onCreate={() => setCreateOpen(true)} />
                ) : (
                  <p className="text-muted text-[15px]">No project matches “{search}”.</p>
                )
              ) : (
                filtered.map((p) => (
                  <ListingItem
                    key={p.id}
                    project={p}
                    playing={playingId === p.id && !paused}
                    onOpen={() => navigate(`/editor/${p.id}/timeline`)}
                    onDelete={() => removal.mutate(p.id)}
                    onRename={(title) => rename.mutate({ id: p.id, title })}
                    onRender={() => render.mutate(p.id)}
                    onTogglePlay={() => togglePlay(p)}
                  />
                ))
              )}
              {removal.isError || rename.isError || render.isError ? (
                <p className="text-err text-[13px]">
                  {(removal.error ?? rename.error ?? render.error)?.message}
                </p>
              ) : null}
            </div>

            <footer className="flex items-center justify-between pt-10 text-[13px] text-muted">
              <p>
                {filtered.length} of {projects.length} projects
              </p>
            </footer>
          </main>
        </section>
      </div>

      <audio
        ref={audioRef}
        className="hidden"
        onPlay={() => setPaused(false)}
        onPause={() => setPaused(true)}
        onEnded={() => setPaused(true)}
      />

      {/* Create FAB — rory `.create` gradient */}
      <button
        type="button"
        onClick={() => setCreateOpen(true)}
        className="fixed left-6 bottom-6 md:left-[120px] md:bottom-[120px] z-30 w-[88px] h-[88px] md:w-[126px] md:h-[126px] rounded-full flex items-center justify-center text-white text-[36px] md:text-[44px] font-light shadow-2xl transition-transform hover:scale-110 active:scale-95"
        style={{
          background:
            'linear-gradient(77.45deg, #ff0000 -2.37%, #cd24c6 68.41%, #1e70eb 129.34%)',
        }}
        aria-label="Create new project"
      >
        <span className="transition-transform hover:rotate-90">+</span>
      </button>

      <GenerateDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(id) => {
          setCreateOpen(false);
          navigate(`/editor/${id}/timeline`);
        }}
      />
    </div>
  );
}

function SidebarLink({
  children,
  active = false,
  onClick,
}: {
  children: React.ReactNode;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`py-[5px] text-[22px] leading-tight text-left transition-colors ${
        active ? 'text-white font-semibold' : 'text-white/60 hover:text-white/90'
      }`}
    >
      {children}
    </button>
  );
}

function EmptyState({ onCreate }: { onCreate(): void }) {
  return (
    <div className="rounded-2xl bg-[rgba(38,43,51,0.55)] px-10 py-12 flex flex-col items-start gap-4 border border-line/40">
      <h2 className="text-white text-[24px] font-semibold leading-tight">
        No projects yet
      </h2>
      <p className="text-muted text-[15px] max-w-[460px] leading-relaxed">
        Hit <span className="text-white font-semibold">Create</span> (or the big
        round button bottom-left) to generate your first song. Then open it in the
        editor, or render it to audio straight from this list.
      </p>
      <button
        type="button"
        onClick={onCreate}
        className="h-11 px-6 rounded-full bg-accent text-white text-[14px] font-semibold mt-2 hover:bg-accent/90 transition-colors"
      >
        Generate a song
      </button>
    </div>
  );
}

function ListingItem({
  project,
  playing,
  onOpen,
  onDelete,
  onRename,
  onRender,
  onTogglePlay,
}: {
  project: Project;
  playing: boolean;
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
  const busy = renderInFlight(r);
  const updated = new Date(project.updatedAt);
  const stop = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    fn();
  };

  return (
    <div
      className="group relative flex flex-col sm:flex-row justify-between items-start gap-6 bg-[rgba(38,43,51,0.7)] rounded-[15px] p-7 sm:p-9 cursor-pointer overflow-hidden hover:bg-[rgba(48,53,61,0.7)] transition-colors"
      onClick={() => !editing && onOpen()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !editing && e.target === e.currentTarget) onOpen();
      }}
      role="button"
      tabIndex={0}
    >
      <div className="flex flex-col gap-3 min-w-0">
        {editing ? (
          <form
            className="flex gap-2"
            onClick={(e) => e.stopPropagation()}
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
              className="h-10 rounded-lg bg-[#14171b] text-white text-[20px] px-3 outline-none min-w-[240px]"
              aria-label="Project title"
            />
            <button type="submit" className="px-3 rounded-lg bg-accent text-white text-[13px] font-semibold">
              Save
            </button>
          </form>
        ) : (
          <h3 className="text-white text-[24px] font-semibold leading-tight truncate max-w-[520px]">
            {project.title}
          </h3>
        )}
        <ul className="flex flex-wrap gap-x-8 gap-y-1 text-[14px] text-muted">
          <li>
            Genre <strong className="text-white font-semibold ml-1.5">{project.genre ?? '—'}</strong>
          </li>
          <li>
            Key <strong className="text-white font-semibold ml-1.5">{project.key}</strong>
          </li>
          <li>
            BPM <strong className="text-white font-semibold ml-1.5">{project.bpm}</strong>
          </li>
          <li>
            Updated{' '}
            <strong className="text-white font-semibold ml-1.5">
              {updated.toLocaleDateString()} {updated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </strong>
          </li>
        </ul>
        <div className="flex items-center gap-2 text-[12px]">
          <span
            className={`h-2 w-2 rounded-full ${
              r.state === 'done' ? 'bg-ok' : r.state === 'failed' ? 'bg-err' : busy ? 'bg-accent animate-pulse' : 'bg-dim'
            }`}
            aria-hidden="true"
          />
          <span className={r.state === 'failed' ? 'text-err' : 'text-muted'}>{renderLabel(r)}</span>
          {r.state === 'failed' && r.error ? (
            <span className="text-dim font-mono truncate max-w-[420px]" title={r.error}>
              {r.error.split('\n')[0]}
            </span>
          ) : null}
        </div>
      </div>

      <div className="flex items-center gap-1 shrink-0 opacity-80 group-hover:opacity-100 transition-opacity">
        <IconButton glyph="↗" label="Open in editor" onClick={stop(onOpen)} />
        {r.state === 'done' ? (
          <>
            <IconButton glyph={playing ? '❚❚' : '▶'} label={playing ? 'Pause' : 'Play'} onClick={stop(onTogglePlay)} />
            <a
              href={`${r.wavUrl}?download=1`}
              onClick={(e) => e.stopPropagation()}
              aria-label="Download WAV"
              title="Download WAV"
              className="h-10 w-10 rounded-full flex items-center justify-center text-[17px] text-white/70 hover:text-white hover:bg-white/10"
            >
              ↓
            </a>
          </>
        ) : (
          <IconButton
            glyph={busy ? '…' : '♫'}
            label={busy ? renderLabel(r) : r.state === 'failed' ? 'Retry render' : 'Render audio'}
            disabled={busy}
            onClick={stop(onRender)}
          />
        )}
        <IconButton
          glyph="✎"
          label="Rename"
          onClick={stop(() => {
            setDraft(project.title);
            setEditing(true);
          })}
        />
        {confirmDelete ? (
          <button
            type="button"
            onClick={stop(onDelete)}
            onBlur={() => setConfirmDelete(false)}
            autoFocus
            className="h-10 px-3 rounded-full bg-err/80 text-white text-[13px] font-semibold"
          >
            Delete?
          </button>
        ) : (
          <IconButton glyph="✕" label="Delete" onClick={stop(() => setConfirmDelete(true))} />
        )}
      </div>
    </div>
  );
}

function IconButton({
  glyph,
  label,
  onClick,
  disabled,
}: {
  glyph: string;
  label: string;
  onClick?: (e: React.MouseEvent) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`h-10 w-10 rounded-full flex items-center justify-center text-[17px] transition-all ${
        disabled
          ? 'text-white/30 cursor-not-allowed'
          : 'text-white/70 hover:text-white hover:bg-white/10'
      }`}
    >
      {glyph}
    </button>
  );
}
