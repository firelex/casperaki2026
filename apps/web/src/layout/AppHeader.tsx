import { Link, NavLink, useNavigate } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import { AccountMenu } from './AccountMenu';

/**
 * Header of the signed-in pages (songs list, sound library): wordmark,
 * page links, one "New song" action and the account menu. The sound
 * library link is shown to admins only, since it lists source names.
 */
export function AppHeader() {
  const navigate = useNavigate();
  const { user } = useAuth();
  return (
    <header className="h-16 shrink-0 border-b border-line/60">
      <div className="mx-auto flex h-full max-w-[1240px] items-center gap-6 px-4 sm:gap-10 sm:px-8">
        <Link to="/" className="app-wordmark text-[21px] text-white">
          casper<span className="text-accent">aki</span>
        </Link>
        <nav className="hidden h-full items-center gap-6 text-[15px] sm:flex" aria-label="Main">
          <HeaderLink to="/">Songs</HeaderLink>
          {user?.isAdmin ? <HeaderLink to="/catalog">Sound library</HeaderLink> : null}
        </nav>
        <div className="ml-auto flex items-center gap-3">
          <button
            type="button"
            onClick={() => navigate('/?create=1')}
            className="h-9 whitespace-nowrap rounded-full bg-accent px-4 text-[14px] font-semibold text-white transition-colors hover:bg-[#e00000]"
          >
            New song
          </button>
          <AccountMenu />
        </div>
      </div>
    </header>
  );
}

function HeaderLink({ to, children }: { to: string; children: string }) {
  return (
    <NavLink
      to={to}
      end
      className={({ isActive }) =>
        `flex h-full items-center border-b-2 transition-colors ${
          isActive ? 'border-accent text-white' : 'border-transparent text-white/60 hover:text-white'
        }`
      }
    >
      {children}
    </NavLink>
  );
}
