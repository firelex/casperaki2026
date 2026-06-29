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
}

export const auth = {
  me: () => defaultBrainClient.get<MeResponse>('/api/auth/me'),
  logout: () => defaultBrainClient.post<{ ok: true }>('/api/auth/logout', {}),
  loginUrl: (returnTo?: string): string => {
    const q = returnTo ? `?return_to=${encodeURIComponent(returnTo)}` : '';
    return `/api/auth/login${q}`;
  },
};
