// apps/brain/src/auth/middleware.ts
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { SessionBundleRepo } from './SessionBundleRepo.js';
import type { OidcClient } from './OidcClient.js';
import { ensureFreshAccessToken, InvalidGrantError } from './tokenRefresh.js';

export const SESSION_COOKIE = 'casperaki_session';
// Single source of truth for the session lifetime — the cookie Max-Age and
// the DB `expires_at` both derive from this (see SessionBundleRepo).
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: { id: string; email: string; name: string; accessToken: string };
    }
  }
}

/** Tiny Cookie-header parser — avoids pulling in cookie-parser for one use. */
export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k === name) {
      try { return decodeURIComponent(part.slice(eq + 1).trim()); }
      catch { return undefined; }
    }
  }
  return undefined;
}

/** Build a Set-Cookie value with the shared brain cookie recipe
 *  (HttpOnly; SameSite=Lax; Secure in production). `value` must already be
 *  encoded by the caller if it needs escaping. Centralizes the four hand-
 *  rolled copies that used to drift on the Secure/SameSite flags. */
export function buildCookie(name: string, value: string, maxAgeSec: number): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;
}

export function setSessionCookie(res: Response, sessionId: string): void {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  res.setHeader('Set-Cookie', buildCookie(SESSION_COOKIE, encodeURIComponent(sessionId), maxAge));
}

export function clearSessionCookie(res: Response): void {
  res.setHeader('Set-Cookie', buildCookie(SESSION_COOKIE, '', 0));
}

/** Attaches req.user if a valid session cookie is present and its access
 *  token can be (re)acquired. Never blocks the request. */
export function attachSession(sessions: SessionBundleRepo, oidc: OidcClient): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const sid = readCookie(req, SESSION_COOKIE);
    if (!sid) return next();
    let bundle;
    try {
      bundle = sessions.get(sid);
    } catch {
      try { sessions.delete(sid); clearSessionCookie(res); } catch { /* best effort */ }
      return next();
    }
    if (!bundle) return next();
    if (Date.parse(bundle.expiresAt) < Date.now()) {
      sessions.delete(sid);
      clearSessionCookie(res);
      return next();
    }
    try {
      const accessToken = await ensureFreshAccessToken({ bundle, oidc, repo: sessions });
      req.user = { id: bundle.sub, email: bundle.email, name: bundle.name, accessToken };
    } catch (err) {
      // Only destroy the session when the refresh token is definitively dead
      // (invalid_grant / rotation failure). Transient errors (IdP 5xx, network)
      // must leave the session intact — otherwise a brief outage logs everyone
      // out permanently. We just proceed without req.user in that case.
      if (err instanceof InvalidGrantError) {
        try { sessions.delete(sid); clearSessionCookie(res); } catch { /* best effort */ }
      }
    }
    next();
  };
}

/** Reject unauthenticated callers with 401. Mount AFTER attachSession. */
export function requireSession(): RequestHandler {
  return (req, res, next) => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    next();
  };
}
