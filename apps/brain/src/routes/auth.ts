// apps/brain/src/routes/auth.ts
import { Router } from 'express';
import type { OidcClient } from '../auth/OidcClient.js';
import type { SessionBundleRepo } from '../auth/SessionBundleRepo.js';
import { clearSessionCookie, readCookie, SESSION_COOKIE } from '../auth/middleware.js';

const STATE_COOKIE = 'casperaki_oidc_state';
const STATE_COOKIE_TTL_SECONDS = 300;

export interface AuthRouterDeps {
  sessions: SessionBundleRepo;
  oidc: OidcClient;
  webOrigin: string; // e.g. http://localhost:5173
}

export function authRouter(deps: AuthRouterDeps): Router {
  const r = Router();
  const { sessions, oidc, webOrigin } = deps;

  r.get('/login', async (req, res) => {
    const returnTo = normalizeReturnTo(req.query.return_to, webOrigin);
    try {
      const { url, state, codeVerifier } = await oidc.buildAuthorizationUrl({ returnTo });
      const payload = Buffer.from(JSON.stringify({ state, codeVerifier, returnTo })).toString('base64url');
      const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
      res.setHeader(
        'Set-Cookie',
        `${STATE_COOKIE}=${payload}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${STATE_COOKIE_TTL_SECONDS}${secure}`,
      );
      res.redirect(url);
    } catch (err: any) {
      res.status(503).json({ error: 'auth service unavailable', message: String(err?.message ?? err) });
    }
  });

  r.get('/callback', async (req, res) => {
    const raw = readCookie(req, STATE_COOKIE);
    if (!raw) return res.status(400).send('Session expired during login. Please try again.');
    let parsed: { state: string; codeVerifier: string; returnTo: string };
    try {
      parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    } catch {
      return res.status(400).send('Invalid login state.');
    }
    if (req.query.state !== parsed.state) return res.status(400).send('State mismatch.');
    const asError = req.query.error as string | undefined;
    if (asError) {
      const desc = (req.query.error_description as string | undefined) ?? '';
      return res.status(400).send(`Auth server returned error=${asError}${desc ? `: ${desc}` : ''}`);
    }
    const code = req.query.code as string | undefined;
    if (!code) return res.status(400).send('Missing authorization code.');

    try {
      const tokens = await oidc.exchangeCode({ code, codeVerifier: parsed.codeVerifier });
      if (!tokens.refresh_token || !tokens.id_token) {
        return res.status(502).send('Auth server did not return refresh_token + id_token.');
      }
      const idPayload = JSON.parse(
        Buffer.from(tokens.id_token.split('.')[1], 'base64url').toString('utf8'),
      ) as { sub: string; email: string; name?: string };

      const bundle = sessions.create({
        sub: idPayload.sub,
        email: idPayload.email,
        name: idPayload.name ?? '',
        refreshToken: tokens.refresh_token,
        accessToken: tokens.access_token,
        accessTokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
      });
      const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
      const sessionTtl = 30 * 24 * 60 * 60;
      res.setHeader('Set-Cookie', [
        `${SESSION_COOKIE}=${encodeURIComponent(bundle.sessionId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${sessionTtl}${secure}`,
        `${STATE_COOKIE}=; Path=/; HttpOnly; Max-Age=0`,
      ]);
      res.redirect(parsed.returnTo);
    } catch (err: any) {
      res.status(502).json({ error: 'token exchange failed', message: String(err?.message ?? err) });
    }
  });

  r.post('/logout', async (req, res) => {
    const sid = readCookie(req, SESSION_COOKIE);
    if (sid) {
      const bundle = sessions.get(sid);
      if (bundle) {
        try { await oidc.revoke(bundle.refreshToken); } catch { /* best effort */ }
        sessions.delete(sid);
      }
    }
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  r.get('/me', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not signed in' });
    res.json({ id: req.user.id, email: req.user.email, name: req.user.name });
  });

  return r;
}

export function normalizeReturnTo(raw: unknown, webOrigin: string): string {
  const fallback = (process.env.OIDC_POST_LOGIN_DEFAULT || webOrigin) + '/';
  const value = typeof raw === 'string' ? raw : '';
  if (!value) return fallback;
  if (value.startsWith('/') && !value.startsWith('//')) return new URL(value, fallback).toString();
  try {
    const url = new URL(value);
    if (url.origin === new URL(webOrigin).origin) return url.toString();
  } catch { /* fall through */ }
  return fallback;
}
