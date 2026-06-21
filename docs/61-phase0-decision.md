# 61 — WASM render port, Phase 0 decision doc (2026-06-16)

> The committed deliverable that **gates Phase 1** of the in-browser WASM render
> port ([`60-wasm-render-port-plan.md`](./60-wasm-render-port-plan.md)). Phase 0 set
> out to resolve the engine-base fork, settle the parity-oracle questions, and
> prove the browser pipeline end-to-end. All four deliverables are in; the
> verdicts and their evidence are below. **Do not start Phase 1 before this doc
> is committed** (per the Phase 0 charter) — it is.

## TL;DR

| Question | Verdict |
| --- | --- |
| Engine base: JUCE-lite or bespoke? | **Bespoke.** Driven by licensing *and* confirmed feasible. |
| Does the bespoke WASM path compile + emit a tone? | **Yes.** emcc 6.0.0 → standalone WASM, **zero imports**, instantiated in an AudioWorklet, tone renders. |
| Is the native render bit-reproducible for a fixed seed? | **No.** Two identical-input renders differ (empirical md5 + root cause). |
| So what is "within tolerance"? | **Not a sample-exact null.** Pitch/timing/structure compare exactly; **velocity/dither need a deterministic-RNG fix or a perceptual/statistical tolerance**. |
| Licensing of the shipped client? | Only **AirWindows (MIT)** is safe to compile in. JUCE 8 (AGPLv3) and Tracktion (GPLv3) need commercial licenses; **SimpleSide (GPLv3) must be reimplemented**. |

## 1. Engine-base decision — **bespoke**

Two axes, both resolved toward bespoke:

**(a) Compile-clean / emits-a-tone — PASS.** The bespoke path was proven, not assumed:
- `apps/web/wasm/tone.c` — a pure-C stereo sine generator, **no JUCE**, static block
  buffers (no malloc) → built by `apps/web/wasm/build.sh` with **Emscripten 6.0.0**
  (`emcc … -sSTANDALONE_WASM=1 --no-entry`) to `apps/web/public/wasm/engine-tone.wasm`
  (7,144 bytes).
- Verified it **instantiates with an empty import object** — `WebAssembly.Module.imports()`
  returns `[]`. No JS glue, no WASI shims. That is the crux: a standalone DSP module an
  `AudioWorkletProcessor` can `WebAssembly.instantiate(bytes, {})` directly. `dsp_render()`
  produces a real sine (verified sample values in Node).
- `emcmake` is on PATH (`~/emsdk/upstream/emscripten/emcmake`), so the CMake-driven port of
  the real engine in Phase 1 has its toolchain ready.

**(b) Shipping-license cost — favours bespoke regardless of (a).** See §4. JUCE 8 is
AGPLv3-or-commercial; shipping even a JUCE subset in the client `.wasm` is distribution that
triggers copyleft. Bespoke avoids that entirely. **If JUCE-lite is ever reconsidered, an
Indie/Pro JUCE license is a precondition, not an afterthought.**

> Consequence for Phase 1: `Sequencer.cpp` and the sampler are **re-implemented from**
> `casperaki_engine`, not lifted (they are `te::`-coupled). Only self-contained MIT DSP
> (AirWindows) compiles as-is.

## 2. Determinism & tolerance — **non-deterministic; null-test invalid as-is**

**Root cause (code).** The engine's resolution RNG is not seeded deterministically:
- `SequencerUtils.h:73` — `inline j::Random randomNumberGenerator{}` is **default-constructed,
  which seeds from `Time::getHighResolutionTicks()`** (wall clock). It drives velocity
  humanization at `SequencerUtils.h:653`:
  `velocity += (randomNumberGenerator.nextInt(127) - 65) / 5;` → **velocity grids differ every
  process run.**
- `Sequencer.cpp:710` — `int iRand = rand() % 10;` in `getDefaultSegmentBars` uses libc
  `rand()`. There is **no `srand()` anywhere** in the engine, so this stream *is* stable
  (effective seed 1) across runs — but it is the exception, not the rule.
- The AirWindows FX use `rand()` for float dither (e.g. `fpdL = rand()*UINT32_MAX`) — FX-path
  only (Phase 2), tiny amplitude, but still not sample-stable.

**Empirical confirmation.** `scripts/determinism-check.sh` rendered the **same** brightPop
envelope **twice** through the (57f-fixed) native engine with the **same sample bytes**
(stub server serving identical files), isolating the engine RNG as the only variable:

```
run1 md5 = 2974c9382f44c44188f351d26d053c4b   (55,566,816 bytes)
run2 md5 = cb06ef93294b6b58fdb66222db92ec4e   (55,566,816 bytes)
VERDICT: DIFFER — first differing byte at offset 439 (immediately after the 44-byte WAV
header), 45,150,207 / 55,566,816 bytes differ.
```

The audio diverges in the very first block. **A sample-accurate WAV null-test against a single
golden is therefore invalid as the parity oracle.**

**Definition of "within tolerance" (resolves the open item in `docs/60`):**
1. **Preferred — make resolution deterministic in the port.** The WASM engine owns its RNG;
   seed it from a fixed seed (or the song hash) so a given `song.json` resolves identically
   every run. With deterministic resolution + deterministic DSP, the oracle becomes a
   **near-exact WAV null** with a small dB floor (≈ −90 dBFS) for resampler/FP-order drift
   between native and WASM math. **This is the recommended path** and the engine-base
   re-implementation is the natural place to do it. *(It also implies regenerating goldens
   from a determinised native build, or accepting that native goldens only match the WASM
   engine band-wise — see (2).)*
2. **Fallback — perceptual/statistical tolerance.** If native and WASM cannot be made
   bit-identical, compare with **per-band RMS and spectral distance under a threshold** (e.g.
   per 1/3-octave band RMS within ±0.5 dB, log-spectral distance below a fixed bound), **not**
   a sample diff.

**Corroboration from the resolution oracle (below):** the dump's *pitch / start-beat /
length / structure* fields are stable run-to-run; only **velocity** carries the humanization
RNG. So the resolution oracle is exact for note identity & timing and tolerance-only for
velocity — a useful split: Phase 1 can hard-assert pitch/timing and soft-assert velocity.

## 3. Resolved-event dump (resolution oracle) — **golden produced**

`native/harness.cpp` gained a `SPIKE_DUMP_EVENTS=<path>` mode (`dumpResolvedEvents`). It walks
the **fully-resolved `te::Edit`** *after* the 3 s settle (so async drum-pattern fills are in,
before the render) and serializes the schedule to JSON
(`schema: casperaki/resolved-events/v1`). It reads the resolved `te::` clips from the harness
— **no `casperaki_engine` source is touched.** Regenerate with
`scripts/dump-resolved-events.sh [genreDir]`.

Golden for brightPop (`out/.../brightPop/resolved-events.json`, gitignored artifact):
**15 tracks · 5,862 MIDI notes · 364 drum step-hits · 15 sample clips · 210.0 s.**
Tracks: `Loop, Sample Transitions FX, Synths 3/2/1, Guitar(strums), PluckedSynths, Pad, Keys,
Bass(long/short notes), Drums-rest/toms/snares/kicks`.

Representative shape (excerpt):
```jsonc
// MIDI lane — note identity + beat timing exact; velocity carries RNG
{ "name": "Synths 3", "clips": [
  { "name": "intro", "type": "midi", "startSec": 0.0, "endSec": 16.0, "noteCount": 32,
    "notes": [ { "n": 55, "name": "G3", "startBeat": 0.0, "lenBeats": 0.5, "vel": 114 }, … ] } ] }
// Drum lane — StepClip channels + per-step hits with velocity
{ "name": "Guitar(strums)", "clips": [
  { "type": "step", "channels": [ { "note": 48, "name": "C_1_chordShortStrumDown" } ],
    "patterns": [ { "name": "…", "numSteps": 16, "hits": [ { "ch": 0, "step": 0, "vel": … }, … ] } ] } ] }
// Sample lane — source asset + absolute placement
{ "name": "Loop", "clips": [ { "name": "verse1", "type": "wave", "startSec": 16.0, "source": "playsample-50000.ogg" } ] }
```

The WASM engine emits the same schema; diffing the two validates musical **resolution**
independently of any audio comparison — the fuzzy-part oracle the plan asks for.

## 4. Licensing verdict (first-class Phase 0 axis)

Context: the client `.wasm` is **distributed to end users' browsers** — that is conveying
object code, the strongest copyleft trigger. Verified against primary sources (LICENSE files /
official pricing):

| Component | License | Shipping a closed-source WASM client | Verdict |
| --- | --- | --- | --- |
| **JUCE 8** | **AGPLv3** or commercial (8.0.0 moved GPLv3→AGPLv3) | AGPLv3 forces source disclosure; tiers: Starter free ≤ $20k/yr, Indie $40/mo ≤ $300k/yr, Pro $175/mo no cap | **needs commercial license** → avoid by going bespoke |
| **AirWindows DSP** | **MIT** | None beyond carrying the copyright/permission notice (third-party-licenses page) | **safe to compile in** |
| **Tracktion Engine** | **GPLv3** or commercial | GPLv3 forces disclosure; needs Tracktion *and* JUCE commercial licenses | **needs commercial license** → moot (dropped) |
| **SimpleSide** | **GPLv3** (A. Montanez / KottV) | Strong copyleft; cannot embed | **must reimplement** — it's a tempo-synced **volume/pan "pumping"** plugin, *not* a sidechain-EQ |

**Net:** of the four, only **AirWindows (MIT)** may be compiled into the shipped client. This
**independently mandates the bespoke engine base** (no JUCE in the client) and that
**SimpleSide's pumping behaviour be reimplemented**, not lifted. `docs/60` updated to match
(JUCE 8 = AGPLv3; SimpleSide = pumping, not EQ; AirWindows attribution).

## 5. Browser pipeline — COOP/COEP + pull-based AudioWorklet

The structural 57f lesson ("never let the engine drive itself") is baked in from day one:
- `apps/web/vite.config.ts` now sends **`COOP: same-origin` + `COEP: require-corp`** on dev
  *and* preview → `crossOriginIsolated === true`, the precondition for SharedArrayBuffer + WASM
  threads in Phase 3. The same-origin `/api` proxy is unaffected. *(Caveat: `require-corp`
  blocks cross-origin subresources lacking CORP/CORS; switch to `credentialless` if a
  third-party asset breaks.)*
- `apps/web/public/worklets/engine-tone-worklet.js` — an `AudioWorkletProcessor` that
  instantiates the WASM module (empty imports) and, on each `process()` call, **pulls** one
  128-frame block from `dsp_render()`. The WebAudio render thread drives the engine; nothing
  blocks the main thread; silence is emitted until the module is ready. This is the real
  pull-based path the engine port will use, not a mock.
- `apps/web/src/pages/WasmTonePage.tsx` (`/wasm-tone`, dev route) wires it together behind a
  Play button (AudioWorklet needs a user gesture) and surfaces `crossOriginIsolated`.

Headless verification (Vite dev server): `/` and `engine-tone.wasm` both return the COOP/COEP
headers; `engine-tone.wasm` serves as `application/wasm`; the worklet serves as
`text/javascript`. **Not verifiable headlessly:** *audible* output — that needs a real browser
with an audio device (manual check: open `/wasm-tone`, click Play, confirm a 440 Hz tone and
`crossOriginIsolated: true`).

## Deliverable checklist (Phase 0 charter)

- [x] **Engine-base decision doc incl. licensing** — this doc + `docs/60` updates. → **bespoke**.
- [x] **Determinism finding + defined tolerance** — non-deterministic (empirical md5 + cause);
  tolerance = deterministic-RNG-then-null (preferred) or per-band RMS/spectral (fallback).
- [x] **Browser test-tone via the real pull-based path** — built, COOP/COEP + serving verified
  headlessly (audible check is the one manual step).
- [x] **Golden resolved-event dump** — `dumpResolvedEvents` + `dump-resolved-events.sh`;
  brightPop golden = 15 tracks / 5,862 notes / 364 step-hits / 15 wave clips.

## Carry-forward into Phase 1 / Phase 2

- **Determinise the WASM engine's RNG** (fixed/song-hash seed) so the golden-master oracle can
  be a near-exact null; otherwise commit to the per-band tolerance up front.
- **Phase 2 still blocked on fresh goldens** (`docs/60` §Parity oracles): the existing
  `out/all-genre-render-smoke/*/out.wav` are pre-/partial-57f and, per §2 here, also
  velocity-non-deterministic — regenerate from a **determinised** native build, which depends
  on the `render-all-genres` background-driver bug (separate handover).
- **Extend the dump to all 8 genres** as Phase 1 resolution fixtures (one command per genre).
- The new spike files live under `apps/web/wasm/`, `apps/web/public/{wasm,worklets}/`, and
  `apps/engine-spike/scripts/{determinism-check,dump-resolved-events}.sh`; the harness dumper
  is in `native/harness.cpp`.
