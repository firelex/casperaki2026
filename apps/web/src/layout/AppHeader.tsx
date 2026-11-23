import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import { AccountMenu } from './AccountMenu';

/**
 * The navigation of every signed-in page, the editor included: wordmark,
 * page links, one "New song" action and the account menu. `compact`: the
 * editor's slimmer version (its own control bar sits below). "Songs" stays
 * lit inside a song.
 */
export function AppHeader({ compact = false }: { compact?: boolean }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const inSong = useLocation().pathname.startsWith('/editor/');
  return (
    <header className={`${compact ? 'h-11 bg-bg' : 'h-16'} shrink-0 border-b border-line/60`}>
      <div className={`flex h-full items-center gap-6 sm:gap-10 ${compact ? 'px-4' : 'mx-auto max-w-[1240px] px-4 sm:px-8'}`}>
        <Link to="/" className="shrink-0" aria-label="Casperaki: your songs">
          <img src="/brand/casperaki-logo.svg" alt="Casperaki" width={140} height={16} className="block h-[16px] w-auto" />
        </Link>
        <nav className="hidden h-full items-center gap-6 text-[15px] sm:flex" aria-label="Main">
          <HeaderLink to="/" lit={inSong}>Songs</HeaderLink>
          <HeaderLink to="/sounds">Sound library</HeaderLink>
          {user?.isAdmin ? <HeaderLink to="/suggestions">Suggestions</HeaderLink> : null}
        </nav>
        <div className="ml-auto flex items-center gap-3">
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

function HeaderLink({ to, lit = false, children }: { to: string; lit?: boolean; children: string }) {
  return (
    <NavLink
      to={to}
      end
      className={({ isActive }) =>
        `flex h-full items-center border-b-2 transition-colors ${
          isActive || lit ? 'border-accent text-white' : 'border-transparent text-white/60 hover:text-white'
        }`
      }
    >
      {children}
    </NavLink>
  );
}
