import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import { useSession } from '../state/session';
import { AccountMenu } from './AccountMenu';
import { TasksMenu } from './TasksMenu';

/**
 * The navigation of every signed-in page, the editor included: wordmark,
 * page links, one "New song" action and the account menu, 44 px high on
 * every page. `compact`: the editor's (solid background, as its own control
 * bar sits below). While a song is
 * open, its title is a link back to it (the view it was left in), so the
 * sound library and the other pages are a click away from the song.
 */
let lastSongPath: string | undefined;

export function AppHeader({ compact = false }: { compact?: boolean }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { pathname } = useLocation();
  const { activeSong } = useSession();
  const inSong = pathname.startsWith('/editor/');
  if (inSong) lastSongPath = pathname;
  const songPath = activeSong ? (lastSongPath?.startsWith(`/editor/${activeSong.id}/`) ? lastSongPath : `/editor/${activeSong.id}/timeline`) : undefined;
  return (
    <header className={`h-11 shrink-0 border-b border-line/60 ${compact ? 'bg-bg' : ''}`}>
      <div className="flex h-full items-center gap-6 px-4 sm:gap-10">
        <Link to="/" className="shrink-0" aria-label="Casperaki: your songs">
          <img src="/brand/casperaki-logo.svg" alt="Casperaki" width={140} height={16} className="block h-[16px] w-auto" />
        </Link>
        <nav className="hidden h-full items-center gap-6 text-[15px] sm:flex" aria-label="Main">
          <HeaderLink to="/">Songs</HeaderLink>
          {activeSong && songPath ? (
            <HeaderLink to={songPath} lit={inSong} title={`Back to ${activeSong.project.title}`}>
              {`♪ ${activeSong.project.title}`}
            </HeaderLink>
          ) : null}
          <HeaderLink to="/sounds">Sounds</HeaderLink>
          <HeaderLink to="/singers">Singers</HeaderLink>
          <HeaderLink to="/avatars" lit={pathname.startsWith('/avatars/')}>Avatars</HeaderLink>
          <HeaderLink to="/melodies">Melodies</HeaderLink>
          {user?.isAdmin ? <HeaderLink to="/suggestions">Suggestions</HeaderLink> : null}
        </nav>
        <div className="ml-auto flex items-center gap-3">
          <TasksMenu />
          <button
            type="button"
            onClick={() => navigate('/hum')}
            className="h-8 whitespace-nowrap rounded-full border border-white/30 px-4 text-[14px] font-semibold text-white transition-colors hover:border-white/60"
          >
            Hum a song
          </button>
          <button
            type="button"
            onClick={() => navigate('/?create=1')}
            className="h-8 whitespace-nowrap rounded-full bg-accent px-4 text-[14px] font-semibold text-white transition-colors hover:bg-[#e00000]"
          >
            New song
          </button>
          <AccountMenu />
        </div>
      </div>
    </header>
  );
}

function HeaderLink({ to, lit = false, title, children }: { to: string; lit?: boolean; title?: string; children: string }) {
  return (
    <NavLink
      to={to}
      end
      title={title}
      className={({ isActive }) =>
        `flex h-full min-w-0 max-w-[220px] shrink-0 items-center whitespace-nowrap border-b-2 transition-colors ${
          isActive || lit ? 'border-accent text-white' : 'border-transparent text-white/60 hover:text-white'
        }`
      }
    >
      <span className="truncate">{children}</span>
    </NavLink>
  );
}
