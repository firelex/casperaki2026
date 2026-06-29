// apps/web/src/auth/AuthContext.tsx
import {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
  type ReactNode,
} from 'react';
import { auth, type MeResponse } from '../api/auth';
import { BrainError } from '../api/client';

export type AuthUser = MeResponse;

interface AuthState {
  user: AuthUser | null;
  isLoading: boolean;
  /** Full-page redirect to the OIDC provider via the brain. */
  signIn: () => void;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const me = await auth.me();
        if (!cancelled) setUser(me);
      } catch (err) {
        const is401 = err instanceof BrainError && err.status === 401;
        if (!cancelled && !is401) {
          console.warn('auth/me failed:', err instanceof Error ? err.message : err);
        }
        if (!cancelled) setUser(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const signIn = useCallback(() => {
    const returnTo = window.location.pathname + window.location.search;
    window.location.href = auth.loginUrl(returnTo);
  }, []);

  const signOut = useCallback(async () => {
    try {
      await auth.logout();
    } catch {
      // best-effort — drop local user regardless
    } finally {
      setUser(null);
      window.location.href = '/';
    }
  }, []);

  const value = useMemo<AuthState>(
    () => ({ user, isLoading, signIn, signOut }),
    [user, isLoading, signIn, signOut],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used inside <AuthProvider>');
  return v;
}
