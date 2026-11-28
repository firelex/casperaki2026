# Casting, part 1: the speech service and singers' speaking voices — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A speech service on datigator that speaks lines in described voices (Breeze TTS 2), and a speaking voice for
every singer, matched to its singing voice, made when a singer is added and on demand.

**Architecture:** A new harness service `speech` (port 16516) with two stages: `lines` (speak a list of lines, each
sped up and compressed) and `speaking_voice` (eight candidate voices from a description, the one closest to the
singer's reference kept, by WavLM speaker embeddings). Breeze loads per job and is released after it, like the vocals
service. The brain writes each singer's voice description with the assistant's language model, runs the stage, and
keeps the result with the singer; the Singers page plays it and lets the user describe the voice instead.

**Tech Stack:** Python 3.12 (Breeze's venv, torch, transformers), the service harness (`_serving/harness.py`), ffmpeg;
brain TypeScript (Express, zod 3, vitest); web React (vitest).

**Spec:** `docs/superpowers/specs/2026-11-28-video-modes-casting-design.md` (sections "Constraints", "Owner's answers"
2, "Speech processing", "Singers' speaking voices").

**Later plans** (one per part, each written when the one before is done): 2 remove the console and cartoon videos
(shared modules first); 3 the casting writer; 4 casting timeline and soundtrack; 5 engine casting scenes and render;
6 the Video tab's modes.

## Global Constraints

- No fallbacks: a missing voice, failed line or unreachable service fails with a message naming it.
- LLM prompts in plain English, understandable without this codebase.
- Breeze: code `~/breeze-tts-2/code` (pinned upstream, untouched), weights `~/breeze-tts-2/weights`, venv
  `~/breeze-tts-2/.venv` (Python 3.12). Licence research/non-commercial: casting is admin-only (later plans).
- Speech finishing chain, exactly: `atempo=1.1,acompressor=threshold=-20dB:ratio=4:attack=5:release=80:makeup=4,loudnorm=I=-16:TP=-1.5:LRA=7`, 48 kHz mono WAV.
- Candidate seeds, exactly: `[7, 11, 21, 33, 42, 57, 64, 99]`.
- Speaker model: `microsoft/wavlm-base-plus-sv` (transformers `WavLMForXVector`), weights in
  `/mnt/d/casperaki-models/microsoft__wavlm-base-plus-sv` (weights on /mnt/d, venvs on the Linux disk).
- Models load per job and are released after it (one shared GPU). Service URL in the brain: `SPEECH_SERVICE_URL`.
- Commit only your own files (other sessions work in the same tree); push promptly; ship via `deploy/datigator/deploy.sh`.

## Review Focus

1. A singer whose reference is very short or mostly silence: the matcher must still embed it (WavLM on ≥1 s) or fail
   naming the singer — test in Task 2.
2. A user description that is empty or only spaces on the Singers page: refused with 400 "describe the voice" — test in
   Task 5.
3. Making a speaking voice while the speech service is down: the task fails with the service URL in the message, the
   singer keeps any earlier speaking voice — test in Task 4.
4. Built-in singers (shared, read-only folder): their speaking voices are stored per owner under the data folder, never
   written into the repo's voices folder — test in Task 4.
5. A second request while one speaking-voice task for the same singer is running: refused 409 — test in Task 5.

---

### Task 1: The speech service speaks lines

**Files:**
- Create: `apps/models/services/speech/pipeline/__init__.py`, `pipeline/paths.py`, `pipeline/breeze.py`,
  `pipeline/post.py`, `pipeline/lines.py`, `README.md`
- Create: `apps/models/services/_serving/adapters/speech.py`
- Test: `apps/models/services/speech/tests/test_post.py`, `tests/test_lines.py`

**Interfaces:**
- Produces: `breeze.Breeze()` (loads the model; `.speak(text: str, instruction: str, seed: int, out: Path) -> Path`
  writes a 24 kHz WAV; `.close()` frees the GPU). `post.finish(raw: Path, out: Path) -> float` (runs the finishing
  chain, returns seconds). Stage `lines`: params `{"stage": "lines", "lines": [{"id": str, "text": str,
  "instruction": str, "seed": int}]}` → files `<id>.wav` (finished) and result file `lines.json` =
  `{"lines": [{"id", "file", "seconds"}]}`; one job step per line (`job.step(id, text[:60])`).

- [ ] **Step 1: Write the failing tests.** `test_post.py::test_finish_speeds_up_and_levels`: a 3.3 s 220 Hz sine
  at -30 dBFS through `finish` → duration 3.0 s ±0.05, integrated loudness -16 LUFS ±1 (measure with ffmpeg
  `ebur128`), 48 kHz mono. `test_lines.py::test_refuses_bad_lines`: `lines.run` with an empty list, a missing
  `text`, a duplicate `id`, or an id that is not `[a-z0-9-]+` raises `ValueError` naming the problem (no model
  loaded: validation runs first).
- [ ] **Step 2: Run** `cd apps/models/services/speech && ~/breeze-tts-2/.venv/bin/python -m pytest tests -q` →
  FAIL (modules missing).
- [ ] **Step 3: Implement.** `paths.py`: `BREEZE_ROOT = Path.home()/"breeze-tts-2"`, `BREEZE_CODE`, `BREEZE_WEIGHTS`,
  `WAVLM_SV` (above). `breeze.py`: drive the model in-process the way `~/breeze-tts-2/code/infer.py` `main()` does
  (same request dict, `set_all_seeds(seed)`, eager mode: no `--fast-all`, ~8 GB). `post.py`: ffmpeg with the exact
  chain. `lines.py`: `run(params, out_dir, job) -> {"file": "lines.json", "kind": "json"}`; validate, then one
  `Breeze()` for all lines, `close()` in `finally`. Adapter `speech.py` like `adapters/vocals.py`: STAGES
  `("lines", "speaking_voice")`, MANIFEST `python: "3.12"`, `venv: ".venv"`, setup
  `[["ln", "-s", str(Path.home()/"breeze-tts-2/.venv"), ".venv"]]`; `load` puts `BREEZE_CODE` on `sys.path` and
  checks code and weights exist (SystemExit naming the missing path).
- [ ] **Step 4: Run** the tests → PASS. Then the service by hand:
  `cd apps/models/services/_serving && python3 harness.py --adapter speech --port 16516`, POST `/generate`
  `{"stage":"lines","lines":[{"id":"ice-1","text":"Right. Well. That was certainly a choice.","instruction":"<Ice's description from the spec>","seed":7}]}`,
  poll `/result` to `done`, fetch `ice-1.wav` with `/file?job=..&name=ice-1.wav` → about 3 s of speech.
- [ ] **Step 5: Commit** `feat(speech): speech service: lines spoken by Breeze in described voices, sped up and compressed`.

### Task 2: Matching a speaking voice to a singer

**Files:**
- Create: `apps/models/services/speech/pipeline/match.py`, `pipeline/speaking_voice.py`, `tools/fetch_wavlm.py`
- Test: `apps/models/services/speech/tests/test_match.py`, `tests/test_speaking_voice.py`

**Interfaces:**
- Consumes: Task 1 `Breeze`, `post.finish`.
- Produces: `match.SpeakerMatcher()` (`.embed(wav: Path) -> np.ndarray` unit vector; `.similarity(a, b) -> float`
  cosine; `.close()`). Stage `speaking_voice`: params `{"stage": "speaking_voice", "reference": abs path,
  "description": str, "test_line": str, "seeds": list[int]}` → files `candidate-<seed>.wav` (finished) and
  `speaking_voice.json` = `{"best_seed": int, "scores": {"<seed>": float}, "sample": "candidate-<best>.wav"}`;
  steps `speak` (one per candidate), `match`.

- [ ] **Step 1: Write the failing tests.** `test_match.py` (needs the weights; skip with a reason naming
  `tools/fetch_wavlm.py` when the folder is missing — a missing model in production still fails loudly in `load`):
  `test_same_voice_scores_higher`: two halves of `vocals/voices/` built-in reference A score higher with each other
  than A's half with built-in reference B; `test_too_short_fails`: a 0.3 s clip raises `ValueError` "at least 1 s of
  voice". `test_speaking_voice.py::test_refuses_bad_params`: a relative or missing reference, empty description or
  test line, empty or repeated seeds raise `ValueError` naming it (before any model loads).
- [ ] **Step 2: Run** them → FAIL.
- [ ] **Step 3: Implement.** `tools/fetch_wavlm.py` downloads the model to `WAVLM_SV`. `match.py`: 16 kHz mono,
  silence trimmed (librosa `effects.split`, top_db 35), ≥1 s required, `WavLMForXVector` embeddings normalised.
  `speaking_voice.py`: validate; Breeze speaks the test line once per seed with the description as instruction,
  each finished; Breeze closed; matcher embeds the reference and each candidate; best = highest cosine.
- [ ] **Step 4: Run** the tests → PASS.
- [ ] **Step 5: Commit** `feat(speech): speaking voice matched to a singer (eight described candidates, WavLM similarity)`.

### Task 3: The owner's listening test (gate)

**Files:** Create `apps/models/services/speech/tools/trial_speaking_voice.py` (calls `speaking_voice.run` directly,
writes into a given folder; prints scores).

- [ ] **Step 1:** Median sung pitch of Karla and Kesha from their `voice.json` `f0` (non-zero values) in
  `~/casperaki-data/singers/demo-user/<id>/`.
- [ ] **Step 2:** Run the trial for each with a description written the way Task 4's prompt will (a woman, age range,
  how high or low her speaking voice sits given the sung median, bright or husky, from the uploader's description:
  Karla "Strasser", Kesha "Sassy"), test line "Hi, I'm <name>. Honestly, I'm a bit nervous, but I'm really excited to
  be here." Output to `~/casperaki-data/voicetest/<name>/`.
- [ ] **Step 3:** Give the owner the scp command (quote the remote path for zsh) and the scores; ask whether the
  chosen voice fits each singer and whether a lower-scored candidate fits better.
- [ ] **Step 4: GATE.** The owner approves → Task 4. The owner rejects → stop and take it back to the owner (the
  description-only voice was the alternative) before any brain work.
- [ ] **Step 5: Commit** the trial tool `chore(speech): speaking-voice trial tool`.

### Task 4: The brain makes and keeps speaking voices

**Files:**
- Create: `apps/brain/src/singers/speakingVoice.ts`, `apps/brain/src/singers/speakingVoiceTask.ts`
- Modify: `apps/brain/src/config.ts` (`speechServiceUrl` from `SPEECH_SERVICE_URL`), `src/singers/userSingers.ts`
  (singer gains `speaking?`), `src/singers/addSingerTask.ts` (last step), `src/tasks/tasks.ts` + `src/store.ts`
  (task kind `speakingVoice`, songId null, like `addSinger`), `src/bootstrap.ts`
- Test: `apps/brain/test/speaking-voice.spec.ts`

**Interfaces:**
- Consumes: Task 2's stage through the existing harness client (`sing/vocalsClient.ts`, constructed with
  `speechServiceUrl`), `ChatModel` (`llm/chatModel.ts`, the assistant endpoint).
- Produces: `SpeakingVoiceSchema = z.object({ description: z.string().min(1), seed: z.number().int(), sample:
  z.literal('speaking.wav'), madeBy: z.enum(['matched', 'described']), createdAt: z.string() }).strict()`;
  `describeVoice(chat: ChatModel, facts: { name: string; description: string; medianHz: number }): Promise<string>`;
  `speakingVoiceDir(dataDir, ownerId, singerId, builtIn: boolean): string` — own singers: `<dataDir>/<owner>/<id>/`,
  built-in: `<dataDir>/<owner>/builtin-speaking/<id>/`; `readSpeakingVoice(...)`/`writeSpeakingVoice(...)` storing
  `speaking.json` + `speaking.wav` there; task kind `speakingVoice` with options `{ singerId: string; description?:
  string }` (description given: used as is, `madeBy: 'described'`, one candidate, seed 7; else written by
  `describeVoice` and matched, `madeBy: 'matched'`).

- [ ] **Step 1: Write the failing tests** (fake chat model and a fake speech service on a local port, as the existing
  singer tests fake the vocals service): `describes the voice from the singing and keeps the closest candidate`
  (the prompt sent contains the name, the uploader's description and "about 460 Hz"; stored speaking.json has the
  fake's best seed and `madeBy: 'matched'`); `uses the user's description as is`; `adding a singer ends with its
  speaking voice` (Add a singer's steps end with `speaking voice` done); `a built-in singer's voice is kept under
  the data folder` (nothing written into BRAIN_SINGERS_DIR); `fails naming the speech service when it is down, and
  keeps the earlier voice`; `503 naming SPEECH_SERVICE_URL when unset`.
- [ ] **Step 2: Run** `cd apps/brain && npx vitest run test/speaking-voice.spec.ts` → FAIL.
- [ ] **Step 3: Implement.** `describeVoice` prompt (plain English, JSON answer `{"description": "..."}`): explain
  that a speech synthesiser makes a speaking voice from one sentence; give the singer's name, the uploader's words
  about the voice, and the median pitch of their singing in Hz with what that suggests (below ~165 Hz usually a man's
  voice, above a woman's; speaking sits lower than singing); ask for one sentence stating man or woman, age range,
  pitch, texture and manner, natural and conversational, no accent unless the uploader's words name one, no real
  person's name. Median from `voice.json` f0 (non-zero). Test line: "Hi, I'm <name>. Honestly, I'm a bit nervous, but
  I'm really excited to be here." The task submits stage `speaking_voice`, follows it with `followJob`, copies the
  sample to `speaking.wav`, writes `speaking.json` last (atomic), and only then replaces the old one.
- [ ] **Step 4: Run** the spec → PASS; run the singers specs (`test/add-singer.spec.ts`, `test/singers*.spec.ts`)
  → PASS.
- [ ] **Step 5: Commit** `feat(singers): speaking voices made from the singing (described, matched) when a singer is added and on demand`.

### Task 5: Routes and the Singers page

**Files:**
- Modify: `apps/brain/src/routes/singers.ts`, `apps/web/src/api/singers.ts`, `apps/web/src/pages/SingersPage.tsx`
- Test: `apps/brain/test/speaking-voice.spec.ts` (routes), `apps/web/test/singers.test.ts`

**Interfaces:**
- Consumes: Task 4's task kind and storage.
- Produces: `GET /api/singers` items gain `speaking: { description, madeBy, sampleUrl } | null`;
  `GET /api/singers/:id/speaking-sample` → WAV; `POST /api/singers/:id/speaking-voice` body `{ description?: string }`
  → 202 `{ taskId }` (400 "describe the voice" for a blank description; 409 while one runs for that singer; 404
  unknown singer; 503 naming SPEECH_SERVICE_URL).

- [ ] **Step 1: Write the failing tests.** Brain: the three status codes and the listing field. Web: a singer card
  with a speaking voice shows "Speaking voice" with a play button and its description; one without shows "Make a
  speaking voice"; "Describe it yourself" opens a text box whose Save posts the description; blank Save is disabled.
- [ ] **Step 2: Run** brain and web tests → FAIL.
- [ ] **Step 3: Implement** the routes and the card section (reuse the page's existing play button and task progress
  patterns).
- [ ] **Step 4: Run** `cd apps/brain && npx vitest run test/speaking-voice.spec.ts test/singers*.spec.ts` and
  `cd apps/web && npx vitest run` → PASS; `npx tsc --noEmit` in both.
- [ ] **Step 5: Commit** `feat(singers): speaking voice on the Singers page (listen, make, describe it yourself)`.

### Task 6: Live on datigator

**Files:** Modify `deploy/datigator/start.sh` (svc-speech, port 16516, comment line like the others).

- [ ] **Step 1:** `tools/fetch_wavlm.py`; add `SPEECH_SERVICE_URL=http://127.0.0.1:16516` to
  `~/.config/casperaki/brain.env` (back it up first as `brain.env.bak-<date>-speech`); start svc-speech.
- [ ] **Step 2:** Commit start.sh `chore(deploy): svc-speech`; push; deploy with the running-tasks gate.
- [ ] **Step 3:** Through the live site (demo login), make speaking voices for Karla, Kesha and the built-in singers;
  check each task ends done and the sample plays (WAV, 2-6 s).
- [ ] **Step 4:** Tell the owner what to listen to; update the memory note `casting-mode.md` (speech service live, port).
