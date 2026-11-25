# Vocal Tasks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** New songs start with empty vocal tracks; the Vocal track's menu writes the melody (instant) and the lyrics (a
background task); a Tasks item lists the tasks; finished results go into the song only when nothing is playing.

**Architecture:** A generator param hides the vocal tracks; a vocal edit shows them. The brain keeps tasks in a SQLite
table, runs one task per kind at a time, and keeps a finished result until a page of its owner applies it. The web app
applies ready results when the live player is not playing.

**Tech Stack:** TypeScript, vitest, express, better-sqlite3, React + TanStack Query, @teamsuzie/ui menus.

**Spec:** `docs/superpowers/specs/2026-11-25-vocal-tasks-design.md`

## Global Constraints

- Generator param name `vocalMelody`; `false` = empty vocal tracks; absent = shown (all existing songs unchanged).
- Task kinds: `writeLyrics` (this plan). States: `running` | `ready` | `done` | `failed`.
- Lyric writer: 6 rounds at most; rounds 1–4 without reasoning, 5–6 with; grammar reading every round; failure after
  round 6 fails the task (no fallback).
- No fallbacks, no silent catches (owner's rule). Every LLM prompt in plain English.
- Do not rebuild or commit another session's uncommitted thin-sections files.

## Review Focus

- The project is saved (moved to a new song id) while its task runs → the task follows the project and applies to the
  saved version (brain test in Task 3).
- The project is deleted while its task runs → the task ends without error and is not applied (Task 3).
- The brain restarts with a task running → it resumes (Task 3).
- The user has unsaved edits when a result is applied → the edits stay and the words go into the working copy (Task 4).
- Write lyrics on a song whose melody was written but not saved → the task uses the posted working song, and applying
  shows the melody in the saved version (Tasks 1 and 3).

---

### Task 1: Generator — hidden vocal melody, Write melody, lyrics show the melody

**Files:** Modify `packages/arrangement/src/orchestrate/index.ts`, `packages/arrangement/src/edits/vocal-edits.ts`,
`packages/arrangement/src/index.ts`; Test `packages/arrangement/test/written-lyrics.spec.ts`.

**Produces:** `VOCAL_MELODY_PARAM = 'vocalMelody'`, `vocalMelodyShown(song: Song): boolean`,
`writeMelody(working: Song): Song`; `applyWrittenLyrics` drops the param.

- [ ] Test: `orchestrate({...PARAMS, params: { vocalMelody: false }})` has the three vocal definitions, every section
  has them `false` and no vocal overrides; other tracks and chords equal those of `orchestrate(PARAMS)`.
- [ ] Test: `writeMelody(hidden)` equals (minus generator params) `orchestrate(PARAMS)`'s vocal tracks, and
  `vocalMelodyShown` is true; `applyWrittenLyrics(hidden, lyrics)` shows the melody.
- [ ] Implement; run `npx vitest run test/written-lyrics.spec.ts`; full arrangement suite once before commit.

### Task 2: Brain — the lyric writer

**Files:** Create `apps/brain/src/lyrics/lyricist.ts` (from `b59673c^`, changed as the spec says),
`apps/brain/test/fakeLyricModel.ts`, `apps/brain/test/lyricist.spec.ts`.

**Produces:** `writeLyrics(song: Song, model: ChatModel, request: { sections: string[]; title?: string }): Promise<WrittenLyrics>`.

- [ ] Tests with a scripted fake model: fitting draft → returned after one call; a line cut on a HOLD → repaired in
  round 2; grammar flag → repaired; rounds 5–6 sent with `thinking: true`; still wrong after 6 → throws naming lines.
- [ ] Implement; run `npx vitest run test/lyricist.spec.ts`.

### Task 3: Brain — tasks table, runner, routes, events

**Files:** Modify `apps/brain/src/store.ts` (table `tasks`, moved by `moveProject`), `apps/brain/src/events.ts`
(event `task`), `apps/brain/src/bootstrap.ts`, `apps/brain/src/routes/songs.ts` (generate sets `vocalMelody: false`),
`apps/brain/src/routes/tracks.ts` (`writeMelody`, `applyLyrics`); Create `apps/brain/src/tasks/tasks.ts`,
`apps/brain/src/routes/tasks.ts`; Test `apps/brain/test/tasks.spec.ts`.

**Produces:** `GET /api/tasks` → `{ tasks: TaskJson[] }`, `POST /api/tasks` `{ kind, songId, song }` → `{ task }`,
`POST /api/tasks/:id/apply` → `{ task, saved: GeneratedSong }`, `POST /api/tasks/:id/retry` → `{ task }`;
`TaskJson = { id, kind, songId, title, state, message?, startedAt, finishedAt? }`.

- [ ] Tests: start → ready (fake model) → apply saves a version with the words and melody; save while running →
  applies to the moved project; delete while running → no error, task gone; failure → `failed` with message, retry;
  resume on restart; generate gives empty vocals; one task per kind and song (409 when already running).
- [ ] Implement; run brain suite.

### Task 4: Web — Vocal menu, Tasks item, applying results

**Files:** Create `apps/web/src/api/tasks.ts`, `apps/web/src/state/useTasks.ts` (list + apply-when-stopped),
`apps/web/src/layout/TasksMenu.tsx`; Modify `apps/web/src/layout/AppHeader.tsx`, `apps/web/src/editor/TimelineView.tsx`,
`apps/web/src/state/useBrainEvents.ts`; Test `apps/web/test/tasks.test.ts`.

- [ ] Test the pure decision `shouldApply(task, playerStatus)` and the apply handler (clean editor → switches to saved;
  dirty → saved + words merged into working copy; other song → only list refresh).
- [ ] Implement menu items (Write melody / Write lyrics with disabled reasons), the Tasks dropdown, the hourglass.
- [ ] Run web tests and typecheck.

### Task 5: Ship

- [ ] Full arrangement, brain, web suites; commit only this work; push; deploy with `deploy.sh`; check casperaki.com.
