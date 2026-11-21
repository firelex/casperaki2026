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
import { createSongsRouter, ownerOf } from './routes/songs.js';
import { createPlaybackRouter } from './routes/playback.js';
import { PlaybackService } from './render/playbackService.js';
import { openSongsStore, type SongsStore } from './store.js';
import { openAuthDb } from './auth/authDb.js';
import { SessionBundleRepo } from './auth/SessionBundleRepo.js';
import { OidcClient } from './auth/OidcClient.js';
import { attachSession, requireSession } from './auth/middleware.js';
import { RenderService } from './render/renderService.js';
import { authRouter } from './routes/auth.js';

export interface CreateAppDeps {
  /** Optional injected store. Tests pass an in-memory store; bootstrap
   *  uses the configured songsDbPath when no store is provided. */
  readonly store?: SongsStore;
  readonly auth?: { sessions: SessionBundleRepo; oidc: OidcClient };
  /** Optional injected render service (tests). Bootstrap builds one when
   *  CASPERAKI_SAMPLE_LIBRARY_ROOT is configured. */
  readonly renders?: RenderService;
  readonly playback?: PlaybackService;
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
  // Songs are sent whole on save (PUT /api/songs/:id); a long song's JSON runs to
  // several hundred kB compact, so leave generous headroom.
  app.use(express.json({ limit: '16mb' }));

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

  const admins = new Set(config.adminEmails);
  const isAdmin = (email: string) => admins.has(email.toLowerCase());
  if (auth) {
    if (admins.size === 0) console.warn('[brain] BRAIN_ADMIN_EMAILS is empty — nobody can browse the sound catalog.');
    // Session resolution runs on every request; never rejects.
    app.use(attachSession(auth.sessions, auth.oidc));
    // Auth endpoints mounted BEFORE the gate so login/callback/me/logout
    // are reachable unauthenticated.
    app.use('/api/auth', authRouter({
      sessions: auth.sessions,
      oidc: auth.oidc,
      webOrigin: config.webOrigin,
      postLoginDefault: config.postLoginDefault,
      isAdmin,
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

  const renders =
    deps.renders ??
    (config.sampleLibraryRoot
      ? new RenderService({
          rendersDir: resolve(config.rendersDir),
          emitScript: resolve(config.renderEmitScript),
          renderBin: resolve(config.renderBin),
          stubSamplesDir: resolve(config.renderStubSamplesDir),
          sampleLibraryRoot: config.sampleLibraryRoot,
          mix: config.renderMix,
          ffmpegBin: config.ffmpegBin,
          nodeBin: process.execPath,
        })
      : undefined);
  if (!renders) {
    console.warn('[brain] CASPERAKI_SAMPLE_LIBRARY_ROOT not set — per-song rendering is DISABLED (render routes answer 503).');
  }

  const playback =
    deps.playback ??
    (config.sampleLibraryRoot
      ? new PlaybackService({
          playbackDir: resolve(config.playbackDir),
          sampleCacheDir: resolve(config.sampleCacheDir),
          emitScript: resolve(config.renderEmitScript),
          nodeBin: process.execPath,
          sampleLibraryRoot: config.sampleLibraryRoot,
          ffmpegBin: config.ffmpegBin,
          stubSamplesDir: resolve(config.renderStubSamplesDir),
        })
      : undefined);

  app.use(createSongsRouter({ store, renders }));
  app.use(createPlaybackRouter({ store, playback, ownerOf }));
  app.use(createRendersRouter({ artifactPath: config.renderArtifactPath }));
  // Browsing the catalog is for admins (it lists source library / preset
  // names). Single-entry lookups stay open: the editor needs them.
  app.use(
    createCatalogRouter({
      canBrowse: (req) => (auth ? Boolean(req.user && isAdmin(req.user.email)) : true),
    }),
  );

  // Unknown /api routes answer JSON 404 rather than falling into the SPA.
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  if (config.webDistDir) {
    const dist = resolve(config.webDistDir);
    const indexHtml = join(dist, 'index.html');
    readFileSync(indexHtml); // fail at startup, naming the path, if the web build is missing
    // Same cross-origin isolation headers the Vite dev/preview servers send
    // (the in-browser WASM engine pages need SharedArrayBuffer).
    app.use((_req, res, next) => {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      next();
    });
    app.use(express.static(dist, { index: false, maxAge: '1h' }));
    app.get('*', (_req, res) => {
      res.setHeader('cache-control', 'no-cache');
      res.sendFile(indexHtml);
    });
  }

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
