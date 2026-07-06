// apps/brain/test/auth/middleware.test.ts
import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import { readCookie, requireSession, attachSession, SESSION_COOKIE } from '../../src/auth/middleware.ts';
import { openAuthDb } from '../../src/auth/authDb.ts';
import { SessionBundleRepo } from '../../src/auth/SessionBundleRepo.ts';
import { OidcTokenError } from '../../src/auth/OidcClient.ts';

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

  it('calls next without user when sessions.get() throws', async () => {
    const fakeSessions = {
      get() { throw new Error('db down'); },
      delete() {},
    } as any;
    const req = { headers: { cookie: `${SESSION_COOKIE}=somesid` } } as unknown as Request;
    const res = { setHeader: vi.fn() } as unknown as Response;
    const next = vi.fn();
    await expect(attachSession(fakeSessions, {} as any)(req, res, next)).resolves.toBeUndefined();
    expect((req as any).user).toBeUndefined();
    expect(next).toHaveBeenCalled();
  });

  it('calls next without user when session is expired', async () => {
    const db = openAuthDb(':memory:');
    const sessions = new SessionBundleRepo(db, 'secret');
    const created = sessions.create({
      sub: 'u2', email: 'e2@x.com', name: 'E2', refreshToken: 'r', accessToken: 'a',
      accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    db.prepare('UPDATE user_sessions SET expires_at = ? WHERE session_id = ?')
      .run(new Date(Date.now() - 1000).toISOString(), created.sessionId);
    const req = { headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(created.sessionId)}` } } as unknown as Request;
    const res = { setHeader: vi.fn() } as unknown as Response;
    const next = vi.fn();
    await attachSession(sessions, {} as any)(req, res, next);
    expect((req as any).user).toBeUndefined();
    expect(next).toHaveBeenCalled();
  });

  it('calls next without user when oidc.refresh throws', async () => {
    const db = openAuthDb(':memory:');
    const sessions = new SessionBundleRepo(db, 'secret');
    const created = sessions.create({
      sub: 'u3', email: 'e3@x.com', name: 'E3', refreshToken: 'r', accessToken: 'a',
      accessTokenExpiresAt: new Date(Date.now() - 70_000).toISOString(),
    });
    const oidc = { refresh: async () => { throw new Error('idp down'); } } as any;
    const req = { headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(created.sessionId)}` } } as unknown as Request;
    const res = { setHeader: vi.fn() } as unknown as Response;
    const next = vi.fn();
    await expect(attachSession(sessions, oidc)(req, res, next)).resolves.toBeUndefined();
    expect((req as any).user).toBeUndefined();
    expect(next).toHaveBeenCalled();
  });

  it('KEEPS the session on a transient (5xx) refresh error', async () => {
    const sessions = new SessionBundleRepo(openAuthDb(':memory:'), 'secret');
    const created = sessions.create({
      sub: 'u4', email: 'e4@x.com', name: 'E4', refreshToken: 'r', accessToken: 'a',
      accessTokenExpiresAt: new Date(Date.now() - 70_000).toISOString(),
    });
    const oidc = { refresh: async () => { throw new OidcTokenError(503, 'unavailable'); } } as any;
    const req = { headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(created.sessionId)}` } } as unknown as Request;
    const res = { setHeader: vi.fn() } as unknown as Response;
    await attachSession(sessions, oidc)(req, res, vi.fn());
    // A brief IdP outage must not log the user out — the row survives.
    expect(sessions.get(created.sessionId)).not.toBeNull();
  });

  it('DELETES the session on an invalid_grant refresh error', async () => {
    const sessions = new SessionBundleRepo(openAuthDb(':memory:'), 'secret');
    const created = sessions.create({
      sub: 'u5', email: 'e5@x.com', name: 'E5', refreshToken: 'r', accessToken: 'a',
      accessTokenExpiresAt: new Date(Date.now() - 70_000).toISOString(),
    });
    const oidc = { refresh: async () => { throw new OidcTokenError(400, '{"error":"invalid_grant"}'); } } as any;
    const req = { headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(created.sessionId)}` } } as unknown as Request;
    const res = { setHeader: vi.fn() } as unknown as Response;
    await attachSession(sessions, oidc)(req, res, vi.fn());
    expect(sessions.get(created.sessionId)).toBeNull();
    expect(res.setHeader).toHaveBeenCalled(); // cookie cleared
  });
});
