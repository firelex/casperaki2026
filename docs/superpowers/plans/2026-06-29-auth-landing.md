# Auth + Landing Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the casperaki workbench behind real authentication via the shared `open_teamsuzie` OIDC provider, with a public landing page for signed-out visitors.

**Architecture:** The brain becomes a thin OIDC *client* (ported almost file-for-file from `apps/suzie-it-department/src/server/auth/`): a local sqlite sessions table, an `OidcClient`, `attachSession`/`requireSession` middleware, and a `/api/auth` router. The heavy infra (Postgres, Redis, users, passwords, Google, login UI) lives only in the shared `open_teamsuzie/apps/platform/auth` provider. The web app gains an `AuthProvider`, a gated route tree, and reuses the existing bespoke landing wired to the real OIDC redirect.

**Tech Stack:** Express 4 + better-sqlite3 (brain), `openid-client` (PKCE helpers), Node `crypto` (session encryption), React + react-router (web), `@teamsuzie/ui` + `@teamsuzie/theme` (app chrome).

## Global Constraints

- **Reference implementation:** `apps/suzie-it-department/src/server/auth/` and `src/web/auth/AuthContext.tsx`. Port faithfully; adapt only the names below. Do not reinvent (see repo `AGENTS.md`).
- **Brain stays Express 4 + better-sqlite3.** Do not introduce Postgres, Redis, express-session, or Express 5 into the brain.
- **Cookie name:** `casperaki_session` (session), `casperaki_oidc_state` (login state).
- **Session-bundle encryption label:** `casperaki-session-bundle`.
- **Web dev origin:** `http://localhost:5173`. **Brain origin:** `http://localhost:16500`.
- **OIDC redirect URI:** `http://localhost:16500/api/auth/callback`.
- **Provider issuer (default):** `http://localhost:3005`.
- **Provider client env slug:** `CASPERAKI` (→ `OIDC_CLIENT_CASPERAKI_ID/_SECRET/_REDIRECT_URIS`).
- **Secrets via env only.** `SESSION_SECRET` required when `NODE_ENV=production`; random per-process fallback in dev.
- **TDD:** failing test → minimal impl → green → commit. Commit after every task.

---

## File Structure

**Brain (`apps/brain/`):**
- Create `src/auth/SessionBundleRepo.ts` — encrypted session bundles in sqlite.
- Create `src/auth/authDb.ts` — opens the auth sqlite DB, creates `user_sessions`.
- Create `src/auth/OidcClient.ts` — PKCE auth-code client against the provider.
- Create `src/auth/tokenRefresh.ts` — refresh expiring access tokens.
- Create `src/auth/middleware.ts` — cookie helpers, `attachSession`, `requireSession`.
- Create `src/routes/auth.ts` — `/api/auth/{login,callback,logout,me}`.
- Modify `src/config.ts` — OIDC + session config.
- Modify `src/bootstrap.ts` — construct auth deps, wire middleware ordering.
- Create `.env.example` — documented env.
- Tests under `test/auth/`.

**Web (`apps/web/`):**
- Create `src/api/auth.ts` — `auth.{me,loginUrl,logout}` helpers.
- Create `src/auth/AuthContext.tsx` — `AuthProvider` + `useAuth`.
- Modify `src/main.tsx` — wrap `<AuthProvider>`.
- Modify `src/App.tsx` — loading/landing/authed gate.
- Modify `src/pages/LoginPage.tsx` — repurpose as landing; wire `signIn()`.
- Modify `package.json` — add `@teamsuzie/ui`, `@teamsuzie/theme`, `deps:build`.
- Tests under `test/`.

**Provider (`open_teamsuzie/apps/platform/auth/`):** run + register the casperaki client (ops/config, Task 5). No code committed to this repo.

---

## Task 1: Brain — encrypted session store

**Files:**
- Create: `apps/brain/src/auth/authDb.ts`
- Create: `apps/brain/src/auth/SessionBundleRepo.ts`
- Test: `apps/brain/test/auth/SessionBundleRepo.test.ts`

**Interfaces:**
- Produces: `openAuthDb(path: string): Database.Database` (creates `user_sessions`).
- Produces: `class SessionBundleRepo` with `create(input)`, `get(sessionId)`, `updateTokens(sessionId, t)`, `delete(sessionId)`, `purgeExpired()` and the `SessionBundle` interface (fields: `sessionId, sub, email, name, refreshToken, accessToken, accessTokenExpiresAt, lastSeenAt, expiresAt, createdAt`).

- [ ] **Step 1: Write the failing test**

```ts
// apps/brain/test/auth/SessionBundleRepo.test.ts
import { describe, it, expect } from 'vitest';
import { openAuthDb } from '../../src/auth/authDb.ts';
import { SessionBundleRepo } from '../../src/auth/SessionBundleRepo.ts';

function repo() {
  return new SessionBundleRepo(openAuthDb(':memory:'), 'test-secret');
}
const base = {
  sub: 'user-1', email: 'a@b.com', name: 'A B',
  refreshToken: 'refresh-xyz', accessToken: 'access-xyz',
  accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
};

describe('SessionBundleRepo', () => {
  it('round-trips a bundle and decrypts the refresh token', () => {
    const r = repo();
    const created = r.create(base);
    const got = r.get(created.sessionId);
    expect(got?.email).toBe('a@b.com');
    expect(got?.refreshToken).toBe('refresh-xyz'); // decrypted
  });

  it('returns null for unknown ids and after delete', () => {
    const r = repo();
    const created = r.create(base);
    r.delete(created.sessionId);
    expect(r.get(created.sessionId)).toBeNull();
    expect(r.get('nope')).toBeNull();
  });

  it('updateTokens replaces the stored tokens', () => {
    const r = repo();
    const c = r.create(base);
    r.updateTokens(c.sessionId, {
      refreshToken: 'r2', accessToken: 'a2',
      accessTokenExpiresAt: new Date(Date.now() + 7200_000).toISOString(),
    });
    const got = r.get(c.sessionId);
    expect(got?.refreshToken).toBe('r2');
    expect(got?.accessToken).toBe('a2');
  });

  it('purgeExpired removes only expired rows', () => {
    const db = openAuthDb(':memory:');
    const r = new SessionBundleRepo(db, 'test-secret');
    const c = r.create(base);
    db.prepare(`UPDATE user_sessions SET expires_at = ? WHERE session_id = ?`)
      .run(new Date(Date.now() - 1000).toISOString(), c.sessionId);
    r.purgeExpired();
    expect(r.get(c.sessionId)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/brain && pnpm vitest run test/auth/SessionBundleRepo.test.ts`
Expected: FAIL — cannot find `../../src/auth/authDb.ts`.

- [ ] **Step 3: Create `authDb.ts`**

```ts
// apps/brain/src/auth/authDb.ts
//
// Opens the brain's auth sqlite DB and ensures the user_sessions table.
// Separate file from the songs store so auth state is self-contained.
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import Database from 'better-sqlite3';

const USER_SESSIONS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS user_sessions (
    session_id              TEXT PRIMARY KEY,
    sub                     TEXT NOT NULL,
    email                   TEXT NOT NULL,
    name                    TEXT NOT NULL,
    refresh_token_enc       TEXT NOT NULL,
    access_token            TEXT NOT NULL,
    access_token_expires_at TEXT NOT NULL,
    last_seen_at            TEXT NOT NULL,
    expires_at              TEXT NOT NULL,
    created_at              TEXT NOT NULL
  );
`;

export function openAuthDb(path: string): Database.Database {
  const dbPath = path === ':memory:' ? ':memory:' : isAbsolute(path) ? path : resolve(process.cwd(), path);
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(USER_SESSIONS_SCHEMA);
  return db;
}
```

- [ ] **Step 4: Create `SessionBundleRepo.ts`**

Port `apps/suzie-it-department/src/server/auth/SessionBundleRepo.ts` verbatim, with one change — the scrypt label on line 23:

```ts
// apps/brain/src/auth/SessionBundleRepo.ts
import type Database from 'better-sqlite3';
import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from 'node:crypto';

export interface SessionBundle {
  sessionId: string;
  sub: string;
  email: string;
  name: string;
  refreshToken: string;
  accessToken: string;
  accessTokenExpiresAt: string;
  lastSeenAt: string;
  expiresAt: string;
  createdAt: string;
}

const TTL_MS = 30 * 24 * 60 * 60 * 1000;

export class SessionBundleRepo {
  private key: Buffer;

  constructor(private db: Database.Database, secret: string) {
    this.key = scryptSync(secret, 'casperaki-session-bundle', 32);
  }

  private encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('base64url')}.${ct.toString('base64url')}.${tag.toString('base64url')}`;
  }

  private decrypt(blob: string): string {
    const [ivB, ctB, tagB] = blob.split('.');
    const iv = Buffer.from(ivB, 'base64url');
    const ct = Buffer.from(ctB, 'base64url');
    const tag = Buffer.from(tagB, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  }

  create(input: { sub: string; email: string; name: string; refreshToken: string; accessToken: string; accessTokenExpiresAt: string }): SessionBundle {
    const now = new Date();
    const sessionId = randomBytes(32).toString('base64url');
    const bundle: SessionBundle = {
      sessionId,
      sub: input.sub, email: input.email, name: input.name,
      refreshToken: input.refreshToken,
      accessToken: input.accessToken,
      accessTokenExpiresAt: input.accessTokenExpiresAt,
      lastSeenAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + TTL_MS).toISOString(),
      createdAt: now.toISOString(),
    };
    this.db.prepare(
      `INSERT INTO user_sessions (session_id, sub, email, name, refresh_token_enc, access_token, access_token_expires_at, last_seen_at, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(sessionId, input.sub, input.email, input.name,
          this.encrypt(input.refreshToken), input.accessToken, input.accessTokenExpiresAt,
          bundle.lastSeenAt, bundle.expiresAt, bundle.createdAt);
    return bundle;
  }

  get(sessionId: string): SessionBundle | null {
    const row = this.db.prepare(`SELECT * FROM user_sessions WHERE session_id = ?`).get(sessionId) as any;
    if (!row) return null;
    return {
      sessionId: row.session_id, sub: row.sub, email: row.email, name: row.name,
      refreshToken: this.decrypt(row.refresh_token_enc),
      accessToken: row.access_token,
      accessTokenExpiresAt: row.access_token_expires_at,
      lastSeenAt: row.last_seen_at, expiresAt: row.expires_at, createdAt: row.created_at,
    };
  }

  updateTokens(sessionId: string, t: { refreshToken: string; accessToken: string; accessTokenExpiresAt: string }): void {
    this.db.prepare(
      `UPDATE user_sessions SET refresh_token_enc = ?, access_token = ?, access_token_expires_at = ?, last_seen_at = ? WHERE session_id = ?`,
    ).run(this.encrypt(t.refreshToken), t.accessToken, t.accessTokenExpiresAt, new Date().toISOString(), sessionId);
  }

  delete(sessionId: string): void {
    this.db.prepare(`DELETE FROM user_sessions WHERE session_id = ?`).run(sessionId);
  }

  purgeExpired(): void {
    this.db.prepare(`DELETE FROM user_sessions WHERE expires_at < ?`).run(new Date().toISOString());
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/brain && pnpm vitest run test/auth/SessionBundleRepo.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/brain/src/auth/authDb.ts apps/brain/src/auth/SessionBundleRepo.ts apps/brain/test/auth/SessionBundleRepo.test.ts
git commit -m "feat(brain): encrypted session bundle store (sqlite)"
```

---

## Task 2: Brain — OIDC client + token refresh

**Files:**
- Create: `apps/brain/src/auth/OidcClient.ts`
- Create: `apps/brain/src/auth/tokenRefresh.ts`
- Modify: `apps/brain/package.json` (add `openid-client`)
- Test: `apps/brain/test/auth/OidcClient.test.ts`

**Interfaces:**
- Consumes: `SessionBundle`, `SessionBundleRepo` (Task 1).
- Produces: `class OidcClient` with `buildAuthorizationUrl({returnTo}) → {url, state, codeVerifier}`, `exchangeCode({code, codeVerifier}) → OidcTokenResponse`, `refresh(refreshToken) → OidcTokenResponse`, `revoke(token)`. Constructor opts include `discoverImpl?` and `fetchImpl?` for tests.
- Produces: `ensureFreshAccessToken({bundle, oidc, repo, force?}) → Promise<string>`.

- [ ] **Step 1: Add the dependency**

```bash
cd apps/brain && pnpm add openid-client
```
Expected: `openid-client` appears in `apps/brain/package.json` dependencies.

- [ ] **Step 2: Write the failing test**

```ts
// apps/brain/test/auth/OidcClient.test.ts
import { describe, it, expect, vi } from 'vitest';
import { OidcClient } from '../../src/auth/OidcClient.ts';

const discovery = {
  authorization_endpoint: 'https://idp.test/authorize',
  token_endpoint: 'https://idp.test/token',
  revocation_endpoint: 'https://idp.test/revoke',
};
function client(fetchImpl?: typeof fetch) {
  return new OidcClient({
    issuerUrl: 'https://idp.test', clientId: 'casperaki', clientSecret: 'shh',
    redirectUri: 'http://localhost:16500/api/auth/callback',
    resource: 'http://localhost:16500',
    discoverImpl: async () => discovery,
    fetchImpl,
  });
}

describe('OidcClient', () => {
  it('builds a PKCE authorization URL with required params', async () => {
    const { url, state, codeVerifier } = await client().buildAuthorizationUrl({ returnTo: '/' });
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://idp.test/authorize');
    expect(u.searchParams.get('client_id')).toBe('casperaki');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('state')).toBe(state);
    expect(codeVerifier.length).toBeGreaterThan(20);
  });

  it('exchangeCode posts to the token endpoint and returns tokens', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r', id_token: 'i', expires_in: 3600, token_type: 'Bearer' }), { status: 200 }),
    ) as unknown as typeof fetch;
    const tokens = await client(fetchImpl).exchangeCode({ code: 'c', codeVerifier: 'v' });
    expect(tokens.access_token).toBe('a');
    expect(fetchImpl).toHaveBeenCalledWith('https://idp.test/token', expect.objectContaining({ method: 'POST' }));
  });

  it('throws on a non-2xx token response', async () => {
    const fetchImpl = vi.fn(async () => new Response('bad', { status: 400 })) as unknown as typeof fetch;
    await expect(client(fetchImpl).exchangeCode({ code: 'c', codeVerifier: 'v' })).rejects.toThrow(/token endpoint 400/);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/brain && pnpm vitest run test/auth/OidcClient.test.ts`
Expected: FAIL — cannot find `../../src/auth/OidcClient.ts`.

- [ ] **Step 4: Create `OidcClient.ts`**

Port `apps/suzie-it-department/src/server/auth/OidcClient.ts` verbatim (it has no suzie-specific names). The full content:

```ts
// apps/brain/src/auth/OidcClient.ts
import {
  randomState,
  randomPKCECodeVerifier,
  calculatePKCECodeChallenge,
} from 'openid-client';

export interface OidcDiscovery {
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint?: string;
  jwks_uri?: string;
}

export interface OidcTokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in: number;
  token_type: string;
}

export interface CreateOpts {
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  // RFC 8707 resource indicator. MUST be an absolute URI — apps/auth's
  // oidc-provider rejects bare identifiers with `invalid_target`.
  resource: string;
  fetchImpl?: typeof fetch;
  discoverImpl?: (issuerUrl: string) => Promise<OidcDiscovery>;
}

export class OidcClient {
  private discovery: OidcDiscovery | null = null;
  private discoveryPromise: Promise<OidcDiscovery> | null = null;

  constructor(private opts: CreateOpts) {}

  private async ensureDiscovered(): Promise<OidcDiscovery> {
    if (this.discovery) return this.discovery;
    if (!this.discoveryPromise) {
      const discover = this.opts.discoverImpl ?? defaultDiscover(this.opts.fetchImpl);
      this.discoveryPromise = discover(this.opts.issuerUrl).then((d) => {
        this.discovery = d;
        return d;
      });
    }
    return this.discoveryPromise;
  }

  async buildAuthorizationUrl(_args: { returnTo: string }): Promise<{ url: string; state: string; codeVerifier: string }> {
    const d = await this.ensureDiscovered();
    const state = randomState();
    const codeVerifier = randomPKCECodeVerifier();
    const codeChallenge = await calculatePKCECodeChallenge(codeVerifier);
    const u = new URL(d.authorization_endpoint);
    u.searchParams.set('client_id', this.opts.clientId);
    u.searchParams.set('redirect_uri', this.opts.redirectUri);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', 'openid profile email tools offline_access');
    u.searchParams.set('prompt', 'consent');
    u.searchParams.set('state', state);
    u.searchParams.set('code_challenge', codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');
    u.searchParams.set('resource', this.opts.resource);
    return { url: u.toString(), state, codeVerifier };
  }

  async exchangeCode(args: { code: string; codeVerifier: string }): Promise<OidcTokenResponse> {
    return this.postToken({
      grant_type: 'authorization_code',
      code: args.code,
      redirect_uri: this.opts.redirectUri,
      code_verifier: args.codeVerifier,
      resource: this.opts.resource,
    });
  }

  async refresh(refreshToken: string): Promise<OidcTokenResponse> {
    return this.postToken({ grant_type: 'refresh_token', refresh_token: refreshToken, resource: this.opts.resource });
  }

  async revoke(token: string): Promise<void> {
    const d = await this.ensureDiscovered();
    if (!d.revocation_endpoint) return;
    const f = this.opts.fetchImpl ?? fetch;
    await f(d.revocation_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token, client_id: this.opts.clientId, client_secret: this.opts.clientSecret }).toString(),
    });
  }

  private async postToken(body: Record<string, string>): Promise<OidcTokenResponse> {
    const d = await this.ensureDiscovered();
    const f = this.opts.fetchImpl ?? fetch;
    const res = await f(d.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        ...body,
        client_id: this.opts.clientId,
        client_secret: this.opts.clientSecret,
      }).toString(),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`token endpoint ${res.status}: ${text}`);
    return JSON.parse(text) as OidcTokenResponse;
  }
}

function defaultDiscover(fetchImpl?: typeof fetch) {
  return async (issuerUrl: string): Promise<OidcDiscovery> => {
    const f = fetchImpl ?? fetch;
    const url = new URL('/.well-known/openid-configuration', issuerUrl).toString();
    const res = await f(url);
    if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`);
    return res.json() as Promise<OidcDiscovery>;
  };
}
```

- [ ] **Step 5: Create `tokenRefresh.ts`**

Port `apps/suzie-it-department/src/server/auth/tokenRefresh.ts` verbatim (adjust the relative import extension to `.ts` to match brain's NodeNext style used in tests; the source files use `.ts` specifiers already):

```ts
// apps/brain/src/auth/tokenRefresh.ts
import type { OidcClient } from './OidcClient.ts';
import type { SessionBundle, SessionBundleRepo } from './SessionBundleRepo.ts';

const REFRESH_LEEWAY_MS = 60_000;

export async function ensureFreshAccessToken(args: {
  bundle: SessionBundle;
  oidc: OidcClient;
  repo: SessionBundleRepo;
  force?: boolean;
}): Promise<string> {
  const { bundle, oidc, repo, force = false } = args;
  const expiresAt = Date.parse(bundle.accessTokenExpiresAt);
  if (!force && expiresAt - Date.now() > REFRESH_LEEWAY_MS) return bundle.accessToken;
  const fresh = await oidc.refresh(bundle.refreshToken);
  if (!fresh.refresh_token) throw new Error('OIDC token endpoint did not return a new refresh token (rotation required)');
  const next = {
    accessToken: fresh.access_token,
    refreshToken: fresh.refresh_token,
    accessTokenExpiresAt: new Date(Date.now() + fresh.expires_in * 1000).toISOString(),
  };
  repo.updateTokens(bundle.sessionId, next);
  bundle.accessToken = next.accessToken;
  bundle.refreshToken = next.refreshToken;
  bundle.accessTokenExpiresAt = next.accessTokenExpiresAt;
  return next.accessToken;
}
```

> Note: the brain's `tsconfig`/tests use `.ts` import specifiers (see existing `src/bootstrap.ts` imports use `.js` for runtime build; tests import `.ts`). Match the **existing brain convention**: runtime `src/*` files import sibling modules with `.js` specifiers (as `bootstrap.ts` does). Therefore in `OidcClient.ts`/`tokenRefresh.ts`/`middleware.ts`/`routes/auth.ts`, import siblings with `.js` (e.g. `./SessionBundleRepo.js`). Tests import `src/*.ts` directly. Apply `.js` specifiers consistently in all brain `src/auth/*` files below.

- [ ] **Step 6: Fix import specifiers to brain convention**

In `tokenRefresh.ts` change `./OidcClient.ts` → `./OidcClient.js` and `./SessionBundleRepo.ts` → `./SessionBundleRepo.js`. (The `OidcClient.ts` above has no sibling-src imports, so no change there.)

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd apps/brain && pnpm vitest run test/auth/OidcClient.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 8: Commit**

```bash
git add apps/brain/src/auth/OidcClient.ts apps/brain/src/auth/tokenRefresh.ts apps/brain/test/auth/OidcClient.test.ts apps/brain/package.json pnpm-lock.yaml
git commit -m "feat(brain): OIDC PKCE client + token refresh"
```

---

## Task 3: Brain — session middleware

**Files:**
- Create: `apps/brain/src/auth/middleware.ts`
- Test: `apps/brain/test/auth/middleware.test.ts`

**Interfaces:**
- Consumes: `SessionBundleRepo` (Task 1), `OidcClient` + `ensureFreshAccessToken` (Task 2).
- Produces: `readCookie(req, name)`, `setSessionCookie(res, id)`, `clearSessionCookie(res)`, `attachSession(sessions, oidc): RequestHandler`, `requireSession(): RequestHandler`, consts `SESSION_COOKIE = 'casperaki_session'`, `SESSION_TTL_MS`. Augments `Express.Request` with `user?: { id; email; name; accessToken }`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/brain/test/auth/middleware.test.ts
import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import { readCookie, requireSession, attachSession, SESSION_COOKIE } from '../../src/auth/middleware.ts';
import { openAuthDb } from '../../src/auth/authDb.ts';
import { SessionBundleRepo } from '../../src/auth/SessionBundleRepo.ts';

describe('readCookie', () => {
  it('extracts a named cookie from the header', () => {
    const req = { headers: { cookie: `x=1; ${SESSION_COOKIE}=abc%20def; y=2` } } as unknown as Request;
    expect(readCookie(req, SESSION_COOKIE)).toBe('abc def');
  });
  it('returns undefined when absent', () => {
    const req = { headers: {} } as unknown as Request;
    expect(readCookie(req, SESSION_COOKIE)).toBeUndefined();
  });
});

describe('requireSession', () => {
  it('401s when no user', () => {
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as Response;
    const next = vi.fn();
    requireSession()({ } as Request, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
  it('calls next when user present', () => {
    const next = vi.fn();
    requireSession()({ user: { id: 'u' } } as unknown as Request, {} as Response, next);
    expect(next).toHaveBeenCalled();
  });
});

describe('attachSession', () => {
  it('attaches req.user for a valid, unexpired session', async () => {
    const sessions = new SessionBundleRepo(openAuthDb(':memory:'), 'secret');
    const created = sessions.create({
      sub: 'u', email: 'e@x.com', name: 'E', refreshToken: 'r', accessToken: 'a',
      accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    const oidc = {} as any; // not called — token still fresh
    const req = { headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(created.sessionId)}` } } as unknown as Request;
    const res = { setHeader: vi.fn() } as unknown as Response;
    const next = vi.fn();
    await attachSession(sessions, oidc)(req, res, next);
    expect((req as any).user?.email).toBe('e@x.com');
    expect(next).toHaveBeenCalled();
  });
  it('skips silently with no cookie', async () => {
    const sessions = new SessionBundleRepo(openAuthDb(':memory:'), 'secret');
    const req = { headers: {} } as unknown as Request;
    const next = vi.fn();
    await attachSession(sessions, {} as any)(req, {} as Response, next);
    expect((req as any).user).toBeUndefined();
    expect(next).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/brain && pnpm vitest run test/auth/middleware.test.ts`
Expected: FAIL — cannot find `../../src/auth/middleware.ts`.

- [ ] **Step 3: Create `middleware.ts`**

Port `apps/suzie-it-department/src/server/auth/middleware.ts` with name changes: `SESSION_COOKIE = 'casperaki_session'`, and sibling imports use `.js`:

```ts
// apps/brain/src/auth/middleware.ts
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { SessionBundleRepo } from './SessionBundleRepo.js';
import type { OidcClient } from './OidcClient.js';
import { ensureFreshAccessToken } from './tokenRefresh.js';

export const SESSION_COOKIE = 'casperaki_session';
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
    if (k === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

export function setSessionCookie(res: Response, sessionId: string): void {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`,
  );
}

export function clearSessionCookie(res: Response): void {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`,
  );
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
      sessions.delete(sid);
      clearSessionCookie(res);
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
    } catch {
      sessions.delete(sid);
      clearSessionCookie(res);
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/brain && pnpm vitest run test/auth/middleware.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/brain/src/auth/middleware.ts apps/brain/test/auth/middleware.test.ts
git commit -m "feat(brain): session cookie middleware (attach/require)"
```

---

## Task 4: Brain — auth routes, config, bootstrap wiring

**Files:**
- Create: `apps/brain/src/routes/auth.ts`
- Modify: `apps/brain/src/config.ts`
- Modify: `apps/brain/src/bootstrap.ts`
- Create: `apps/brain/.env.example`
- Test: `apps/brain/test/auth/routes.integration.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-3.
- Produces: `authRouter(deps: { sessions: SessionBundleRepo; oidc: OidcClient; webOrigin: string }): Router` (type `AuthRouterDeps`) mounting `GET /login`, `GET /callback`, `POST /logout`, `GET /me`.
- Produces (config): `BrainConfig` gains `sessionSecret: string`, `oidc: { issuerUrl; clientId; clientSecret; redirectUri; resource } | null`, `authDbPath: string`, `webOrigin: string`.
- Produces (bootstrap): `createApp` gains optional `auth?: { sessions; oidc }` dep; when absent and `config.oidc` is set, it constructs them; when `config.oidc` is null, auth routes/gate are skipped (dev-without-provider mode).

- [ ] **Step 1: Write the failing integration test**

```ts
// apps/brain/test/auth/routes.integration.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../../src/bootstrap.ts';
import { loadConfig } from '../../src/config.ts';
import { openAuthDb } from '../../src/auth/authDb.ts';
import { SessionBundleRepo } from '../../src/auth/SessionBundleRepo.ts';
import { SESSION_COOKIE } from '../../src/auth/middleware.ts';

let server: Server;
let baseUrl: string;
let sessions: SessionBundleRepo;

beforeAll(async () => {
  const config = loadConfig({ BRAIN_SONGS_DB_PATH: ':memory:', SESSION_SECRET: 'test-secret', OIDC_ISSUER_URL: 'https://idp.test', OIDC_CLIENT_ID: 'casperaki', OIDC_CLIENT_SECRET: 'shh', OIDC_REDIRECT_URI: 'http://localhost:16500/api/auth/callback', OIDC_RESOURCE: 'http://localhost:16500', WEB_ORIGIN: 'http://localhost:5173' } as NodeJS.ProcessEnv);
  sessions = new SessionBundleRepo(openAuthDb(':memory:'), 'test-secret');
  const oidc = { /* not exercised by these tests */ } as any;
  const app = createApp(config, { store: undefined, auth: { sessions, oidc } });
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('auth routes + gate', () => {
  it('GET /healthz is public', async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
  });
  it('GET /api/auth/me is 401 when signed out', async () => {
    const res = await fetch(`${baseUrl}/api/auth/me`);
    expect(res.status).toBe(401);
  });
  it('a gated API route is 401 when signed out', async () => {
    const res = await fetch(`${baseUrl}/api/songs/does-not-exist`);
    expect(res.status).toBe(401);
  });
  it('GET /api/auth/me returns the user with a valid session cookie', async () => {
    const b = sessions.create({ sub: 'u', email: 'e@x.com', name: 'E', refreshToken: 'r', accessToken: 'a', accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString() });
    const res = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(b.sessionId)}` } });
    expect(res.status).toBe(200);
    expect((await res.json()).email).toBe('e@x.com');
  });
});
```

> Note: confirm the gated path. If `GET /api/songs/:id` is not a real route, use any real gated read route from `apps/brain/src/routes/songs.ts`; the assertion is only that an unauthenticated `/api/*` (non-auth) call returns 401 from the gate, which fires before routing.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/brain && pnpm vitest run test/auth/routes.integration.test.ts`
Expected: FAIL — `loadConfig` doesn't accept the new env / `createApp` has no `auth` dep.

- [ ] **Step 3: Extend `config.ts`**

Add to the Zod schema and `loadConfig` (keep existing fields). Append these fields to `ConfigSchema`:

```ts
  // --- Auth (OIDC client) ---
  sessionSecret: z.string().default(''),
  authDbPath: z.string().default('./data/auth.sqlite'),
  webOrigin: z.string().default('http://localhost:5173'),
  oidcIssuerUrl: z.string().optional(),
  oidcClientId: z.string().optional(),
  oidcClientSecret: z.string().optional(),
  oidcRedirectUri: z.string().default('http://localhost:16500/api/auth/callback'),
  oidcResource: z.string().default('http://localhost:16500'),
```

And in `loadConfig`, add to the parsed object:

```ts
    sessionSecret: env.SESSION_SECRET,
    authDbPath: env.BRAIN_AUTH_DB_PATH,
    webOrigin: env.WEB_ORIGIN,
    oidcIssuerUrl: env.OIDC_ISSUER_URL,
    oidcClientId: env.OIDC_CLIENT_ID,
    oidcClientSecret: env.OIDC_CLIENT_SECRET,
    oidcRedirectUri: env.OIDC_REDIRECT_URI,
    oidcResource: env.OIDC_RESOURCE,
```

Then add a derived helper at the end of `config.ts`:

```ts
/** OIDC is "configured" only when issuer + client id/secret are all present. */
export function oidcConfigured(c: BrainConfig): boolean {
  return Boolean(c.oidcIssuerUrl && c.oidcClientId && c.oidcClientSecret);
}
```

Add the production guard inside `loadConfig` before the return:

```ts
  if (env.NODE_ENV === 'production' && !env.SESSION_SECRET) {
    throw new Error('SESSION_SECRET is required in production');
  }
```

(Place this line at the top of the `loadConfig` body, before `return ConfigSchema.parse(...)`.)

- [ ] **Step 4: Create `routes/auth.ts`**

Port `apps/suzie-it-department/src/server/routes/auth.ts`, changing: `ctx: AppContext` → `deps: { sessions; oidc }`, cookie name `casperaki_oidc_state`, default web origin from a passed value, and `.js` specifiers.

```ts
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

function normalizeReturnTo(raw: unknown, webOrigin: string): string {
  const fallback = (process.env.OIDC_POST_LOGIN_DEFAULT || webOrigin) + '/';
  const value = typeof raw === 'string' ? raw : '';
  if (!value) return fallback;
  if (value.startsWith('/')) return new URL(value, fallback).toString();
  try {
    const url = new URL(value);
    if (url.origin === new URL(webOrigin).origin) return url.toString();
  } catch { /* fall through */ }
  return fallback;
}
```

- [ ] **Step 5: Wire `bootstrap.ts`**

Modify `createApp` to build auth deps and order middleware. Replace the current body of `createApp` and add construction:

```ts
// apps/brain/src/bootstrap.ts — imports to add:
import { openAuthDb } from './auth/authDb.js';
import { SessionBundleRepo } from './auth/SessionBundleRepo.js';
import { OidcClient } from './auth/OidcClient.js';
import { attachSession, requireSession } from './auth/middleware.js';
import { authRouter } from './routes/auth.js';
import { loadConfig, oidcConfigured, type BrainConfig } from './config.js';
```

Extend `CreateAppDeps`:

```ts
export interface CreateAppDeps {
  readonly store?: SongsStore;
  readonly auth?: { sessions: SessionBundleRepo; oidc: OidcClient };
}
```

New `createApp` body:

```ts
export function createApp(config: BrainConfig, deps: CreateAppDeps = {}): Express {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  const store = deps.store ?? openSongsStore({ path: config.songsDbPath });

  // Build auth deps if not injected and OIDC is configured.
  const auth =
    deps.auth ??
    (oidcConfigured(config)
      ? {
          sessions: new SessionBundleRepo(openAuthDb(config.authDbPath), config.sessionSecret || 'dev-only-session-secret'),
          oidc: new OidcClient({
            issuerUrl: config.oidcIssuerUrl!,
            clientId: config.oidcClientId!,
            clientSecret: config.oidcClientSecret!,
            redirectUri: config.oidcRedirectUri,
            resource: config.oidcResource,
          }),
        }
      : null);

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, service: '@casperaki/brain' });
  });

  if (auth) {
    // Session resolution runs on every request; never rejects.
    app.use(attachSession(auth.sessions, auth.oidc));
    // Auth endpoints mounted BEFORE the gate so login/callback/me/logout
    // are reachable unauthenticated.
    app.use('/api/auth', authRouter({ sessions: auth.sessions, oidc: auth.oidc, webOrigin: config.webOrigin }));
    // Everything else under /api requires a valid session.
    app.use('/api', requireSession());
    // Sweep expired sessions hourly.
    setInterval(() => auth.sessions.purgeExpired(), 60 * 60 * 1000).unref();
  } else {
    console.warn('[brain] OIDC not configured — auth routes and gate are DISABLED (dev mode).');
  }

  app.use(createSongsRouter({ store }));
  app.use(createRendersRouter({ artifactPath: config.renderArtifactPath }));
  app.use(createCatalogRouter());

  return app;
}
```

> Note: the existing routers mount their own paths (e.g. `/api/songs`). The `app.use('/api', requireSession())` gate must be registered BEFORE those routers (as ordered above) so it runs first. Verify the song/render/catalog routers mount under `/api`; if any mounts at root without `/api`, move it below the gate or adjust the gate path to cover it. All currently sit under `/api` per `src/routes/*`.

- [ ] **Step 6: Run the integration test**

Run: `cd apps/brain && pnpm vitest run test/auth/routes.integration.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: Run the full brain test suite + typecheck**

Run: `cd apps/brain && pnpm vitest run && pnpm typecheck`
Expected: all green. Fix any type errors (e.g. `Express.Request.user` augmentation must be picked up — ensure `src/auth/middleware.ts` is part of the tsconfig include).

- [ ] **Step 8: Create `.env.example`**

```bash
# apps/brain/.env.example
# --- core ---
BRAIN_PORT=16500
BRAIN_HOST=127.0.0.1

# --- auth (OIDC client of open_teamsuzie/apps/platform/auth) ---
# Required in production; dev falls back to a random per-process secret.
SESSION_SECRET=
WEB_ORIGIN=http://localhost:5173
OIDC_ISSUER_URL=http://localhost:3005
OIDC_CLIENT_ID=casperaki
OIDC_CLIENT_SECRET=change-me-to-match-provider
OIDC_REDIRECT_URI=http://localhost:16500/api/auth/callback
OIDC_RESOURCE=http://localhost:16500
# When OIDC_ISSUER_URL/CLIENT_ID/CLIENT_SECRET are unset, the brain runs
# WITHOUT auth (open dev mode) — useful for pure landing-page UI work.
```

- [ ] **Step 9: Commit**

```bash
git add apps/brain/src/routes/auth.ts apps/brain/src/config.ts apps/brain/src/bootstrap.ts apps/brain/.env.example apps/brain/test/auth/routes.integration.test.ts
git commit -m "feat(brain): /api/auth routes, OIDC config, session gate"
```

---

## Task 5: Provider — run + register the casperaki client

**Files:** none in this repo. Operates on `open_teamsuzie/apps/platform/auth` and produces a working `apps/brain/.env`.

This is the one task that must be confirmed against the running provider; treat the values as the starting point.

- [ ] **Step 1: Start Postgres + Redis**

```bash
cd ../open_teamsuzie
# Inspect the compose file for service names/ports first:
cat docker/docker-compose.yml
docker compose -f docker/docker-compose.yml up -d
```
Expected: Postgres on 5432, Redis on 6379 (per `apps/platform/auth/src/config/index.ts` defaults).

- [ ] **Step 2: Configure the casperaki client + Google for the provider**

In the auth service's env (`open_teamsuzie/apps/platform/auth/.env`, create from its `.env.example` if present), add the first-party client triple (consumed by `loadClientRegistry`):

```bash
OIDC_CLIENT_CASPERAKI_ID=casperaki
OIDC_CLIENT_CASPERAKI_SECRET=<generate a strong secret>
OIDC_CLIENT_CASPERAKI_REDIRECT_URIS=http://localhost:16500/api/auth/callback
# Google OAuth (provider-side). Configure per the provider's OAuth provider
# config (OAuthProviderConfig model / its admin). Casperaki does nothing here.
```
Confirm `CORS_ORIGINS` includes `http://localhost:5173` (it does by default).

- [ ] **Step 3: Build shared-auth and run the provider**

```bash
cd ../open_teamsuzie
pnpm --filter "@teamsuzie/shared-auth..." build
pnpm --filter "@teamsuzie/auth" dev
```
Expected: "Auth service running on port 3005".

- [ ] **Step 4: Verify discovery**

```bash
curl -s http://localhost:3005/.well-known/openid-configuration | head -c 400
```
Expected: JSON with `authorization_endpoint`, `token_endpoint`, `jwks_uri`. Note the `token_endpoint`/`authorization_endpoint` — they must be reachable from the brain.

- [ ] **Step 5: Resolve the resource indicator**

Check `apps/platform/auth/src/oidc/Provider.ts` (or its `resourceIndicators.getResourceServerInfo`) for which `resource` values are accepted. Set `OIDC_RESOURCE` in `apps/brain/.env` to an accepted absolute URI. If `http://localhost:16500` is rejected with `invalid_target`, use the value the provider expects (often the issuer URL). **This is the known integration risk; confirm here.**

- [ ] **Step 6: Write `apps/brain/.env`**

Copy `apps/brain/.env.example` → `apps/brain/.env` and fill `SESSION_SECRET` (any random 32+ char string), `OIDC_CLIENT_SECRET` (matching Step 2), and the confirmed `OIDC_RESOURCE`.

- [ ] **Step 7: Smoke-test the brain login redirect**

```bash
cd apps/casperaki2026 && pnpm dev:brain   # in one terminal
curl -si 'http://localhost:16500/api/auth/login' | grep -i location
```
Expected: a `302` `Location:` pointing at `http://localhost:3005/.../auth?...client_id=casperaki...`. No code is committed; this task's deliverable is a working provider + filled `.env`.

---

## Task 6: Web — auth API helper + AuthProvider

**Files:**
- Create: `apps/web/src/api/auth.ts`
- Create: `apps/web/src/auth/AuthContext.tsx`
- Test: `apps/web/test/auth.test.ts`

**Interfaces:**
- Consumes: `defaultBrainClient`, `BrainError` from `apps/web/src/api/client.ts` (existing).
- Produces: `auth.me()`, `auth.logout()`, `auth.loginUrl(returnTo?)`.
- Produces: `AuthProvider`, `useAuth(): { user: AuthUser | null; isLoading: boolean; signIn(): void; signOut(): Promise<void> }`, `interface AuthUser { id; email; name }`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/test/auth.test.ts
import { describe, it, expect } from 'vitest';
import { auth } from '../src/api/auth.ts';

describe('auth.loginUrl', () => {
  it('encodes return_to', () => {
    expect(auth.loginUrl('/editor/abc')).toBe('/api/auth/login?return_to=%2Feditor%2Fabc');
  });
  it('omits return_to when not given', () => {
    expect(auth.loginUrl()).toBe('/api/auth/login');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && pnpm vitest run test/auth.test.ts`
Expected: FAIL — cannot find `../src/api/auth.ts`.

- [ ] **Step 3: Create `api/auth.ts`**

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && pnpm vitest run test/auth.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Create `auth/AuthContext.tsx`**

Port `apps/suzie-it-department/src/web/auth/AuthContext.tsx`, swapping its `ApiError` for the web's `BrainError` (which carries `.status`) and its `api.auth` for our `auth`:

```tsx
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
        if (!cancelled && err instanceof BrainError && err.status !== 401) {
          console.warn('auth/me failed:', err.message);
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
```

- [ ] **Step 6: Typecheck**

Run: `cd apps/web && pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/api/auth.ts apps/web/src/auth/AuthContext.tsx apps/web/test/auth.test.ts
git commit -m "feat(web): auth API helper + AuthProvider/useAuth"
```

---

## Task 7: Web — teamsuzie UI deps, gated routes, landing wired to OIDC

**Files:**
- Modify: `apps/web/package.json`
- Modify: `apps/web/src/main.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/pages/LoginPage.tsx`

**Interfaces:**
- Consumes: `AuthProvider`/`useAuth` (Task 6).
- Produces: a route tree where signed-out users see only the landing; signed-in users see Projects/Editor.

- [ ] **Step 1: Add teamsuzie UI deps + build script**

In `apps/web/package.json`, add to `dependencies` (match suzie-it-department's link paths — web is at `apps/web`, so the relative path to open_teamsuzie is `../../../open_teamsuzie`):

```json
"@teamsuzie/ui": "link:../../../open_teamsuzie/packages/ui",
"@teamsuzie/theme": "link:../../../open_teamsuzie/packages/theme",
```

Add to `scripts`:

```json
"deps:build": "cd ../../../open_teamsuzie && pnpm --filter \"@teamsuzie/ui...\" --filter \"@teamsuzie/theme...\" build",
```

Then:

```bash
cd apps/casperaki2026 && pnpm install
pnpm --filter @casperaki/web deps:build
```
Expected: install links the packages; `deps:build` produces their `dist/`. (This is the prerequisite the root README already documents for `@teamsuzie/ui`.)

- [ ] **Step 2: Wrap `main.tsx` with `<AuthProvider>`**

Edit `apps/web/src/main.tsx` — add the import and wrap `<App />`:

```tsx
import { AuthProvider } from './auth/AuthContext';
// ...
createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
```

- [ ] **Step 3: Gate `App.tsx`**

Wrap the existing routes so signed-out users get the landing. Edit `apps/web/src/App.tsx` — keep the existing route definitions, but split public vs gated:

```tsx
import { Navigate, Route, Routes } from 'react-router-dom';
import { SessionProvider } from './state/session';
import { useAuth } from './auth/AuthContext';
import { LoginPage } from './pages/LoginPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { EditorPage } from './pages/EditorPage';
import { CatalogPage } from './pages/CatalogPage';
import { WasmTonePage } from './pages/WasmTonePage';
import { WasmRenderPage } from './pages/WasmRenderPage';

export function App() {
  const { user, isLoading } = useAuth();
  if (isLoading) return <BootSplash />;
  if (!user) return <LoginPage />; // public landing for everyone signed out

  return (
    <SessionProvider>
      <Routes>
        <Route path="/" element={<ProjectsPage />} />
        <Route path="/catalog" element={<CatalogPage />} />
        {/* dev-only WASM spikes stay reachable when signed in */}
        <Route path="/wasm-tone" element={<WasmTonePage />} />
        <Route path="/wasm-render" element={<WasmRenderPage />} />
        <Route path="/editor" element={<Navigate to="/" replace />} />
        <Route path="/editor/:songId" element={<Navigate to="timeline" replace />} />
        <Route path="/editor/:songId/sound" element={<EditorPage tab="sound" />} />
        <Route path="/editor/:songId/timeline" element={<EditorPage tab="timeline" />} />
        <Route path="/editor/:songId/structure" element={<EditorPage tab="structure" />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </SessionProvider>
  );
}

function BootSplash() {
  return (
    <div className="fixed inset-0 flex items-center justify-center bg-[#e2e2e2] text-sm text-black/50">
      Loading…
    </div>
  );
}
```

> Note: the old `/login` route is removed — there is no in-app login screen anymore; the landing IS the signed-out view, and credential entry happens on the provider. Remove any `useNavigate('/login')` references elsewhere if present (grep `'/login'`).

- [ ] **Step 4: Rewire `LoginPage.tsx` as the landing**

The file already renders the bespoke landing. Make two changes:
1. Replace the fake `nextPage()` navigation with the real OIDC redirect.
2. Remove the dead email/password form; the right panel becomes "Sign in" / "Continue with Google" CTAs that both call `signIn()`.

Edit `apps/web/src/pages/LoginPage.tsx`:
- Add `import { useAuth } from '../auth/AuthContext';` and remove `useNavigate`/`FormEvent` usage tied to the old form.
- In `LoginPage`, replace:
  ```tsx
  const navigate = useNavigate();
  // ...
  const nextPage = () => { setHidden(true); setTimeout(() => navigate('/'), 400); };
  const onSubmit = (e) => { e.preventDefault(); nextPage(); };
  ```
  with:
  ```tsx
  const { signIn } = useAuth();
  const go = () => { setHidden(true); setTimeout(signIn, 300); };
  ```
- Pass `onContinue={go}` to `SignUpPanel` and have the `LoginPanel` "Log in" become a button calling `go` (no `<form>`/inputs). Simplest: render only `SignUpPanel` (its three buttons — "Use phone or email", "Continue with Google", "Continue with Apple" — all call `onContinue={go}`); drop the `panel` toggle and `LoginPanel` entirely. Update the footer disclaimer text from "no auth backend" to a neutral tagline.
- Remove the now-unused `SignUpPanel onSwitch` prop and the `LoginPanel` function.

The animation/brand markup (left panel) is unchanged.

- [ ] **Step 5: Typecheck + build**

Run: `cd apps/web && pnpm typecheck && pnpm build`
Expected: PASS. Fix any leftover references to removed symbols (`LoginPanel`, `useNavigate`, `/login`).

- [ ] **Step 6: Commit**

```bash
git add apps/web/package.json apps/web/src/main.tsx apps/web/src/App.tsx apps/web/src/pages/LoginPage.tsx pnpm-lock.yaml
git commit -m "feat(web): gate app behind auth; landing wired to OIDC sign-in"
```

---

## Task 8: Web — signed-in chrome + full round-trip verification

**Files:**
- Create: `apps/web/src/layout/AccountMenu.tsx`
- Modify: `apps/web/src/layout/AppHeader.tsx` (mount the account menu)

**Interfaces:**
- Consumes: `useAuth` (Task 6), `@teamsuzie/ui` primitives.
- Produces: a header control showing the signed-in user with a sign-out action, built from `@teamsuzie/ui` (no hand-rolled button).

- [ ] **Step 1: Inspect available `@teamsuzie/ui` primitives**

```bash
sed -n '1,80p' ../open_teamsuzie/packages/ui/src/index.ts | grep -iE "button|dropdown|menu|avatar"
```
Use the exported `Button` (and a dropdown/menu if exported; otherwise a simple `Button`).

- [ ] **Step 2: Create `AccountMenu.tsx`**

```tsx
// apps/web/src/layout/AccountMenu.tsx
import { Button } from '@teamsuzie/ui';
import { useAuth } from '../auth/AuthContext';

export function AccountMenu() {
  const { user, signOut } = useAuth();
  if (!user) return null;
  return (
    <div className="flex items-center gap-3">
      <span className="text-xs text-black/60">{user.email}</span>
      <Button variant="outline" size="sm" onClick={() => void signOut()}>
        Sign out
      </Button>
    </div>
  );
}
```

> Note: confirm `Button`'s prop names (`variant`/`size`) against `../open_teamsuzie/packages/ui/src/components/button.tsx`; adjust if they differ.

- [ ] **Step 3: Mount it in `AppHeader.tsx`**

Add `import { AccountMenu } from './AccountMenu';` and render `<AccountMenu />` in the header's right-hand area (follow the existing header layout in `apps/web/src/layout/AppHeader.tsx`).

- [ ] **Step 4: Typecheck + build**

Run: `cd apps/web && pnpm typecheck && pnpm build`
Expected: PASS.

- [ ] **Step 5: Full manual round-trip (requires Task 5 provider running)**

```bash
# terminal A: provider (open_teamsuzie/apps/platform/auth) on :3005
# terminal B:
cd apps/casperaki2026 && pnpm dev:all
```
Verify in the browser at http://localhost:5173:
1. Signed out → bespoke landing renders.
2. Click "Use phone or email" → redirected to the provider login.
3. Sign in with email/password → bounced back to `/`, Projects renders, header shows your email.
4. Reload → still signed in (session cookie persists).
5. "Continue with Google" → Google flow → returns signed in.
6. "Sign out" → back to landing; `/api/songs/*` now 401 (check Network tab).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/layout/AccountMenu.tsx apps/web/src/layout/AppHeader.tsx
git commit -m "feat(web): signed-in account menu + sign-out (teamsuzie ui)"
```

---

## Final verification

- [ ] `cd apps/brain && pnpm vitest run && pnpm typecheck` — green.
- [ ] `cd apps/web && pnpm vitest run && pnpm typecheck && pnpm build` — green.
- [ ] Manual round-trip (Task 8 Step 5) passes for both email and Google.
- [ ] With OIDC env unset, `pnpm dev:brain` logs the "auth DISABLED (dev mode)" warning and the landing still loads (pure UI mode).
