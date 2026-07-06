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
  // Optional per OAuth 2.0 (RFC 6749 §5.1). Callers must default a missing
  // value rather than assume it is present — see tokenRefresh / auth route.
  expires_in?: number;
  token_type: string;
}

/** Thrown by token-endpoint calls on a non-2xx response. Carries the raw
 *  status + body so callers can distinguish a definitive `invalid_grant`
 *  (session is dead) from a transient 5xx (leave the session intact). */
export class OidcTokenError extends Error {
  constructor(readonly status: number, readonly body: string) {
    super(`token endpoint ${status}: ${body}`);
    this.name = 'OidcTokenError';
  }
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
      this.discoveryPromise = discover(this.opts.issuerUrl)
        .then((d) => {
          this.discovery = d;
          return d;
        })
        .catch((err) => {
          // Don't cache a rejected discovery forever — otherwise one failed
          // fetch at boot (IdP not up yet) bricks auth until process restart.
          this.discoveryPromise = null;
          throw err;
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
    if (!res.ok) throw new OidcTokenError(res.status, text);
    return JSON.parse(text) as OidcTokenResponse;
  }
}

function defaultDiscover(fetchImpl?: typeof fetch) {
  return async (issuerUrl: string): Promise<OidcDiscovery> => {
    const f = fetchImpl ?? fetch;
    // Append the well-known suffix to the FULL issuer (including any path),
    // per OpenID Connect Discovery. `new URL('/.well-known/...', issuer)`
    // would discard a path-based issuer like `https://idp/realms/x`.
    const base = issuerUrl.endsWith('/') ? issuerUrl : `${issuerUrl}/`;
    const url = new URL('.well-known/openid-configuration', base).toString();
    const res = await f(url);
    if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`);
    return res.json() as Promise<OidcDiscovery>;
  };
}
