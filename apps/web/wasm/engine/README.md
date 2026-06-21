# casperaki WASM render engine (docs/60 Phase 1)

Bespoke C++ render engine that ports `casperaki_engine`'s `song.json` → render
path to WebAssembly (no JUCE/Tracktion — see [docs/61](../../../../docs/61-phase0-decision.md)
for the engine-base decision and the licensing rationale). Portable C++17: the
same headers build natively (for tests + the resolution oracle diff) and under
Emscripten (for the browser).

## Layout

- `src/Random.h` — deterministic RNG. Faithful transcription of `juce::Random`'s
  48-bit LCG, seeded from a fixed value or the song hash instead of the wall
  clock. This is **step 1** of Phase 1 (docs/61 §2): the engine owns its RNG so a
  given `song.json` resolves to the same velocity grid every run, which lets the
  golden oracle be a near-exact null.
- `src/ResolvedEvents.h` — the internal Resolved-Timeline IR.
- `src/Resolver.h` — `song.json` (+ inst-N.json) → ResolvedEvents. Ports the
  resolution logic from `Sequencer.cpp` / `instruments/*.h` (re-implemented, not
  lifted — the originals are `te::`-coupled). **Ported so far:** structure/
  timeline math. Header comments track the remaining increments.
- `src/Serialize.h` — ResolvedEvents → `casperaki/resolved-events/v1`, the same
  schema the native harness dumps, so the two can be diffed.
- `src/main_native.cpp` — CLI: envelope dir → resolved-events/v1 on stdout.
- `src/main_wasm.cpp` — embind `resolveSong(songJson, instJsons[])` for the
  browser.

## Build & test (native)

```sh
cmake -S . -B build && cmake --build build
ctest --test-dir build                           # random + audio + sampler + realsample
./build/casperaki_resolve <envelope-dir>         # emit resolved-events/v1
node scripts/validate-resolution.mjs [genre]     # diff resolution vs native oracle
./build/casperaki_render <envelope-dir> out.wav  # stereo master WAV (no FX), STUB samples
./build/casperaki_render <envelope-dir> out.wav '' <library-root>   # REAL sample library
node scripts/validate-audio.mjs [genre]          # IR-faithfulness energy oracle (stub)
CASPERAKI_SAMPLE_LIBRARY_ROOT=… node scripts/validate-audio.mjs     # … against the real render
node scripts/validate-wasm-parity.mjs [genre]    # wasm streaming mixer == native (stub PCM)
node scripts/validate-wasm-realsamples.mjs [genre]  # wasm real-sample ABI smoke (ffmpeg+lib)
```

`realsample_test` (ctest) and `validate-wasm-realsamples.mjs` SKIP-and-pass when
`CASPERAKI_SAMPLE_LIBRARY_ROOT` is unset (or ffmpeg is absent), so the suite stays
green on machines without the Dropbox library mounted.

`casperaki_render` is now a thin loop over the streaming **`Mixer`** (`audio/Mixer.h`):
the same mix core the browser worklet runs, OGG-decode-free (it consumes already-
decoded PCM). `casperaki_mixer_probe <dir> <stub-pcm-file> <numBlocks> <out-raw>` is
the native side of the wasm parity guard — it renders raw `Mixer::pullBlock` output
(no normalise) from stub PCM read out of a file, so the wasm build can be fed
byte-identical PCM and the two pull paths diffed.

`casperaki_render` takes an optional third arg for the stub sample dir (defaults
to `apps/engine-spike/samples`) and an optional fourth arg (or the
`CASPERAKI_SAMPLE_LIBRARY_ROOT` env var) for the **real** sample library root.

**Real sample library (docs/60 Phase 1 finish).** When a library root is given,
the render plays the actual multisample library instead of the stubs:

- **Join by id, in the mixer** (`audio/Mixer.h`): the join keys decoded PCM by a
  string id taken straight from the IR + inst-N.json — a tonal/bass slot's
  `samples[].id`, a drum step channel's sub-instrument name, a wave clip's
  resolved `playsample-<id>.ogg`, a guitar fret-noise note's `fx.fxFretNoise[n]`
  id, or a guitar strum note's `virtualGuitaristSamples[].id`. The mixer stays
  OGG/MP3-decode-free; it only looks samples up. Any id with no registered PCM
  (no library, or an unresolved lane) falls back to the role stub — so the
  no-library render is **byte-identical** to the stub-only path (verified across
  all 8 genres, including the guitar fret/strum tracks, which keep the per-note
  sampler structure and only swap each note's PCM when a real id is staged).
- **Decode + slice, in the host.** Natively, `audio/SampleLibrary.h` reads the
  envelope's `asset-manifest.json`, resolves each `relativePath` against the
  library root, decodes it (`audio/AudioDecode.h` → minimp3 for `.mp3`,
  stb_vorbis for `.ogg`), and **slices each tonal slot at the manifest's
  `[sliceStart, sliceEnd]` (seconds)** before binding it by id. One decode per
  file is cached across its slots. The two guitar pools mirror the legacy
  prestage (`apps/engine-spike/scripts/lib/{stage-guitar-strums,audio-slice,
  guitar-chord-alias}.mjs`): **fret-noises** cut the `Guitar.fretNoiseSibling`
  "Default FX" mp3 into N equal slices (one per `fxFretNoise[]` id); **strums**
  bind one whole pre-sliced chord/fx mp3 per `virtualGuitaristSamples[]` entry,
  resolved under the manifest's `Guitar.chordsAbsDir`/`fxAbsDir` (the chord root
  translated sharp→disk-canonical, e.g. `A#`→`Bb`). In the browser the same plan
  is built by the vite `/render-demo` middleware and the slices are cut from
  `decodeAudioData` buffers (see below).

With the library absent the stub fallback is unchanged (drums → kick/snare/hat,
else tone; bass → bass-c2; every other tonal/wave → tone): timing and relative
pitch faithful, timbres placeholder.

The oracle goldens are produced by
`apps/engine-spike/scripts/dump-resolved-events.sh <genre>` and live (gitignored)
under `apps/engine-spike/out/all-genre-render-smoke/<genre>/resolved-events.json`.

## Build (browser)

```sh
./build-wasm.sh    # -> apps/web/public/wasm/engine-resolve.{js,wasm} + engine-render.wasm
```

Two modules:

- **`engine-resolve.{js,wasm}`** — an embind module (`createResolveEngine().resolveSong`)
  for main-thread resolution: `song.json` (+ inst-N.json) → resolved-events/v1 JSON.
- **`engine-render.wasm`** — the streaming mixer (`src/main_render_wasm.cpp`), built
  STANDALONE (no JS glue, native wasm exceptions) so an AudioWorkletProcessor can
  `WebAssembly.instantiate()` the raw bytes directly (the `../tone.c` precedent). Its
  C ABI: `mixer_config` → `mixer_set_sample` ×5 (role-keyed stub PCM) + any number of
  `mixer_set_sample_id` (real PCM keyed by the join id — tonal slot id / drum name /
  `playsample-<id>.ogg`) → `mixer_build` (runs the Resolver + the track→sampler join)
  → per-quantum `mixer_pull` / `mixer_left` / `mixer_right`. The five WASI stdio
  imports are unused (worklet stubs them); memory growth is ON for the real library
  (tens of MB/genre) and adds `env.emscripten_notify_memory_growth` — a no-op, safe
  because all heap growth happens during build (before the L/R views are taken) and
  `mixer_pull` never allocates. `malloc`/`free` are exported for staging.

**Live playback** (the one manual, non-headless check — like `/wasm-tone`): the
`/wasm-render` dev page (`src/pages/WasmRenderPage.tsx`) fetches a genre envelope +
the 5 stub oggs (served by the dev-only `/render-demo` vite middleware, no files
copied into `public/`), decodes them with `decodeAudioData`, and hands them to
`public/worklets/casperaki-render-worklet.js`, which builds the mixer and PULLS one
128-frame quantum per `process()`. Audio-thread allocation is eliminated (preallocated
32-voice pool + shared stop-fade scratch in `audio/Sampler.h`), and the RT path uses a
fixed master gain + hard clamp instead of the offline peak-normalise.

With **real samples** toggled on (default when the library is mounted), the page
additionally fetches the genre's sample plan (`/render-demo/plan/<genre>`) and each
unique library asset (`/render-demo/asset/<genre>/<i>`, resolved against
`CASPERAKI_SAMPLE_LIBRARY_ROOT`), decodes each once with `decodeAudioData`, slices
the tonal slots client-side, and stages them via `mixer_set_sample_id` — so the
worklet plays the real timbres (stubs remain the per-key fallback). The middleware
loads `apps/engine-spike/.env` to find the library, mirroring `prestage-samples.mjs`.

## Validation status

`lengthSec` and `genre` match the native oracle exactly for all 8 genres.

**Tonal lanes — done, exact.** Every Synths-class instrument
(leadSynths/synths/keys/popBrass/popStrings/orchestral/vocals) and Bass resolves
note-for-note against the oracle across all 8 genres: pitch (`n` + name), start
beat, length beats AND velocity are hard-asserted exact (≈17.5k notes). Velocity
is `VelocityMode::beat` — a pure function of the beat position, no RNG — so it is
exact, not statistical. `validate-resolution.mjs` does the per-note diff; ties at
equal start beats are compared as a multiset (the native dump serialises ties via
`std::sort`, whose order is libstdc++-introsort-defined and not musical).

**Drum step lanes — done, exact.** The drum instrument resolves to its four
step tracks (`Drums-kicks/-snares/-toms/-rest`); every clip's channels (sampler
note + name) and per-step hits match the oracle across all 8 genres
(`stepHits✓` total per genre). The base pattern drives every segment (the
fixtures' `brainRoundtrip` overrides set `reset:false` so `override.pattern` is
ignored; `override.type` is the only group filter), with fills overlaid via
setNote(`x` set / `0` clear) semantics. The channel array ORDER is the native
sampler's `std::unordered_map` hash order — non-musical, non-portable — so the
validator resolves each hit's channel index to its (note, name) and compares the
hit and channel sets, the same way it treats `std::sort` note ties.

**Wave lanes — done, exact.** The `Loop` track (one wave clip per present
segment, spanning the full segment range) and the shared `Sample Transitions FX`
track (one clip per `arrangement[seg].transitions` entry, placed at
`segStart + toTime(seqStartPos/8) + offsetSec` for `details.duration`) match the
oracle across all 8 genres: clip name, start/end seconds and resolved source
(`playsample-{id}.ogg`). Duplicate instrument ids are deduped first-wins, the
same as `CasperakiEngine::addInstrument` (the fixtures ship two id-50000 `Loop`
instruments). Wave clips are compared as a per-track multiset — te's `getClips()`
order is a serialisation artifact, like the `std::sort` note ties and the
`unordered_map` step-channel order.

**Guitar lanes — done.** The Guitar instrument (electric/acoustic) resolves to
its four tracks across all 5 guitar genres (`src/Guitar.h`,
`Resolver::resolveGuitarInstrument`):

- **(short notes) / (long notes)** — tonal notes (`strum` voiced over the guitar
  chord shape via the embedded `ChordData.json`, plus `chord`/`note`), split
  dur>0.5. Pitch (n+name), start beat and length beats assert EXACT (incl. the
  per-clip overlap shortener); velocity is `VelocityMode::randomised`, drawn from
  a clock-seeded global `juce::Random` in the golden, so it is validated to a ±25
  band rather than equality — it becomes exact in Phase 2 once the golden is
  regenerated from a determinised build. The engine still draws its own seeded
  RNG in faithful order (deterministic run-to-run / Phase-2-ready).
- **(fret noises)** — `fretNoise` notes (`n = sounds[i]`), velocity from data:
  EXACT.
- **(strums)** — `virtualGuitarist` strums: a midi clip (note = soundIndex+48,
  velocity 65 — both exact) + a channel-only step clip. The sound index is the
  per-instrument first-seen order of the sample key; step channels span
  0..maxUsedInSegment with skipped slots padded `(60,"")` (te
  `StepClip::insertNewChannel` appends, so a slot is real only when first reached
  as a new maximum). A strum whose key is absent from `virtualGuitaristSamples`
  throws (`ensureSampleMidiNote`), caught per (instrument, segment), aborting the
  rest of that segment's strum loop — so a genre that ships only a few sample
  flavours keeps just the strums up to its first un-shipped one. The clip start
  carries the negative-time stretch (strum offsets are slightly negative).

**arpeggio / EDMArpeggiator — not ported, by design.** No fixture's `song.json`
emits these step types (a census finds only note/noteAbsolute/noteRelative/chord/
strum/fretNoise/virtualGuitarist), so there is no oracle to validate against;
`getArpeggioNotes` stays ported-but-unexercised and `getEDMArpeggiatorNotes` is
not ported. See PORTING-MAP.md step 4.

All eight genres pass `validate-resolution.mjs` with full track coverage (no
PENDING lanes remain).

**Audio render (sampler/mix half) — done.** `casperaki_render` turns the resolved
IR into a stereo master WAV with the ported `CasperakiSamplerPlugin` voice model:
a faithful Lagrange resampler (`audio/Interpolator.h`), the tracktion fader/pan
gain chain (`audio/Gain.h`), per-voice `juce::ADSR` (`audio/Adsr.h`, 0.001/0.1/
1.0/2.0), and the 32-voice note-on/off allocator (`audio/Sampler.h`). The driver
(`audio/Render.h`) joins each IR track to its sampler config, schedules note/step/
wave events, and sums per-track buffers (no FX) over a pull-based 128-frame block
loop. OGG decode is an adapter (`audio/OggDecode.h`, vendored stb_vorbis) so the
sampler core consumes already-decoded PCM (the browser path will feed
`decodeAudioData` buffers instead).

The audio oracle is structural/synthetic, not a WAV null against the golden
`out.wav` (the golden was rendered with stub samples, has silent VST tonal/bass
lanes, and carries FX — Phase 1 is no-FX). `validate-audio.mjs` asserts the
rendered energy lands where the IR places notes/clips and is silent where it is
empty: **all 8 genres pass** — 92–99.9 % active-window coverage and deep-silence
windows at exactly zero. `sampler_test` locks the voice model at the unit level
(unison gain, octave-up length, one-shot completion, layering).

**Streaming mixer + WASM real-time playback — done.** `Render.h` is refactored
into the reusable streaming `Mixer` and the offline WAV is **bit-identical** to
the pre-refactor render for all 8 genres (the refactor changed structure, not a
single sample). The mixer is compiled to `engine-render.wasm` and driven live by
an AudioWorklet (`/wasm-render`).

`validate-wasm-parity.mjs` is the headless parity guard: it feeds the native
`casperaki_mixer_probe` and the wasm `mixer_pull` **byte-identical** stub PCM at a
fixed 44100/128 and diffs the first 4000 blocks. It does **not** demand
bit-equality — native (glibc) and wasm (emscripten musl) differ by a last ULP in
`powf` (the playback ratio) and `exp`/`log` (the gain), and that occasionally
cascades through the 32-voice cap (`samplesLeftToPlay = 1 + (int)(fileLen/ratio)`
flips by a sample, dropping a *different* voice on each platform) into a
whole-voice O(1) divergence in the densest genres. So the guard asserts the two
renders are the SAME signal to well within a fraction of a percent (NRMSE) with
the rare cascade samples a negligible slice (<1 % disagree past a relative+floor
tolerance) — **all 8 genres pass** (NRMSE 0.016–1.6 %, organicVibes the dense
high-water mark). A real port bug diverges on a broad swath and trips both checks.
Bit-exact wasm↔native would need deterministic transcendentals, which is
Phase-2-gated (along with FX/dither) — see docs/61 §2.

**Real sample library — done.** The id-keyed join binds the actual multisample
library (asset-manifest.json → relativePath + per-slot `[sliceStart, sliceEnd]`)
in both the native render and the browser. Validation:

- **`casperaki_render … <library-root>`** decodes/slices the real assets for all 8
  genres with **zero decode failures** (e.g. ballad: 33 files → 80 tonal slots +
  17 drum lanes + 8 wave sources + 8 fret slots + 12 strums, 0 missing); the four
  resolved-guitar genres (ballad/latin/organicVibes/rock) bind all 8 fret slices
  and every shipped strum, and the energy oracle
  (`CASPERAKI_SAMPLE_LIBRARY_ROOT=… validate-audio.mjs`) passes all 8 at
  99.7–100 % coverage. The only lanes that still fall back to stub are genuinely
  unresolved upstream: brightPop's Guitar lane (`status:"unresolved"` — no catalog
  match, mirrors the legacy prestage), and schlager's PopStrings/PopBrass (the
  catalog has both families, but the manifest generator emits no lane entry for
  them — an `apps/engine-spike` manifest gap, not a render-port gap; the join
  stubs any lane the host doesn't stage).
- **`realsample_test`** (ctest) drives the native decode+slice end to end and
  asserts, for the first tonal lane: slice length == the manifest slice duration
  (offsets honored, not the whole preset), the slice's autocorrelation
  fundamental matches the slot's note (octave-folded — real synth basses lock a
  sub-octave), and distinct slots get distinct audio (no one-source-across-slots
  bug). This caught a real bug: `MINIMP3_FLOAT_OUTPUT` defined only in the impl TU
  made `mp3d_sample_t` differ across TUs (float vs int16) → a stack overflow +
  int16-scale garbage; the macro is now set in `AudioDecode.h` too.
- **`validate-wasm-realsamples.mjs`** pushes real PCM into the wasm mixer via the
  new `mixer_set_sample_id` ABI (ffmpeg standing in for `decodeAudioData`) and
  asserts the render is finite, non-silent, and materially different from the
  stub-only render (real samples actually applied through the join).
- The **no-library path stays byte-identical** to the committed render for all 8
  genres, and the stub-PCM parity guard NRMSE is unchanged — the join is a true
  no-op when no real sample is registered.
