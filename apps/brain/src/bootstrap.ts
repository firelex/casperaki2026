// apps/brain — process bootstrap.
//
// Loads .env, builds the typed config, constructs the Express app, and
// starts listening. Kept separate from src/index.ts so tests can build
// an app without taking a port. Mirrors the convention used by
// apps/models.

import 'express-async-errors';
import 'dotenv/config';

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
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

/** A stable dev session secret persisted next to the auth DB. Regenerating
 *  it per process (the old behaviour) silently invalidated every on-disk
 *  session on restart — decrypt then threw for all of them. Persisting it
 *  keeps dev sessions valid across restarts. */
function resolveDevSessionSecret(authDbPath: string): string {
  if (authDbPath === ':memory:') return 'casperaki-dev-ephemeral-secret';
  const dir = dirname(isAbsolute(authDbPath) ? authDbPath : resolve(process.cwd(), authDbPath));
  const secretPath = join(dir, '.dev-session-secret');
  try {
    const existing = readFileSync(secretPath, 'utf8').trim();
    if (existing) return existing;
  } catch { /* not written yet — create below */ }
  const secret = randomBytes(32).toString('hex');
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(secretPath, secret, { mode: 0o600 });
  } catch { /* non-fatal: fall back to the in-memory value for this process */ }
  return secret;
}

export function createApp(config: BrainConfig, deps: CreateAppDeps = {}): Express {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // Cleanup hooks for resources createApp itself owns (never for injected
  // deps — tests own those). Invoked by startServer().stop().
  const disposers: Array<() => void> = [];

  let store = deps.store;
  if (!store) {
    store = openSongsStore({ path: config.songsDbPath });
    const owned = store;
    disposers.push(() => { try { owned.close(); } catch { /* best effort */ } });
  }

  // Build auth deps if not injected and OIDC is configured.
  let auth = deps.auth ?? null;
  if (!auth && oidcConfigured(config)) {
    const authDb = openAuthDb(config.authDbPath);
    disposers.push(() => { try { authDb.close(); } catch { /* best effort */ } });
    auth = {
      sessions: new SessionBundleRepo(
        authDb,
        config.sessionSecret || resolveDevSessionSecret(config.authDbPath),
      ),
      oidc: new OidcClient({
        issuerUrl: config.oidcIssuerUrl!,
        clientId: config.oidcClientId!,
        clientSecret: config.oidcClientSecret!,
        redirectUri: config.oidcRedirectUri,
        resource: config.oidcResource,
      }),
    };
  }

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, service: '@casperaki/brain' });
  });

  if (auth) {
    // Session resolution runs on every request; never rejects.
    app.use(attachSession(auth.sessions, auth.oidc));
    // Auth endpoints mounted BEFORE the gate so login/callback/me/logout
    // are reachable unauthenticated.
    app.use('/api/auth', authRouter({
      sessions: auth.sessions,
      oidc: auth.oidc,
      webOrigin: config.webOrigin,
      postLoginDefault: config.postLoginDefault,
    }));
    // Everything else under /api requires a valid session.
    app.use('/api', requireSession());
    // Sweep expired sessions hourly.
    const purgeTimer = setInterval(() => auth!.sessions.purgeExpired(), 60 * 60 * 1000);
    purgeTimer.unref();
    disposers.push(() => clearInterval(purgeTimer));
  } else {
    console.warn('[brain] OIDC not configured — auth routes and gate are DISABLED (dev mode).');
  }

  app.use(createSongsRouter({ store }));
  app.use(createRendersRouter({ artifactPath: config.renderArtifactPath }));
  app.use(createCatalogRouter());

  // Expose owned-resource cleanup so startServer().stop() can dispose the
  // sqlite handles (checkpointing WAL) and the purge interval on shutdown.
  (app.locals as { dispose?: () => void }).dispose = () => {
    for (const d of disposers.splice(0)) d();
  };

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
      new Promise<void>((resolvePromise, reject) => {
        server.close((err) => {
          (app.locals as { dispose?: () => void }).dispose?.();
          if (err) reject(err);
          else resolvePromise();
        });
      }),
  };
}
