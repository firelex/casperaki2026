// apps/brain/test/auth/tokenRefresh.test.ts
import { describe, it, expect, vi } from 'vitest';
import { ensureFreshAccessToken, InvalidGrantError } from '../../src/auth/tokenRefresh.ts';
import { OidcTokenError } from '../../src/auth/OidcClient.ts';
import { openAuthDb } from '../../src/auth/authDb.ts';
import { SessionBundleRepo } from '../../src/auth/SessionBundleRepo.ts';

function staleBundle(repo: SessionBundleRepo) {
  // accessTokenExpiresAt in the past → a refresh is forced.
  return repo.create({
    sub: 'u', email: 'e@x.com', name: 'E', refreshToken: 'r0', accessToken: 'a0',
    accessTokenExpiresAt: new Date(Date.now() - 70_000).toISOString(),
  });
}

describe('ensureFreshAccessToken', () => {
  it('returns the current token without refreshing when still fresh', async () => {
    const repo = new SessionBundleRepo(openAuthDb(':memory:'), 'secret');
    const bundle = repo.create({
      sub: 'u', email: 'e@x.com', name: 'E', refreshToken: 'r', accessToken: 'fresh',
      accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    const oidc = { refresh: vi.fn() } as any;
    const token = await ensureFreshAccessToken({ bundle, oidc, repo });
    expect(token).toBe('fresh');
    expect(oidc.refresh).not.toHaveBeenCalled();
  });

  it('dedupes concurrent refreshes into a single token-endpoint call (single-flight)', async () => {
    const repo = new SessionBundleRepo(openAuthDb(':memory:'), 'secret');
    const bundle = staleBundle(repo);
    let calls = 0;
    const oidc = {
      refresh: vi.fn(async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 10));
        return { access_token: 'a1', refresh_token: 'r1', expires_in: 3600, token_type: 'Bearer' };
      }),
    } as any;
    // Two parallel callers with the SAME session id must not both hit the IdP.
    const [t1, t2] = await Promise.all([
      ensureFreshAccessToken({ bundle, oidc, repo }),
      ensureFreshAccessToken({ bundle, oidc, repo }),
    ]);
    expect(t1).toBe('a1');
    expect(t2).toBe('a1');
    expect(calls).toBe(1);
  });

  it('classifies an invalid_grant token error as InvalidGrantError (session is dead)', async () => {
    const repo = new SessionBundleRepo(openAuthDb(':memory:'), 'secret');
    const bundle = staleBundle(repo);
    const oidc = {
      refresh: vi.fn(async () => { throw new OidcTokenError(400, '{"error":"invalid_grant"}'); }),
    } as any;
    await expect(ensureFreshAccessToken({ bundle, oidc, repo })).rejects.toBeInstanceOf(InvalidGrantError);
  });

  it('re-throws a transient 5xx as-is (NOT InvalidGrantError → session kept)', async () => {
    const repo = new SessionBundleRepo(openAuthDb(':memory:'), 'secret');
    const bundle = staleBundle(repo);
    const oidc = {
      refresh: vi.fn(async () => { throw new OidcTokenError(503, 'service unavailable'); }),
    } as any;
    await expect(ensureFreshAccessToken({ bundle, oidc, repo })).rejects.not.toBeInstanceOf(InvalidGrantError);
  });

  it('defaults a missing expires_in instead of producing an Invalid Date', async () => {
    const repo = new SessionBundleRepo(openAuthDb(':memory:'), 'secret');
    const bundle = staleBundle(repo);
    const oidc = {
      refresh: vi.fn(async () => ({ access_token: 'a1', refresh_token: 'r1', token_type: 'Bearer' })),
    } as any;
    const token = await ensureFreshAccessToken({ bundle, oidc, repo });
    expect(token).toBe('a1');
    // The persisted expiry must be a valid, future ISO timestamp.
    const persisted = repo.get(bundle.sessionId)!;
    expect(Number.isFinite(Date.parse(persisted.accessTokenExpiresAt))).toBe(true);
    expect(Date.parse(persisted.accessTokenExpiresAt)).toBeGreaterThan(Date.now());
  });
});
