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

  it('backslash bypass /\\evil.com/x → fallback (open-redirect fix)', () => {
    // The WHATWG URL parser treats "\" as "/", so this must NOT be accepted
    // as a same-origin path — it would resolve to http://evil.com/x.
    expect(normalizeReturnTo('/\\evil.com/x', WEB_ORIGIN)).toBe('http://localhost:5173/');
  });

  it('mixed slash/backslash /\\/evil.com → fallback (open-redirect fix)', () => {
    expect(normalizeReturnTo('/\\/evil.com', WEB_ORIGIN)).toBe('http://localhost:5173/');
  });

  it('honors an explicit postLoginDefault for the fallback', () => {
    expect(normalizeReturnTo('', WEB_ORIGIN, 'https://app.example.com')).toBe(
      'https://app.example.com/',
    );
  });

  it('other-origin absolute https://evil.com/x → fallback', () => {
    expect(normalizeReturnTo('https://evil.com/x', WEB_ORIGIN)).toBe('http://localhost:5173/');
  });

  it('empty string → fallback', () => {
    expect(normalizeReturnTo('', WEB_ORIGIN)).toBe('http://localhost:5173/');
  });
});
