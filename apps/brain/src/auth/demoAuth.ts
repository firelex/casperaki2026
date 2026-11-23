// apps/brain/src/auth/demoAuth.ts
//
// Demo sign-in (BRAIN_DEMO_LOGIN=1): a fake login for while casperaki.com sits
// behind the gateway. One fixed account (shown as a hint on the login form),
// no auth service, no user database. The session is a cookie holding an HMAC
// of the demo user id, so only this brain (its SESSION_SECRET) can mint it.
// The demo user is an admin: the whole app is open to whoever gets past the
// gateway.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { Router, type RequestHandler } from 'express';

import { buildCookie, clearSessionCookie, readCookie, SESSION_COOKIE, SESSION_TTL_MS } from './middleware.js';

export const DEMO_CREDENTIALS = { email: 'demo@example.com', password: 'demo123' } as const;
export const DEMO_USER = { id: 'demo-user', email: DEMO_CREDENTIALS.email, name: 'Demo' } as const;

function sign(secret: string): string {
  return `${DEMO_USER.id}.${createHmac('sha256', secret).update(DEMO_USER.id).digest('base64url')}`;
}

function validCookie(value: string, secret: string): boolean {
  const expected = Buffer.from(sign(secret));
  const got = Buffer.from(value);
  return got.length === expected.length && timingSafeEqual(got, expected);
}

/** Sets req.user to the demo user when the request carries a valid demo session cookie. */
export function attachDemoSession(secret: string): RequestHandler {
  return (req, _res, next) => {
    const sid = readCookie(req, SESSION_COOKIE);
    if (sid && validCookie(sid, secret)) req.user = { ...DEMO_USER, accessToken: '' };
    next();
  };
}

/** A same-site path to return to after signing in ('/' unless it is a plain path), so the
 *  flow works whatever host the browser came through (WEB_ORIGIN may be localhost behind the gateway). */
export function demoReturnPath(raw: unknown): string {
  return typeof raw === 'string' && raw.startsWith('/') && !raw.startsWith('//') && !raw.includes('\\') ? raw : '/';
}

export function demoAuthRouter(deps: { secret: string }): Router {
  const r = Router();

  // The web's "Sign in" navigates here (as it does for OIDC): send it to the login form.
  r.get('/login', (req, res) => {
    res.redirect(`/sign-in?return_to=${encodeURIComponent(demoReturnPath(req.query.return_to))}`);
  });

  r.post('/login', (req, res) => {
    const { email, password } = (req.body ?? {}) as { email?: unknown; password?: unknown };
    const ok =
      typeof email === 'string' &&
      email.trim().toLowerCase() === DEMO_CREDENTIALS.email &&
      password === DEMO_CREDENTIALS.password;
    if (!ok) return res.status(401).json({ error: 'Wrong email or password.' });
    res.setHeader('Set-Cookie', buildCookie(SESSION_COOKIE, sign(deps.secret), Math.floor(SESSION_TTL_MS / 1000)));
    res.json({ ok: true });
  });

  r.post('/logout', (_req, res) => {
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  r.get('/me', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not signed in' });
    res.json({ id: req.user.id, email: req.user.email, name: req.user.name, isAdmin: true });
  });

  return r;
}
