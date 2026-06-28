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
