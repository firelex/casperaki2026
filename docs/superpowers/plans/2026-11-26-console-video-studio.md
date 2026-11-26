# Console Video Part 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (the owner chose inline execution).

**Goal:** Lyrics, a pulsing logo, a fuller desk, a monitor, a studio room with moving speakers, and orbit/pulse
camera moves for the console music video.

**Architecture:** Almost all in the engine repo (`~/apps/casperaki-video`): new optional-free input fields
(`lyrics`, per-track `sends`), new scene components, CC0 assets bundled in `assets/` and staged into the render's
public folder. The brain adds the lyric lines; the web sends each strip's sends.

**Tech Stack:** as part 1 (Remotion 4.0.545, `@remotion/three`, three.js, zod, vitest).

**Spec:** `docs/superpowers/specs/2026-11-26-console-video-studio-design.md`

## Global Constraints

- No fallbacks; empty lyrics is a defined case. Pure function of the frame.
- CC0 assets only (Poly Haven), 1k, committed under `casperaki-video/assets/` with a `CREDITS.md` listing source
  URLs and the CC0 licence.
- After each engine task: `pnpm test`, `pnpm typecheck`, GPU demo render with stills to the owner.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A song with no lyrics, or an instrumental gap of minutes: no empty band, no stale line.
2. A very long lyric line: wraps or shrinks, never runs off screen (both formats).
3. A song with no bridge and one chorus at the very end: the orbit still fits or is skipped cleanly.
4. A song with no drums/bass strips: woofers follow the master instead (a defined rule, stated in code).
5. Render time on a 3–4 minute song stays within ~2× the part-1 time.

---

### Task 1: Lyrics and logo (engine + brain)

- Engine: `ConsoleInputObjectSchema.lyrics: TimedLyric[]` (reuse `TimedLyricSchema`), `src/console/LyricBand.tsx`
  (current + next line, fades, auto-shrink to fit), `src/console/Logo.tsx` (`assets/casperaki-logo.svg`, pulse =
  f(master level)); `logoPulse(level, peak): number` and `lyricAt(lyrics, t): { current?, next?, fade }` in
  `src/console/overlay.ts`. Assets staged by `renderComposition`.
- Tests (`test/console-overlay.test.ts`): lyricAt picks the sung line and the next; nothing in a gap longer than 4 s
  after a line; fades 0→1 over 0.25 s; logoPulse 0 at silence, 1 at the song peak; schema rejects a lyric line that
  ends before it starts.
- Brain: `songToConsoleInput` adds `lyrics: lyricLines(song)`; test in `video.spec.ts` (console input carries the
  song's lyric lines).

### Task 2: Fuller desk and monitor (engine + web)

- Engine: per-track `sends: { reverb: number | null; delay: number | null; chorus: number | null }` (dB);
  `sendKnobAngle(db | null)` (null or ≤ −100 = off, fully left) in `values.ts`; `Strip.tsx` gains send/pan/EQ knobs,
  mute/solo buttons; `Desk.tsx` chassis (armrest, wooden cheeks, meter bridge); `Monitor.tsx` bezel + stand around
  `Screen`.
- Web: `buildConsoleBody` sends each strip's sends (the mixer's rule: the first part's, Pro override wins).
- Brain: Pro-mode send overrides from `project.mixOverrides.lanes[strip]` replace the measured sends (as `trimDb`).
- Tests: sendKnobAngle (off, 0 dB, −20 dB); schema requires sends; web: a strip's sends are its first part's;
  brain: a Pro send override replaces the measured send.

### Task 3: Studio room and speakers (engine)

- `src/console/Room.tsx` (floor with wood texture, panelled walls, ceiling lights, live-room window),
  `src/console/Speaker.tsx` (cabinet, woofer and tweeter cones; `cone(level)` pushes out), HDRI environment
  (`assets/studio.hdr`) via three's `RGBELoader` with `delayRender`.
- `lowEndLevel(input, t)` in `values.ts`: max level of strips whose bus is drums or bass; if none, the master
  (Review Focus 4). Tests for both cases.

### Task 4: Orbit and pulse zoom (engine)

- `planCamera`: shot kind `orbit` (8 bars from the bridge's first bar line, else the last chorus's; skipped if the
  section is under 8 bars, then as long as the section).
- `pulseZoom(input, t): number` (0..1, beat envelope × loudness) applied as an FOV punch in wide/chorus shots.
- Tests: an orbit lands in the bridge; a song without a bridge orbits in its last chorus; no orbit when no section
  is long enough; pulse is 0 in verses, peaks on beats in a chorus.

### Task 5: Ship

- Push the engine, re-pin the brain (pnpm 9.15.9 + https rewrite), run brain/web tests, merge to `feat/full-flow`,
  deploy, render a real song through the live tab, show the owner.
