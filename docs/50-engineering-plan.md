# 50 — Phased engineering plan: the Casperaki rebuild

> Execution plan for rebuilding Casperaki as a modern pnpm/TypeScript monorepo while
> preserving the deterministic **brain → `song.json` → engine** contract and adding
> AI content (ACE-Step 1.5, SoulX-Singer). Companion to the proposal in
> This doc is the master rebuild plan: the *how* and *in what order*.
> Build code, not just docs — but **no implementation here**, this is the plan.

## Guiding principles

1. **The schema is the spine.** `packages/song-schema` is built first and everything
   depends on it. The brain emits it, the engine consumes it, the web edits it, the
   AI models annotate it. Every phase boundary is a `song.json` it can produce or read.
2. **Determinism is a tested property, not an aspiration.** Same inputs (incl. an
   explicit `seed`) → byte-identical `song.json`. This is asserted from Phase 1 onward
   and never regressed. AI content is layered so it never breaks reproducibility of the
   procedural skeleton (AI outputs are captured as cached artifacts referenced by id/hash).
   New code uses `bpm` as the global tempo field name; legacy `tempo` is accepted only
   at adapter boundaries and normalized with diagnostics.
3. **De-risk the audio path early.** The WASM engine build is the single biggest
   unknown; it gets a spike in Phase 0 and a full integration in Phase 3, run in
   parallel with brain work so it can't silently block the critical path.
4. **Two parallel tracks.** A **TS/procedural track** (schema → brain → web) and an
   **audio/AI track** (engine WASM + models integration) run concurrently and meet at
   the `song.json` seam. This is the primary axis for splitting Claude/Codex work.
5. **AI performs into Casperaki's structure.** ACE-Step is not primarily prompt-from-
   scratch. The primary workflow is: deterministic `song.json` -> engine guide render /
   stems -> ACE-Step conditioned generation -> cached AI artifact attached back to the
   song. Casperaki supplies tempo, harmony, groove, and section shape; transformer
   models add fluidity, timbre, and performance life.

## Dependency graph (phases)

```
P0 Foundation ─┬─▶ P1 song-schema ─┬─▶ P3 Brain ───┬─▶ P5 Web UI ──▶ P6 AI performance ──▶ P7 Harden
               │                   │               │                     ▲
               └─▶ P2 Engine WASM ─┴───────────────┴─────────────────────┘
                       (spike in P0, full in P2 — runs alongside P1/P3)
```

- **P0** unblocks everything (monorepo + engine spike), but it has two sub-tracks:
  **P0a** monorepo foundation and **P0b** engine spike.
- **P1** (schema) gates **P3** (brain) and **P2** (engine wrapper validates against it).
- **P1 can start as soon as P0a is stable**; it does not need to wait for the P0b
  engine spike, only for fixture paths/contracts to be identified.
- **P2** (engine WASM) and **P1/P3** are independent — run in parallel.
- **P5** (web) needs both a brain (data) and an engine (audio).
- **P6** (AI) needs the brain flow to exist as integration points; the models app
  itself (this repo) is already built and can be hardened in parallel from P0.

---

## Phase 0 — Foundation & engine de-risking spike

**Goal:** Stand up the monorepo skeleton in `open_teamsuzie` style and prove the engine
can build to WASM before committing to the full rebuild shape.

**P0a - Monorepo foundation deliverables**
- `pnpm-workspace.yaml` declaring `apps/*`, `packages/*` tiers; root `package.json`
  with workspace scripts (`dev`, `build`, `typecheck`, `test`), shared `tsconfig.base.json`,
  and Vitest config. ESLint/Prettier can follow the house template where trivial, but
  should not block the first schema/engine proof.
- Current single-package app **moved to `apps/models/`** (this repo's `src/web`,
  `src/server`, `services/`).
- Empty but wired-up package shells: `packages/song-schema`, `packages/music-theory`,
  `packages/arrangement` (each builds and is importable).
- `link:` wiring to `../open_teamsuzie` shared packages (`@teamsuzie/ui`, `types`,
  optionally `db-sqlite`, `shared-auth`, `agent-loop`, `skills`).

**P0b - Engine spike deliverables**
- `engine/` git submodule(s) initialized
  (`casperaki_engine` + its `tracktion_engine`/`matchering`/`choc` submodules);
  Emscripten SDK installed; attempt the `make-wasm-great-again` / WASM target build.
  Produce a written **spike report**: does it build? what bit-rot? toolchain pinned?
- Decision record: monorepo root layout (promote `casperaki` to root vs. nest), and
  render-target stance (WASM-only vs. WASM + native service fallback).

**Risks / unknowns**
- ⚠️ **Engine WASM build is the top risk.** Docs note "expect to spend time getting it
  to build" and recent commits suggest bit-rot. The spike exists to surface this *now*.
  Fallback: native `server_app`/`LinuxApp` headless render service if WASM is infeasible.
- Emscripten + JUCE/Tracktion version drift; Projucer vs. CMake friction.
- `@teamsuzie/ui` and other linked packages may assume conventions the models app
  doesn't yet follow; `link:` resolution across a workspace can be fiddly.

**Consult**
- [`30-reference-architecture.md`](30-reference-architecture.md) (monorepo conventions),
  [`13-models-layer.md`](13-models-layer.md) (current app structure being moved).
- [`11-legacy-audio-engine.md`](11-legacy-audio-engine.md) (build targets, submodules,
  branches, `LibWASM/casperaki-web-tester`).
- `../open_teamsuzie/docs/ARCHITECTURE.md`, `pnpm-workspace.yaml`, `apps/starters/`.
- Repo memory: `blackwell-model-integration-gotchas`, `casperaki-serving-architecture`.

**Acceptance criteria**
- `pnpm install && pnpm -r build && pnpm -r typecheck` succeed from root.
- `apps/models` runs (API `:16400`, web `:16401`) exactly as before the move.
- Empty packages import cleanly across apps.
- Spike report committed with a **go/no-go on WASM** and a pinned toolchain (or a
  documented fallback to native render service).

**Parallel work (Claude ∥ Codex)**
- **A (TS/infra):** monorepo scaffolding, workspace wiring, moving the models app.
- **B (audio):** engine submodule init + WASM build spike + report.
  These share no files and can run fully concurrently.

---

## Phase 1 — The contract: `packages/song-schema` ★ highest leverage

**Goal:** One canonical, versioned `song` schema (TS + Zod + JSON Schema) that both
legacy envelopes (brain `songs.details` JSONB and engine `song.json` + `inst-*.json`)
serialize to, with fixtures proving round-trip fidelity.

**Deliverables**
- Canonical TypeScript types + Zod schemas for: top-level song, `songStructure`,
  `arrangement` (segments, `instruments`, `overrides`, `fills`, `mutes`,
  `signalProcessors`, `transitions`), note-event union (`note`, `chord`,
  `noteRelative`, `EDMArpeggiator`, `virtualGuitarist`, vocal notes w/ phonemes),
  drum-fill ASCII grids, and `inst-*.json` instrument definitions.
- `schemaVersion` field; **v1 pinned to "what the engine `Sequencer` parses today"** so
  the existing engine keeps working unmodified.
- Generated **JSON Schema** export for cross-language (C++ engine) validation.
- `canonicalStringifySong(song)` (or equivalent) that produces stable sorted-key JSON;
  determinism tests assert byte-identical output only through this canonical serializer.
- **Adapters:** canonical ↔ legacy-brain-JSONB and canonical ↔ engine-`song.json`/`inst-*`.
- **Fixture corpus:** import the engine's `e2etest/*.json` and the WASM tester's
  `src/assets/songs/1/song.json` + `inst-*.json`; validate all against the schema.
- Round-trip + determinism test suite (parse → serialize → re-parse is stable;
  canonicalization produces stable byte output, e.g. sorted keys).

**Risks / unknowns**
- The two legacy shapes differ in subtle ways (e.g. note keys as bar-beat strings,
  legacy `tempo` vs canonical `bpm`, display-name vs `lowLevelType` keying). Reconciling without a
  running brain/engine to diff against is error-prone — fixtures mitigate.
- Chord grammar breadth (40+ types) and note string/MIDI duality must be captured exactly.
- Risk of over-modeling: v1 must match *current* behavior, not an idealized schema.

**Consult**
- [`20-song-data-format.md`](20-song-data-format.md) (the authoritative shape — this is
  the primary source).
- [`10-legacy-backend-brain.md`](10-legacy-backend-brain.md) §"Song data model"
  (`songs.details` envelope).
- [`11-legacy-audio-engine.md`](11-legacy-audio-engine.md) (`Sequencer`, `Chord.h`,
  supported note types — the ground truth for what v1 must parse).
- Legacy fixtures: `casperaki_engine/e2etest/*.json`,
  `casperaki_engine/LibWASM/casperaki-web-tester/src/assets/songs/1/`.

**Acceptance criteria**
- Every legacy fixture validates against the Zod schema.
- Canonical → engine-`song.json` adapter output is byte-accepted by the (Phase 2) WASM
  engine `setSong()` for at least one full song.
- JSON Schema generated and validates the same fixtures from a non-TS validator.
- Determinism test: serializing the same canonical song twice yields identical bytes.

**Parallel work**
- Single-owner package by nature (one schema, one author) to avoid drift, BUT:
  - **A:** core schema + Zod + JSON Schema generation.
  - **B (parallel):** fixture extraction/curation from legacy repos + adapter for the
    engine envelope (validated by B's own engine work in P2).

---

## Phase 2 — Engine as a WASM dependency

**Goal:** A reproducible WASM build of `casperaki_engine` wrapped in a thin TS module
that `apps/web` can drive, repointed at the new brain for samples.

**Deliverables**
- Reproducible engine WASM build (documented toolchain; ideally CI-buildable). Decide
  Projucer vs. CMake migration based on the P0 spike.
- TS wrapper module mirroring `LibWASM/casperaki-web-tester`: `setSong(song)`,
  transport (`play/pause/stop/seekTo`, tempo), `ControlState` 50 Hz callback bridge,
  instrument mute/volume, and export-to-WAV.
- Sample/VST API client **repointed** from `staging.casperaki.com` (JWT) to the new
  brain's sample endpoints; sample pre-cache flow.
- A minimal standalone harness page that loads a Phase 1 fixture song and plays it
  (proves browser audio end to end, independent of `apps/web`).
- **(Conditional)** native headless render service build (`server_app`/`LinuxApp`) if
  P0 decided "both" for high-quality/offline bounce.

**Risks / unknowns**
- ⚠️ Same WASM build risk carried from P0; this phase is where it's fully paid down.
- Browser audio glitches, threading/SharedArrayBuffer/COOP-COEP headers, memory limits
  for large sample sets.
- Sample API contract: the engine expects a specific download/stream shape — the brain
  must implement it (couples P2 and P3 at the sample endpoint).
- VST hosting in WASM: bundled `ExternalPlugins/Mac/*.vst` are native — confirm what
  actually works in the WASM target vs. desktop.

**Consult**
- [`11-legacy-audio-engine.md`](11-legacy-audio-engine.md) (entire doc: `CasperakiEngine`,
  `ControlState`, `CasperakiApi`, `SamplesDownloadTask`, WASM tester, branches).
- [`20-song-data-format.md`](20-song-data-format.md) (what `setSong` must accept).
- `casperaki_engine` branches: `make-wasm-great-again`, `wasm-rebuild`.
- Phase 1 schema + engine adapter (the bytes `setSong` receives).

**Acceptance criteria**
- WASM build reproducible from documented steps (and/or CI green).
- Harness page plays a Phase 1 fixture song in-browser with the `ControlState` callback
  driving a playhead, and exports a WAV.
- Sample loading works against a stub/real brain sample endpoint.
- Determinism check: rendering the same `song.json` twice yields identical (or
  perceptually identical within documented tolerance) audio output.

**Parallel work**
- This is the **audio track**, run entirely in parallel with P1/P3 (TS track). Owned by
  the engine-focused agent. Only sync point with the TS track is the sample-endpoint
  contract (define it as a stub early so both sides proceed).

---

## Phase 3 — Brain: `apps/brain` + `packages/{music-theory,arrangement}`

**Goal:** A new Express+TS service that deterministically generates canonical
`song.json`, porting the legacy procedural generators and dropping the legacy ops
baggage (REAPER/S3/Passport/Sequelize-5).

**Deliverables**
- `packages/music-theory`: chord/note/scale primitives ported from engine `Chord.h` /
  `Note.h` logic (chord-symbol → semitone intervals → MIDI), with tests.
- `packages/arrangement`: procedural generators ported from the JS brain —
  `SongStructureClass`, `ChordsClass` (+ `chords.json`/`precedents.json`),
  `ArrangementsClass` orchestration, per-instrument pattern generators
  (bass/guitar/pad/piano/string/synth/brass + drum rules), lyric/phoneme generation
  (`getSyllables`, CMU→Vocaloid). **All seeded for determinism.**
- `apps/brain`: Express 5 (`index.ts`/`config.ts`/`bootstrap.ts`) exposing generation
  endpoints (structure, chords, arrangement, patterns, vocals/melody, full song) that
  emit canonical `song.json`. Persistence via **SQLite (`@teamsuzie/db-sqlite`)** or
  Postgres if multi-tenancy is needed.
- **Sample/instrument catalog** + the sample-download/stream endpoint the engine calls
  (closes the P2 contract). Instrument selection (`lowLevelType` → catalog) stays
  server-side.
- **Asset-bank strategy executed:** decide what of the ~3 GB legacy banks (pattern
  JSONs, `syllables.json` 21 MB, `lyrics.json`, sample audio) is actually needed; move
  to object storage, not git.
- Determinism harness: golden-file tests asserting `generate(seed, params)` →
  byte-identical canonical `song.json`.

**Risks / unknowns**
- ⚠️ **Determinism while porting JS→TS:** the legacy generators use `Math.random()`
  throughout; faithful reproduction *and* determinism requires threading a seeded RNG
  everywhere. Decide: bit-compatible-with-legacy output, or just internally
  deterministic (recommended — legacy parity is not worth bit-chasing).
- Scope: ~433 JS files, large pattern/melody data files. Prioritize the path that
  produces one good song per genre before breadth.
- Postgres `Instruments`/`Lyrics` data extraction from the legacy DB (may need a dump).
- Coupling to the engine's exact note semantics (durations, beat-position keys).

**Consult**
- [`10-legacy-backend-brain.md`](10-legacy-backend-brain.md) (the entire generation
  pipeline — primary source).
- `casperaki2-engine-js`: `api/v1.0/services/classes/` (ArrangementsClass, ChordsClass,
  SongStructureClass, pattern generators, LyricsSnippetsGeneratorClass, NotatorClass),
  `chords.json`, `precedents.json`, `instrumentGroups.json`, melody/rhythm pattern data.
- [`20-song-data-format.md`](20-song-data-format.md) + Phase 1 schema (the output target).
- **Drop list:** RendererClass/RenderProcess (REAPER), S3 creds, Passport, Sequelize-5,
  ffmpeg director (defer).

**Acceptance criteria**
- `apps/brain` generates a canonical `song.json` that (a) validates against
  `song-schema` and (b) plays through the Phase 2 WASM engine.
- At least one fully-arranged song per a chosen set of genres (e.g. edm, pop, ballad).
- Determinism golden tests pass: identical seed → identical output across runs/machines.
- No REAPER/S3/Passport/Sequelize dependencies; secrets via env, none hardcoded.

**Parallel work**
- **A (music-theory):** chord/note port + tests — self-contained, start immediately
  after P1.
- **B (arrangement generators):** depends on A's primitives; pattern generators can be
  split per-instrument-family across two agents.
- **C (brain service + catalog/sample endpoint):** the Express shell, persistence, and
  sample endpoint can be built against schema stubs in parallel with A/B; the sample
  endpoint is the contract the P2 audio track consumes.

---

## Phase 4 - SoulX vocals & notation path (decision-gated)

**Goal:** Resolve the vocal synthesis strategy, wire SoulX-Singer as the forward vocal
path, and preserve the legacy Notator path as a useful first-class salvage item.

**Deliverables**
- **Decision recorded** (vocal strategy decision):
  legacy Vocaloid-phoneme path vs. **SoulX-Singer** (forward path). Define how
  lyrics + melody from the brain feed the chosen synthesizer.
- Brain → SoulX-Singer integration: map canonical vocal notes (melody + lyric +
  phoneme/timing) to SoulX-Singer inputs; capture rendered vocal stems as cached
  artifacts referenced by id/hash in `song.json` (preserves determinism of the skeleton).
- **Notation lane:** preserve and port `NotatorClass` lead-vocal -> ABC -> PDF. This
  worked well in the legacy system and is valuable for song inspection, sharing, and
  musician-facing output. It can run as a parallel sub-task so it does not block the
  SoulX vocal proof.

**Risks / unknowns**
- SoulX-Singer input contract vs. legacy phoneme model — may need a melody/lyric
  alignment layer that doesn't exist yet.
- Determinism of AI vocals: treat as non-deterministic content cached by hash, not as
  part of the reproducible procedural core.
- This phase can be **deferred/parallelized** — it's gated on a decision, not on P3
  completion (only on the vocal-note schema from P1).

**Consult**
- [`10-legacy-backend-brain.md`](10-legacy-backend-brain.md) §3 (lyrics/vocals,
  `cmuToVocaloid.json`, phoneme embedding).
- [`13-models-layer.md`](13-models-layer.md) (SoulX-Singer adapter — already built).
- [`20-song-data-format.md`](20-song-data-format.md) (vocal note shape).
- `firelex/virtualsinger`, `firelex/diffsinger` (only if reviving synthesis path).

**Acceptance criteria**
- A decision doc committed; one end-to-end vocal generated from brain vocal data via
  the chosen path and referenced in a `song.json`.
- One lead-vocal notation fixture exports to ABC/PDF from canonical song data, preserving
  the useful legacy Notator behavior.
- Procedural determinism unaffected (vocal artifacts are referenced, not inlined-random).

**Parallel work**
- Owned by the **audio/AI agent** for SoulX; notation is a separate parallel sub-task
  once the P1 vocal-note schema exists.

---

## Phase 5 — Frontend: `apps/web`

**Goal:** Re-implement Rory's editors in React 19 + `@teamsuzie/ui`, driven by the brain's
`song.json` and the WASM engine for real playback.

**Deliverables**
- React 19 + Vite + React Router 7 app (`/api` proxy to brain) using `@teamsuzie/ui`.
- Editors re-implemented (Vue → React, interaction logic ported, framework not):
  timeline/arranger, structure editor, piano roll, drum machine, sound design, mixer,
  playbar, automation curve editor, publish surface.
- State driven by canonical `song.json` (load/save via brain; TanStack Query); **all
  edits mutate the schema**, not a local demo store.
- **Playback wired to the WASM engine** (Phase 2 wrapper) — replacing `setInterval`;
  `ControlState` callback drives the playhead; export buttons call real engine export.

**Risks / unknowns**
- Largest UI surface (~10k LOC of Vue reference). Porting fidelity vs. time tradeoff;
  prioritize piano roll + timeline + playbar (the core loop) first.
- Mixer was non-functional in legacy — needs real design against engine volume controls.
- Editing→`song.json`→engine `setSong` latency for interactive feel (incremental
  updates vs. full reload).

**Consult**
- [`12-legacy-frontend.md`](12-legacy-frontend.md) (component inventory, LOC, what's
  good — the UX spec).
- `casperaki-fe-rory`: `components/editor/{PianoRoll,DrumMachine,Playbar,Mixer,Publish}.vue`,
  `views/{Timeline,Structure,SoundDesign,Editor}.vue`, `components/app/*` toolkit.
- Phase 1 schema (the state model), Phase 2 wrapper (playback API).
- `../open_teamsuzie` starters + `packages/ui`.

**Acceptance criteria**
- Load a brain-generated song, edit it across editors, hear it play via the WASM engine,
  export audio — full loop with no demo-store stubs.
- Edits persist via brain and survive reload; the edited `song.json` re-validates.

**Parallel work**
- Editors are independent components — split across agents (e.g. A: piano roll +
  drum machine; B: timeline + structure + playbar; C: mixer + automation + publish).
- Depends on P3 (data) and P2 (audio); the audio track and TS track converge here.

---

## Phase 6 - AI performance layer & agentic assists

**Goal:** Wire `apps/models` into the flow so AI performs into Casperaki's deterministic
structure, plus optional natural-language editing.

**Deliverables**
- **ACE-Step 1.5 conditioned generation:** canonical `song.json` -> engine guide render
  or stems -> ACE generation conditioned on those files, so the output inherits tempo,
  harmony, groove, and section shape. Prompt-from-scratch remains useful for ideation,
  but the primary product workflow is Casperaki-guided ACE performance.
- AI artifact schema/provenance: model id/version, adapter version, prompt, seed/settings,
  conditioning render ids/hashes, output file hashes, timestamps, and source segment/stem
  references. Artifacts are cached and attached by reference so the procedural skeleton
  remains reproducible.
- SAM-Audio stems where useful; Matchering as the final master (bridges legacy engine
  master + models app master — pick one path).
- **(Optional)** natural-language editing ("make the chorus bigger") via `llm-proxy` +
  `agent-loop`, expressed as typed tools/skills that mutate canonical `song.json`.
- All AI outputs captured as cached artifacts (id/hash) so a song remains reproducible.

**Risks / unknowns**
- Determinism boundary: AI is non-deterministic; the architecture must keep the
  procedural core reproducible and treat AI as referenced content.
- GPU/serving ops (Blackwell sm_120 gotchas — see repo memory).
- Where AI "wins" vs. procedural is a product decision, not just engineering.

**Consult**
- [`13-models-layer.md`](13-models-layer.md) (adapters, generic `/api/services` lifecycle).
- [`30-reference-architecture.md`](30-reference-architecture.md) (llm-proxy, tools/skills/MCP).
- Repo memory: `casperaki-serving-architecture`, `blackwell-model-integration-gotchas`.

**Acceptance criteria**
- At least one ACE-conditioned path uses a Casperaki guide render/stem and produces
  generated audio that audibly follows the source tempo/harmony/structure, while the
  song still validates and plays; reproducibility of the procedural skeleton is
  demonstrably preserved.
- Matchering master applied to a final bounce.

**Parallel work**
- The models app itself is **already built** and can be hardened from P0 onward
  (independent track). Integration glue depends on P3/P5 existing.

---

## Phase 7 — Hardening, determinism CI, and cutover

**Goal:** Make the whole system reproducible, tested, observable, and documented; retire
legacy.

**Deliverables**
- CI: typecheck + Vitest across the workspace; engine WASM build; **determinism gate**
  (golden `song.json` + render hashes) blocking merges.
- End-to-end test: prompt/params → brain → `song.json` → engine → audio (+ optional AI).
- Docs refresh; `.env.example` complete; migration runbook; legacy repos archived per
  the salvage map.
- Performance pass (generation time, WASM render time, sample caching).

**Risks / unknowns**
- Determinism across machines/CI (RNG, float audio, library versions) — pin everything.
- Hidden legacy behaviors only surfaced under real load.

**Consult** — all prior phases and the salvage maps in the legacy docs.

**Acceptance criteria**
- Green CI incl. determinism gate; documented E2E passes; legacy decommissioned.

---

## Claude ∥ Codex parallelization matrix

Two persistent tracks meet at the `song.json` seam. Assign one agent per track; fan out
within a phase where noted.

| Phase | TS / procedural track (Agent A) | Audio / AI track (Agent B) | Sync point |
|---|---|---|---|
| P0 | monorepo scaffold, move models app | engine WASM spike + report | go/no-go on WASM |
| P1 | core schema + Zod + JSON Schema | fixtures + engine-envelope adapter | schema validates fixtures |
| P2 | (continues P1 / starts P3 prep) | WASM build + TS wrapper + sample client | sample-endpoint contract |
| P3 | music-theory → arrangement → brain | (continues P2) + sample endpoint consumer | brain `song.json` plays in engine |
| P4 | (continues P3 / starts P5) | SoulX vocal path; Notator lane in parallel | vocal/notation artifacts in `song.json` |
| P5 | editors split A/B/C | playback/export wiring | full edit→play→export loop |
| P6 | NL-edit tools/skills (optional) | ACE-conditioned generation, SAM, Matchering | AI artifacts referenced, song valid |
| P7 | determinism CI + E2E | engine build CI + render hashing | green determinism gate |

**Hard ordering constraints (cannot parallelize across):** P0 → P1 → P3 → P5 (data
spine); the audio track (P0 spike → P2 → P5 playback) runs alongside but must converge
at P5. P4 and P6 are decision-gated and can float once their P1 schema deps exist.

**Always-available parallel work (any phase):** hardening the existing `apps/models`
serving layer, fixture curation, and docs — none of these block the critical path.
