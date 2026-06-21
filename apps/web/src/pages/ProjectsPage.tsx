import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { AppHeader } from '../layout/AppHeader';
import { defaultBrainClient } from '../api/client';
import { useSession, type ProjectListItem } from '../state/session';
import { GenerateDialog } from '../editor/GenerateDialog';
import { generatorView, summarizeStructure } from '../types/song';

/**
 * Projects screen.
 *
 * Mirrors `rory-fe/src/views/ProjectsView.vue`: header + 20%/70% split
 * between sidebar nav and listing main. Right side has search + sort
 * + a vertical list of project cards (rory's `<ListingItem>`). Bottom-
 * left has the circular Create FAB with rory's red-magenta-blue
 * gradient — clicking it opens the generate dialog rather than
 * exploding into a new screen (that animation is theatre we'll add
 * later if it earns its keep).
 */
export function ProjectsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { songs, removeSong } = useSession();
  const [showPage, setShowPage] = useState(false);
  const [searchActive, setSearchActive] = useState(false);
  const [search, setSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setShowPage(true), 80);
    return () => clearTimeout(t);
  }, []);

  const health = useQuery({
    queryKey: ['health'],
    queryFn: () => defaultBrainClient.get<{ ok: boolean; service: string }>('/healthz'),
    refetchInterval: 15_000,
    retry: 0,
  });
  const brainOk = health.data?.ok === true;

  const removal = useMutation({
    mutationFn: async (id: string) => {
      removeSong(id);
      queryClient.removeQueries({ queryKey: ['song', id] });
    },
  });

  const filtered = songs.filter((p) => {
    if (!search.trim()) return true;
    const needle = search.trim().toLowerCase();
    return (
      p.song.id.toLowerCase().includes(needle) ||
      p.genre.toLowerCase().includes(needle) ||
      (p.song.song.title ?? '').toLowerCase().includes(needle) ||
      p.seed.toLowerCase().includes(needle)
    );
  });

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
            <SidebarLink>Templates</SidebarLink>
            <SidebarLink>Vibes</SidebarLink>
            <SidebarLink>Profile</SidebarLink>
            <SidebarLink>Settings</SidebarLink>

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
                {health.isLoading
                  ? 'connecting'
                  : brainOk
                    ? '@casperaki/brain · 16500'
                    : 'unreachable'}
              </span>
            </div>
          </aside>

          {/* Main */}
          <main className="flex-1 flex flex-col mr-0 lg:mr-[60px] min-h-[60vh] pb-32">
            <header className="flex items-center justify-between gap-6 mb-2">
              <div
                className={`relative transition-all duration-300 ${
                  searchActive ? 'w-[34%]' : 'w-[22%]'
                }`}
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
                <label className="text-[13px] uppercase tracking-[0.12em] text-muted font-semibold">
                  Sort by
                </label>
                <select className="h-[45px] rounded-lg bg-[#14171b] text-white text-[15px] px-5 pr-10 outline-none border-0">
                  <option>Last updated</option>
                  <option>Date created</option>
                  <option>Project length</option>
                </select>
              </div>
            </header>

            <div
              className={`flex flex-col gap-6 pt-12 transition-opacity ${
                searchActive ? 'opacity-60' : 'opacity-100'
              }`}
            >
              {filtered.length === 0 ? (
                <EmptyState onCreate={() => setCreateOpen(true)} />
              ) : (
                filtered.map((p) => (
                  <ListingItem
                    key={p.song.id}
                    project={p}
                    onOpen={() => navigate(`/editor/${p.song.id}/timeline`)}
                    onDelete={() => removal.mutate(p.song.id)}
                  />
                ))
              )}
            </div>

            <footer className="flex items-center justify-between pt-10 text-[13px] text-muted">
              <p>
                {filtered.length} of {songs.length} projects
              </p>
              <button className="text-white/60 hover:text-white text-[13px]" disabled>
                Next →
              </button>
            </footer>
          </main>
        </section>
      </div>

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
}: {
  children: React.ReactNode;
  active?: boolean;
}) {
  return (
    <a
      className={`py-[5px] text-[22px] leading-tight cursor-pointer transition-colors ${
        active ? 'text-white font-semibold' : 'text-white/60 hover:text-white/90'
      }`}
    >
      {children}
    </a>
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
        round button bottom-left) to generate your first deterministic song via
        the brain.
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
  onOpen,
  onDelete,
}: {
  project: ProjectListItem;
  onOpen(): void;
  onDelete(): void;
}) {
  const summary = summarizeStructure(project.song.song);
  const totalBars = summary.reduce((sum, s) => sum + s.bars, 0);
  const seconds = Math.round((totalBars * 4 * 60) / project.song.song.bpm);
  const mm = Math.floor(seconds / 60);
  const ss = String(seconds % 60).padStart(2, '0');
  const gen = generatorView(project.song.song);
  const title = project.song.song.title || `${project.genre} · ${project.seed}`;

  return (
    <div
      className="group relative flex justify-between items-start gap-6 bg-[rgba(38,43,51,0.7)] rounded-[15px] p-9 cursor-pointer overflow-hidden hover:bg-[rgba(48,53,61,0.7)] transition-colors"
      onClick={onOpen}
      role="button"
      tabIndex={0}
    >
      <div className="flex flex-col gap-3 min-w-0">
        <h3 className="text-white text-[24px] font-semibold leading-tight truncate max-w-[520px]">
          {title}
        </h3>
        <ul className="flex flex-wrap gap-x-8 gap-y-1 text-[14px] text-muted">
          <li>
            Genre <strong className="text-white font-semibold ml-1.5">{project.genre}</strong>
          </li>
          <li>
            Length <strong className="text-white font-semibold ml-1.5">{mm}m {ss}s</strong>
          </li>
          <li>
            Segments <strong className="text-white font-semibold ml-1.5">{summary.length}</strong>
          </li>
          <li>
            BPM <strong className="text-white font-semibold ml-1.5">{project.song.song.bpm}</strong>
          </li>
          <li>
            Seed{' '}
            <strong className="text-white font-mono font-semibold ml-1.5">
              {gen?.seed ?? project.seed}
            </strong>
          </li>
        </ul>
        <div className="font-mono text-[11px] text-dim mt-1 break-all">
          #{project.song.id} · {project.song.hash.slice(0, 32)}…
        </div>
      </div>

      <div className="flex items-center gap-1 shrink-0 opacity-80 group-hover:opacity-100 transition-opacity">
        <IconButton
          glyph="↗"
          label="Open"
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
        />
        <IconButton glyph="▶" label="Play" disabled />
        <IconButton glyph="↓" label="Download" disabled />
        <IconButton
          glyph="✕"
          label="Delete"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
        />
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
