import { Button } from '@teamsuzie/ui';
import { useAuth } from '../auth/AuthContext';

/**
 * Signed-in account chip: shows the current user's email and a sign-out
 * action built from @teamsuzie/ui Button primitives.
 * Returns null when no user is signed in so the header stays clean on the
 * landing / unauthenticated views.
 */
export function AccountMenu() {
  const { user, signOut } = useAuth();
  if (!user) return null;
  return (
    <div className="flex items-center gap-3">
      <span className="text-xs text-white/60 hidden sm:inline">{user.email}</span>
      <Button variant="outline" size="sm" onClick={() => void signOut()}>
        Sign out
      </Button>
    </div>
  );
}
