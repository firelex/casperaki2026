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
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import express, { type Express } from 'express';

import { loadConfig, oidcConfigured, type BrainConfig } from './config.js';
import { createCatalogRouter } from './routes/catalog.js';
import { createRendersRouter } from './routes/renders.js';
import { createSongsRouter, hashCanonical, ownerOf } from './routes/songs.js';
import { createTasksRouter } from './routes/tasks.js';
import { BackgroundTasks, type AceDeps, type SingDeps } from './tasks/tasks.js';
import { levelVocals, withVocalFader } from './sing/vocalLevel.js';
import { applyMixOverrides, canonicalStringifySong } from '@casperaki/song-schema';
import { VocalsClient } from './sing/vocalsClient.js';
import { EventHub } from './events.js';
import { ArtworkTasks, HarnessImageService, type ImageService } from './artwork/tasks.js';
import { SongTitler } from './titles/songTitler.js';
import { OpenAiChatModel, type ChatModel } from './llm/chatModel.js';
import { createDawExportRouter } from './routes/dawExport.js';
import { DawExportService } from './export/dawExportService.js';
import { createPlaybackRouter } from './routes/playback.js';
import { songMixConfig } from './render/songVersion.js';
import { createPatternsRouter } from './routes/patterns.js';
import { createSuggestionsRouter } from './routes/suggestions.js';
import { createTracksRouter } from './routes/tracks.js';
import { createSoundsRouter } from './routes/sounds.js';
import { createSingersRouter, readSingers, singerVoice, speakingSinger } from './routes/singers.js';
import { SpeakingVoices } from './singers/speakingVoice.js';
import { UserSingers } from './singers/userSingers.js';
import { createAvatarsRouter } from './routes/avatars.js';
import { createCastingRouter } from './routes/casting.js';
import { AvatarPacks } from './avatars/avatarPacks.js';
import { UserAvatars } from './avatars/userAvatars.js';
import { sweepOldBuilds } from './avatars/avatarBuildTask.js';
import { loadRealisticLibrary } from './avatars/realisticDesign.js';
import { createMelodyLibraryRouter } from './routes/melodyLibrary.js';
import { MelodyLibrary } from './melodies/melodyLibrary.js';
import { MelodyEdits } from './melodies/melodyEdits.js';
import { exportApprovedPatterns, PATTERN_LIBRARY_DIRS, setPrecedentEdits, type PatternLibraryDirs } from '@casperaki/arrangement';
import { commitAndPush, type Committer } from './git.js';
import { PlaybackService } from './render/playbackService.js';
import { openSongsStore, type SongsStore } from './store.js';
import { openAuthDb } from './auth/authDb.js';
import { SessionBundleRepo } from './auth/SessionBundleRepo.js';
import { OidcClient } from './auth/OidcClient.js';
import { attachSession, requireSession } from './auth/middleware.js';
import { RenderService } from './render/renderService.js';
import { renderAvatarVideo } from '@casperaki/video';
import { videoAvatars } from './avatars/videoAvatars.js';
import { createVideoRouter } from './routes/video.js';
import { createLabRouter } from './routes/lab.js';
import { createHumRouter } from './routes/hum.js';
import { OpenAiCompatibleLlm, type AssistantLlm } from './assistant/llm.js';
import { createAssistantRouter } from './assistant/route.js';
import { VideoService } from './video/videoService.js';
import { authRouter } from './routes/auth.js';
import { attachDemoSession, demoAuthRouter } from './auth/demoAuth.js';

/** How often the brain polls a running vocals-service job (ms). */
const SING_POLL_MS = 2000;

export interface CreateAppDeps {
  /** Optional injected store. Tests pass an in-memory store; bootstrap
   *  uses the configured songsDbPath when no store is provided. */
  readonly store?: SongsStore;
  readonly auth?: { sessions: SessionBundleRepo; oidc: OidcClient };
  /** Optional injected render service (tests). Bootstrap builds one when
   *  CASPERAKI_SAMPLE_LIBRARY_ROOT is configured. */
  readonly renders?: RenderService;
  /** Tests: the DAW export jobs. */
  readonly dawExports?: DawExportService;
  /** Music videos (tests inject one with a fake planner / renderer). */
  readonly videos?: VideoService;
  readonly playback?: PlaybackService;
  /** The song assistant's model (tests inject a scripted fake). */
  readonly assistantLlm?: AssistantLlm;
  /** Names new songs (tests inject a fake; production uses the assistant model). */
  readonly songTitler?: SongTitler;
  /** For tests: draws song artwork instead of the image service. */
  readonly imageService?: ImageService;
  /** Tests: how often a running vocals-service job is polled (ms; production 2000). */
  readonly singPollMs?: number;
  /** Sing's vocal level (default: rendered with the render service and measured, src/sing/vocalLevel.ts). */
  readonly vocalLevel?: Pick<SingDeps, 'levelVocals' | 'withVocalFader'>;
  /** The language model artwork briefs are written with (tests inject a fake). */
  readonly chatModel?: ChatModel;
  /** The language model lyrics are written with (tests inject a fake; production: the chat model). */
  readonly lyricModel?: ChatModel;
  /** The melody library's precedent bank directory (tests point it at fixtures). */
  readonly melodyLibraryDir?: string;
  /**
   * Records the data people change in the app in git: approved patterns (exported into the
   * pattern library) and melody edits. The server passes commitAndPush; tests leave it out, and
   * then pattern decisions stay in the database only and melody edits are not committed.
   */
  readonly commit?: Committer;
  /** Where approved patterns are exported (tests point it at a copy). */
  readonly patternLibraryDirs?: PatternLibraryDirs;
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
  if (config.demoLogin && auth) throw new Error('BRAIN_DEMO_LOGIN=1 cannot be combined with injected OIDC auth');
  if (!auth && !config.demoLogin && oidcConfigured(config)) {
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
  const demoSecret = config.demoLogin ? config.sessionSecret || resolveDevSessionSecret(config.authDbPath) : null;
  if (demoSecret) {
    console.warn('[brain] BRAIN_DEMO_LOGIN=1: fake demo sign-in (demo@example.com), OIDC is not used.');
    app.use(attachDemoSession(demoSecret));
    app.use('/api/auth', demoAuthRouter({ secret: demoSecret }));
    app.use('/api', requireSession());
  } else if (auth) {
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
          masteringBin: resolve(config.masteringBin),
          masteringReferencesDir: resolve(config.masteringReferencesDir),
          ...(config.vocalTakesDir ? { vocalTakesDir: config.vocalTakesDir } : {}),
        })
      : undefined);
  // DAW exports (stems / REAPER / Logic) next to the renders: <rendersDir>/../daw-exports.
  const dawExports = deps.dawExports ?? (config.sampleLibraryRoot
    ? new DawExportService({
        exportsDir: join(dirname(resolve(config.rendersDir)), 'daw-exports'),
        emitScript: resolve(config.renderEmitScript),
        renderBin: resolve(config.renderBin),
        stubSamplesDir: resolve(config.renderStubSamplesDir),
        sampleLibraryRoot: config.sampleLibraryRoot,
        nodeBin: process.execPath,
        ...(config.vocalTakesDir ? { vocalTakesDir: config.vocalTakesDir } : {}),
      })
    : undefined);
  // Avatars: dressed from the part packs (BRAIN_AVATAR_PACKS_DIR), kept per user next to their singers.
  const avatarPacks = config.avatarPacksDir ? new AvatarPacks(config.avatarPacksDir) : undefined;
  avatarPacks?.list(); // fail at startup, naming the pack, if a manifest is broken
  const userAvatars = config.singersDataDir ? new UserAvatars(config.singersDataDir) : undefined;
  // Music videos next to the renders: <rendersDir>/../videos.
  const videos =
    deps.videos ??
    (renders
      ? new VideoService({
          config: { videosDir: join(dirname(resolve(config.rendersDir)), 'videos'), ffmpegBin: config.ffmpegBin, renderConcurrency: config.videoRenderConcurrency },
          store,
          renders,
          renderAvatarVideo,
          ...(avatarPacks && userAvatars
            ? { avatars: { packsDir: avatarPacks.root, ...(config.danceClipsDir ? { clipsDir: config.danceClipsDir } : {}), resolve: (ownerId: string, songId: string, ids: readonly string[]) => videoAvatars(store, userAvatars, ownerId, songId, ids) } }
            : {}),
          // `playback` (the mix config) is set up below; these run per video, after start-up.
          songMix: (ownerId, songId) => {
            const project = store.getProject(ownerId, songId);
            if (!project) throw new Error(`song ${songId} is not a project of this owner`);
            return songMixConfig(project, playback ? () => playback.mixConfig : undefined);
          },
          standardMixConfig: () => {
            if (!playback) throw new Error('Music videos need the mix config (CASPERAKI_MIX_CONFIG) to know which version of a song they show.');
            return playback.mixConfig;
          },
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
          mixConfigPath: requireMixConfig(config.mixConfigPath),
          ...(config.vocalTakesDir ? { vocalTakesDir: config.vocalTakesDir } : {}),
          masteringReferencesDir: resolve(config.masteringReferencesDir),
        })
      : undefined);

  // New songs are created under a placeholder title and named by the language
  // model afterwards (src/titles), so generation itself stays deterministic.
  const titleEp = assistantEndpoint(config);
  const titler = deps.songTitler ?? (titleEp ? new SongTitler(titleEp, store) : undefined);
  if (!titler) console.warn('[brain] ASSISTANT_LLM_URL not set — new songs keep their placeholder titles.');
  const chatModel = deps.chatModel ?? (titleEp ? new OpenAiChatModel(titleEp) : undefined);
  // Events for the user's open pages (GET /api/events), e.g. artwork drawn in the background.
  const events = new EventHub();
  app.use(events.router(ownerOf));
  // Song artwork, drawn after the title (src/artwork/tasks.ts): needs the language model and the image service.
  if (Boolean(config.artworkServiceUrl || deps.imageService) !== Boolean(config.artworkDir)) {
    throw new Error('Set both ARTWORK_SERVICE_URL and BRAIN_ARTWORK_DIR for song artwork, or neither.');
  }
  const artwork =
    chatModel && config.artworkDir && (deps.imageService || config.artworkServiceUrl)
      ? new ArtworkTasks({ store, model: chatModel, images: deps.imageService ?? new HarnessImageService(config.artworkServiceUrl!), events, dir: resolve(config.artworkDir) })
      : undefined;
  if (!artwork) console.warn('[brain] ARTWORK_SERVICE_URL / BRAIN_ARTWORK_DIR not set — new songs get no artwork.');
  (app.locals as { artworkTasks?: ArtworkTasks }).artworkTasks = artwork;
  app.use(createSongsRouter({ store, renders, ...(playback ? { mixConfig: () => playback.mixConfig } : {}), ...(titler ? { onPlaceholderTitle: (u) => titler.name(u) } : {}), ...(artwork ? { artwork } : {}) }));
  app.use(createDawExportRouter({ store, exports: dawExports, ownerOf }));
  app.use(createPlaybackRouter({ store, playback, ownerOf }));
  // Background tasks on songs (src/tasks/tasks.ts): writing lyrics needs the language model; singing the vocals service,
  // a folder for each task's step files and the takes folder.
  const lyricModel = deps.lyricModel ?? chatModel;
  if (!lyricModel) console.warn('[brain] ASSISTANT_LLM_URL not set — Write lyrics answers 503.');
  const singSettings = { VOCALS_SERVICE_URL: config.vocalsServiceUrl, BRAIN_TASK_FILES_DIR: config.taskFilesDir, BRAIN_VOCAL_TAKES_DIR: config.vocalTakesDir };
  const singMissing = Object.entries(singSettings).filter(([, v]) => v === undefined).map(([k]) => k);
  if (config.vocalsServiceUrl && singMissing.length > 0) throw new Error(`VOCALS_SERVICE_URL is set, so Sing also needs ${singMissing.join(' and ')}.`);
  if (!config.vocalsServiceUrl) console.warn('[brain] VOCALS_SERVICE_URL not set — Sing answers 503.');
  // Sing sets each song's vocal level from its backing (src/sing/vocalLevel.ts): it renders the sung song, so it needs
  // per-song rendering and the mix config (tests inject their own `vocalLevel`).
  let vocalLevel: CreateAppDeps['vocalLevel'] = deps.vocalLevel;
  if (config.vocalsServiceUrl && !vocalLevel) {
    if (!renders || !playback) throw new Error('VOCALS_SERVICE_URL is set, so Sing also needs per-song rendering and the mix config (CASPERAKI_SAMPLE_LIBRARY_ROOT, CASPERAKI_MIX_CONFIG): it matches the vocal level to each song\'s backing.');
    const levelRenders = renders;
    const levelPlayback = playback;
    const levelFilesDir = config.taskFilesDir!;
    vocalLevel = {
      levelVocals: (ownerId, songId, song, taskId) =>
        levelVocals({
          dir: join(resolve(levelFilesDir), taskId, 'level'),
          canonical: canonicalStringifySong(song, 2),
          baseConfig: levelPlayback.mixConfig,
          overrides: store.getProject(ownerId, songId)?.mixOverrides ?? null,
          ffmpegBin: config.ffmpegBin,
          renderMix: (dir, canonical, mixConfig, solo) => levelRenders.renderMix(dir, canonical, mixConfig, solo),
        }),
      withVocalFader: (overrides, faderDb) => withVocalFader(overrides, levelPlayback.mixConfig, faderDb),
    };
  }
  // Add a singer: the users' own singers (BRAIN_SINGERS_DATA_DIR), made by the vocals service's add_singer stage.
  const userSingers = config.singersDataDir ? new UserSingers(config.singersDataDir) : undefined;
  if (config.singersDataDir && !(config.vocalsServiceUrl && config.taskFilesDir)) {
    throw new Error('BRAIN_SINGERS_DATA_DIR is set, so Add a singer also needs VOCALS_SERVICE_URL and BRAIN_TASK_FILES_DIR.');
  }
  if (!config.singersDataDir) console.warn('[brain] BRAIN_SINGERS_DATA_DIR not set — Add a singer answers 503.');
  const sing = config.vocalsServiceUrl
    ? {
        client: new VocalsClient(config.vocalsServiceUrl),
        filesDir: config.taskFilesDir!,
        takesDir: config.vocalTakesDir!,
        ffmpegBin: config.ffmpegBin,
        pollMs: deps.singPollMs ?? SING_POLL_MS,
        singerVoice: (ownerId: string, singerId: string) => singerVoice(config.singersDir, userSingers, ownerId, singerId),
        ...vocalLevel!,
      }
    : undefined;
  // Transcribe melody: the recording is kept in BRAIN_TASK_FILES_DIR; the vocals service reads sections with written
  // lyrics (or with music behind the voice), the hum service sections without.
  const transcribe = {
    filesDir: config.taskFilesDir,
    client: sing?.client,
    humServiceUrl: config.humServiceUrl,
    ffmpegBin: config.ffmpegBin,
    pollMs: deps.singPollMs ?? SING_POLL_MS,
  };
  // ACE layer: renders the working song (with the project's Pro-mode mix) into the task's folder, then the ace service
  // plays one instrument part over it; the clips are stored with the sung takes.
  let ace: AceDeps | undefined;
  if (config.aceServiceUrl) {
    const aceMissing = Object.entries({ BRAIN_TASK_FILES_DIR: config.taskFilesDir, BRAIN_VOCAL_TAKES_DIR: config.vocalTakesDir, CASPERAKI_SAMPLE_LIBRARY_ROOT: renders }).filter(([, v]) => v === undefined).map(([k]) => k);
    if (aceMissing.length > 0) throw new Error(`ACE_SERVICE_URL is set, so ACE layers also need ${aceMissing.join(' and ')}.`);
    const aceRenders = renders!;
    const taskFilesDir = config.taskFilesDir!;
    ace = {
      client: new VocalsClient(config.aceServiceUrl),
      filesDir: taskFilesDir,
      takesDir: config.vocalTakesDir!,
      ffmpegBin: config.ffmpegBin,
      pollMs: deps.singPollMs ?? SING_POLL_MS,
      renderWav: (ownerId, songId, song, taskId) => {
        const mix = store.getProject(ownerId, songId)?.mixOverrides;
        if (mix && !playback) throw new Error('This song has a Pro-mode mix, but the brain has no mix config (CASPERAKI_MIX_CONFIG).');
        const mixConfig = mix ? applyMixOverrides(playback!.mixConfig, mix) : undefined;
        return aceRenders.renderMix(join(resolve(taskFilesDir), taskId, 'render'), canonicalStringifySong(song, 2), mixConfig);
      },
    };
  } else {
    console.warn('[brain] ACE_SERVICE_URL not set — Add ACE layer answers 503.');
  }
  // Singers' speaking voices (src/singers/speakingVoice.ts): the speech service, the language model that describes
  // the voice, and the singers' data folder (where the voices are kept) and task files.
  const speakingVoices = config.singersDataDir ? new SpeakingVoices(config.singersDataDir) : undefined;
  const speaking =
    config.speechServiceUrl && lyricModel && speakingVoices && config.taskFilesDir
      ? { client: new VocalsClient(config.speechServiceUrl, 'speech service'), voices: speakingVoices, chat: lyricModel, filesDir: config.taskFilesDir, pollMs: deps.singPollMs ?? SING_POLL_MS }
      : undefined;
  if (!speaking) console.warn('[brain] SPEECH_SERVICE_URL (with ASSISTANT_LLM_URL, BRAIN_SINGERS_DATA_DIR, BRAIN_TASK_FILES_DIR) not set — speaking voices answer 503.');
  const addSinger =
    userSingers && sing
      ? { client: sing.client, filesDir: config.taskFilesDir!, singers: userSingers, ffmpegBin: config.ffmpegBin, pollMs: deps.singPollMs ?? SING_POLL_MS, ...(speaking ? { speaking } : {}) }
      : undefined;
  const speakingVoice = speaking ? { ...speaking, findSinger: (ownerId: string, singerId: string) => speakingSinger(config.singersDir, userSingers, ownerId, singerId) } : undefined;
  // Realistic avatars (src/avatars/avatarBuildTask.ts): the avatar builder and its curated library (read now: a bad
  // library stops the brain), builds kept a day in <BRAIN_TASK_FILES_DIR>/avatar-builds.
  const avatarBuild =
    config.avatarBuilderUrl && config.avatarLibraryFile && config.taskFilesDir && userAvatars
      ? { client: new VocalsClient(config.avatarBuilderUrl, 'avatar builder'), library: loadRealisticLibrary(config.avatarLibraryFile), filesDir: join(config.taskFilesDir, 'avatar-builds'), pollMs: deps.singPollMs ?? SING_POLL_MS }
      : undefined;
  if (!avatarBuild) console.warn('[brain] AVATAR_BUILDER_URL and AVATAR_LIBRARY_FILE (with BRAIN_TASK_FILES_DIR, BRAIN_SINGERS_DATA_DIR) not set — realistic avatars answer 503.');
  if (avatarBuild) {
    const sweep = () => sweepOldBuilds(avatarBuild.filesDir, Date.now());
    sweep();
    setInterval(sweep, 60 * 60 * 1000).unref();
  }
  // Casting scripts (src/casting): the assistant's language model writes them; the performer is one of the user's avatars.
  const casting =
    lyricModel && userAvatars
      ? {
          chat: lyricModel,
          avatars: userAvatars,
          findSinger: (ownerId: string, singerId: string) => {
            const s = speakingSinger(config.singersDir, userSingers, ownerId, singerId);
            return { name: s.name, description: s.description.trim() ? s.description : null };
          },
        }
      : undefined;
  if (!casting) console.warn('[brain] ASSISTANT_LLM_URL (with BRAIN_SINGERS_DATA_DIR) not set — casting scripts answer 503.');
  // Casting soundtracks (src/casting): the speech service speaks the script, the song's export and the music are mixed.
  const castingSoundtrack =
    config.speechServiceUrl && config.castingMusicDir && config.taskFilesDir && userAvatars && speakingVoices && videos
      ? {
          client: new VocalsClient(config.speechServiceUrl, 'speech service'),
          filesDir: config.taskFilesDir,
          pollMs: deps.singPollMs ?? SING_POLL_MS,
          ffmpegBin: config.ffmpegBin,
          musicDir: config.castingMusicDir,
          avatars: userAvatars,
          singerVoice: (ownerId: string, singerId: string) => {
            const s = speakingSinger(config.singersDir, userSingers, ownerId, singerId);
            const v = speakingVoices.get(ownerId, singerId, s.builtIn);
            return v ? { description: v.description, seed: v.seed, ...(v.line ? { line: v.line } : {}) } : undefined;
          },
          exportSong: (ownerId: string, songId: string) => videos.exportSong(ownerId, songId),
        }
      : undefined;
  if (!castingSoundtrack) console.warn('[brain] SPEECH_SERVICE_URL, BRAIN_CASTING_MUSIC_DIR (with BRAIN_TASK_FILES_DIR, BRAIN_SINGERS_DATA_DIR, rendering) not set — casting soundtracks answer 503.');
  const tasks = new BackgroundTasks({ store, events, ...(lyricModel ? { lyricModel } : {}), ...(sing ? { sing } : {}), ...(ace ? { ace } : {}), ...(addSinger ? { addSinger } : {}), ...(speakingVoice ? { speakingVoice } : {}), ...(avatarBuild ? { avatarBuild } : {}), ...(casting ? { casting } : {}), ...(castingSoundtrack ? { castingSoundtrack } : {}), transcribe, hash: hashCanonical, clock: () => new Date().toISOString() });
  app.use(createTracksRouter({ isSinging: (owner, songId) => tasks.isSinging(owner, songId) }));
  (app.locals as { tasks?: BackgroundTasks }).tasks = tasks;
  app.use(createTasksRouter({ store, tasks, now: () => new Date() }));
  app.use(createCastingRouter({ store, tasks, ownerOf, isAdminRequest: (req) => (demoSecret ? Boolean(req.user) : auth ? Boolean(req.user && isAdmin(req.user.email)) : true) }));
  app.use(createLabRouter({ ffmpegBin: config.ffmpegBin, beatThisPython: config.beatThisPython, humLabDir: config.humLabDir }));
  app.use(
    createHumRouter({
      humServiceUrl: config.humServiceUrl,
      amtServiceUrl: config.amtServiceUrl,
      humLabDir: config.humLabDir,
      store,
      ...(titler ? { onPlaceholderTitle: (u: Parameters<SongTitler['name']>[0]) => titler.name(u) } : {}),
      ...(artwork ? { artwork } : {}),
    }),
  );
  app.use(createSoundsRouter({ playback }));
  readSingers(config.singersDir); // fail at startup, naming the file, if the singers list is broken
  app.use(createSingersRouter({ dir: config.singersDir, ...(userSingers ? { users: userSingers } : {}), tasks, ...(speakingVoices ? { voices: speakingVoices } : {}) }));
  if (!config.avatarPacksDir) console.warn('[brain] BRAIN_AVATAR_PACKS_DIR not set — Avatars answer 503.');
  if (config.avatarPacksDir && !config.danceClipsDir) console.warn('[brain] BRAIN_DANCE_CLIPS_DIR not set — avatar videos use only the built-in dance moves.');
  app.use(
    createAvatarsRouter({
      ...(avatarPacks ? { packs: avatarPacks } : {}),
      ...(userAvatars ? { avatars: userAvatars } : {}),
      checkSinger: (ownerId, singerId) => void singerVoice(config.singersDir, userSingers, ownerId, singerId),
      isAdminRequest: (req) => (demoSecret ? Boolean(req.user) : auth ? Boolean(req.user && isAdmin(req.user.email)) : true),
      ...(avatarBuild
        ? { realistic: { library: avatarBuild.library, buildsDir: avatarBuild.filesDir, tasks: { startAvatarBuild: (o: string, d: unknown) => tasks.startAvatarBuild(o, d), get: (o: string, id: string) => store.getTask(o, id) } } }
        : {}),
    }),
  );
  // Melody library edits: loaded now and handed to the generator, so songs use them (a bad file stops the brain).
  const commit = deps.commit;
  const melodyEdits = new MelodyEdits(
    config.melodyEditsPath,
    (edits) => setPrecedentEdits(Object.fromEntries(edits)),
    commit ? (path, message) => commit([path], message) : undefined,
  );
  app.use(createMelodyLibraryRouter({ library: new MelodyLibrary(melodyEdits, deps.melodyLibraryDir) }));
  const assistantEp = assistantEndpoint(config);
  app.use(createAssistantRouter({ store, ownerOf, llm: deps.assistantLlm ?? (assistantEp ? new OpenAiCompatibleLlm(assistantEp) : undefined) }));
  app.use(createVideoRouter({ store, videos, ownerOf }));
  app.use(
    createPatternsRouter({
      store,
      playback,
      isAdminRequest: (req) => (demoSecret ? Boolean(req.user) : auth ? Boolean(req.user && isAdmin(req.user.email)) : true),
      reviewerOf: (req) => req.user?.email ?? 'local-dev',
      ...(commit
        ? {
            publishLibrary: (approved: ReadonlySet<string>, message: string) => {
              const dirs = deps.patternLibraryDirs ?? PATTERN_LIBRARY_DIRS;
              const changes = exportApprovedPatterns(approved, { dirs });
              commit([dirs.drums, dirs.bass, dirs.authored], changes.length ? `${message}\n\n${changes.join('\n')}` : message);
              return changes;
            },
          }
        : {}),
    }),
  );
  app.use(
    createSuggestionsRouter({
      store,
      mixConfig: playback,
      isAdminRequest: (req) => (demoSecret ? Boolean(req.user) : auth ? Boolean(req.user && isAdmin(req.user.email)) : true),
      authorOf: (req) => req.user?.email ?? 'local-dev',
    }),
  );
  app.use(createRendersRouter({ artifactPath: config.renderArtifactPath }));
  // Browsing the catalog is for admins (it lists source library / preset
  // names). Single-entry lookups stay open: the editor needs them.
  app.use(
    createCatalogRouter({
      canBrowse: (req) => (demoSecret ? Boolean(req.user) : auth ? Boolean(req.user && isAdmin(req.user.email)) : true),
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
    // Vite's /assets/ files carry a content hash in their names: cache them for
    // good. Everything else (the engine .wasm, worklet, workers, engine driver,
    // images) keeps its name across builds: revalidate every time (ETag), or a
    // browser runs a stale engine against new code.
    app.use(
      express.static(dist, {
        index: false,
        setHeaders: (res, path) => {
          res.setHeader('cache-control', path.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache');
        },
      }),
    );
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
  const app = createApp(config, { commit: commitAndPush });
  const server = app.listen(config.port, config.host, () => {
    console.log(`[brain] listening on http://${config.host}:${config.port}`);
  });
  (app.locals as { artworkTasks?: ArtworkTasks }).artworkTasks?.resumeAll();
  (app.locals as { tasks?: BackgroundTasks }).tasks?.resumeAll();
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

function requireMixConfig(path: string | undefined): string {
  if (!path) throw new Error('CASPERAKI_MIX_CONFIG is required for in-browser playback (path to casperaki_engine/config/mix-config.json)');
  return resolve(path);
}

/** The assistant's endpoint when both its URL and model are set; one without the other is a configuration error. */
function assistantEndpoint(config: BrainConfig): { baseUrl: string; model: string; apiKey?: string } | undefined {
  const { assistantLlmUrl: baseUrl, assistantLlmModel: model, assistantLlmKey: apiKey } = config;
  if (!baseUrl && !model) return undefined;
  if (!baseUrl || !model) throw new Error('ASSISTANT_LLM_URL and ASSISTANT_LLM_MODEL must be set together (brain.env).');
  return { baseUrl, model, ...(apiKey ? { apiKey } : {}) };
}

