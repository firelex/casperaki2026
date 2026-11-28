# Casting 5: the Casting Scenes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The video engine renders a casting video from the brain's casting timeline and soundtrack: backstage
(the narrator over the singer waiting), the stage door walk, the singer meeting one judge at the Casperaki desk, the
performance, applause and the verdicts — the realistic judges seated, mouths moving, gesturing; the anime singer.

**Architecture:** A new composition in `casperaki-video` (`CastingVideo`, landscape and portrait) beside the dance
floor, reusing its avatar loading (pack recipes and VRM files), equal heights, mouths (faceAt from line levels),
dance clips (Mixamo FBX: the casting clips in `~/casperaki-data/casting-clips`) and the stage scene. New: three sets
(green room, corridor and stage door, judges' desk in front of the stage), a shot planner that cuts to whoever speaks,
seated judges and the singer's actions per segment. The brain gets a `castingVideo` task rendering the latest
soundtrack's timeline with the song's levels and the avatars.

**Tech Stack:** casperaki-video (Remotion, three.js, three-vrm, zod 4, vitest), brain (TypeScript, vitest).

**Spec:** `docs/superpowers/specs/2026-11-28-video-modes-casting-design.md` ("Scenes to build", "Motion clips for
casting", "Levels and mouths", "The casting timeline"); plans 3 and 4 (the script and the timeline).

## Global Constraints

- Judges: the realistic VRMs (`~/casperaki-data/judges/vrm/<id>.vrm`, built by avatar-builder `tools/build_judges.py`),
  seated left to right Bob, Love, Ice (head judge, centre-right), Nicky **(my call)**, at a long desk with the Casperaki
  logo on its front panel, between the camera side and the stage, facing the singer (owner).
- The singer: the user's anime avatar (pack recipe), the song's singer; everyone at one height (equal heights).
- Sets drawn in code like the existing scenes, with CC0 Poly Haven furniture (`~/casperaki-data/casting-assets/
  polyhaven`, glTF 1k, staged like pack files) where it shows most: sofa, armchairs, coffee table, plants, mirror,
  lamps, judges' chairs; a studio HDRI for the realistic skin.
- Motion: seated judges loop `sitting-idle`, switch to `sitting-talking` while they speak, and play a gesture clip on
  their line's gesture (clap → sitting-clapping, thumbsUp-like (nod/point/handsUp) → sitting-thumbs-up, others: talking);
  the singer: `standing-idle-nervous` backstage, `walk` through the door, `standing-talking` while answering, the
  music video's lead routine during the performance, `bow` in the applause, `celebration` or `disappointed` at the
  verdict.
- Shots: the speaker in frame (a judge close-up, the singer medium), reaction shots every few lines, a wide of desk
  and stage at each segment start; during the performance the stage camera with judges' cutaways.
- No fallbacks: a missing clip, asset, avatar or timeline field fails the render naming it.

## Review Focus

1. Overlapping lines (a cut-in): both mouths move, the camera stays on the first speaker until the second's line is
   the only one.
2. A line by the singer during talk: the camera cuts to the singer, not a judge.
3. A portrait render frames one person at a time (no wide desk shots that lose the speaker).
4. The verdict "notThisTime": the singer's last clip is disappointed, never celebration.
5. A soundtrack made from a script whose avatar is gone → the casting video task refuses with 400.

---

### Task 1: The casting input and the shot plan (engine, pure)

**Files:** `src/schema/casting.ts`, `src/casting/shots.ts`; tests `test/casting-shots.test.ts`.
- `CastingVideoInputSchema`: title, artist, audio, timeline (the brain's CastingTimeline: segments, lines with levels
  and gestures, performance, applause), song (bpm, firstBeatSeconds, beatsPerBar, sections, lyrics, master/voice
  levels for the performance), singer (id, name, recipe), judges ({id: 'ice'|'nicky'|'love'|'bob', vrm}), outcome.
- `planCastingShots(input) → Shot[]` (segment, start, end, subject, framing) and `speakerAt(timeline, t)`.
- Tests: Review Focus 1-4 (as shots), each segment covered without gaps, cuts not faster than 1.2 s.

### Task 2: The sets

**Files:** `src/casting/sets/{greenRoom,corridor,judgesDesk}.tsx`, `src/casting/assets.ts` (staged glTF loading);
tests for the asset list and the desk's seat positions.

### Task 3: The people

**Files:** `src/casting/people.ts` (judges' and singer's poses per time: clips, mouths, gestures), the
`CastingVideo` composition and `renderCastingVideo` in `src/render.ts`; tests for clip choice per time.

### Task 4: The castingVideo task (brain)

**Files:** brain `tasks.ts` (kind `castingVideo`), `routes/casting.ts` (`POST …/casting/video`, `GET …/casting/video.mp4`),
input built from the latest soundtrack, the song's levels (as the music video's, measured by the browser — for
the first renders the soundtrack's own levels **(my call)**), the singer avatar and the judges' VRMs.

### Task 5: First render and the owner's review

- [ ] Render "Electric Daydream" (landscape, preview quality), watch it, fix what is broken, send it.
