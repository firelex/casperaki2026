# Hum Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On /hum, the chosen version's melody is editable in a piano roll, its 16 half-bar chords can be changed, a read-only score follows every edit, and the song is built from the edited version.

**Architecture:** The brain keeps the analysis as now; edits live in the page and are sent with the requests that need them (song, complete) plus two new calls (re-fit chords, chord options for a half bar) built on the existing fitter in `packages/arrangement/src/hum/`. On the web, a pure edit model (`apps/web/src/hum/melodyEdit.ts`) holds the rules; a new editable piano roll and chord row draw it; the existing `Score` component engraves it.

**Tech Stack:** TypeScript, Express + zod (brain), React + Tailwind (web), vitest, abcjs via `Score.tsx`.

**Spec:** `docs/superpowers/specs/2026-11-24-hum-editor-design.md`

## Global Constraints

- The editor's own piano roll (`apps/web/src/editor/sequencer/ClipDetail.tsx` PianoRoll) stays view-only; do not change it. The editable roll is a new hum-only component.
- The score is read-only.
- Chords never re-fit on their own; completion never rewrites a hummed bar or a bar whose melody the user edited.
- 8 bars × 4 beats = 32 beats; 16 half-bar chords; 16th-note grid (0.25 beat).
- No fallbacks or silent defaults: bad requests return 400 with a message naming what is wrong; failures show on the page.
- Commit only your own files (`git commit -- <paths>`), message ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Targeted tests while working; full brain, arrangement and web suites once before the final commit.
- Deploy with `./deploy.sh` (refuses with uncommitted files under apps/ or packages/); restart the brain only when no video is rendering.

## Review Focus

1. A note dragged or resized past the end of bar 8 or before beat 0: it stays inside 0..32 beats (test in Task 3).
2. Moving a note onto another note: the move is refused and the note stays where it was (test in Task 3).
3. The user deletes every note: "Complete a different way" is disabled, and the song request is refused by the brain with a clear message rather than building an empty chorus (tests in Tasks 2 and 3).
4. Chord edits alone do not mark a bar as the user's: completion may still rewrite that bar's melody over the new chord (test in Task 3).
5. Right click on a note must not open the browser menu, and a press that moves more than 4 px before 350 ms is a move, not a resize (checked in the browser in Task 4).

---

### Task 1: Fitter helpers for re-fit and chord options

**Files:**
- Modify: `apps/brain/src/hum/fit.ts`
- Test: `apps/brain/test/hum-fit.spec.ts` (create)

**Interfaces:**
- Consumes: `harmonize`, `slotWeights`, `fitScore`, `chordFromId`, `chordSymbol`, `parseChordSymbol`, `loadChordFitModel` from `@casperaki/arrangement` hum exports; existing `majorTonicOf`, `PHRASE_BARS`.
- Produces:
  - `refitChords(melody: readonly BeatNote[], key: Transcription['key']): { slots: string[]; chords: string[] }` — the recommendation (`harmonize(...).alternatives[0]`) for the full 8-bar melody (melodyBars = 8).
  - `chordOptions(melody: readonly BeatNote[], slot: number, key: Transcription['key']): { chord: string; fit: number }[]` — every chord in the model's `prior.vocab`, as a symbol in the song's key, sorted by `fitScore` of that slot's weights, best first (ties: vocab order).
  - `slotsOfChords(chords: readonly string[], key: Transcription['key']): string[]` — symbols to chord ids (`parseChordSymbol` then `chordId`), throws on an unknown symbol.

- [ ] **Step 1: Write failing tests**: `refitChords` on a melody of only C-E-G whole notes in C major returns 16 chords and slot 0 is `C`; `chordOptions(..., 0, ...)` has length equal to `loadChordFitModel().prior.vocab.length` and its first entry contains the pitch classes of the notes in slot 0; `slotsOfChords(['C','Am'], C major)` gives `['0:maj','9:min']`; `slotsOfChords(['Cxyz'])` throws; `chordOptions` with slot 16 throws.
- [ ] **Step 2: Run** `pnpm -C apps/brain vitest run test/hum-fit.spec.ts` — expect FAIL (not exported).
- [ ] **Step 3: Implement** the three functions in `fit.ts`.
- [ ] **Step 4: Run** the same command — expect PASS.
- [ ] **Step 5: Commit** `feat(hum): re-fit chords and ranked chord options for an edited melody`.

### Task 2: Brain routes take edits

**Files:**
- Modify: `apps/brain/src/routes/hum.ts`
- Test: `apps/brain/test/hum.spec.ts`

**Interfaces:**
- Consumes: Task 1 functions; `UserChorusSchema` from arrangement.
- Produces (bodies are zod `.strict()`):
  - `POST /api/hum/song { analysisId, alternative, genre, title?, melody?, chords? }` — `melody` and `chords` must come together; when given they are used instead of the stored alternative's, validated with `UserChorusSchema` (400 `bad_edit` with the zod message otherwise). An empty melody → 400 `empty_melody`, "The melody has no notes."
  - `POST /api/hum/complete { analysisId, alternative, melody?, chords?, keepBars? }` — with an edit, all three are required; `keepBars` are 0-based bar numbers; the AMT request uses this melody as prompt, `slotsOfChords(chords)` for the voicing, and `keepBars`. 400 `nothing_to_complete` when `keepBars` covers all 8 bars; 400 `empty_melody` when no prompt note falls in `keepBars`. Response: the analysis with that alternative's `melody` replaced (chords as sent).
  - `POST /api/hum/refit { analysisId, melody }` → `{ chords: string[16] }`.
  - `POST /api/hum/chord-options { analysisId, melody, slot }` → `{ options: { chord, fit }[] }`.

- [ ] **Step 1: Write failing tests** in `hum.spec.ts` (follow its existing fake-service setup): song with edited melody/chords puts exactly those into `params.userChorus`; song with only `melody` → 400; song with empty melody → 400 `empty_melody`; complete with `keepBars` [0,1,5] sends `keepBars: [0,1,5]` and the sent chords' voicing to the fake AMT; complete with all 8 bars kept → 400; refit returns 16 chords; chord-options slot 3 returns options sorted by fit descending.
- [ ] **Step 2: Run** `pnpm -C apps/brain vitest run test/hum.spec.ts` — expect the new tests to FAIL.
- [ ] **Step 3: Implement** the route changes and the two new routes.
- [ ] **Step 4: Run** the same command — expect PASS.
- [ ] **Step 5: Commit** `feat(hum): song and completion take the edited melody and chords; re-fit and chord-options calls`.

### Task 3: Melody edit model (pure)

**Files:**
- Create: `apps/web/src/hum/melodyEdit.ts`
- Test: `apps/web/src/hum/melodyEdit.test.ts`

**Interfaces:**
- Consumes: `BeatNote` from `apps/web/src/api/hum.ts`.
- Produces:
  - `const TOTAL_BEATS = 32; const GRID = 0.25;`
  - `interface VersionEdit { melody: BeatNote[]; chords: string[]; editedBars: Set<number>; history: { melody: BeatNote[]; chords: string[]; editedBars: Set<number> }[] }`
  - `startEdit(melody, chords): VersionEdit`
  - `addNote(e, beat, midi, length): VersionEdit` — snaps beat down to GRID; refuses (returns `e` unchanged) when the spot is inside a note; length is cut at the next note's start and at TOTAL_BEATS.
  - `deleteNote(e, index): VersionEdit`
  - `moveNote(e, index, beat, midi): VersionEdit` — snaps; clamps so the note stays in 0..TOTAL_BEATS; refused if it would overlap another note.
  - `resizeNote(e, index, length): VersionEdit` — snaps to GRID, minimum GRID, capped at the next note's start and TOTAL_BEATS.
  - `setChord(e, slot, chord): VersionEdit` — does not touch `editedBars`.
  - `setChords(e, chords): VersionEdit` (for re-fit), `undo(e): VersionEdit`, `keptBars(e, hummedBars): number[]` (hummed bars ∪ editedBars, sorted).
  - Every melody change adds the bars the old and the new note touch to `editedBars`; every change pushes the previous state on `history`; melody stays sorted by beat.

- [ ] **Step 1: Write failing tests**: add at beat 1.1 snaps to 1.0; add inside a note is refused; add before a note at 3 with length 4 is cut to end at 3; move past the end clamps (start + duration ≤ 32); move onto another note is refused; resize to 0.1 becomes 0.25 and resize past the next note is capped; moving a note from bar 2 to bar 5 marks bars 1 and 4 (0-based) edited; `setChord` leaves `editedBars` empty; `keptBars` with hummedBars 2 and an edit in bar 5 is `[0,1,5]`; `undo` after add restores the melody; deleting all notes gives an empty melody.
- [ ] **Step 2: Run** `pnpm -C apps/web vitest run src/hum/melodyEdit.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** `melodyEdit.ts`.
- [ ] **Step 4: Run** the same command — expect PASS.
- [ ] **Step 5: Commit** `feat(hum): melody edit model`.

### Task 4: Editor on the hum page

**Files:**
- Create: `apps/web/src/hum/HumPianoRoll.tsx`, `apps/web/src/hum/HumChordRow.tsx`
- Modify: `apps/web/src/pages/HumSongPage.tsx` (replace the view-only `PianoRoll` at the bottom of the file; per-version edits; Re-fit chords, Undo, Back to the original; score), `apps/web/src/api/hum.ts` (new calls and optional edit fields)

**Interfaces:**
- Consumes: Task 2 endpoints; Task 3 model; `Score` from `apps/web/src/editor/sequencer/Score.tsx` (`notes` as `{ pitch: midi, start: beat, length: duration }`, `beats: 32`, `songKey`, `bpm`, `beat` = playback position or undefined).
- Produces:
  - `humApi.refit(id, melody): Promise<string[]>`, `humApi.chordOptions(id, melody, slot): Promise<{ chord: string; fit: number }[]>`, `humApi.complete(id, alternative, edit?: { melody, chords, keepBars })`, `humApi.song(id, alternative, genre, edit?: { melody, chords })`.
  - `HumPianoRoll({ melody, hummedBars, editedBars, onAdd, onDelete, onMove, onResize, playBeat })`: looks like the editor's detail-window roll (key column with note names, dark rows for black keys, bar and beat lines, hummed bars on a lighter ground, user-edited bars marked, completed notes in the second colour). Mouse: left click on empty → add; right click on a note → delete (`preventDefault` on `contextmenu`); press + drag → move; press held 350 ms without moving more than 4 px, then drag → resize. Touch: tap a note to select it and show a delete button; long press + drag resizes. A short tone (the page's existing `tone` helper) when a note is added, changes pitch or is resized. Pitch range: the melody's range plus 4 semitones each side, at least 18 rows, growing when a drag reaches an edge.
  - `HumChordRow({ chords, onPick, loadOptions })`: 16 half-bar cells above the roll (repeated chords shown once, as now); clicking a cell opens a list from `loadOptions(slot)` (best first) using `@teamsuzie/ui` `DropdownMenu`.
- Page behaviour: edits are kept per version in page state for the session; "Complete a different way" sends `{ melody, chords, keepBars: keptBars(edit, hummedBars) }` and is disabled when `keptBars` has 8 bars or the melody is empty; Make the song sends the edited melody and chords; Play plays the edited version; Ctrl+Z undoes.

- [ ] **Step 1: Implement** the API additions, the two components and the page changes.
- [ ] **Step 2: Typecheck** `pnpm -C apps/web exec tsc --noEmit` — expect no errors.
- [ ] **Step 3: Check in the browser** (Playwright against the running dev or live site at `/hum?upload=1`, uploading a HumTrans clip as in the hum-to-song e2e run): add, delete (right click, no context menu), move, long-press resize, change a chord from the list, Re-fit chords, Undo, Complete a different way keeps hummed and edited bars, the score updates, Make the song opens a song whose chorus has the edited notes. Save screenshots to the session scratchpad `hum-editor/`.
- [ ] **Step 4: Run full suites** `pnpm -C apps/brain test`, `pnpm -C packages/arrangement test`, `pnpm -C apps/web test` — expect PASS.
- [ ] **Step 5: Commit** `feat(hum): edit the melody and chords before making the song, with a score`, push, `./deploy.sh`, and confirm /hum on casperaki.com shows the editor.
