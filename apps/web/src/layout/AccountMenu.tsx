import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@teamsuzie/ui';

import { useNavigate } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';

/** Account button (the user's initial) opening a menu with the signed-in
 *  email, the admin pages (also here for phones, where the header hides its
 *  links) and "Sign out". */
export function AccountMenu() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  if (!user) return null;
  const initial = (user.name || user.email).trim().charAt(0).toUpperCase();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="flex h-9 w-9 items-center justify-center rounded-full bg-panel-2 text-[14px] font-semibold text-white outline-none ring-white/60 hover:bg-line focus-visible:ring-2"
        aria-label={`Account: ${user.email}`}
      >
        {initial}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={8}
        className="z-50 min-w-[220px] rounded-[10px] border border-line bg-panel p-1 text-white shadow-2xl"
      >
        <DropdownMenuLabel className="px-3 py-2 text-[13px] font-normal text-white/60">{user.email}</DropdownMenuLabel>
        <DropdownMenuSeparator className="my-1 h-px bg-line" />
        {user.isAdmin ? (
          <>
            <DropdownMenuItem className="cursor-pointer rounded-[6px] px-3 py-2 text-[14px] outline-none data-[highlighted]:bg-white/10" onSelect={() => navigate('/suggestions')}>
              Suggestions
            </DropdownMenuItem>
            <DropdownMenuItem className="cursor-pointer rounded-[6px] px-3 py-2 text-[14px] outline-none data-[highlighted]:bg-white/10" onSelect={() => navigate('/catalog')}>
              Sound library
            </DropdownMenuItem>
            <DropdownMenuSeparator className="my-1 h-px bg-line" />
          </>
        ) : null}
        <DropdownMenuItem
          className="cursor-pointer rounded-[6px] px-3 py-2 text-[14px] outline-none data-[highlighted]:bg-white/10"
          onSelect={() => void signOut()}
        >
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
