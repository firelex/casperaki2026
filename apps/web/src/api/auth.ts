// apps/web/src/api/auth.ts
//
// Auth endpoints on the brain. me()/logout() go through the shared
// BrainClient (so 401 surfaces as a BrainError with .status). loginUrl()
// is a plain string the browser navigates to (full-page redirect to the
// OIDC provider), so it does NOT use fetch.
import { defaultBrainClient } from './client';

export interface MeResponse {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  /** May browse the sound catalog (BRAIN_ADMIN_EMAILS on the brain). */
  readonly isAdmin: boolean;
}

export const auth = {
  me: () => defaultBrainClient.get<MeResponse>('/api/auth/me'),
  /** The demo sign-in (brain BRAIN_DEMO_LOGIN=1): sets the session cookie or fails with 401. */
  demoLogin: (email: string, password: string) => defaultBrainClient.post<{ ok: true }>('/api/auth/login', { email, password }),
  logout: () => defaultBrainClient.post<{ ok: true }>('/api/auth/logout', {}),
  loginUrl: (returnTo?: string): string => {
    const q = returnTo ? `?return_to=${encodeURIComponent(returnTo)}` : '';
    return `/api/auth/login${q}`;
  },
};
