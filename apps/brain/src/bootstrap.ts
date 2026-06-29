// apps/brain — process bootstrap.
//
// Loads .env, builds the typed config, constructs the Express app, and
// starts listening. Kept separate from src/index.ts so tests can build
// an app without taking a port. Mirrors the convention used by
// apps/models.

import 'express-async-errors';
import 'dotenv/config';

import express, { type Express } from 'express';

import { loadConfig, oidcConfigured, type BrainConfig } from './config.js';
import { createCatalogRouter } from './routes/catalog.js';
import { createRendersRouter } from './routes/renders.js';
import { createSongsRouter } from './routes/songs.js';
import { openSongsStore, type SongsStore } from './store.js';
import { openAuthDb } from './auth/authDb.js';
import { SessionBundleRepo } from './auth/SessionBundleRepo.js';
import { OidcClient } from './auth/OidcClient.js';
import { attachSession, requireSession } from './auth/middleware.js';
import { authRouter } from './routes/auth.js';

export interface CreateAppDeps {
  /** Optional injected store. Tests pass an in-memory store; bootstrap
   *  uses the configured songsDbPath when no store is provided. */
  readonly store?: SongsStore;
  readonly auth?: { sessions: SessionBundleRepo; oidc: OidcClient };
}

export function createApp(config: BrainConfig, deps: CreateAppDeps = {}): Express {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  const store = deps.store ?? openSongsStore({ path: config.songsDbPath });

  // Build auth deps if not injected and OIDC is configured.
  const auth =
    deps.auth ??
    (oidcConfigured(config)
      ? {
          sessions: new SessionBundleRepo(openAuthDb(config.authDbPath), config.sessionSecret || 'dev-only-session-secret'),
          oidc: new OidcClient({
            issuerUrl: config.oidcIssuerUrl!,
            clientId: config.oidcClientId!,
            clientSecret: config.oidcClientSecret!,
            redirectUri: config.oidcRedirectUri,
            resource: config.oidcResource,
          }),
        }
      : null);

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, service: '@casperaki/brain' });
  });

  if (auth) {
    // Session resolution runs on every request; never rejects.
    app.use(attachSession(auth.sessions, auth.oidc));
    // Auth endpoints mounted BEFORE the gate so login/callback/me/logout
    // are reachable unauthenticated.
    app.use('/api/auth', authRouter({ sessions: auth.sessions, oidc: auth.oidc, webOrigin: config.webOrigin }));
    // Everything else under /api requires a valid session.
    app.use('/api', requireSession());
    // Sweep expired sessions hourly.
    setInterval(() => auth.sessions.purgeExpired(), 60 * 60 * 1000).unref();
  } else {
    console.warn('[brain] OIDC not configured — auth routes and gate are DISABLED (dev mode).');
  }

  app.use(createSongsRouter({ store }));
  app.use(createRendersRouter({ artifactPath: config.renderArtifactPath }));
  app.use(createCatalogRouter());

  return app;
}

export function startServer(): { stop: () => Promise<void> } {
  const config = loadConfig();
  const app = createApp(config);
  const server = app.listen(config.port, config.host, () => {
    console.log(`[brain] listening on http://${config.host}:${config.port}`);
  });
  return {
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
