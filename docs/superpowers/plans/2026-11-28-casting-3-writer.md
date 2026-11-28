# Casting 3: the Writer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The brain writes a casting video's spoken script — the narrator backstage, the four judges' banter with
questions the singer answers, and the verdicts — natural and in character, each line with a delivery note and a
gesture, as an admin-only background task whose result the owner can read.

**Architecture:** `apps/brain/src/casting/`: the cast (judges' and narrator's profiles and voices, the singer as a
character), the song facts the writer is grounded in, a **plan** call per scene (beats, who speaks in which order,
the question to the singer, the verdict shape) and one **turn** call per line (the speaker writes their next line
seeing the plan, their profile and everything said so far). A task kind `castingScript` (on a song, admins only) runs
it and stores the script; plan 4 voices it and builds the timeline.

**Tech Stack:** brain (TypeScript, Express, zod 3, vitest), the existing `ChatModel` (DeepSeek, JSON answers).

**Spec:** `docs/superpowers/specs/2026-11-28-video-modes-casting-design.md` ("Writing the talk", "The singer as a
character", "Verdict", "Length", "The judges" with the jury profiles).

## Global Constraints

- Every prompt is plain English, understandable without this codebase (global rule); no real person's name or
  likeness; the sample lines in the profiles are a guide, not to be reused word for word.
- Talk must be natural, never stilted (owner); short turns (mostly one or two sentences); reactions and
  interruptions allowed.
- Lengths (spoken at about 2.6 words a second after the 1.1× speed-up): backstage 30-40 s, banter about 30 s,
  verdicts about 45 s.
- Ice has the last word in the verdicts. Outcomes: `fourYes` ("Through, four yeses"), `threeOne` ("Through, three to
  one"), `notThisTime`; the writer is told who says yes and who says no.
- Admins only (403 `admin_only`); the song must have a finished Sing whose singer is the performing avatar's
  singer, and a section named chorus (400 naming what is missing).
- No fallbacks: a model answer that is not the JSON asked for, or names a speaker not in the scene, fails the task
  with the model's answer quoted (first 200 characters).

## Review Focus

1. A turn answer whose speaker differs from the planned speaker, or empty text → the task fails naming the turn.
2. `threeOne`: exactly one judge says no, the same one on a re-run of the same song (seeded by the song id); any judge
   may be the no, and Ice still speaks last.
3. A song without lyrics → the writer is told there are no words yet; no invented quotes (test the prompt).
4. A singer without a description → the singer's character comes from the name and the avatar's name only.
5. Cancelling the task between turns stops further model calls.

---

### Task 1: The cast and the song facts

**Files:**
- Create: `apps/brain/src/casting/cast.ts`, `apps/brain/src/casting/facts.ts`
- Test: `apps/brain/test/casting-writer.spec.ts`

**Interfaces:**
- Produces: `JUDGES: readonly Judge[]` (`id: 'ice'|'nicky'|'love'|'bob'`, `name`, `profile: string` — the spec's
  profile text in plain English, `voice: { description: string; seed: number }` from the spec's table);
  `NARRATOR: { id: 'narrator'; profile; voice }`; `Outcome = 'fourYes'|'threeOne'|'notThisTime'`;
  `verdictVotes(outcome, songId): Record<JudgeId, 'yes'|'no'>`;
  `castingFacts(song: Song, singer: { name: string; description: string | null }, avatarName: string): CastingFacts`
  = `{ title, genre (display name), bpm, tempoWord ('slow'|'mid-tempo'|'fast'), sections: string[], quotes: string[]
  (up to 4 lyric lines of the first chorus, else the first lines; [] without lyrics), singerName, singerDescription,
  avatarName }`.

- [ ] **Step 1: Failing tests** — four judges with the spec's voices (Ice seed 7 …, Bob seed 21); `verdictVotes`:
  fourYes all yes, notThisTime all no, threeOne exactly one no, the same for the same song id and varying across
  ids; `castingFacts` of the demo song quotes chorus lines and gives `tempoWord`; a song without lyrics gives
  `quotes: []`.
- [ ] **Step 2: Run** `npx vitest run test/casting-writer.spec.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS. **Commit** `feat(casting): the cast and the song facts for the writer`.

### Task 2: Scene plans and turns

**Files:**
- Create: `apps/brain/src/casting/writer.ts`
- Test: `apps/brain/test/casting-writer.spec.ts` (a scripted fake `ChatModel` that records prompts)

**Interfaces:**
- Produces: `Gesture = 'nod'|'shakeHead'|'laugh'|'leanBack'|'leanIn'|'point'|'clap'|'handsUp'|'shrug'|'none'`;
  `ScriptLine = { speaker: 'narrator'|JudgeId|'singer'; text: string; delivery: string; gesture: Gesture }`;
  `CastingScript = { outcome; votes; backstage: ScriptLine[]; banter: ScriptLine[]; verdicts: ScriptLine[] }`;
  `writeScript(chat: ChatModel, facts: CastingFacts, outcome: Outcome, votes, signal: AbortSignal,
  onLine?: (scene, line) => void): Promise<CastingScript>`.
- Per scene: one **plan** call → `{ beats: string[]; turns: { speaker, intent }[] }` (backstage: narrator only,
  4-7 turns; banter: judges and the singer, 6-12 turns, at least one question the singer answers; verdicts: each
  judge's vote in a turn that matches `votes`, Ice's turn last, 6-10 turns); then one **turn** call per planned turn
  → `{ text, delivery, gesture }`. The turn prompt holds: the scene's beats, the speaker's profile, the
  conversation so far, the turn's intent, the song facts; the judges' sample lines are marked as a guide only.
- Checks: planned speakers belong to the scene; a verdicts plan that does not give every judge a vote turn, or
  does not end with Ice, is refused; words per scene within the spec's length (± 40 %) or the scene is refused
  naming its length.

- [ ] **Step 1: Failing tests** — Review Focus 1, 2, 3, 4, 5; a full script from the fake model has the three
  scenes, Ice last; prompts contain no "TODO"-like shorthand and name no real person (check the profile text
  against the spec's "inspired by" names).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Real model check** — run `writeScript` once against the live DeepSeek for the demo user's sung song
  (a small script under the scratchpad); read the result; fix prompts until it reads naturally; paste the script
  for the owner.
- [ ] **Step 6: Commit** `feat(casting): the writer (scene plans, one call per line)`.

### Task 3: The castingScript task and its route

**Files:**
- Modify: `apps/brain/src/store.ts` (kind `castingScript`), `apps/brain/src/tasks/tasks.ts`, `apps/brain/src/routes/video.ts`
  (or a new `routes/casting.ts`), `apps/brain/src/bootstrap.ts`; web `src/api/tasks.ts` (label "Casting script").
- Test: `apps/brain/test/casting-script.spec.ts`

**Interfaces:**
- `POST /api/songs/:id/casting/script` `{ avatarId, outcome }` → 202 `{ task }` (admins; 400 no finished Sing by the
  avatar's singer / no chorus / unknown outcome); the task's result is the `CastingScript`; steps per scene
  (Backstage, Banter, Verdicts) with the lines so far.
- `GET /api/songs/:id/casting/script` → the latest finished script for the song (404 none).

- [ ] **Step 1: Failing tests** — 403 for non-admins; 400 for each missing precondition; a run with the fake model
  stores the script and shows three steps.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; brain suite once.
- [ ] **Step 5: Deploy and live check** — start a script for the demo user's sung song through the route; send the
  owner the script text to read.
- [ ] **Step 6: Commit** `feat(casting): castingScript task (admins)`.
