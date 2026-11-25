# Guitar Strums Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pattern-lab kind for recorded chord strums, guitar in EDM/schlager/urban, about 230 new grooves for review,
and the two fx holes fixed.

**Architecture:** `guitarStrums` styles live beside `guitarPicks` in the authored bank and emit the same
`virtualGuitarist` events the legacy bank does, so the engine path is unchanged. Selection maps guitar sound genres and
adds an optional guitar lane from a forked draw. Grooves are proposals files checked by a script.

**Tech Stack:** TypeScript, zod, vitest; React lab page; ffmpeg for slicing.

**Spec:** `docs/superpowers/specs/2026-11-25-guitar-strums-design.md`

## Global Constraints

- Strokes: `down` → `chordShortStrumDown`, `up` → `chordShortStrumUp`, `longDown` → `chordLongStrumDown`, `longUp` → `chordLongStrumUp`.
- fx allowed: fx1, fx2, fx4, fx6 (`GUITAR_FX`).
- Guitar sound genre: urban → ballad; schlager, latin, edm → brightPop; others their own genre.
- Extra guitar: edm, schlager, urban, 1 song in 3, from `rng.fork('roster/extraGuitar')`, only when the genre has an
  approved authored guitar style. Urban: acoustic lane; edm/schlager: acoustic or clean electric.
- Guitar lane mix: legacy bank has candidates for genre+bpm → authored 1 in 2; none → authored always.
- No fallbacks; fail loud. Plain-English prompts for the groove-writing agents. No transcriptions of songs.
- Library files (Dropbox sound library) are data: fix data there.

## Review Focus

- A genre with an extra guitar but no legacy candidates and no authored styles must not throw: the gate prevents the
  lane (test in Task 2).
- A song at a tempo where the legacy bank has no candidates in a supported genre with authored styles → authored plays
  (Task 1 test).
- A `guitarStrums` pattern whose beat lies past its bars → rejected by the schema (Task 1 test).
- Lab preview of a strum proposal for urban → the song has a guitar lane playing it (Task 2 test).
- Missing strum/fx sample file → the live player throws naming the file (Task 5 test).

---

### Task 1: `guitarStrums` kind (arrangement)

**Files:** Modify `packages/arrangement/src/patterns/chord-tones.ts` (schema, emit), `proposals.ts` (union, preview,
lanePreview), `authored-bank.ts`, `export-approved.ts`, `patterns/index.ts` (mix rule), `virtual-guitarist-bank.ts`
(export `virtualGuitaristBankHasPatterns(genre, bpm): boolean`), `src/index.ts`; Test
`packages/arrangement/test/guitar-strums.spec.ts`.

**Produces:** `GuitarStrumPatternSchema` `{ bars 1–8, energy?, strums: [beat, stroke, length][] (min 1), picks?: GuitarPick[], fx?: [beat, GuitarFx][] }`,
`AuthoredPatterns` gains `{ kind: 'guitarStrums', patterns }`, `familyTakesKind('guitar','guitarStrums') === true`.

- [ ] Tests: emit over a C/F section gives `virtualGuitarist` events with the right event names, chords and durations,
  picks as `strum` events, fx as fx events; beat past bars rejected; proposal loads and previews; authored style of kind
  guitarStrums loads; mix rule: with legacy candidates authored is taken ~half the time over many seeds, with none
  (urban) always.
- [ ] Implement; run the spec; then the patterns-related specs.

### Task 2: Guitar in more genres (selection)

**Files:** Modify `packages/arrangement/src/selection/index.ts`; Test `packages/arrangement/test/guitar-strums.spec.ts`.

- [ ] Tests: `familySoundPool('guitar','urban')` equals the ballad acoustic pool; schlager/latin/edm guitar pools
  equal brightPop's; with no approved urban guitar style no urban song has a guitar; with one (test bank dir or
  preview), about a third of urban songs have one; edm/brightPop goldens unchanged.
- [ ] Implement `guitarSoundGenre(genre)` used by roster resolution and `familySoundPool`; the extra-guitar draw.

### Task 3: Groove checker and grooves

**Files:** Create `packages/arrangement/scripts/check-guitar-strums.ts`; proposals
`packages/arrangement/data/patterns/proposals/guitar-strums-<genre>.json`.

- [ ] Checker: loads proposals (schema), per style ≥1 low and ≥1 high pattern, 16th / triplet grid only, rhythm
  fingerprint (onset set per bar) not equal to any legacy-bank bar pattern or other proposal; prints a table.
- [ ] Agents write the grooves per genre (counts in the spec); run the checker until clean.

### Task 4: Lab page

**Files:** Modify `apps/web/src/api/patterns.ts`, `apps/web/src/pages/PatternLabPage.tsx`.

- [ ] `GuitarStrumPattern` type, a grid (one row per stroke type, picks and fx rows), explanation line; typecheck and
  web tests.

### Task 5: fx holes

**Files:** Sound library `electricGuitarsTCRectifier{Mono,Stereo}/fx/fx1..8.mp3`; Modify
`apps/brain/src/render/playbackService.ts`; Test in the brain suite.

- [ ] Slice: fx i starts at the onset nearest (i−1)·4 s minus the same lead the Domino slices have, 0.7837 s long,
  encoded like the Domino files; check by listening level/onset.
- [ ] Player: missing strum/fx file → throw naming the path; test.

### Task 6: Ship

- [ ] Targeted specs, full arrangement + brain + web suites once; commit; push; deploy.
