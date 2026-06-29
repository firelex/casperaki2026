import { describe, it, expect } from 'vitest';
import { auth } from '../src/api/auth';

describe('auth.loginUrl', () => {
  it('encodes return_to', () => {
    expect(auth.loginUrl('/editor/abc')).toBe('/api/auth/login?return_to=%2Feditor%2Fabc');
  });
  it('omits return_to when not given', () => {
    expect(auth.loginUrl()).toBe('/api/auth/login');
  });
});
