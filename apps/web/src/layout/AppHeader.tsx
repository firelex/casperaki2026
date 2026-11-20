import { NavLink, useNavigate } from 'react-router-dom';
import { AccountMenu } from './AccountMenu';

/**
 * Top header used on the Projects screen — mirrors rory-fe
 * `components/app/Header.vue`: brand mark, icon nav with red top-border
 * on active, profile chip on the right.
 */
export function AppHeader() {
  const navigate = useNavigate();
  return (
    <header className="flex items-center w-full h-[72px] px-4 md:px-10 border-b border-line/60">
      <div className="flex-1 flex items-center gap-3 min-w-0">
        <span className="text-[20px] font-semibold tracking-tight text-white">
          casper<span className="text-accent">aki</span>
        </span>
        <span className="hidden sm:inline text-[10px] uppercase tracking-[0.32em] text-dim ml-3">
          workbench
        </span>
      </div>

      <nav className="hidden sm:flex items-center gap-2 h-full">
        <IconNav to="/" label="Home" glyph="◇" />
        <IconNav to="/catalog" label="Catalog" glyph="≡" />
        <IconNav to="#profile" label="Profile" glyph="◐" disabled />
        <IconNav to="#settings" label="Settings" glyph="✱" disabled />
      </nav>

      <div className="flex-1 flex items-center justify-end gap-3">
        <span className="sm:hidden text-[10px] uppercase tracking-[0.18em] text-dim mr-2">
          v0
        </span>
        <button
          type="button"
          onClick={() => navigate('/?create=1')}
          className="h-9 px-4 rounded-full bg-accent text-white text-[13px] font-semibold hover:bg-accent/90 transition-colors"
        >
          Create
        </button>
        <AccountMenu />
      </div>
    </header>
  );
}

function IconNav({
  to,
  label,
  glyph,
  disabled,
}: {
  to: string;
  label: string;
  glyph: string;
  disabled?: boolean;
}) {
  if (disabled) {
    return (
      <span
        className="h-full w-[52px] flex items-center justify-center text-[18px] text-dim/40 border-t-[3px] border-transparent select-none"
        title={`${label} — not in M0`}
        aria-disabled="true"
      >
        {glyph}
      </span>
    );
  }
  return (
    <NavLink
      to={to}
      end
      className={({ isActive }) =>
        `h-full w-[52px] flex items-center justify-center text-[18px] border-t-[3px] transition-all ${
          isActive
            ? 'border-accent text-white scale-110'
            : 'border-transparent text-white/60 hover:text-white/90'
        }`
      }
      aria-label={label}
    >
      {glyph}
    </NavLink>
  );
}
