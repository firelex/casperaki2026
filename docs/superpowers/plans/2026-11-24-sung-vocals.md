# Sung Vocals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** With a song's Vocals switch on, SoulX-Singer sings the lead vocal section by section on datigator's GPU, and the takes play as audio clips on the Vocal lane in the browser player, the server export and the video.

**Architecture:** A synchronous `/sing` route on the existing SoulX harness adapter (svc-soulx :16512) sings phrases with a catalogued voice. The brain turns a section's vocal notes and lyrics into a SoulX score, fingerprints it, and stores each section take as a WAV in a takes directory, recorded on the song as an `aiArtifacts` entry (kind `soulx-vocal`). The engine adapter lowers those artifacts into a general `audioClips` instrument; the engine (one codebase for the browser and native builds) plays each clip once on its own lane.

**Tech Stack:** Python harness adapter (SoulX venv, torch 2.8 cu128), TypeScript (zod song schema, engine-adapter, Express brain), C++17 engine (WASM via emsdk and native `casperaki_render`), React web app, ffmpeg.

**Spec:** `docs/superpowers/specs/2026-11-24-sung-vocals-design.md`

## Global Constraints

- Lead "Vocal" track only; backing vocals stay silent.
- Vocals are off by default, per song; off means nothing is sung and playback is unchanged.
- Takes are reused until the section's notes, lyrics, voice, key, tempo or model settings change; "Sing again" makes a new take (take number + 1).
- No silent failure: a missing or stale take with Vocals on is an error naming the section; "Play without vocals" is an explicit user action.
- No fallbacks or silent defaults anywhere (owner's standing rule): missing config, phonemes, voices or files throw with a message that names them.
- English lyrics from the legacy lyric bank (`vocalNote.vocaloidPhonemes`, ARPAbet); every note sung as a note (SoulX note type 2), rests `<SP>` (type 1).
- A SoulX call is a lyric line (4 bars), split earlier only at a rest of one beat or more.
- The take sings the written notes moved by the voice's fixed octave (catalogue); score, MIDI export and video keep the written notes.
- Takes are kept until the owner deletes them by name (a listing script); never deleted silently.
- Every signed-in user may sing; the service sings one request at a time.

## Review Focus

- A song whose tempo or key changes after singing: every take becomes stale and playback refuses until re-sung (test in Task 4).
- A section with no vocal notes (instrumental intro): no take is needed and none is asked for (tests in Tasks 3 and 4).
- A repeated section (verse2 = verse1 notes): the same fingerprint, so one SoulX call serves both (test in Task 4).
- svc-soulx down or a voice unknown: the sing route answers 502/422 with the service's message, never an empty take (test in Task 4).
- A saved song played from the projects list with Vocals on and a stale take: 409 with a message telling the user to open the song to sing (test in Task 7).

---

### Task 1: SoulX service routes (/voices, /sing) and svc-soulx

**Files:**
- Modify: `apps/models/services/_serving/adapters/soulx-singer.py`
- Create: `apps/models/services/soulx-singer/voices.json`
- Create: `apps/models/services/soulx-singer/sing_check.py` (a smoke check against the running service, not a unit test)

**Interfaces:**
- Produces: `GET`-style sync route `POST /voices` → `{"voices": [{"id", "label", "octave", "low", "high"}]}` and `POST /sing` with `{"voice": str, "phrases": [{"phoneme": [str], "duration": [float], "notePitch": [int], "noteType": [int]}], "steps": int}` → `{"sampleRate": 24000, "phrases": [{"wav": base64 PCM16 mono}], "tookMs": int}`. `phoneme` entries are SoulX phones (`en_K-IH0-NG`, `<SP>`), `notePitch` is MIDI as sung (octave already applied by the service from the voice), 0 for rests.

- [ ] **Step 1:** Write `voices.json`: one entry per demo voice, `{id, label, prompt: {json, audio}, octave, low, high}`. Voices: the repo's `en_prompt`, `en_target`, `zh_target`, `yue_target` and the lowered `en_prompt_m9`, `en_target_m9`, `zh_prompt_m10` (`/mnt/d/casperaki-data/hum-beats/soulx-prompts-low/`). `octave` 0 for voices whose prompt median is at or above MIDI 60, -12 below; `low`/`high` from the prompt JSON's note pitches. Labels in plain words ("Ella (English, female)").
- [ ] **Step 2:** Add `ROUTES = {"/voices": voices, "/sing": sing}` to the adapter. `load()` also processes every catalogue prompt once (`dp.process`). `sing` validates every phone against `phone_set.json` and raises `RequestError(422, ...)` naming the phrase and phone; unknown voice → 422; it applies the voice octave to `notePitch > 0`, runs `model.infer(..., control="score", n_steps=steps, cfg=config.infer.cfg, auto_shift=False, pitch_shift=0)` per phrase, returns base64 WAVs. `steps` must be between 16 and 64.
- [ ] **Step 3:** Start the service: `tmux new -d -s svc-soulx 'cd ~/apps/casperaki/apps/models/services/_serving && python3 harness.py --adapter soulx-singer --port 16512 --models-dir /mnt/d/casperaki-models 2>&1 | tee -a run/svc-soulx.log'`. Expected: `ready on http://127.0.0.1:16512`.
- [ ] **Step 4:** `sing_check.py` posts one 4-bar phrase ("Walking through the golden day", MIDI 60–64) with each voice. Expected: each answer is 24 kHz audio, length within 0.2 s of the phrase, RMS above -40 dBFS; an unknown phone answers 422 naming it.
- [ ] **Step 5:** Add `SOULX_SERVICE_URL=http://127.0.0.1:16512` to `~/.config/casperaki/brain.env` (outside git). Commit adapter, voices.json, sing_check.py.

### Task 2: Song schema: vocals setting

**Files:**
- Modify: `packages/song-schema/src/schemas/song.ts`
- Create: `packages/song-schema/src/schemas/vocals.ts`
- Test: `packages/song-schema/test/vocals.spec.ts`

**Interfaces:**
- Produces: `VocalsSettingSchema = z.object({ enabled: z.boolean(), voice: z.string().min(1), takeNumbers: z.record(z.string(), z.number().int().min(1)) }).strict()`; `SongSchema` gains `vocals: VocalsSettingSchema.optional()` (absent = off, as for songs made before this feature). Exported `VocalsSetting`.

- [ ] **Step 1: Test** `vocals.spec.ts`: a song without `vocals` parses and has none; `{enabled:true, voice:'en_prompt', takeNumbers:{chorus1:2}}` round-trips; an unknown key inside `vocals` fails; `takeNumbers.chorus1 = 0` fails.
- [ ] **Step 2:** Run `pnpm -C packages/song-schema test -- vocals` → FAIL. Implement. Run → PASS. Build the package (`pnpm -C packages/song-schema build`).
- [ ] **Step 3:** Commit.

### Task 3: Brain: a section's SoulX score and its fingerprint (pure)

**Files:**
- Create: `apps/brain/src/vocals/score.ts`
- Test: `apps/brain/test/vocalScore.spec.ts`

**Interfaces:**
- Produces:
  - `interface Phrase { startSec: number; phoneme: string[]; duration: number[]; notePitch: number[]; noteType: number[] }`
  - `interface SectionScore { segment: string; lengthSec: number; phrases: Phrase[] }`
  - `sectionScore(song: Song, segment: string): SectionScore | undefined` (undefined: the section has no lead vocal notes)
  - `soulxPhones(arpabet: readonly string[]): string` (`['k','ih0','ng']` → `en_K-IH0-NG`)
  - `TAKE_SETTINGS = { model: 'soulx-singer', steps: 32 } as const`
  - `takeFingerprint(score: SectionScore, voice: string, takeNumber: number): string` (sha256 hex of the stable JSON of `{v: 1, settings: TAKE_SETTINGS, voice, takeNumber, phrases}`)

- [ ] **Step 1: Tests** (`vocalScore.spec.ts`, songs built from the brightPop golden `packages/arrangement/test/fixtures/golden/orchestrate/brightPop/brightPop-vertical-slice.song.json`):
  - `soulxPhones(['k','ih0','ng'])` is `'en_K-IH0-NG'`; `soulxPhones([])` throws.
  - `sectionScore(song, 'verse1')`: phrases start at multiples of 4 bars' seconds unless a rest of ≥ 1 beat split them; every phrase's `duration` sums to its length; rests are `<SP>`/pitch 0/type 1; notes are type 2; pitches equal the song's vocal MIDI notes; `lengthSec` = bars × 4 × 60 / bpm.
  - A note whose `vocaloidPhonemes` is missing throws naming the section and bar.
  - A section without Vocal notes returns undefined.
  - `takeFingerprint` is equal for verse1 and verse2 of the golden (same notes) and changes with the voice, the take number, the bpm and a transposed key.
- [ ] **Step 2:** Run `pnpm -C apps/brain exec vitest run test/vocalScore.spec.ts` → FAIL. Implement. → PASS.
- [ ] **Step 3:** Commit.

### Task 4: Brain: singing takes, the vocals routes

**Files:**
- Create: `apps/brain/src/vocals/takes.ts`, `apps/brain/src/routes/vocals.ts`
- Modify: `apps/brain/src/config.ts` (`soulxServiceUrl` from `SOULX_SERVICE_URL`, `vocalTakesDir` from `BRAIN_VOCAL_TAKES_DIR`), the app wiring where other routers are mounted
- Create: `apps/brain/scripts/list-vocal-takes.mjs` (lists takes with size and the songs naming them; deletes only ids given on the command line)
- Test: `apps/brain/test/vocals.spec.ts`

**Interfaces:**
- Consumes: Task 3 (`sectionScore`, `takeFingerprint`, `TAKE_SETTINGS`), Task 1 routes, Task 2 `VocalsSetting`.
- Produces:
  - `class VocalTakes { constructor(cfg: { takesDir: string; serviceUrl: string; ffmpegBin: string; fetchImpl?: typeof fetch }); status(song: Song): SectionStatus[]; sing(song: Song, segment: string): Promise<AIArtifact>; takePath(fingerprint: string): string }`
  - `type SectionStatus = { segment: string; state: 'none' | 'current' | 'stale' | 'missing' }` (none: no vocal notes; current: an `aiArtifacts` soulx-vocal entry attached to `{scope:'segment', segment, instrument:'Vocal'}` whose `conditioning.hashes[0]` is the fingerprint now and whose file exists; stale: an entry with another fingerprint; missing: no entry)
  - Artifact written by `sing`: `{ id: 'vocal-<segment>-<fp12>', kind: 'soulx-vocal', modelId: 'soulx-singer', modelVersion: 'steps-32', seed: takeNumber, prompt: voice, conditioning: { hashes: [fp] }, output: { uri: 'vocal-take:<fp>.wav', sha256, lufs, durationSeconds }, attachedTo: { scope: 'segment', segment, instrument: 'Vocal' }, createdAt }`
  - Take file: `<takesDir>/<fp>.wav`, 44.1 kHz stereo PCM16, exactly `lengthSec` long, phrases at their `startSec`, normalised to -24 LUFS (ffmpeg `loudnorm`), written via a temp file and rename. An existing file with that fingerprint is reused without calling the service.
  - Routes: `GET /api/vocals/voices` (proxies `/voices`), `POST /api/vocals/status {song}` → `{sections: SectionStatus[]}`, `POST /api/vocals/sing {song, segment}` → `{artifact}`. 503 `vocals_not_configured` naming the missing env var; service unreachable → 502; service 4xx → 422 with its message.
- [ ] **Step 1: Tests** with a fake fetch that answers `/sing` with sine-wave WAVs and counts calls: status of a fresh song with vocals on is `missing` for vocal sections and `none` for the rest; `sing` writes a file of the right length and returns the artifact above; singing verse2 after verse1 reuses the file (no second service call); after changing bpm the status is `stale`; a service 422 becomes a 422 naming the phone; no `SOULX_SERVICE_URL` → 503 naming it.
- [ ] **Step 2:** Run → FAIL; implement; run → PASS. Run the brain suite once.
- [ ] **Step 3:** Commit.

### Task 5: Engine adapter: lower vocal takes to an `audioClips` instrument

**Files:**
- Create: `packages/engine-adapter/src/audio-clips.ts`
- Modify: `packages/engine-adapter/src/index.ts` (call it next to the loops lowering)
- Test: `packages/engine-adapter/test/audio-clips.spec.ts`

**Interfaces:**
- Consumes: Task 2 schema; artifacts as written by Task 4.
- Produces: when `song.vocals?.enabled`, one inst `{ id, name: 'Vocal', type: 'audioClips', lowLevelType: 'vocal', clips: [{ segment, key: 'take-<fp>.wav', sourcePath: '<CASPERAKI_VOCAL_TAKES_DIR>/<fp>.wav', durationSec }] }` with one clip per section that has a soulx-vocal artifact for instrument Vocal; `CASPERAKI_VOCAL_TAKES_DIR` unset while a clip is needed → throws naming it. Vocals off or absent → no inst (Vocal stays unlowered, as today). The id follows the adapter's id allocation for new insts.
- [ ] **Step 1: Tests:** vocals off → no audioClips inst; on with two artifacts → two clips with the keys/paths above; on without the env var → throws `CASPERAKI_VOCAL_TAKES_DIR`.
- [ ] **Step 2:** FAIL → implement → PASS; build the package; run its suite.
- [ ] **Step 3:** Commit.

### Task 6: Engine: play `audioClips` (browser and native)

**Files:**
- Modify: `apps/web/wasm/engine/src/Resolver.h` (`resolveAudioClips`), `apps/web/wasm/engine/src/audio/SampleLibrary.h` (`loadWaves` also registers each clip's `key` from `sourcePath`), the mixer lane gain for `lowLevelType: 'vocal'` (0 dB lane, own mute/solo lane named after the inst)
- Test: the engine's existing resolver/serialize checks (`apps/web/wasm/engine/scripts`), plus a new fixture song with one audioClips inst

**Interfaces:**
- Consumes: Task 5 inst shape.
- Produces: per clip a wave `Clip{name: segment, type: "wave", startSec: segment start, endSec: start + durationSec, source: key, loop: false}` on a track named `Vocal`.
- [ ] **Step 1:** Add the fixture (one 8-bar segment, one audioClips clip pointing at a generated 2 s sine WAV) and an expectation: the resolved dump has one Vocal track with one non-looping wave clip at the segment start; the native render of the fixture is not silent between 0 and 2 s and silent after.
- [ ] **Step 2:** Run → FAIL; implement; rebuild native (`cmake --build apps/web/wasm/engine/build`) and WASM (`apps/web/wasm/engine/build-wasm.sh`); run → PASS; existing engine checks still pass.
- [ ] **Step 3:** Commit.

### Task 7: Brain playback and render: serve takes, refuse stale vocals

**Files:**
- Modify: `apps/brain/src/render/playbackService.ts` (plan entries for audioClips clips: kind `wave`, key = clip key, spec `{ takePath }` resolved and guarded inside the takes dir), `apps/brain/src/routes/playback.ts` (before lowering: with vocals on, any `missing`/`stale` section → 409 `vocals_need_singing` with the section names and "Open the song and play it to sing its vocals"), `apps/brain/src/render/renderService.ts` and the playback lowering (pass `CASPERAKI_VOCAL_TAKES_DIR` to the emit script and the native render), render jobs refuse stale vocals the same way.
- Test: `apps/brain/test/playbackVocals.spec.ts`

**Interfaces:**
- Consumes: Tasks 4–6.
- [ ] **Step 1: Tests:** a song with vocals on and current takes → the plan has one `wave` entry per take whose sample file decodes; a stale take → 409 naming the section; a take path outside the takes dir → error; vocals off → plan unchanged.
- [ ] **Step 2:** FAIL → implement → PASS; brain suite once.
- [ ] **Step 3:** Commit.

### Task 8: Web: Vocals switch, voice, singing before play

**Files:**
- Create: `apps/web/src/api/vocals.ts`, `apps/web/src/editor/VocalsControl.tsx`, `apps/web/src/audio/singVocals.ts`
- Modify: the editor header (mount `VocalsControl`), `apps/web/src/audio/useLiveTransport.ts` (sing missing/stale sections before loading when vocals are on; progress text; on failure show the error and a "Play without vocals" button that plays a copy with `vocals.enabled = false`)
- Test: `apps/web/test/vocals.test.ts`

**Interfaces:**
- Consumes: Task 4 routes; the editor's song update path.
- Produces: `singMissing(song, onProgress): Promise<Song>` (status → sing each missing/stale section in order → the song with each section's artifact replaced); `withTake(song, artifact): Song` (replaces the Vocal artifact of that segment); `singAgain(song, segment | 'all'): Song` (bumps `takeNumbers`).
- [ ] **Step 1: Tests** for `withTake` (replaces, keeps other kinds and sections), `singAgain` (bumps one or all vocal sections), `singMissing` with a fake API (sings only missing/stale, reports "Singing chorus1 (2 of 3)").
- [ ] **Step 2:** FAIL → implement → PASS; web tsc and suite.
- [ ] **Step 3:** `VocalsControl`: a "Vocals" switch, a voice menu (from `/api/vocals/voices`), and per section its state with a "Sing again" button; plus "Sing all again".
- [ ] **Step 4:** Commit.

### Task 9: Live end to end

- [ ] **Step 1:** Deploy (`deploy/datigator/deploy.sh`) with `BRAIN_VOCAL_TAKES_DIR=/home/roli79/casperaki-data/vocal-takes` and `SOULX_SERVICE_URL` in brain.env; svc-soulx running.
- [ ] **Step 2:** Through the brain API (as the dev owner), take a generated song, switch vocals on, sing every section, check every take: length = section length, -24 LUFS ± 1, not silent where the section has notes; play plan includes the takes; a server render of the song includes the Vocal lane (non-silent stem where the vocal sings).
- [ ] **Step 3:** Update `docs/superpowers/specs/2026-11-24-sung-vocals-design.md` status, the services README (svc-soulx), and the memory note on the services (svc-soulx :16512 also not in start-services.sh).
