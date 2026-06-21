# 60 — In-browser WASM render port: phased plan (2026-06-16)

> Master plan for porting the **render** — everything `casperaki_engine` does
> downstream of `song.json` — to WebAssembly so the arranged song plays
> interactively in the browser with sound parity to the native offline render.
> Companion to [`50-engineering-plan.md`](./50-engineering-plan.md) (which earmarks
> this as the audio track's "Phase 0 spike + Phase 3 integration"). This doc is the
> *how* and *in what order*; **no implementation here**.

## What is and isn't being ported

- **`song.json` (+ `inst-N.json`) is the handover contract — unchanged.** The brain
  stays backend and keeps emitting the same schema it emits for the native engine.
- **The sample library stays backend.** The WASM client fetches sample files over
  HTTP (no disk pre-staging, no proxy cache, no CURL).
- **What ports to WASM = the entire render path** that `casperaki_engine` performs
  *after* `song.json`: sequencing/resolution → sampler → submix/aux-FX graph → master.
  This is a **re-implementation informed by** `~/apps/casperaki_engine`, **not** a
  wholesale lift: the Tracktion-coupled scheduling/routing and the sampler are rewritten;
  only self-contained plain-C++ DSP (the AirWindows ports, MIT-licensed) is compiled as-is.
  `Sequencer.cpp` will **not** compile under Emscripten as-is — it is `te::`-coupled.
- **Tracktion is dropped** — its Edit/Clip/Track/Renderer/proxy-cache model is editing
  infrastructure hostile to WASM and unneeded (the arrangement is already done). The small
  part it provided — a timeline scheduler and the submix/aux routing graph — is
  reimplemented.
- **JUCE is likely dropped too (bespoke), driven by licensing — not just the toolchain.**
  See [Licensing](#licensing--a-first-class-phase-0-axis) and Phase 0.

## Architectural spine

### song.json carries intent, not resolved events

`song.json` carries *composition intent* (chords, `arpeggio`/`noteRelative`/`EDMArpeggiator`
specs, drum-grid ASCII strings, sample **IDs**). The concrete MIDI notes, sample
placements, sustain-tail extension and velocity grids are resolved **engine-side** today
in `Sequencer.cpp` + `SequencerUtils.h`. Because the boundary is `song.json`, that
resolution ports **into the WASM engine** (C++), re-implemented from `casperaki_engine`
(the logic is `te::`-coupled today, so it is rewritten, not lifted).

### Licensing — a first-class Phase 0 axis

JUCE 8 is dual-licensed: **AGPLv3 _or_ a paid commercial license** (verified from the
JUCE 8 `LICENSE.md` — note 8.0.0 moved the free path from GPLv3 to **AGPLv3**, adding the
network/SaaS clause). The free path is AGPLv3-only and **does not permit closed-source**;
the commercial tiers are Starter (free, ≤ $20k/yr revenue), Indie ($40/user/mo, ≤ $300k/yr)
and Pro ($175/user/mo, no cap). Compiling "JUCE-lite" into a module **shipped to users'
browsers** is distribution of object code that triggers the copyleft — for a closed-source
commercial product that means **buying an Indie/Pro JUCE license or open-sourcing the
client**. That can push toward **fully-bespoke independent of whether JUCE compiles cleanly
under Emscripten**. So Phase 0's engine-base decision has two axes: (a) does the path
compile clean + emit a tone, and (b) what does shipping it cost legally.

What JUCE actually provides here is small and reimplementable:
- **Audio decode** (`AudioFormatReader`) → use the browser's own `decodeAudioData` on the
  main thread (fetched OGG/MP3/WAV → Float32 buffers, transferred into the worklet). Zero
  dependency, no GPL. Fallback: stb_vorbis / dr_libs (public domain).
- **Sampler** (`SamplerSound`/`Voice`, `LagrangeInterpolator`) → the voice model is simple
  (zone lookup + pitch-ratio Lagrange interp, already mapped in recon); reimplement.
- **Audio device** → a standard `AudioWorkletProcessor` pulling from the WASM module; we
  don't need JUCE's Emscripten device.

License posture of the rest:
- **AirWindows DSP — MIT.** Safe to compile into a shipped build; this is the bulk of FX.
  MIT still requires **carrying the copyright/permission notice** in the distributed client
  (a third-party-licenses page) — a bare `.wasm` does not satisfy attribution on its own.
- **SimpleSide — GPLv3** (Armando Montanez / `github.com/KottV/SimpleSide`; verified). It is a
  **tempo-synced volume/pan "pumping" automation** plugin (a faux-sidechain), *not* a
  sidechain-EQ. Do **not** lift its source into a shipped client; **reimplement its pumping
  behaviour** instead.
- **Tracktion Engine — GPLv3-or-commercial — moot** (dropped); shipping it closed-source would
  need both a Tracktion *and* a JUCE commercial license.

**Lean: bespoke, reimplementing the few JUCE pieces we need.** Phase 0's spike confirms
the bespoke path's feasibility rather than choosing between JUCE-lite and bespoke. If
JUCE-lite is ever reconsidered, a JUCE commercial license is a precondition, not an
afterthought.

### The mix is engine-side data, not in song.json

`fxGroup` assignment, per-group send levels (`FX.h`) and rack/plugin chains
(`PresetManager.h`) are compiled C++ constants — **not** in `song.json`. They port as
data tables baked into the WASM engine.

### Internal Resolved-Timeline IR + the dump oracle

Inside the engine, resolution produces a flat **Resolved-Timeline IR**:
`lane → [{ tAbs, sampleId | note+zone, gain, pan, durBeats, fxGroup }]`. This is an
*internal* structure, **not** an external seam (the external seam is `song.json`).

De-risking move: add a **"dump resolved events"** mode to the native harness
(`apps/engine-spike/native/harness.cpp`) that serializes its MIDI/sample schedule. The
WASM engine emits the same dump. Diffing the two validates the fuzziest part of the port
(musical resolution) **before** any audio comparison — a unit-test oracle for resolution,
distinct from the WAV-level A/B oracle for DSP.

This dump **isn't free**: the engine has **no IR today** — it goes `song.json` → `te::`
clips directly. Emitting it means instrumenting `Sequencer` where notes/samples get placed
and serializing that schedule (native-internals work, Phase 0) — not reading an existing
structure.

### Unified lane model

Everything is an audio lane: a sampler lane, an ACE-Step "lego" stem, and a
SAM-separated stem are all pre-decoded buffers on a track. N lanes flow through one
mix/FX graph; the graph is agnostic to a lane's origin. Design to this from day one.

### WASM constraints (carry the 57f lesson forward)

- **Never block the main thread.** Engine runs pull-based in an AudioWorklet (the
  WebAudio callback pulls blocks). No offline busy-loops — this is the structural
  version of the [57f](./57f-duplicate-lane-render-hang.md) hang.
- Start single-threaded; add WASM threads (Emscripten pthreads + SharedArrayBuffer +
  COOP/COEP headers) only if perf demands it.
- Sample loading = `fetch` → decode → buffers. No `AudioFileCache`/proxy machinery.
- No VST hosting; all DSP is compiled-in C++.

## Parity oracles

- **Resolution oracle:** native harness resolved-event dump (Phase 0) vs WASM engine dump.
- **DSP / golden-master A/B:** native offline WAVs in
  `apps/engine-spike/out/all-genre-render-smoke/{ballad,brightPop,edm,latin,organicVibes,rock,schlager,urban}/out.wav`
  (8 genres, 210 s). A dry/no-FX native reference is the Phase 1 target; full-FX goldens are the Phase 2 target.
- **⚠ The current goldens are stale.** They are June-14, **pre-57f-fix** (brightPop's is a
  partial render — wrong size, 54,630,192 bytes). They are parity targets only once
  **regenerated with the 57f-fixed engine**, which itself depends on resolving the
  `render-all-genres` background-driver bug (separate handover). **Phase 2 entry condition.**
- **⚠ "Within tolerance" is undefined and hinges on determinism.** The native engine calls
  `rand()` (e.g. `Sequencer::getDefaultSegmentBars`). Before relying on a sample-accurate
  WAV null-test, **confirm the native render is bit-reproducible for a fixed seed**:
  - if it **is** → tolerance = near-exact null with a defined dB floor for resampler/FX float drift;
  - if it **isn't** → the oracle must be **perceptual/statistical** (per-band RMS / spectral
    distance under a threshold), not a sample diff.
  Resolve this in Phase 0/1 — it determines whether the golden-master oracle even works.

## Phases

### Phase 0 — Foundations & de-risking
Resolve the engine-base fork and prove the pipeline end-to-end with *silence*.
- **Engine-base decision — two axes:** (a) **compiles + emits a tone** — `emcmake` + a
  bespoke `AudioWorkletProcessor` pulling from a minimal WASM DSP module (timeboxed);
  (b) **shipping-license cost** — see [Licensing](#licensing--a-first-class-phase-0-axis).
  Default lean: **bespoke**, reimplementing the few JUCE pieces. JUCE-lite is on the table
  only with a JUCE commercial license.
- **Determinism & tolerance:** determine whether the native render is bit-reproducible for
  a fixed seed (engine uses `rand()`), then **define "within tolerance"** accordingly
  (sample-accurate null + float-drift floor if deterministic, else a perceptual/statistical
  metric). Phase 1/2 done-criteria depend on this.
- COOP/COEP-capable serving in `apps/web` (Vite); worklet loads the WASM module and pulls
  blocks (silence is fine).
- **Resolved-event dump:** instrument the native `Sequencer` at note/sample placement and
  serialize the schedule (touches native internals — no IR exists today).
- **Deliverable:** engine-base decision doc (incl. licensing) + a determinism finding &
  defined tolerance + browser test-tone via the real pull-based path + a golden
  resolved-event dump file.

### Phase 1 — Lane/sampler engine (sampled lanes, no FX)
- Port resolution (`Sequencer`/`SequencerUtils`) into the WASM engine: chord/arp/
  `noteRelative` resolution, drum-grid expansion, sample-ID→asset resolution,
  sustain-tail, velocity grids. Validate against the resolution oracle.
- HTTP sample pipeline: backend manifest → `fetch` → decode → RAM buffers.
- WASM sampler: zone lookup + pitch-ratio resampling
  `rate = 2^((note−key)/12) × sr_file/sr_engine` (Lagrange interp), 32-voice model,
  per-voice gain/pan. Mix all lanes to master, **no FX**.
- AudioWorklet scheduler fires IR events per block.
- **Deliverable:** brightPop sample lanes play in-browser, timing + pitch matching a
  native dry/no-FX reference within tolerance.

### Phase 2 — Mix/FX graph (the parity phase)
**Entry condition:** the 8 genre goldens must be **regenerated with the 57f-fixed engine**
(the current ones are stale/partial — see Parity oracles), which depends on resolving the
`render-all-genres` background-driver bug. **And** the determinism/tolerance question
(Phase 0) must be settled. No parity work starts against stale goldens or an undefined
tolerance.
- Routing topology from `Sequencer.cpp`: per-lane 3 aux sends (reverb/delay/chorus) →
  per-`fxGroup` submix → master, plus the 3 aux returns.
- Port the DSP: compile the 10 in-tree AirWindows (`Source/airwindows_extras/`, MIT) +
  extract the 6 Tracktion-bundled AirWindows (Pyewacket, EQ, Logical4, NC-17, Thunder,
  ADClip7); **reimplement SimpleSide's tempo-synced volume/pan pumping** (GPLv3 — do not lift
  source into a shipped client); **replace ValhallaFreqEcho** (no source) with an in-tree
  freq-shift echo.
- Rack chains + send tables from `PresetManager.h` / `FX.h` as data.
- Add `signalProcessors` automation (LP sweeps, volume curves) + `transitions` one-shots.
- **Deliverable:** full-FX render matches the 8 native golden WAVs within tolerance.
  This is the project's definition of done for the engine.

### Phase 3 — Neural lanes + product integration
- ACE-Step lego stems and SAM stems as additional pre-decoded buffer lanes through the
  same graph (proves the unified model end-to-end).
- Wire the live engine into the `apps/web` Playbar (transport / seek / loop) as an
  alternative to the static-WAV path; loading/streaming UX.
- WASM threads (pthreads + SAB) only if perf demands.
- **Deliverable:** brain → `song.json` → interactive in-browser player, sampled + neural
  lanes through one mix/FX graph, no main-thread stalls.

## Decisions

| Decision | Status |
| --- | --- |
| Boundary = `song.json`; brain + samples stay backend | **Decided** |
| Render (resolution + sampler + FX) ports to C++/WASM, reusing `casperaki_engine` source | **Decided** |
| Drop Tracktion; reimplement scheduler + routing graph | **Decided** |
| Plan committed to docs | **Decided** (this doc) |
| JUCE-lite vs fully-bespoke | **Bespoke** — JUCE 8 = AGPLv3-or-commercial when shipped to browsers; Phase 0 confirmed bespoke feasibility (emcc standalone WASM, zero imports, tone in worklet) — see [docs/61](./61-phase0-decision.md) |
| SimpleSide (GPLv3) in a shipped client | **Reimplement its volume/pan pumping, don't lift source** |
| Audio decode | Browser `decodeAudioData` (main thread) → buffers; stb_vorbis/dr_libs fallback |
| Parity tolerance / determinism | **Open — settled in Phase 0** before Phase 2 relies on it |
| WASM threads | Deferred; single-threaded until perf demands |

## Key risks

- **Licensing, not just feasibility:** shipping JUCE to browsers triggers AGPL/GPL, and
  SimpleSide is GPL. A shipped client must be bespoke (or carry a JUCE commercial license)
  and must reimplement SimpleSide rather than lift it. This is a Phase 0 decision axis, not
  an afterthought.
- **Non-determinism could break the golden-master oracle:** the engine uses `rand()`, so a
  naive sample-accurate WAV null-test may be invalid. A determinism finding + a defined
  tolerance must precede Phase 2 (see Parity oracles).
- **Stale goldens:** the current golden WAVs are pre-57f/partial and must be regenerated
  (blocked on the `render-all-genres` driver bug) before Phase 2 can measure parity.
- **The bespoke worklet + WASM DSP pipeline** is the biggest technical unknown —
  front-loaded into the Phase 0 spike so it can't silently block the critical path.
- **Tracktion-coupled code in `Sequencer.cpp`** (track/submix/send wiring uses `te::`):
  the casperaki-specific scheduling intent is reusable as a guide, but the timeline/graph
  plumbing is reimplemented, not lifted.
- **ValhallaFreqEcho has no source** — Phase 2 must substitute an in-tree freq-shift echo;
  exact parity here is best-effort.
- **Sample-asset resolution** moves from disk pre-staging to an HTTP manifest; the
  ID→file mapping (currently in `engine-adapter` + `prestage-samples.mjs`) must be
  exposed as a backend manifest the WASM client can fetch.

## Source to mine (re-implement / compile from, not lift wholesale)

- `packages/{song-schema,arrangement,engine-adapter}` — the input contract + ID→asset mapping.
- `casperaki_engine/Source/instruments/{Synths,Bass,Guitar}.h` — sampler zone/voice logic.
- `casperaki_engine/Source/sequencer/Sequencer.cpp` (+ `SequencerUtils.h`) — resolution + routing topology.
- `casperaki_engine/Source/FX.h` — `lowLevelType`→`fxGroup` mapping + per-group send params.
- `casperaki_engine/Source/PresetManager.h` — rack chains per `fxGroup`/master.
- `casperaki_engine/Source/FXPluginRemap.h` + `Source/airwindows_extras/` — the in-process plugin set and AirWindows ports.
- Parity reference: `apps/engine-spike/native/harness.cpp` → `out/.../out.wav`.
