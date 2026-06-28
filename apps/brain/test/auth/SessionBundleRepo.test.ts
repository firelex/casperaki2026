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
