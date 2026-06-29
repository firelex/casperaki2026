// apps/brain/test/auth/normalizeReturnTo.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import { normalizeReturnTo } from '../../src/routes/auth.js';

const WEB_ORIGIN = 'http://localhost:5173';

beforeAll(() => {
  delete process.env.OIDC_POST_LOGIN_DEFAULT;
});

describe('normalizeReturnTo', () => {
  it('path-relative /editor/abc → resolved against webOrigin', () => {
    expect(normalizeReturnTo('/editor/abc', WEB_ORIGIN)).toBe('http://localhost:5173/editor/abc');
  });

  it('same-origin absolute URL → kept as-is', () => {
    expect(normalizeReturnTo('http://localhost:5173/projects', WEB_ORIGIN)).toBe(
      'http://localhost:5173/projects',
    );
  });

  it('protocol-relative //evil.com/x → fallback (open-redirect fix)', () => {
    expect(normalizeReturnTo('//evil.com/x', WEB_ORIGIN)).toBe('http://localhost:5173/');
  });

  it('other-origin absolute https://evil.com/x → fallback', () => {
    expect(normalizeReturnTo('https://evil.com/x', WEB_ORIGIN)).toBe('http://localhost:5173/');
  });

  it('empty string → fallback', () => {
    expect(normalizeReturnTo('', WEB_ORIGIN)).toBe('http://localhost:5173/');
  });
});
