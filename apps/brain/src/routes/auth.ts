// apps/brain/src/routes/auth.ts
import { Router } from 'express';
import type { OidcClient } from '../auth/OidcClient.js';
import type { SessionBundleRepo } from '../auth/SessionBundleRepo.js';
import { buildCookie, clearSessionCookie, readCookie, SESSION_COOKIE, SESSION_TTL_MS } from '../auth/middleware.js';

const STATE_COOKIE = 'casperaki_oidc_state';
const STATE_COOKIE_TTL_SECONDS = 300;

export interface AuthRouterDeps {
  sessions: SessionBundleRepo;
  oidc: OidcClient;
  webOrigin: string; // e.g. http://localhost:5173
  /** Optional post-login default target (OIDC_POST_LOGIN_DEFAULT). Falls
   *  back to `${webOrigin}/` when unset. Passed in from config so this route
   *  never reads process.env directly. */
  postLoginDefault?: string;
}

export function authRouter(deps: AuthRouterDeps): Router {
  const r = Router();
  const { sessions, oidc, webOrigin, postLoginDefault } = deps;

  r.get('/login', async (req, res) => {
    const returnTo = normalizeReturnTo(req.query.return_to, webOrigin, postLoginDefault);
    try {
      const { url, state, codeVerifier } = await oidc.buildAuthorizationUrl({ returnTo });
      const payload = Buffer.from(JSON.stringify({ state, codeVerifier, returnTo })).toString('base64url');
      res.setHeader('Set-Cookie', buildCookie(STATE_COOKIE, payload, STATE_COOKIE_TTL_SECONDS));
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
      const idPayload = decodeIdTokenClaims(tokens.id_token);
      if (!idPayload) {
        return res.status(502).send('Auth server returned a malformed id_token.');
      }
      if (!idPayload.sub || !idPayload.email) {
        return res.status(502).send('Auth server id_token is missing required claims (sub, email).');
      }

      // OAuth makes expires_in optional; default so a missing value can't
      // produce an Invalid-time-value throw at new Date(NaN).toISOString().
      const expiresInSec = Number.isFinite(tokens.expires_in) ? (tokens.expires_in as number) : 300;
      const bundle = sessions.create({
        sub: idPayload.sub,
        email: idPayload.email,
        name: idPayload.name ?? '',
        refreshToken: tokens.refresh_token,
        accessToken: tokens.access_token,
        accessTokenExpiresAt: new Date(Date.now() + expiresInSec * 1000).toISOString(),
      });
      const sessionTtl = Math.floor(SESSION_TTL_MS / 1000);
      res.setHeader('Set-Cookie', [
        buildCookie(SESSION_COOKIE, encodeURIComponent(bundle.sessionId), sessionTtl),
        buildCookie(STATE_COOKIE, '', 0),
      ]);
      res.redirect(parsed.returnTo);
    } catch (err: any) {
      res.status(502).json({ error: 'token exchange failed', message: String(err?.message ?? err) });
    }
  });

  r.post('/logout', async (req, res) => {
    const sid = readCookie(req, SESSION_COOKIE);
    if (sid) {
      // sessions.get() can throw if the bundle can't be decrypted (e.g. the
      // session secret rotated). Logout must still clear the cookie and delete
      // the row rather than 500 and strand the user in a signed-in state.
      let bundle = null;
      try { bundle = sessions.get(sid); } catch { /* undecryptable — fall through to delete */ }
      if (bundle) {
        try { await oidc.revoke(bundle.refreshToken); } catch { /* best effort */ }
      }
      try { sessions.delete(sid); } catch { /* best effort */ }
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

/** Decode an id_token's payload claims without verifying its signature.
 *  Returns null when the token is structurally malformed (so the caller can
 *  502 rather than crash on `split('.')[1]` being undefined). NOTE: this does
 *  not validate iss/aud/exp or the signature — the token comes straight from
 *  the token endpoint over TLS with client auth. A jwks_uri signature check is
 *  a worthwhile follow-up (the discovery type already carries jwks_uri). */
function decodeIdTokenClaims(idToken: string): { sub?: string; email?: string; name?: string } | null {
  const parts = idToken.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

export function normalizeReturnTo(raw: unknown, webOrigin: string, postLoginDefault?: string): string {
  const base = postLoginDefault || webOrigin;
  const fallback = base.endsWith('/') ? base : `${base}/`;
  const value = typeof raw === 'string' ? raw : '';
  if (!value) return fallback;
  const allowedOrigin = new URL(webOrigin).origin;
  // Path-relative target: must start with a single '/' and contain NO
  // backslash. The WHATWG URL parser treats '\' as '/', so '/\evil.com/x'
  // and '/\/evil.com' would otherwise resolve to an off-origin host. We also
  // re-check the resolved origin as defense-in-depth.
  if (value.startsWith('/') && !value.startsWith('//') && !value.includes('\\')) {
    const resolved = new URL(value, allowedOrigin);
    if (resolved.origin === allowedOrigin) return resolved.toString();
    return fallback;
  }
  try {
    const url = new URL(value);
    if (url.origin === allowedOrigin) return url.toString();
  } catch { /* fall through */ }
  return fallback;
}
