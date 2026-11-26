# Console Music Video Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Console" music-video style: a 3D mixing desk driven by the song's real track levels, automation
and notes, with a rule-based camera, rendered by the brain to MP4 beside the existing cartoon style.

**Architecture:** The scene is a new Remotion composition in the video engine repo (`~/apps/casperaki-video`,
`firelex/casperaki-video`), drawn with three.js through `@remotion/three`. The browser measures each track's
levels with the existing WASM meter worker and sends them, with tracks, clips and notes, in the start request.
The brain checks the data belongs to the saved version (a version key in the playback payload), makes sure the
exported mix matches that version, and renders. No language model.

**Tech Stack:** TypeScript, React 19, Remotion 4.0.545, `@remotion/three` 4.0.545, three.js,
`@react-three/fiber`, zod, vitest, Express (brain).

**Spec:** `docs/superpowers/specs/2026-11-26-console-music-video-design.md` (read it first; this plan argues
from it).

## Global Constraints

- No fallbacks (owner's rule): missing or inconsistent data throws with a message naming what is wrong. No
  `?? default` for required values.
- `@remotion/three` and every `@remotion/*` package pinned to exactly `4.0.545`.
- The engine never reads a Casperaki song: the brain adapts it.
- Formats: `landscape` 1920×1080, `portrait` 1080×1920, `-preview` = half size (`scale: 0.5`), 30 fps.
- Existing cartoon routes, file names (`<format>.mp4`, `status-<format>.json`, `plan-<format>.json`) and
  behaviour stay unchanged, apart from the stale-audio fix in Task 6.
- Fader scale = the mixer's: `TOP_DB = 6`, `BOTTOM_DB = -60` (`apps/web/src/editor/sequencer/Mixer.tsx:15-16`).
  Level to dB = `20·log10(peak)`. Meter at a time = max of the current bin and the 3 before it (the mixer's
  `peakAt`, `Mixer.tsx:140-146`).
- Low-pass knob: logarithmic 20 Hz to 20 kHz.
- A strip's volume and automation follow the mixer's rule (`Mixer.tsx:351-357`): target volume = the parts'
  common `volumeDb`, or `null` when they differ (a drum kit) or none was resolved; a `null` strip's fader sits
  at 0 dB, as the mixer shows it (a defined case, not a fallback). Volume automation = the first part that has
  one; low-pass = the first part that has one.
- Strips = `mixerStrips()` (`apps/web/src/audio/vocalLanes.ts:18`). Lanes with no track row get role
  `effects` and the desk palette's effects colour; a track row with no colour is an error.
- Web goes live only through `deploy/datigator/deploy.sh`. Never run a vite build in `apps/web` by hand.
- Brain tests: run the targeted spec while working, and the full brain suite once before each commit.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A song saved again after the levels were measured:** the brain must refuse with a clear "the song
   changed, measure again" message and never render mismatched levels. Test in Task 7.
2. **A song with no automation and silent stretches (an intro with only drums):** faders and knobs stay still,
   silent strips stay dark, and no strip "enters" before it sounds. Tests in Tasks 3 and 4.
3. **A very short song (shorter than one section) or a single-section song:** the camera still produces
   contiguous shots on bar lines that end on the song's last frame. Test in Task 4.
4. **Many tracks (20+ strips):** the desk must stay readable, with name plates legible in the wide shot.
   Check in Task 5's demo render with a 24-strip demo.
5. **Starting a console video while a cartoon video of the same song is being made (and the reverse):** one
   job at a time per song, as now, with the 409 message. Test in Task 7.

---

## Repo 1: the video engine (`~/apps/casperaki-video`)

### Task 1: 3D in headless Chrome on datigator (time-boxed spike, then the setting)

**Files:**
- Modify: `package.json` (add `@remotion/three@4.0.545`, `three`, `@react-three/fiber`, `@types/three`)
- Create: `src/console/GlProbe.tsx` (a spinning lit cube, 2 s), registered in `src/Root.tsx` as `GlProbe`
- Create: `scripts/render-gl-probe.mjs`
- Modify: `src/render.ts` (export `const CONSOLE_GL` and use it in Task 5)
- Modify: `README.md` (a "3D rendering" section)

**Interfaces:**
- Produces: `export const CONSOLE_GL: 'angle' | 'egl' | 'swangle' | 'vulkan'` in `src/render.ts`.

- [ ] **Step 1:** Add the dependencies; `pnpm install`; `pnpm typecheck` passes.
- [ ] **Step 2:** Write `GlProbe` with `<ThreeCanvas>` from `@remotion/three` and the render script, which
  renders it with `chromiumOptions: { gl }` for a `gl` given on the command line and prints the seconds taken
  and Chrome's `WEBGL_debug_renderer_info` renderer string (logged from the component with
  `console.log`, captured via `onBrowserLog`).
- [ ] **Step 3:** On datigator, run it for `angle`, `egl`, `vulkan`, then `swangle`. A GPU mode passes when the
  renderer string names the NVIDIA card (or D3D12 over it) and the MP4 shows the cube. Time-box GPU attempts
  (including any WSL driver setup) to one hour.
- [ ] **Step 4:** Set `CONSOLE_GL` to the first passing GPU mode, else `swangle`. Write the README section: the
  mode chosen, the renderer string, seconds per rendered second, and (if `swangle`) that the scene must stay
  light (no soft shadows, at most 3 lights).
- [ ] **Step 5:** Commit `feat: three.js in the renderer, GL mode for datigator`.

### Task 2: The console input schema

**Files:**
- Create: `src/schema/console.ts`
- Modify: `src/schema/input.ts` (export the shared `seconds`, `SectionSchema` already exported)
- Modify: `src/lib.ts` (export the schema and types)
- Test: `test/console-schema.test.ts`

**Interfaces:**
- Produces (all zod, `.strict()`):
  - `AutomationSchema = { t0: seconds, step: positive, values: number[] (min 1) }`
  - `ConsoleNoteSchema = { startSeconds, lengthSeconds (positive), pitch: int 0..127 | null, velocity: int 0..127 | null }` (`null`: the song gives none, e.g. sung notes; drawn at a fixed mid brightness)
  - `ConsoleClipSchema = { section: string, startSeconds, endSeconds (> start), notes: ConsoleNote[] }`
  - `ConsoleTrackSchema = { name: string(min 1), role: 'track' | 'leadVocal' | 'effects', color: /^#[0-9a-f]{6}$/i (required for track and leadVocal, absent for effects), bus: string, volumeDb: number | null, levels: number[] (each 0..∞), volumeAutomation?: Automation, lowPassAutomation?: Automation, clips: ConsoleClip[] }`
  - `ConsoleInputSchema = { title, artist, audio: { path, durationSeconds }, bpm, firstBeatSeconds, beatsPerBar, sections: Section[], binSeconds: positive, tracks: ConsoleTrack[] (min 1), master: number[] }`
    with a `superRefine` that every track's `levels` and `master` have the same length, and that length ×
    `binSeconds` is within one bin of `audio.durationSeconds`; track names unique; at most one `leadVocal`.
  - Types `ConsoleInput`, `ConsoleTrack`, `ConsoleClip`, `ConsoleNote`, `Automation`.
  - `demoConsoleInput` in `src/demo.ts`: 24 strips over the demo song (Review Focus 4), one with volume
    automation (a fade-in), one with a low-pass sweep, one lead vocal, two effects strips.

- [ ] **Step 1: Write the failing tests** in `test/console-schema.test.ts`:
  - `accepts the demo console input` → `ConsoleInputSchema.parse(demoConsoleInput)` does not throw.
  - `rejects a track without a colour` (role `track`, `color` removed) → throws `/color/`.
  - `rejects an effects strip with a colour` → throws.
  - `rejects levels of a different length than the master` → throws `/levels/`.
  - `rejects levels that don't cover the song` (`binSeconds` 0.05, 10 bins, duration 30) → throws `/cover/`.
  - `rejects two lead vocals` and `rejects a duplicate track name`.
- [ ] **Step 2:** Run `pnpm vitest run test/console-schema.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3:** Implement the schema and the demo.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit `feat: console video input schema`.

### Task 3: What moves, and by how much

**Files:**
- Create: `src/console/values.ts`
- Test: `test/console-values.test.ts`

**Interfaces:**
- Consumes: `Automation`, `ConsoleTrack` (Task 2).
- Produces:
  - `levelAt(levels: readonly number[], binSeconds: number, t: number): number` (max of bin and 3 before).
  - `songPeak(input: ConsoleInput): number` (the loudest bin over all tracks; throws if 0).
  - `meterHeight(level: number, peak: number): number` → 0..1, on a dB scale from −60 dB below `peak` to `peak`.
  - `isPlaying(level: number, peak: number): boolean` → level within 40 dB of `peak`.
  - `automationAt(a: Automation | undefined, t: number): number | undefined` (port of
    `apps/web/src/audio/livePlayer.ts:110`, same interpolation).
  - `faderPosition(db: number): number` → 0..1 on `BOTTOM_DB = -60`..`TOP_DB = 6`, clamped.
  - `trackFaderDb(track: ConsoleTrack, t: number): number` → `(volumeDb ?? 0) + (automationAt(volumeAutomation, t) ?? 0)`,
    where `volumeDb === null` means the strip's parts differ and the fader sits at 0 dB (Global Constraints).
  - `knobAngle(hz: number): number` → radians, −0.75π at 20 Hz to +0.75π at 20 kHz, log scale, clamped.
  - `firstEntrySeconds(track: ConsoleTrack, binSeconds: number, peak: number): number | undefined`.

- [ ] **Step 1: Write the failing tests:**
  - `levelAt` at bin 5 returns the max of bins 2..5; at bin 1 the max of 0..1.
  - `faderPosition(6) === 1`, `faderPosition(-60) === 0`, `faderPosition(-27) === 0.5`, `faderPosition(20) === 1`.
  - `knobAngle(20) ≈ -0.75π`, `knobAngle(20000) ≈ 0.75π`, `knobAngle(632.5) ≈ 0`.
  - `trackFaderDb` without automation is constant over the song (Review Focus 2).
  - `firstEntrySeconds` of a track silent for its first 40 bins (`binSeconds` 0.05) is `2`; of an all-silent
    track is `undefined` (Review Focus 2).
  - `songPeak` of an all-silent input throws `/silent/`.
- [ ] **Step 2:** Run `pnpm vitest run test/console-values.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run it. Expected: PASS.
- [ ] **Step 5:** Commit `feat: console video value mapping`.

### Task 4: The camera rules

**Files:**
- Create: `src/console/camera.ts`
- Test: `test/console-camera.test.ts`

**Interfaces:**
- Consumes: `ConsoleInput` (Task 2), `firstEntrySeconds`, `songPeak` (Task 3).
- Produces:
  - `type CameraShot = { startSeconds: number; endSeconds: number; kind: 'opening' | 'wide' | 'drift' | 'swoop' | 'closing'; strip?: number /* index into tracks, for swoop */ }`
  - `planCamera(input: ConsoleInput): CameraShot[]`: contiguous, from 0 to `audio.durationSeconds`.
  - `cameraPose(shot: CameraShot, t: number, layout: DeskLayout, orientation: Orientation): { position: [number, number, number]; target: [number, number, number] }`
    (`DeskLayout` comes from Task 5; write the pose function there if easier, and keep `planCamera` pure here).

  Rules, in priority order: the first section is `opening`. The last section's last 2 bars are `closing`. A
  section whose name matches `/chorus|drop|hook/i` is `wide`. A track's first entry (or the lead vocal's first
  entry, always) inside a non-wide section gets a `swoop` of 2 bars starting on the bar line at or before the
  entry, at most one swoop per 4 bars (earliest wins, lead vocal first). Everything else is `drift`. Every
  boundary lies on a bar line (`firstBeatSeconds + k·beatsPerBar·60/bpm`) except the song's end.

- [ ] **Step 1: Write the failing tests:**
  - `covers the song without gaps` on the demo console input: first starts at 0, each starts where the
    previous ended, last ends at `durationSeconds`.
  - `cuts on bar lines`: every start except 0 is a bar line within 1 ms.
  - `chorus is wide`: a shot of kind `wide` covers the demo's Chorus.
  - `the lead vocal's entry gets a swoop` at the bar line before it, with `strip` = the lead vocal's index.
  - `a silent track gets no swoop`.
  - `a 6-second single-section song` gives `opening` then `closing` only, ending at 6 (Review Focus 3).
- [ ] **Step 2:** Run `pnpm vitest run test/console-camera.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement `planCamera`.
- [ ] **Step 4:** Run it. Expected: PASS.
- [ ] **Step 5:** Commit `feat: console video camera rules`.

### Task 5: The scene, the compositions and `renderConsoleVideo`

**Files:**
- Create: `src/console/layout.ts` (`DeskLayout`: strip positions for N strips, wrapping to a second row
  above 16 strips; screen position), `src/console/Desk.tsx`, `src/console/Strip.tsx`, `src/console/Screen.tsx`,
  `src/console/ConsoleVideo.tsx` (exports `ConsoleVideo`, `ConsoleVideoPortrait`, `ConsoleVideoPropsSchema`)
- Modify: `src/Root.tsx` (compositions `ConsoleVideo` and `ConsoleVideoPortrait`, duration from
  `audio.durationSeconds`, default props `demoConsoleInput`)
- Modify: `src/render.ts` (add `renderConsoleVideo`; share the staging/concurrency/quality code with
  `renderVideo` by extracting a private `renderComposition(...)`)
- Modify: `src/lib.ts`, `README.md` (the console style, its input, the GL note)
- Create: `scripts/render-console-demo.mjs`, `package.json` script `render:console-demo`
- Test: `test/render-options.test.ts` (extend)

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces: `renderConsoleVideo(request: ConsoleRenderRequest): Promise<void>` with
  `ConsoleRenderRequest = { input: ConsoleInput; outPath: string; orientation: Orientation; quality?: Quality; onProgress?: (p: number) => void; concurrency?: number }`,
  rendered with `chromiumOptions: { gl: CONSOLE_GL }`. Exported from `src/lib.ts` with `ConsoleInputSchema` and
  the types.

  The scene per the spec's "The desk / The screen / The master" and "Which strips": name plates in the track
  colour (the effects colour for effects strips) with the name in text legible in the wide shot; glow while
  `isPlaying`; meter = `meterHeight`; fader = `faderPosition(trackFaderDb)`; knob = `knobAngle` of the low-pass
  automation (a still knob at 20 kHz without one); screen scrolling right to left, playhead fixed at 30% from
  the left, 8 bars visible, notes flash for their length; the master strip at the right end. Everything is a
  pure function of the frame (`useCurrentFrame()`): no `Math.random`, no time-based state.

- [ ] **Step 1: Write the failing tests** in `test/render-options.test.ts`:
  - `renderConsoleVideo rejects a concurrency that is not a positive whole number` (as for `renderVideo`).
  - `renderConsoleVideo rejects an invalid input` (a track without a colour) → `/color/`.
  - `renderConsoleVideo rejects a relative audio path` → `/absolute path/`.
- [ ] **Step 2:** Run `pnpm vitest run test/render-options.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement the scene, compositions and renderer.
- [ ] **Step 4:** Run `pnpm test` and `pnpm typecheck`. Expected: all PASS.
- [ ] **Step 5:** Run `pnpm render:console-demo` (wide, then tall, 20 s, preview quality). Check by eye: strips
  light only while their track plays, the fade-in strip's fader rises, the low-pass knob turns, the camera cuts
  on bars, 24 name plates are readable in the wide shot (Review Focus 4). Note seconds per rendered second.
- [ ] **Step 6:** Commit `feat: console music video scene and renderer`, then `git push` (the brain installs
  the engine from GitHub).

## Repo 2: Casperaki (`~/apps/casperaki`)

### Task 6: Song version key, and exports that match it

**Files:**
- Create: `apps/brain/src/render/songVersion.ts`
- Modify: `apps/brain/src/routes/playback.ts:30-48` (payload gains `versionKey`)
- Modify: `apps/brain/src/render/renderService.ts:143-159` (the reuse check covers the song text too)
- Modify: `apps/brain/src/video/videoService.ts` (`exportedMix` passes the song's Pro mix; new dep `songMixOf`)
- Modify: `apps/brain/src/bootstrap.ts` (wire `songMixOf` with `applyMixOverrides(mixConfig(), project.mixOverrides)`,
  the same rule as `routes/songs.ts:310-317`)
- Modify: `apps/web/src/api/playback.ts` (`PlaybackPayload.versionKey: string`)
- Test: `apps/brain/test/song-version.spec.ts`, extend `apps/brain/test/video.spec.ts`

**Interfaces:**
- Produces: `songVersionKey(canonical: string, mixConfig: string): string` → first 16 hex of
  sha256(`canonical + '\u0000' + mixConfig`). The song text holds its vocal takes' fingerprints, so the key
  covers the takes. `PlaybackPayload.versionKey`. `VideoServiceDeps.songMixOf: (songId: string) => string | undefined`.
  `VideoService` gains `versionKey(songId: string): string` (from the store and `songMixOf`, same function as
  the payload, with the standard mix config when there is no Pro mix).

- [ ] **Step 1: Write the failing tests:**
  - `song-version.spec.ts`: same inputs → same key; a changed song text or mix config → a different key.
  - `playback payload carries the version key` (in the existing playback spec, or `song-version.spec.ts` via
    `playbackPayload`): equals `songVersionKey(canonical, payload.mixConfig)`.
  - `a re-saved song is exported again`: enqueue song A, finish, enqueue changed text with the same mix →
    a new queued render, not the old status.
  - `the video's export uses the song's Pro mix`: a fake `RenderService` records `enqueue` args; with a Pro mix
    set, `mixConfig` is the applied mix.
- [ ] **Step 2:** Run `pnpm -C apps/brain vitest run test/song-version.spec.ts test/video.spec.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. In `enqueue`, include `canonical` in the hashed key (store it as `mixHash`'s
  sibling `versionHash`, or fold it into `mixHash`; the stored status's field must change name if its meaning
  changes, so old statuses on disk read as "different" and re-render once).
- [ ] **Step 4:** Run the same command. Expected: PASS. Then the full brain suite: `pnpm -C apps/brain test`.
- [ ] **Step 5:** Commit `fix(brain): exports follow the saved song and its Pro mix; playback carries a version key`.

### Task 7: The console job and routes

**Files:**
- Modify: `apps/brain/package.json` (`@casperaki/video` at the commit pushed in Task 5), `pnpm install`
- Modify: `apps/brain/src/video/videoInput.ts` (extract `songTiming(song)` → `{ bpm, firstBeatSeconds, beatsPerBar, sections }`
  used by both `songToVideoInput` and new `songToConsoleInput`; the genre check stays only in `songToVideoInput`)
- Modify: `apps/brain/src/video/videoService.ts`, `apps/brain/src/routes/video.ts`, `apps/brain/src/bootstrap.ts`
  (inject `renderConsoleVideo`)
- Test: `apps/brain/test/video.spec.ts`

**Interfaces:**
- Consumes: `renderConsoleVideo`, `ConsoleInputSchema` (Task 5); `VideoService.versionKey` (Task 6).
- Produces:
  - `type VideoStyle = 'cartoon' | 'console'`; job id = `jobId(style, format)` = `format` for cartoon (unchanged
    names) and `console-${format}` for console; files `<jobId>.mp4`, `status-<jobId>.json`, and for console
    `console-input-<format>.json` (the input it rendered, like `plan-<format>.json`).
  - `ConsoleBody` (zod) = `{ versionKey: string, binSeconds: positive, tracks: ConsoleTrack[], master: number[] }`, i.e. `ConsoleInputSchema`'s fields minus the song fields the brain fills in (title, artist, audio, bpm,
    first beat, beats per bar, sections). Derive it from the engine schema with `.omit(...)`, don't copy it.
  - `POST /api/songs/:id/video` body adds `style?: VideoStyle` (default `cartoon`, the existing API) and
    `console?: ConsoleBody` (required when `style === 'console'`, refused otherwise). The planner check applies to
    cartoon only.
  - Console run: steps `audio` then `rendering` (no `planning`). Before rendering, compare
    `body.versionKey` with `VideoService.versionKey(songId)`; on mismatch the start fails at once with
    409 `song_changed`: "The song changed after its tracks were measured. Open the Music Video tab again to
    measure the saved version." Check again after the export finishes (the job fails with the same message).
  - `GET /api/songs/:id/video` → `{ jobs: { cartoon: {...per format}, console: {...per format} }, plannerConfigured }`.
  - `GET /api/songs/:id/video/console-<format>.mp4` beside the existing four; download name
    `"<title> (console video[, preview]).mp4"`.
- [ ] **Step 1: Write the failing tests** in `video.spec.ts` with a fake `renderConsoleVideo` recording its request:
  - `console: renders with the measured tracks and the song's timing, without the planner`
    (planner fake throws if called).
  - `console: refuses a stale version key with 409 song_changed` (Review Focus 1).
  - `console: fails the job if the song changes during the export` (Review Focus 1).
  - `console: works for a genre the cartoon style doesn't support`.
  - `console and cartoon jobs keep separate files and statuses`, and `a second job of either style while one
    runs gets 409 video_in_progress` (Review Focus 5).
  - `console: rejects a body without console data` → 400; `cartoon: rejects console data` → 400.
  - `GET video lists both styles`; `console mp4 route serves the file once done`.
- [ ] **Step 2:** Run `pnpm -C apps/brain vitest run test/video.spec.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run it, then `pnpm -C apps/brain test`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(brain): console music videos`.

### Task 8: The Music Video tab

**Files:**
- Modify: `apps/web/src/audio/livePlayer.ts` (`LaneMeters.versionKey`, from the prepared payload)
- Create: `apps/web/src/editor/consoleVideoData.ts`
- Modify: `apps/web/src/api/video.ts` (style, console body, the new jobs shape)
- Modify: `apps/web/src/editor/MusicVideoView.tsx`
- Test: `apps/web/test/console-video-data.test.ts`, extend `apps/web/test/api.test.ts`

**Interfaces:**
- Consumes: `mixerStrips`, `trackOfLane` (`audio/vocalLanes.ts`), `SequencerModel`, `buildSequencerModel`,
  `colorHex` (`editor/sequencer/layout.ts`), `livePlayer.meters`, the brain's `ConsoleBody` shape (Task 7).
- Produces:
  - `buildConsoleBody(args: { model: SequencerModel; meters: LaneMeters; secondsPerBar: number; leadVocal: string | undefined; hex: (css: string) => string }): ConsoleBody`
    Strips from `mixerStrips(model.tracks.map(t => t.name), meters.mix.lanes lanes)`; a strip's `levels` = the
    per-bin max over its lanes; its volume and automation by the mixer's rule (Global Constraints); `role` =
    `leadVocal` for `leadVocal`, `effects` for a strip with no track row, else `track`; colour via `hex` (throws
    if a track row's colour doesn't resolve); clips and notes converted from bars and beats to seconds with
    `secondsPerBar` (notes without a pitch keep `pitch: null`, without a velocity get `velocity: null`); `master` = `meters.busPeaks[3]`; `versionKey` = `meters.versionKey`. Throws if
    `meters.done` is false.
  - `videoApi.start(songId, { style, orientation, quality, artist, console? })`.
- [ ] **Step 1: Write the failing tests** in `console-video-data.test.ts` (a small hand-built model and meters):
  - a vocal track and its wet lane make one strip whose levels are the per-bin max of both.
  - a lane with no track row becomes an `effects` strip without a colour.
  - the lead vocal gets role `leadVocal`.
  - a clip at bar 4 for 2 bars at 120 BPM → `startSeconds 8`, `endSeconds 12`; a note at beat 17 → `8.5` s.
  - throws `/not finished/` when `meters.done` is false; throws when a track colour doesn't resolve.
  - and in `api.test.ts`: `start` posts `style: 'console'` with the console body.
- [ ] **Step 2:** Run `pnpm -C apps/web vitest run test/console-video-data.test.ts test/api.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement `buildConsoleBody` and the API change.
- [ ] **Step 4:** Run it. Expected: PASS.
- [ ] **Step 5:** Update `MusicVideoView`: a Cartoon/Console choice above the orientation choice. For Console:
  disabled with "Save the song first" while `editorDirty`; on start, run `livePlayer.meters(songId, …)`
  showing "Measuring the tracks (n%)" from `doneBins / binCount`, then build the body and start; the planner
  warning applies to Cartoon only; a `song_changed` error shows its message. Status, progress, preview and
  download per style, as now.
- [ ] **Step 6:** Run `pnpm -C apps/web test` and `pnpm -C apps/web typecheck` (or the repo's `tsc` script).
  Expected: PASS.
- [ ] **Step 7:** Commit `feat(web): console music videos in the Music Video tab`.

### Task 9: Ship and check end to end

- [ ] **Step 1:** Push the branch; on datigator run `deploy/datigator/deploy.sh` (it rebuilds web and restarts
  the brain).
- [ ] **Step 2:** In the live app, make a console preview (wide) of a saved song with a Pro-mix fade and a sung
  vocal. Pass: the MP4 plays the Pro mix with the vocals, the fade strip's fader moves at the fade, the camera
  swoops to the vocal strip when the singing starts.
- [ ] **Step 3:** Edit and save the song in another tab, then press Make video in the first: the
  "song changed" message appears.
- [ ] **Step 4:** Update the Agent Notes topic page for Casperaki music videos (organization space): the console
  style, the version key, the GL mode chosen. Update memory if anything non-obvious came up.
