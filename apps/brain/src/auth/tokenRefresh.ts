// apps/brain/src/auth/tokenRefresh.ts
import { OidcTokenError, type OidcClient } from './OidcClient.js';
import type { SessionBundle, SessionBundleRepo } from './SessionBundleRepo.js';

const REFRESH_LEEWAY_MS = 60_000;
// OAuth 2.0 makes `expires_in` optional; default conservatively so a missing
// value can never produce a NaN expiry (which would throw on toISOString()).
const DEFAULT_EXPIRES_IN_SEC = 300;

/** Raised when a refresh fails in a way that means the session is dead
 *  (the IdP rejected the refresh token, or rotation didn't yield a new
 *  one). The caller should destroy the session. Transient errors (network,
 *  5xx) are re-thrown as-is so the caller can leave the session intact. */
export class InvalidGrantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidGrantError';
  }
}

// Per-session in-flight refresh dedupe. Without this, parallel requests near
// token expiry each call oidc.refresh() with the same refresh token; with
// mandatory rotation the losers get `invalid_grant` and would (previously)
// destroy the session — logging the user out at random.
const inFlight = new Map<string, Promise<string>>();

export async function ensureFreshAccessToken(args: {
  bundle: SessionBundle;
  oidc: OidcClient;
  repo: SessionBundleRepo;
  force?: boolean;
}): Promise<string> {
  const { bundle, force = false } = args;
  const expiresAt = Date.parse(bundle.accessTokenExpiresAt);
  if (!force && Number.isFinite(expiresAt) && expiresAt - Date.now() > REFRESH_LEEWAY_MS) {
    return bundle.accessToken;
  }
  const existing = inFlight.get(bundle.sessionId);
  if (existing) return existing;
  const promise = refreshNow(args).finally(() => {
    inFlight.delete(bundle.sessionId);
  });
  inFlight.set(bundle.sessionId, promise);
  return promise;
}

async function refreshNow(args: {
  bundle: SessionBundle;
  oidc: OidcClient;
  repo: SessionBundleRepo;
}): Promise<string> {
  const { bundle, oidc, repo } = args;
  let fresh;
  try {
    fresh = await oidc.refresh(bundle.refreshToken);
  } catch (err) {
    if (err instanceof OidcTokenError && err.body.includes('invalid_grant')) {
      throw new InvalidGrantError(err.message);
    }
    throw err; // transient (network / 5xx) — leave the session intact
  }
  if (!fresh.refresh_token) {
    throw new InvalidGrantError('OIDC token endpoint did not return a new refresh token (rotation required)');
  }
  const expiresInSec = Number.isFinite(fresh.expires_in) ? (fresh.expires_in as number) : DEFAULT_EXPIRES_IN_SEC;
  const next = {
    accessToken: fresh.access_token,
    refreshToken: fresh.refresh_token,
    accessTokenExpiresAt: new Date(Date.now() + expiresInSec * 1000).toISOString(),
  };
  repo.updateTokens(bundle.sessionId, next);
  bundle.accessToken = next.accessToken;
  bundle.refreshToken = next.refreshToken;
  bundle.accessTokenExpiresAt = next.accessTokenExpiresAt;
  return next.accessToken;
}
