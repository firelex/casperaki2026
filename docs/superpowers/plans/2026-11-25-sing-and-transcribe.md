# Sing and Transcribe melody Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Sing task on the Vocal track sings the song's whole vocal arrangement in the background (YuE2 per section,
checked by ChordNet; SoulX + voice conversion for copies and backing vocals; YuE2 ad-libs), shows every step on the
Tasks page, and writes the sung melody back into the song.

**Architecture:** A new model service `svc-vocals` (serving-harness adapter `vocals`) runs the audio steps in two jobs
per task: `lead` (YuE2 takes, chord check, alignment, transcription) and `repeats` (SoulX copies, backing vocals,
voice conversion, ad-libs, levels). The brain's task runner drives them, generates the backing lines from the sung lead
in between (arrangement code), stores the takes and copies every step into the task. The sung melody becomes generator
param `sungMelody`, so regeneration keeps it and the backing generator follows it. Takes carry a fingerprint of what
they were sung over; the lowering plays only fresh ones, on per-lane dry/wet sends.

**Tech Stack:** TypeScript (brain, web, packages; vitest), Python 3.10 (serving harness, vocals adapter; pytest),
C++ (WASM engine mixer), YuE2-3B (yue2_infer 0.1.5), BS-RoFormer, ChordNet, SoulX-Singer and SoulX-Singer-SVC,
torchaudio MMS forced aligner.

**Spec:** docs/superpowers/specs/2026-11-25-sing-and-transcribe-design.md (read it first). Working examples of every
audio step: apps/models/ace-vocal-tests/other-models/*.py (yue2_sections, yue2_assemble, align_by_chords, chordnet,
soulx_sing_fitted, soulx_svc, syllable_notes, transcribe_vocal, build_plan2_tracks, render_with_vocal). Port from them;
do not import them.

## Global Constraints

- No fallbacks: a missing value or failed step throws with a message naming it (owner's standing rule).
- Harmony threshold default 0.70 (share of a section's half-beats on our chord); YuE2 seeds per unit default 3.
- Wet sends: reverb -10 dB, delay -18 dB, chorus off; dry: all sends off. Off = -100 dB (the engine's "no send").
- Levels: SoulX verses matched to the YuE2 chorus's loudness; backing vocals -6 dB under the lead; ad-libs -4 dB.
- Lead-in for every YuE2 unit: 2 bars of the preceding chords, no singing ("% intro" in the score).
- Ad-libs: choruses from the middle of the song on: chorus indices `floor(n/2) .. n-1` (4-6 of 6, 3-5 of 5).
- Credit text (exact): `Vocals sung with YuE2 (m-a-p/YuE2-3B, https://huggingface.co/m-a-p/YuE2-3B), CC BY-NC 4.0`.
  On the home page (ProjectsPage) and in exports' metadata; never on the song page.
- User-facing copy: "Sing", "Sing again", "Write lyrics first", "Already singing", "The song changed while it was
  being sung: sing again".
- svc-vocals port 16514; brain env `VOCALS_SERVICE_URL`; task files dir env `BRAIN_TASK_FILES_DIR` (required for sing).

## Review Focus

1. The user edits a sung section (chords, words, melody, bars, tempo) while Sing runs → apply refuses with the exact
   message; an edit to drums only → apply succeeds. (Task 9 tests both.)
2. YuE2 skips or adds a word, so forced alignment cannot place every written syllable → the transcription step fails
   naming the section and word, never a shifted melody. (Task 7 test.)
3. The vocal service restarts mid-task (job unknown on poll) or the brain restarts → the task fails with "the vocal
   service lost the job: sing again", not stuck "running". (Task 9 test.)
4. Songs of other shapes: no preChorus, one verse, five choruses, a later verse longer or shorter than the first →
   the plan has the right units (extension unit for the extra bars; cut for a shorter one). (Task 8 tests.)
5. Cancel while queued behind another sing task and while running → both end `failed` with "Cancelled", the service
   job stops at its next step. (Tasks 5 and 9 tests.)

---

### Task 1: Take fingerprints and the yue2-vocal kind (packages/song-schema)

**Files:**
- Create: `packages/song-schema/src/vocal-takes.ts`
- Modify: `packages/song-schema/src/schemas/ai-artifact.ts` (enum), `packages/song-schema/src/index.ts` (export)
- Test: `packages/song-schema/test/vocal-takes.spec.ts`

**Interfaces:**
- Produces: `vocalTakeFingerprint(song: Song, segment: string, track: string): string` (sha256 hex of the canonical
  JSON of `{ bpm, bars: <segment's bars incl. chords>, lane: song.arrangement[segment].overrides[track] ?? null }`);
  `SUNG_TAKE_KINDS = ['yue2-vocal', 'soulx-vocal'] as const`; `isTakeFresh(song: Song, artifact: AIArtifact): boolean`
  (attachedTo segment+instrument and `conditioning.hashes[0] === vocalTakeFingerprint(...)`).

- [ ] **Step 1: Write the failing tests** — `vocalTakeFingerprint` is stable for an unchanged song; changes when the
  segment's chords, the track's notes or words, or the bpm change; unchanged when another track or another segment
  changes. `isTakeFresh` true for a matching hash, false after a chord edit. `AIArtifactKindSchema.parse('yue2-vocal')`
  succeeds.
- [ ] **Step 2: Run** `pnpm -C packages/song-schema exec vitest run test/vocal-takes.spec.ts` → FAIL (not defined).
- [ ] **Step 3: Implement** in `vocal-takes.ts` with the package's `canonicalStringify` + sha256; add `'yue2-vocal'`.
- [ ] **Step 4: Run** the test → PASS; `pnpm -C packages/song-schema build`.
- [ ] **Step 5: Commit** `feat(song-schema): vocal take fingerprints and the yue2-vocal artifact kind`.

### Task 2: Lowering plays fresh takes on dry/wet lanes (packages/engine-adapter)

**Files:**
- Modify: `packages/engine-adapter/src/audio-clips.ts`
- Test: `packages/engine-adapter/test/audio-clips.spec.ts`

**Interfaces:**
- Consumes: Task 1 `isTakeFresh`, `SUNG_TAKE_KINDS`.
- Produces: per track, up to two audioClips instruments: `<track>` for `yue2-vocal` takes with
  `fxSends: { reverb: -100, delay: -100, chorus: -100 }`, and `<track> wet` for `soulx-vocal` takes with
  `fxSends: { reverb: -10, delay: -18, chorus: -100 }` (exported `DRY_SENDS`, `WET_SENDS`). Stale takes are left out.

- [ ] **Step 1: Write the failing tests** (extend the spec's `take()` helper with a kind and a fingerprint):
  a yue2 chorus take and a soulx verse take on Vocal → instruments `Vocal` (dry sends, the chorus clip) and
  `Vocal wet` (wet sends, the verse clip); a take whose fingerprint no longer matches (chord edited) → no clip; an
  `Ad-libs` yue2 take → its own `Ad-libs` dry instrument; existing tests keep passing with fresh fingerprints.
- [ ] **Step 2: Run** `pnpm -C packages/engine-adapter exec vitest run test/audio-clips.spec.ts` → FAIL.
- [ ] **Step 3: Implement** in `buildVocalClipsInsts`: filter `SUNG_TAKE_KINDS` + `isTakeFresh`, group by
  (track, wet); lane name `<track> wet` (not parentheses: the mixer's `baseName` strips "(...)").
- [ ] **Step 4: Run** → PASS; build the package.
- [ ] **Step 5: Commit** `feat(engine-adapter): sung takes on dry and wet lanes, stale takes left out`.

### Task 3: Per-lane sends in the engine mixer (apps/web/wasm/engine)

**Files:**
- Modify: `apps/web/wasm/engine/src/audio/Mixer.h` (`buildTrack`, new `laneSendOverride`)
- Test: the engine's existing C++ test target for the mixer config (see `mixconfig_test` in the engine's build
  files); add a case there.

**Interfaces:**
- Consumes: Task 2's `fxSends` on an audioClips instrument JSON.
- Produces: a lane whose instrument JSON has `fxSends` uses those dB values for its three sends instead of
  `cfgLaneSends`; every other lane unchanged.

- [ ] **Step 1: Write the failing test**: a resolved song with two audioClips instruments, one with
  `fxSends {reverb:-10,delay:-18,chorus:-100}`, one without → the first lane's `sendDb == {-10,-18,-100}`, the second
  equals `cfgLaneSends` for its type.
- [ ] **Step 2: Run** the engine test target → FAIL.
- [ ] **Step 3: Implement** `std::optional<mix::FxSends> laneSendOverride(const std::string& trackName) const` (reads
  `instByName_[baseName]["fxSends"]`, throws if present but missing a key) and use it in `buildTrack`.
- [ ] **Step 4: Run** → PASS; rebuild `casperaki_render`, `casperaki_master` and the WASM bundle with the engine's
  build script; render song a31c5ba0 with the Task 2 lowering and one wet take: the render differs from an all-dry
  render (the check in apps/models/ace-vocal-tests: -11.8 dB difference).
- [ ] **Step 5: Commit** `feat(engine): per-lane effect sends from the instrument (fxSends)`.

### Task 4: Generator param sungMelody and applySungVocals (packages/arrangement)

**Files:**
- Create: `packages/arrangement/src/vocals/sung-melody.ts`
- Modify: `packages/arrangement/src/vocals/index.ts` (`writeVocals`), `packages/arrangement/src/edits/vocal-edits.ts`,
  `packages/arrangement/src/index.ts`
- Test: `packages/arrangement/test/sung-melody.spec.ts`

**Interfaces:**
- Consumes: Task 1 `vocalTakeFingerprint`.
- Produces:
  - `SungNote = { start: number /* beats from section start */, duration: number, midi: number, word: string
    /* fullWord convention: "Un-" continues */, phonemes: string[] /* vocaloid, lowercase with stress digits */ }`
  - `SungMelodySchema` (zod: section name → SungNote[]), `SUNG_MELODY_PARAM = 'sungMelody'`,
    `sungMelodyOf(params): SungMelody`
  - `SungTake = { segment, track, kind: 'yue2-vocal' | 'soulx-vocal', sha256, durationSeconds, modelId, modelVersion,
    seed?: number }`
  - `applySungVocals(working: Song, sung: { melody: SungMelody; takes: SungTake[] }): Song` — records the param,
    regenerates and splices the vocal tracks (as `applyWrittenLyrics`), replaces the song's sung-take artifacts with
    `sung.takes` stamped with `vocalTakeFingerprint` of the result.
- `writeVocals`: a section in `sungMelody` gets those notes on the Vocal lead (replacing the merged melody's notes and
  the words); chords stay the precedent's; backing vocals are generated from this lead as today.

- [ ] **Step 1: Write the failing tests**: orchestrate with `sungMelody` for chorus1 → the Vocal lane of chorus1 has
  exactly those notes and words; Backing vocals 1/2 in chorus1 follow them (each backing note starts with a lead note);
  chords unchanged against the run without the param; `applySungVocals` → artifacts carry fresh fingerprints
  (`isTakeFresh` true), a second `applySungVocals` replaces the first's artifacts; a later `applyWrittenLyrics` makes
  the changed sections' takes stale.
- [ ] **Step 2: Run** `pnpm -C packages/arrangement exec vitest run test/sung-melody.spec.ts` → FAIL.
- [ ] **Step 3: Implement** as above; the param is validated with `SungMelodySchema` (an unknown section throws, as
  written lyrics do).
- [ ] **Step 4: Run** → PASS; run the vocals specs (`test/vocals*.spec.ts`, `test/written-lyrics.spec.ts`) → PASS;
  `pnpm -C packages/arrangement build` (downstream packages import dist).
- [ ] **Step 5: Commit** `feat(arrangement): the sung melody as generator param sungMelody; applySungVocals`.

### Task 5: Step reporting and cancel in the serving harness

**Files:**
- Modify: `apps/models/services/_serving/harness.py`, `apps/models/services/_serving/adapter_common.py`
- Test: `apps/models/services/_serving/test_harness_steps.py` (pytest, with a fake adapter module)

**Interfaces:**
- Produces:
  - Adapter `generate(handle, params, out_dir, job)` (4th argument optional: the harness passes it when the function
    takes four parameters). `job.step(id: str, label: str) -> Step`; `Step.done(text: str = "", numbers: dict = {},
    files: list[str] = [])`, `Step.fail(text)`; `job.cancelled() -> bool`; `job.check_cancelled()` raises
    `common.Cancelled`.
  - `GET /result?job=ID` adds `"steps": [{"id","label","state":"running|done|failed","started","finished","text",
    "numbers","files"}]`; a cancelled job ends `state: "error", error: "Cancelled"`.
  - `GET /file?job=ID&name=<file>` streams a step file (name must be a file the job's steps listed).
  - `POST /cancel?job=ID` → 200; a queued job is removed, a running one is flagged.
  - `GET /result` for an unknown job → 404 `{"error": "unknown job"}` (the brain treats it as lost).

- [ ] **Step 1: Write the failing tests**: a fake adapter reporting two steps (the second with a file) → `/result`
  lists both with states and the file, `/file?name=` returns its bytes, an unlisted name → 404; cancel of a queued job
  → never runs, `error: "Cancelled"`; cancel of a running job → the adapter's `check_cancelled()` raises and the job
  ends "Cancelled"; a 3-argument adapter still works.
- [ ] **Step 2: Run** `python -m pytest apps/models/services/_serving/test_harness_steps.py -v` → FAIL.
- [ ] **Step 3: Implement** in `harness.py` (`Jobs` keeps steps and a cancel flag per job) and `adapter_common.py`
  (`Cancelled`).
- [ ] **Step 4: Run** → PASS; start `harness.py --adapter hum` and check `/health` still answers.
- [ ] **Step 5: Commit** `feat(serving): jobs report their steps and files, and can be cancelled`.

### Task 6: The vocals service environment and adapter skeleton

**Files:**
- Create: `apps/models/services/_serving/adapters/vocals.py`, `apps/models/services/vocals/requirements.txt`,
  `apps/models/services/vocals/README.md` (weights, licences incl. the credit text), `apps/models/services/vocals/pipeline/__init__.py`
- Modify: `deploy/datigator/start.sh` (start `svc-vocals` on 16514 like svc-hum)

**Interfaces:**
- Produces: `MANIFEST = {"id": "vocals", ...}`, `load(ctx)` loading nothing heavy (models load per job, released after
  each stage: one GPU), `generate(handle, params, out_dir, job)` dispatching `params["stage"]` in
  `{"lead", "repeats", "transcribe"}` to `pipeline.lead.run`, `pipeline.repeats.run`, `pipeline.transcribe.run`.
- One venv at `apps/models/services/vocals/.venv` (Python 3.10, torch 2.10 cu128 for sm_120) holding yue2_infer 0.1.5,
  SoulX-Singer's requirements (repo at apps/models/services/soulx-singer/repo on `sys.path`), the BS-RoFormer code
  (apps/models/services/bs-roformer), the MuLaCover package (for ChordNet), torchaudio (MMS forced aligner).
  Weights stay on /mnt/d (paths in the README; venvs stay on the Linux disk, see the memory note on DrvFs).

- [ ] **Step 1:** Create the venv and install; run `python -c "import yue2, mulacover, torchaudio; from soulxsinger.models.soulxsinger import SoulXSinger"`
  → no error. If two packages pin incompatible versions, stop and report the conflict (do not split into
  subprocesses without the owner).
- [ ] **Step 2:** Start `harness.py --adapter vocals --port 16514`; `GET /health` → ready; a job with
  `stage: "nope"` → error naming the unknown stage.
- [ ] **Step 3: Commit** `feat(models): svc-vocals service skeleton (YuE2, SoulX, ChordNet, separation in one venv)`.

### Task 7: The lead stage (YuE2 takes, chord check, alignment, transcription)

**Files:**
- Create: `apps/models/services/vocals/pipeline/{score.py,yue2_takes.py,separate.py,chords.py,align.py,transcribe.py,lead.py}`
- Test: `apps/models/services/vocals/tests/test_score.py`, `test_align.py`, `test_transcribe.py` (pure parts, CPU),
  `apps/models/services/vocals/smoke_lead.py` (GPU, song a31c5ba0)

**Interfaces:**
- Consumes: Task 5 `job.step`, Task 6 dispatch.
- Produces: `lead.run(params, out_dir, job) -> {"file": "lead.json", "kind": "json"}`, where params =
  `{"bpm", "key", "units": [{"id", "lead_in_chords": [str per beat], "chords": [str per beat], "notes": [{"start",
  "duration", "midi"}], "lyrics": [str per line], "words": [[str per syllable] per line]}], "seeds": 3,
  "threshold": 0.7}` and lead.json = `{"units": {id: {"take": "<id>_section.wav", "seed", "chords_match",
  "melody": [SungNote]}}}` (SungNote as Task 4, `phonemes` from the brain's words via the request).
- Steps per unit and seed: `yue2:<unit>:s<seed>` (generate), `separate:...`, `chords:...` (numbers:
  `chords_match`, `starts_at_s`), then `choose:<unit>`, `transcribe:<unit>` (numbers: `syllables`), each with its audio
  file.
- `score.abc(unit, bpm)` writes the ABC layout of other-models/yue2_sections.py (L:1/16, voices Vocal/Ins, `% intro`,
  chord names with flat roots, vocal an octave above sung pitch).
- `align.align(chord_segments, expected_chords_per_beat, bpm) -> (bar_map, match_per_half_beat)` (DTW over half beats
  as align_by_chords.py; cost 0 same root+major/minor, 0.5 no chord, 1 other).
- `transcribe.syllable_notes(vocal, sr, words_per_line, bpm, line_bars) -> list[SungNote-without-phonemes]`: forced
  alignment of the unit's words (torchaudio MMS aligner, romanised lower-case text) gives each syllable's start;
  pitch per syllable from SwiftF0 (the hum service's front end) median, snapped to the key's scale; a syllable the
  aligner cannot place raises `TranscribeError("<section>: could not find the word '<word>' in the take")`.

- [ ] **Step 1: Write the failing tests**: `test_score` — the unit for a31c5ba0 verse1 gives the exact first two Vocal
  lines of `other-models` verse1.abc (copy them into the test); `test_align` — a chord sequence equal to the expected
  one shifted by 2 bars of extra intro → bar 0 maps 2 bars late, match 1.0; with 4 inserted beats mid-way → later bars
  shift by 4 beats; `test_transcribe` — a synthetic vocal (sine notes with silences) with known words → syllable
  starts within 30 ms, pitches exact; one word more than the audio holds → `TranscribeError` naming it.
- [ ] **Step 2: Run** `.venv/bin/python -m pytest apps/models/services/vocals/tests -v` → FAIL.
- [ ] **Step 3: Implement** the modules; `lead.run` reports every step, checks `job.check_cancelled()` between steps,
  fails a unit whose best take is under `threshold` with its scores ("verse1: best take matches our chords 62%
  (seeds 1: 62%, 2: 55%, 3: 40%), below 70%").
- [ ] **Step 4: Run** the tests → PASS; run `smoke_lead.py` on a31c5ba0 (fitted lyrics from
  /mnt/d/casperaki-models/vocal-model-tests/_inputs/lyrics_fitted.txt) → every unit chosen with chords_match ≥ 0.7,
  transcribed melodies of 44 (verse) and 28 (chorus) syllables.
- [ ] **Step 5: Commit** `feat(vocals service): lead stage — YuE2 takes checked by ChordNet, aligned, transcribed`.

### Task 8: The repeats stage, and the brain's singing plan

**Files:**
- Create: `apps/models/services/vocals/pipeline/{soulx.py,svc.py,adlibs.py,levels.py,repeats.py}`,
  `apps/models/services/vocals/tests/test_levels.py`, `test_adlibs.py`, `apps/brain/src/sing/plan.ts`,
  `apps/brain/test/sing-plan.spec.ts`

**Interfaces:**
- Produces (brain): `planSinging(song: Song): SingPlan`, `SingPlan = { units: LeadUnit[]; copies: { segment;
  from: unitId; bars: number /* bars sung */ }[]; reuses: { segment; from: unitId }[]; extensions: { segment; unit:
  unitId /* a LeadUnit for the extra bars */ }[]; adlibChoruses: string[] }`; throws `SingError('Write lyrics first')`
  without written lyrics for every sung section.
- Produces (service): `repeats.run(params, out_dir, job)`, params = `{"lead_job": id, "bpm", "copies": [{"segment",
  "from", "notes": [SungNote incl. phonemes], "voice": "<unit>_section.wav"}], "backings": [{"track", "segment",
  "notes": [SungNote], "voice": "<chorus unit>_section.wav"}], "adlibs": {"chorus_unit", "segments": [...],
  "gaps_bars": [int]}, "levels": {"backing_db": -6, "adlib_db": -4}}` → `repeats.json` `{"takes": [{"segment",
  "track", "kind", "file", "durationSeconds"}]}`. Steps: `soulx:<segment>`, `svc:<segment>`, `backing:<track>:<segment>`,
  `adlibs:yue2:s<seed>`, `adlibs:gate`, `levels`.
- `levels.match(take, reference, offset_db)` (loudness of the singing parts only, as build_plan2_tracks.py).
- `adlibs.gate(take, bars, bar_s)` keeps only the given bars, 0.15 s fades.

- [ ] **Step 1: Write the failing tests**: `sing-plan.spec` — a31c5ba0: units verse1, chorus1, bridge1; copies verse2-4
  from verse1; reuses chorus2-6; adlibChoruses chorus4-6 (6 choruses → indices 3..5); a song whose verse3 has 12 bars
  against verse1's 8 → copy of 8 bars + an extension unit for bars 9-12 (lead-in bars 7-8); a 4-bar verse3 → copy cut
  to 4 bars; five choruses → ad-libs in choruses 3-5; no written lyrics → `SingError('Write lyrics first')`.
  `test_levels` — a take 6 dB quieter than the reference comes out level; with offset -6 → 6 dB under.
  `test_adlibs` — gating bars 3 and 7 of an 8-bar take leaves silence elsewhere and 0.15 s fades.
- [ ] **Step 2: Run** `pnpm -C apps/brain exec vitest run test/sing-plan.spec.ts` and the service pytest → FAIL.
- [ ] **Step 3: Implement**; SoulX sings from the request's notes and phonemes (as soulx_sing_fitted.py, without g2p:
  the brain sends `vocaloidPhonemes`), `svc.py` as soulx_svc.py (RMVPE f0, no pitch shift).
- [ ] **Step 4: Run** → PASS; `smoke_repeats.py` on the smoke_lead job → takes for verse2-4, Backing vocals 1/2 in
  every chorus, ad-libs in chorus4-6.
- [ ] **Step 5: Commit** `feat(sing): the singing plan, and the repeats stage (SoulX copies, backing vocals, ad-libs)`.

### Task 9: The sing task in the brain

**Files:**
- Create: `apps/brain/src/sing/vocalsClient.ts`, `apps/brain/src/sing/singTask.ts`, `apps/brain/test/sing-task.spec.ts`,
  `apps/brain/test/fakeVocalsService.ts`
- Modify: `apps/brain/src/store.ts` (TaskKind `'sing'`; tasks table column `steps TEXT` via the store's migration
  pattern; `setTaskSteps(id, steps)`), `apps/brain/src/tasks/tasks.ts` (kind `sing`, cancel, apply check),
  `apps/brain/src/routes/tasks.ts` (`POST /api/tasks/:id/cancel`, `GET /api/tasks/:id/files/:name`),
  `apps/brain/src/config.ts` (`VOCALS_SERVICE_URL`, `BRAIN_TASK_FILES_DIR`), `apps/brain/src/bootstrap.ts`

**Interfaces:**
- Consumes: Task 4 `applySungVocals`, `vocalTakeFingerprint`; Task 5 contract; Task 7/8 stage params; Task 8
  `planSinging`.
- Produces: `TaskStep = { id, label, state: 'waiting'|'running'|'done'|'failed', startedAt?, finishedAt?, text?,
  numbers?: Record<string, number>, files?: string[] }`; `TaskRow.steps: TaskStep[]`; brain steps `plan`,
  `backing-lines`, `store-takes` around the service's; files copied to `BRAIN_TASK_FILES_DIR/<taskId>/` as each
  service step finishes; takes encoded to ogg (ffmpeg, as playback does) into the takes dir as `<sha256>.ogg`.
- Start: kind `sing` needs melody shown and written lyrics for every sung section (`'Write lyrics first'`), no other
  running sing on the song (`'Already singing'`); Write melody / Write lyrics refuse while a sing runs on the song.
- Apply: for every sung section and every vocal track, `vocalTakeFingerprint(input song)` must equal
  `vocalTakeFingerprint(current song)` (and the bpm) — otherwise the task fails with
  `'The song changed while it was being sung: sing again'`.

- [ ] **Step 1: Write the failing tests** with `fakeVocalsService` (an HTTP stub of the Task 5 contract): a sing task
  runs both stages, its steps appear in `GET /api/tasks` in order with states, files are fetchable; apply after a
  chord edit to chorus1 fails with the exact message; apply after a drum edit succeeds and the song has fresh takes and
  the sung melody param; cancel while queued and while running → `failed` "Cancelled" and the stub got `/cancel`; the
  stub answering 404 for the job → `failed` "the vocal service lost the job: sing again"; brain restart with a running
  sing → resumed task finds the job lost → same failure; Write lyrics during a sing → 409.
- [ ] **Step 2: Run** `pnpm -C apps/brain exec vitest run test/sing-task.spec.ts` → FAIL.
- [ ] **Step 3: Implement**; the brain polls `/result` every 2 s while a stage runs, copies steps on every change and
  publishes a `task` event (`state: 'running'`) so pages refresh.
- [ ] **Step 4: Run** → PASS; run the brain's tasks and lyricist specs → PASS.
- [ ] **Step 5: Commit** `feat(brain): the Sing task — two service stages, every step recorded, cancel, safe apply`.

### Task 10: Sing in the web app: menu, steps on the Tasks page, audio-only tracks, credit

**Files:**
- Modify: `apps/web/src/api/tasks.ts` (kind `sing`, `steps`, `cancel`, `fileUrl`), `apps/web/src/layout/TasksMenu.tsx`,
  `apps/web/src/editor/TimelineView.tsx` (Vocal menu: Sing / Sing again), `apps/web/src/state/tasks.tsx` (apply
  result for sing: reload the saved song), `apps/web/src/pages/ProjectsPage.tsx` (credit line)
- Create: `apps/web/src/editor/audioOnlyTracks.ts` (`audioOnlyTracks(song): string[]`: artifact instruments with no
  instrument definition, e.g. "Ad-libs"), `apps/web/test/sing.test.ts`

**Interfaces:**
- Consumes: Task 9 routes and `TaskStep`.

- [ ] **Step 1: Write the failing tests**: the Vocal menu shows "Sing" disabled with "Write lyrics first" without
  written lyrics, "Already singing" while one runs, "Sing again" when the song has sung takes; the Tasks list renders a
  sing task's steps in order with label, state, running time, text and a play button per file, and a Cancel button
  while running; `audioOnlyTracks` returns ["Ad-libs"] for a song with ad-lib takes; ProjectsPage shows the exact
  credit text; Write melody and Write lyrics are disabled with "Already singing" while a sing runs on the song; a
  section whose take is stale (`isTakeFresh` false, Task 1) is drawn greyed with the tooltip "not sung (changed since
  it was sung)".
- [ ] **Step 2: Run** `pnpm -C apps/web exec vitest run test/sing.test.ts` → FAIL.
- [ ] **Step 3: Implement**; the timeline draws audio-only tracks as rows with their clips (no notes).
- [ ] **Step 4: Run** → PASS; `pnpm -C apps/web exec tsc --noEmit`. Do not run a local vite build (it goes live:
  ship through deploy.sh only).
- [ ] **Step 5: Commit** `feat(web): Sing on the Vocal track, every step on the Tasks page, audio-only vocal tracks`.

### Task 11: Credit in exports

**Files:**
- Modify: `apps/brain/src/render/renderService.ts` (MP3 encode: `-metadata comment=<credit>` when the song has a
  `yue2-vocal` artifact), `apps/brain/src/export/dawExportService.ts` (`readme()`: the credit line, same condition)
- Test: `apps/brain/test/render-credit.spec.ts`

- [ ] **Step 1: Write the failing tests**: with a yue2 take the ffmpeg args contain `-metadata` and the exact credit;
  without, they do not; the DAW README contains the credit only with a yue2 take.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(brain): YuE2 credit in MP3 metadata and the producer export's README`.

### Task 12: Transcribe melody (standalone)

**Files:**
- Create: `apps/models/services/vocals/pipeline/transcribe.py` gains `run(params, out_dir, job)` (stage `transcribe`);
  `apps/brain/src/sing/transcribeTask.ts`; `apps/web` Vocal menu item "Transcribe melody" with a file picker per
  section
- Test: `apps/brain/test/transcribe-task.spec.ts`, service `tests/test_transcribe.py` (extend)

**Interfaces:**
- Task kind `transcribe`, input `{ songId, song, segment, recording }` (a recording of one section sung along from the
  section's first beat). With written lyrics for the section: syllable notes as Task 7; without: pitch-only notes from
  the hum service's `/transcribe` (notes become `SungNote` with the phrase bank's words attached as today).
  Result → `applySungVocals` with `takes: []` for that section only (other sections' melody and takes kept).

- [ ] **Step 1: Write the failing tests**: a recording of verse1 with lyrics → the section's Vocal lane equals the
  transcription; without lyrics → pitch-only notes from the stubbed hum service; other sections unchanged.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: Transcribe melody — a sung section back into the Vocal lane`.

### Task 13: End to end on datigator

- [ ] **Step 1:** Deploy through `deploy/datigator/deploy.sh` (brain, web, start.sh with svc-vocals); set
  `VOCALS_SERVICE_URL=http://127.0.0.1:16514` and `BRAIN_TASK_FILES_DIR` in `~/.config/casperaki/brain.env`.
- [ ] **Step 2:** On casperaki.com: generate an EDM song, Write melody, Write lyrics, Sing. The Tasks page lists every
  step live; the result goes in after Stop; the vocal plays on its bars; verses are wet, the chorus dry; Ad-libs row in
  the later choruses; edit a chorus chord → that chorus goes silent and shows as not sung.
- [ ] **Step 3:** Record the run's step timings in the spec's "What the experiments showed" (one line), commit.
