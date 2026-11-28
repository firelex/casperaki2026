# Casting 4: Voices, Timeline and Soundtrack — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From a written casting script, the brain makes the casting video's soundtrack and timeline: every line
spoken in its character's voice, laid out with the music and the song's performance into one mixed audio file, and a
timeline (segments, lines with times, mouth levels and gestures) the engine will render in plan 5.

**Architecture:** A task kind `castingSoundtrack` (admins, on a song) takes the latest finished casting script, has
the speech service speak every line (its `lines` stage: the voice description and seed of the narrator, a judge, or
the singer's speaking voice), then lays out the segments in time and mixes the audio with ffmpeg. Its result is the
timeline; the mix is a task file. The owner can listen to the soundtrack before any scene exists.

**Tech Stack:** brain (TypeScript, zod 3, vitest, ffmpeg), the speech service (Breeze TTS 2, `lines` stage, already
finishing every line: 1.1× faster, compressed, -16 LUFS).

**Spec:** `docs/superpowers/specs/2026-11-28-video-modes-casting-design.md` ("Owner's answers" 4, "Speech processing",
"Length", "The casting timeline", "Levels and mouths", "The narrator").

## Global Constraints

- Voices: the judges' approved descriptions and seeds (`casting/cast.ts`); the narrator's chosen by the owner from the
  takes in `~/casperaki-data/casting/narrator/` (filled in at Task 1); the singer's own speaking voice (its saved
  description and seed); a singer without one → 400 `no_speaking_voice` "Make Kesha's speaking voice on the Singers
  page first."
- Music (outside git, `BRAIN_CASTING_MUSIC_DIR`, required for the task): "Poised and Ready.mp3" under the backstage
  narration (87.6 s, cut to the segment, ducked under speech, faded out), "The Grand Entrance.mp3" for the stage door
  (14.544 s, whole); no other stings.
- Performance: the song's exported mix from its start to the end of the first section named chorus (`isChorus`),
  then a 3 s fade starting at the chorus's end.
- Segments in order: backstage, door, talk (banter), performance, verdicts; one mixed audio file at 48 kHz.
- Line gaps: 0.35 s between lines of one segment (natural turn-taking); 1 s of air at the start and end of talk and
  verdicts.
- Mouth levels: each line's loudness envelope in bins of the song input's bin length (as the voice levels now).
- No fallbacks: a missing voice, music file, export or line fails the task naming it.

## Review Focus

1. A script line by the singer when the singer has no speaking voice → 400 at start, not a failure mid-way.
2. A song whose first chorus ends after the exported audio (export shorter than the arrangement) → the task fails
   naming both lengths.
3. Lines must not overlap: every line's start ≥ the previous line's end + the gap, within its segment.
4. A script changed (a newer finished script) after the soundtrack started → the soundtrack records which script
   (task id) it was made from.
5. The music folder missing a file → the task fails naming the file.

---

### Task 1: The narrator's voice and how delivery notes are used

**Files:** Modify `apps/brain/src/casting/cast.ts` (NARRATOR voice); Test `apps/brain/test/casting-writer.spec.ts`.

- [ ] **Step 1:** Owner picks a take (a, b or c with seed 7 or 21) → `NARRATOR_VOICE = { description, seed }`; test
  pins it.
- [ ] **Step 2: Shortcut test (no code):** speak two judge lines with the bare voice description and with the line's
  delivery note added ("<description>, <delivery>"); score both against the bare voice with the speech service's
  speaker matcher. Keep delivery notes in the instruction only if the voice stays the same person (similarity within
  0.05 of the bare take); else the instruction is the description alone. Record the result in the ledger.
- [ ] **Step 3: Commit** `feat(casting): the narrator's voice`.

### Task 2: Speaking the lines

**Files:** Create `apps/brain/src/casting/voices.ts`; Test `apps/brain/test/casting-soundtrack.spec.ts` (a fake speech
service, `test/fakeSpeechService.ts` extended with the `lines` stage).

**Interfaces:**
- `lineVoices(script, singerVoice: { description; seed }): LineRequest[]` — `{ id: "<scene>-<n>", text, instruction,
  seed }` per line, in script order.
- `speakLines(client, requests, filesDir, signal, onSteps) → Map<id, { file; seconds }>` (the `lines` stage; each line's
  WAV kept in the task folder under `voices/`).

- [ ] Failing tests: every line gets its speaker's voice (Ice seed 7…, the singer's saved seed); ids are unique and in
  order; a failed speech job fails with its message. → implement → pass → commit
  `feat(casting): every line spoken in its character's voice`.

### Task 3: The timeline

**Files:** Create `apps/brain/src/casting/timeline.ts`; Test `apps/brain/test/casting-soundtrack.spec.ts`.

**Interfaces:**
- `CastingTimeline = { binSeconds; durationSeconds; segments: { kind: 'backstage'|'door'|'talk'|'performance'|'verdicts';
  startSeconds; endSeconds }[]; lines: { speaker; text; gesture; startSeconds; endSeconds; levels: number[] }[];
  performance: { songFromSeconds: 0; songToSeconds; fadeSeconds: 3; videoStartSeconds }; scriptTaskId }`.
- `layOut(script, spoken: Map<id, {seconds}>, song timing, exportSeconds, binSeconds) → CastingTimeline` (pure).
- `lineLevels(wav: Float32Array, sampleRate, binSeconds) → number[]` (RMS per bin, like the vocal levels).

- [ ] Failing tests: Review Focus 2 and 3; segment order and the door's 14.544 s; the performance ends at the first
  chorus's end + 3 s; backstage lasts its lines plus 1.5 s of music before the first; total about 3 minutes for the live
  script's lengths. → implement → pass → commit `feat(casting): the timeline`.

### Task 4: The mix and the castingSoundtrack task

**Files:** Create `apps/brain/src/casting/mix.ts`; Modify `store.ts` (kind), `tasks/tasks.ts`, `routes/casting.ts`,
`config.ts` (`BRAIN_CASTING_MUSIC_DIR`), `bootstrap.ts`, web `api/tasks.ts` labels.

**Interfaces:**
- `mixSoundtrack(timeline, files: { lines: Map<id, path>; song: path; poised: path; entrance: path }, out: path, ffmpeg)`
  — one ffmpeg filter graph: lines placed with `adelay`, the backstage music ducked by 12 dB under the narration
  (sidechain compression) and faded out at the door, the entrance whole, the performance cut and faded, 48 kHz WAV.
- `POST /api/songs/:id/casting/soundtrack` → 202 `{ task }` (the latest finished script; 400 none, no speaking voice,
  music missing); `GET /api/songs/:id/casting/soundtrack.wav` → the latest mix; `GET …/casting/timeline` → its
  timeline.

- [ ] Failing tests: Review Focus 1, 4, 5; a run with the fake speech service and real ffmpeg on short tones makes a
  WAV of the timeline's length. → implement → pass; brain suite once → commit.
- [ ] **Live:** deploy; make the soundtrack for the demo song's live script; listen to the joins (music under the
  narrator, the door, the song's cut and fade); send the owner the WAV.
