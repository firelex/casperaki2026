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
