# Casting, part 2: 3D only (remove the console and cartoon videos) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Only the 3D avatar video remains: the console and 2D cartoon videos are gone from the engine, the brain and
the website, with what the avatar video borrowed from them moved into shared code first, and their old video files
cleaned up.

**Architecture:** In casperaki-video, the pieces the avatar video uses from `src/console/` and `src/schema/input.ts`
move to `src/shared/` and `src/schema/song.ts` (no behaviour change, proven by the existing avatar tests), then the
cartoon (`MusicVideo`, `Lineup`, `components/`, `lib/`, plan/planner/catalog/look/input schemas) and the console
(`console/`, `schema/console.ts`) are deleted. The brain keeps only the avatars style; the browser's track measurement
shrinks to what the avatar video uses (master and per-track levels with each track's role), checked by the brain's own
schema. The Video tab shows only the avatar video (modes come in part 6).

**Tech Stack:** casperaki-video (Remotion, react-three-fiber, zod 4, vitest); brain (Express, zod 3, vitest); web
(React, vitest).

**Spec:** `docs/superpowers/specs/2026-11-28-video-modes-casting-design.md`, section "Removing the console and cartoon
videos" (and Goals: "Remove the console video and the 2D cartoon video everywhere").

## Global Constraints

- No behaviour change to the avatar video: its existing tests (`avatar-video`, `avatar-storyboard`, `dance-clips`)
  pass unchanged except for import paths.
- Old files deleted once at brain start, per song folder in BRAIN_VIDEOS_DIR, exactly: cartoon
  `^(landscape|portrait)(-preview)?\.mp4$`, `^status-(landscape|portrait)(-preview)?\.json$`, `^plan\.json$`; console
  `^console-` and `^status-console-`. Never `avatars-*` or `status-avatars-*`.
- Engine assets (`assets/`, all ours or CC0) stay: the green-room sofa and wood textures are for casting's backstage.
- The engine is a git dependency pinned by commit in `apps/brain/package.json` and `apps/web/package.json`; install
  with `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=url.https://github.com/.insteadOf GIT_CONFIG_VALUE_0=git@github.com: npx pnpm@9.15.9 install --no-frozen-lockfile`.
- Remove `VIDEO_PLANNER_URL`, `VIDEO_PLANNER_MODEL`, `VIDEO_PLANNER_KEY` from the brain's config and from
  `~/.config/casperaki/brain.env` (backup `brain.env.bak-<date>-3d-only`); never write a secret anywhere else.
- Commit only own files; push promptly; ship via deploy.sh with the running-tasks gate.

## Review Focus

1. A song folder holding both old cartoon files and avatar videos: only the old ones go — test in Task 3.
2. An old browser tab posting `style: 'cartoon'` or `'console'` after the deploy: 400 naming the only style, not a
   crash — test in Task 3.
3. A Video tab opened on a song whose last video was a cartoon: shows no stale video and no error — test in Task 4.
4. Measured levels whose tracks have no `leadVocal`: the avatar video still renders (the singer's mouth stays shut) as
   today — test in Task 3.
5. The engine package still type-checks and builds for the website (the dressing room imports
   `@casperaki/video/avatar`) — checked in Task 4 by the web's typecheck and tests.

---

### Task 1: Shared modules in the engine (no behaviour change)

**Files (casperaki-video):**
- Create: `src/shared/levels.ts` (`levelAt`, `coneOffset`, `songPeak` from `console/values.ts`), `src/shared/pulse.ts`
  (`pulseZoom` from `console/camera.ts`, typed on `Pick<AvatarVideoInput, 'sections' | 'bpm' | 'firstBeatSeconds' |
  'master' | 'binSeconds'>`), `src/shared/Overlay.tsx` + `src/shared/lyrics.ts` (`lyricAt`), `src/shared/fonts.ts`,
  `src/shared/RendererLog.tsx` + `src/shared/glLog.ts`, `src/shared/retry.ts`, `src/shared/GlProbe.tsx`,
  `src/schema/song.ts` (`SectionSchema`, `TimedLyricSchema`, `Section`, `TimedLyric`).
- Modify: every import of these in `src/avatar/`, `src/dancefloor/`, `src/schema/avatars.ts`, `src/render.ts`,
  `src/Root.tsx`; the old files re-export nothing (they are deleted in Task 2).
- Test: move the relevant cases of `test/console-values.test.ts`, `console-overlay.test.ts`, `console-retry.test.ts`
  into `test/shared-levels.test.ts`, `shared-overlay.test.ts`, `shared-retry.test.ts` (same assertions, new paths).

**Interfaces:**
- Produces: the modules above with the same exported names and signatures as today (only paths change), plus
  `schema/song.ts` exporting what `schema/input.ts` exported for sections and lyrics.

- [ ] **Step 1:** Write the three `shared-*` test files importing from `../src/shared/...` → run `npx vitest run
  test/shared-*.test.ts` → FAIL (modules missing).
- [ ] **Step 2:** Create the shared modules (moved code, comments kept) and repoint the avatar video's imports.
- [ ] **Step 3:** `npx tsc --noEmit -p . && npx vitest run` → all pass (the console tests still pass: the console code
  is untouched in this task).
- [ ] **Step 4:** Render check: `pnpm build && GALLIUM_DRIVER=d3d12 LD_LIBRARY_PATH=/usr/lib/wsl/lib node
  scripts/render-avatar-demo.mjs ~/casperaki-data/avatar-packs/character-assets --club` → writes the MP4.
- [ ] **Step 5: Commit** `refactor: the avatar video's shared pieces (levels, beat zoom, lyric overlay, renderer log, retry, song schema) out of the console and cartoon code`.

### Task 2: Delete the cartoon and the console from the engine

**Files (casperaki-video):**
- Delete: `src/MusicVideo.tsx`, `src/Lineup.tsx`, `src/components/`, `src/lib/`, `src/console/`,
  `src/schema/{input,plan,planner,catalog,look,console}.ts`, `scripts/{render-demo,render-console-demo,preview,make-demo-audio}.*`
  (keep `make-demo-audio.sh` if the avatar demo needs its audio: check `scripts/render-avatar-demo.mjs`), the cartoon
  and console tests (`console-*.test.ts`, `rig.test.ts`, `schema.test.ts`), and their fixtures.
- Modify: `src/render.ts` (only `renderAvatarVideo`, `avatarPackFiles`, `loadDanceClips`, `CLIP_CONVERSION_VERSION`,
  `CONSOLE_GL` renamed `AVATAR_GL`, the GPU check), `src/Root.tsx` (AvatarStill, GlProbe, AvatarVideo,
  AvatarVideoPortrait), `src/lib.ts` (exports: the render functions above, `AvatarVideoInputSchema` and friends,
  `AVATAR_SCENES`, `AVATAR_CAMERAS`, storyboard schemas, `SectionSchema`, `TimedLyricSchema`, `LAYOUTS`,
  `demoAvatarInput`), `src/demo.ts` (avatar demo only), `test/render-options.test.ts` (avatar render only),
  `README.md`, `package.json` description and scripts.

**Interfaces:**
- Produces: `@casperaki/video` without `renderVideo`, `renderConsoleVideo`, `VideoInputSchema`, `ScenePlanSchema`,
  `plannerPrompt`, `catalog`, `ConsoleInputSchema` and the other console schemas; `AVATAR_GL` in place of `CONSOLE_GL`.

- [ ] **Step 1:** Rewrite `test/render-options.test.ts` for the avatar render only, with a case asserting `lib.ts`
  exports neither `renderVideo` nor `renderConsoleVideo` → run → FAIL (they are still exported).
- [ ] **Step 2:** Delete and trim as listed.
- [ ] **Step 3:** `npx tsc --noEmit -p . && npx vitest run` → PASS; `grep -rn "console/\|schema/input\|components/" src`
  → nothing.
- [ ] **Step 4:** Render check as Task 1 Step 4.
- [ ] **Step 5: Commit and push** `feat!: only the 3D avatar video (the console and the 2D cartoon removed)`.

### Task 3: The brain makes only avatar videos

**Files (brain):**
- Delete: `src/video/planner.ts`, the cartoon and console parts of `src/video/videoInput.ts` (`songToVideoInput`,
  `songToConsoleInput`, the engine console schema use).
- Create: `src/video/oldVideos.ts`: `removeOldVideos(videosDir: string): { removed: number }` (the exact patterns in
  Global Constraints), called once by bootstrap at start (logged `[brain] removed N old cartoon/console video files`).
- Modify: `src/video/videoInput.ts` — `MeasuredLevelsSchema` (zod 3, the brain's own): `{ versionKey: 16 hex,
  binSeconds: positive, master: number[], tracks: [{ name: string, role: string, levels: number[] }] }` (every track
  as long as the master: 400 naming the track); `parseMeasuredLevels(raw): MeasuredLevels`; `songToAvatarInput` takes
  `levels: Omit<MeasuredLevels, 'versionKey'>`; `lyricLines`/`songTiming` typed with `AvatarVideoInput`.
  `src/video/videoService.ts` — `VideoStyle = 'avatars'` only, `StartArgs` `{ levels, avatarIds, storyboard? }`, no
  planner or cartoon/console renderers. `src/routes/video.ts` — body `{ orientation, quality?, artist, levels,
  avatars: { avatarIds, storyboard? } }` (`style`, when sent, must be `'avatars'`: 400 "Only the 3D avatar video is
  made now." otherwise); jobs listed for avatars only. `src/config.ts` and `src/bootstrap.ts` — the planner settings
  and wiring removed.
- Test: `test/video.spec.ts` and `test/video-avatars.spec.ts` rewritten for the avatars-only API; new
  `test/old-videos.spec.ts`.

**Interfaces:**
- Consumes: Task 2's `@casperaki/video` (pinned to Task 2's commit).
- Produces: `POST /api/songs/:id/video` body above; `GET /api/songs/:id/video` → `{ jobs: { avatars: { <format>:
  status } } }`; `MeasuredLevels` type for the web.

- [ ] **Step 1: Write the failing tests:** `old-videos.spec.ts` — a song folder with `landscape.mp4`,
  `status-landscape.json`, `plan.json`, `console-portrait.mp4`, `status-console-portrait.json`,
  `avatars-landscape.mp4`, `status-avatars-landscape.json` → after `removeOldVideos` only the two avatars files remain,
  `removed: 5`; a second call removes 0. `video.spec.ts` — `style: 'cartoon'` and `'console'` → 400 "Only the 3D avatar
  video is made now."; a body with `console` instead of `levels` → 400; levels with an uneven track → 400 naming it;
  `songToAvatarInput` with no `leadVocal` track → `voice` all zeros (as today).
- [ ] **Step 2:** Bump the engine pin to Task 2's commit, install, run → FAIL.
- [ ] **Step 3:** Implement as listed.
- [ ] **Step 4:** `npx tsc --noEmit -p . && npx vitest run` → all pass except the known unrelated
  `melodyLibrary.spec.ts` count (another session's data).
- [ ] **Step 5: Commit** `feat(video)!: only the 3D avatar video; measured levels instead of the console's tracks; old cartoon and console files removed`.

### Task 4: The website shows only the avatar video

**Files (web):**
- Rename: `src/editor/consoleVideoData.ts` → `src/editor/trackLevels.ts`, producing `MeasuredLevels` (master, and per
  track name, role and levels) instead of the console's tracks (clips, notes, sends dropped).
- Modify: `src/api/video.ts` (`VideoStyle` gone; start sends `levels` and `avatars`; status `jobs.avatars`),
  `src/editor/MusicVideoView.tsx` (no Cartoon/Console choice; the avatar picker, storyboard, format and quality as
  today), any other user of the removed names.
- Test: `test/` files for the video view and the measurement (rename/adjust), plus a case: a status whose jobs hold
  only `avatars` and none for the format shown renders the "make a video" state without error.

- [ ] **Step 1:** Adjust the tests to the new names and API → FAIL.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** `npx tsc --noEmit -p . && npx vitest run` → all pass; trial production build to a scratch outDir:
  `npx vite build --outDir /tmp/claude-1000/.../scratchpad/web-trial` → succeeds (never into the shared tree).
- [ ] **Step 4: Commit** `feat(web)!: the Video tab makes only the 3D avatar video`.

### Task 5: Live

- [ ] **Step 1:** Remove the three `VIDEO_PLANNER_*` lines from `~/.config/casperaki/brain.env` after backing it up.
- [ ] **Step 2:** Deploy with the running-tasks gate; the brain log shows the old-files line once.
- [ ] **Step 3:** Through the live site (demo login, headless browser): open Electric Daydream's Video tab, make a
  quick-preview avatar video with the three test avatars, check it renders (frames) and that the song's folder holds
  no cartoon/console files.
- [ ] **Step 4:** Update memory (`avatars-feature.md`, `console-music-video.md` marked removed) and tell the owner.
