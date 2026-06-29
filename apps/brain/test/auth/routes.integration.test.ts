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
