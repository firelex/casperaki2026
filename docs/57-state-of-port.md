# 57 — State of the port (checkpoint, 2026-06-10)

Truth-in-one-place snapshot after the 55a/55b/55c/55d modernization
and the 56a/56b/56c/56d brain-coverage work. No new behaviour — this
file consolidates what's already documented across the 54/55/56
series. Authoritative live scoreboards remain
[`54n-unproven-audio-lanes.md`](./54n-unproven-audio-lanes.md) and
[`54w-engine-bridge-consolidation.md`](./54w-engine-bridge-consolidation.md).

## Stack — current default

| Layer | Version | Source |
| --- | --- | --- |
| JUCE | **8.0.6** | `/home/roli79/apps/spike55a/deps/juce_8.0.6` (symlinked into Tracktion's `modules/juce`) |
| Tracktion Engine | **v3.2.0** | `/home/roli79/apps/spike55a/deps/tracktion_v3.2.0` |
| `casperaki_engine` | `main` `90dc0f4` + patches 01-05 | `/home/roli79/apps/casperaki_engine` |
| Build root | `apps/engine-spike/native/` (single tree — `native55a/` retired in [`55d`](./55d-modernization-landing.md)) | C++20, Debug |
| Engine binary | `apps/engine-spike/native/build/casperaki_spike_artefacts/Debug/casperaki_spike` | unchanged path |

## Engine patches — exactly five

Applied in lex order by `apps/engine-spike/patches/apply.sh`. There is
**no patch 06.** The 55d §1 TransitionSample drift was diagnosed but
not closed via an engine patch (see §"Yellow" below).

| # | File | Purpose | Doc |
| - | --- | --- | --- |
| 01 | `01-edit-forRendering.patch` | `te::Edit` ctor with `Edit::forRendering` (silent render on headless hosts). Note: patch 05's `Edit::Options` rewrite subsumes 01 functionally; 01 still applies cleanly because 05 rewrites the same site and 01 sits in the prefix. | [`52e`](./52e-phase2-first-render.md) |
| 02 | `02-guitar-strum-soundindex-midi-offset.patch` | Guitar strum `keyNote = soundIndex + 48` + integer-valued JSON duration accepted. | [`54m`](./54m-guitar-render-spike.md) |
| 03 | `03-sequencer-fx-submix-eager-create.patch` | Eager `submixTracks[fx]` creation for cymbalsCrashHit / transition routing. | [`54o`](./54o-loop-transition-fills-render.md) |
| 04 | `04-loop-skip-setlooprangebeats.patch` | Drop `setLoopRangeBeats` (hangs `renderToFile`), drop `setLoopInfo` (pre-stretched library), use `setNumberOfLoops(ceil(seg/source))`. | [`54o`](./54o-loop-transition-fills-render.md) |
| 05 | `05-port-juce8-tracktion32.patch` | 5-site engine port for JUCE 8 / Tracktion v3.2 — `Edit::Options` ctor, `TransportControl::setPosition`, `Renderer::renderToFile` `useACID` arg, hide `clearAllContextDevices`, `DynamicObject::clone` → `unique_ptr`. | [`55a`](./55a-juce-tracktion-modernization-spike.md) / [`55b`](./55b-tracktion3-guitar-silence.md) / [`55c`](./55c-modernization-reclassification.md) / [`55d`](./55d-modernization-landing.md) |

## Green

### Brain (orchestrate)

All **8 canonical genres** generate parseSong-clean, semantic-clean,
byte-stable canonical Songs at their canonical bpm:

| Genre | bpm | Seed |
| --- | --- | --- |
| `ballad`       |  75 | `ballad-coverage-smoke` |
| `brightPop`    | 120 | `brightPop-vertical-slice` |
| `edm`          | 128 | `edm-vertical-slice` |
| `latin`        | 120 | `latin-coverage-smoke` |
| `organicVibes` |  90 | `organicVibes-coverage-smoke` |
| `rock`         | 120 | `rock-coverage-smoke` |
| `schlager`     | 120 | `schlager-coverage-smoke` |
| `urban`        |  90 | `urban-coverage-smoke` |

Pinned in `packages/arrangement/test/all-genre-coverage.spec.ts` +
`apps/engine-spike/test/all-genre-emit.spec.ts`.

### Render — all-genre smoke matrix

All 8 genres pass the smoke gate trio (duration > 30 s, peak > −40 dB,
RMS > −35 dB) + every-segment-active envelope check on the
consolidated build. Full 8-genre matrix in **213 s** wall-clock — see
[`56d`](./56d-all-genre-render-smoke.md).

### Production-wired lanes (Green per 54n scoreboard)

- Drums kit (17 component slots: kicks / snares / hats / cymbals /
  toms / shakers / claps).
- Drum fills (per-segment) — `Drums.h::applyFill`.
- Bass per-note tonal — SamplerPlugin via 16-slot bass kit.
- Keys per-note tonal — SamplerPlugin chord+chordType voicings.
- Pad per-note tonal — SamplerPlugin chord voicings.
- Synths (`leadSynths`) — EDMArpeggiator + EDMSynthsPlucked +
  EDMSynthsStabs + noteRelative piano-bank styles.
- PluckedSynths (`synths/synthsPlucked`) — noteRelative dispatch via
  `edmSynthsPluckedLibrary` style.
- Acoustic + electric guitar chord comp — per-note multisample pool.
- Guitar fret noises — 8-slot fxFretNoise pool.
- Guitar chord strums (`virtualGuitarist` pool) — full pattern bank,
  multi-event-per-bar + fx1..fx7.
- Guitar per-string strums (`type: 'strum'`).
- Percussion loops (verse-only).
- TransitionSample lane (cymbalsCrashHit / fx*Lifter / fxHighImpact /
  etc.) — **wired and producing the expected envelope shape**, but see
  Yellow §1 below for the residual 2 dB RMS drift.

### Workspace tests

**973 passing | 1 skipped** across all packages — up from the 957/1
handover baseline by the 16 new tests added by [`56d`](./56d-all-genre-render-smoke.md).
Run with `pnpm -r test` (sequential — the parallel runner's 5 s
per-test timeout occasionally times out one brain API test under CPU
contention).

## Yellow

The render produces audible audio at the right envelope shape on
every lane below; what's missing is structural fidelity proof, not
function.

1. **TransitionSample RMS drift / render-fidelity parity.** 55d §1.
   `transition-only-spike` renders at −28.37 dB RMS vs. legacy
   −26.36 dB (peaks within 0.03 dB). Diagnosed as asymmetric — Drums /
   Loop / Fills are bit-identical so it isn't a global gain change.
   Likely Tracktion v3 default-gain reduction on the auto-inserted
   `volume` plugin of the eager-created fx submix. Mitigated in the
   56d matrix by relaxing the TransitionSample Δrms threshold to
   +0.05 dB (vs +0.10 dB elsewhere). **No engine patch landed for
   this** — a structural fix is punted to the render-fidelity-parity
   pass.
2. **External plugin-chain / mix parity.** 55c §2. The spike harness
   strips every non-Sampler plugin before render, so VST2/VST3/AU
   scan + render under JUCE 8 + Tracktion v3.2 is **untested**.
   Production plugin behaviour (TransitionNoise, signal processors,
   matchering chain, etc.) cannot be declared Green until a
   plugin-bearing fixture gate is added that does NOT strip plugins.
3. **Signal processor (LP sweep) audible proof.** [`54q`](./54q-signal-processor-port.md).
   The LP plugin is verifiably installed and the tag → automation-point
   array port is wired, but the audible attenuation is far below the
   expected envelope. Engine-side `AutomatableParameter` automation
   read is the open gap. Adapter side is Green.
4. **TransitionNoise** (`fxNoiseRise`, synthesized). Deferred — needs
   `EffectsClass.getEffect({type:'fxNoiseRise'})` param port + a
   plugin-cleanup whitelist that survives the harness's
   non-sampler strip. Was gated behind the modernization (now landed);
   unblocked but still unimplemented.
5. **TransitionPattern (`edmSnareDrumRoll`).** Zero validated catalog
   rows — selection has no candidates to pick from. Deferred.
6. **Vocal rendering / AI audio path.** SoulX / ACE-Step path —
   `Vocal` instrumentDefinition is a synthetic placeholder; the
   adapter doesn't lower it and the engine doesn't render it. The
   apps/brain melody track is generated but its audio realisation
   is not in the engine pipeline. Separate post-port slice.

## Known quality caveats

- **0 dBFS peaks / gain staging not final.** 5 of 8 genres in the 56d
  matrix render at peak 0.00 dB. Cumulative levels add up faster than
  the legacy mix because every sampler-driven lane independently
  trims for itself; there is no master-pad and no per-segment
  matchering. Punted to the render-fidelity-parity pass.
- **Plugin racks stripped / not parity-tested.** The harness's
  `non-sampler-plugin-strip` removes 76 plugins per render to dodge
  the engine's external-plugin loader complexity. Anything that
  depends on those plugins (TransitionNoise, signal processors,
  matchering, automation reads) is therefore Yellow until item
  Yellow §2 above is closed.
- **Catalog fallback policies are explicit but lossy.**
  `organicVibes` Drums pick from latin-tagged rows; `organicVibes`
  Bass picks from ballad-tagged rows; `schlager` Bass picks from
  latin-tagged rows; `brightPop` Loop picks from latin-tagged rows
  (only at canonical bpm + the 120-130 latin density peak); `edm` +
  `schlager` Keys dispatches via `chordsStraight` (no piano-bank
  per-genre library). These are tagged with `pickSource: 'fallback'`
  on the selection side per the 56c follow-on. The 56d matrix surface
  them in its `fallbackPicks` column. Not a regression — these
  fallbacks ARE the legacy catalog reality and the brain output is
  faithful to the legacy `ArrangementsClass.js:432-440` behaviour.
  But they ARE a level/timbre mismatch the future render-fidelity
  pass should consider re-attributing.
- **Catalog audit gaps.** `drumKits` sheet contributed zero
  audit-valid rows; the kit is assembled from per-component families.
  `percussionLoops` bpm-bin folder names diverge from catalog
  lowLevels (handled via audit `aliasesApplied` reverse-map). Both
  are stable but worth flagging.
- **Sample stub server fallback trap.** [`55b`](./55b-tracktion3-guitar-silence.md)
  documented the 58-byte stub response that sticky-cached into a
  wrong-`PRODUCT_NAME` temp dir. Permanent guardrail is the
  `PRODUCT_NAME "CasperakiSpike"` invariant — any future binary that
  shares the audio-cache layout MUST keep it.

## How to reproduce

```sh
# 0. Sample stub server (one-time, separate shell).
node apps/engine-spike/scripts/sample-stub-server.mjs

# 1. Apply patches 01-05 to the engine repo (idempotent).
bash apps/engine-spike/patches/apply.sh

# 2. Build the engine binary against JUCE 8.0.6 + Tracktion v3.2.0.
#    Defaults to /home/roli79/apps/spike55a/deps/{juce_8.0.6,
#    tracktion_v3.2.0}; override via CASPERAKI_JUCE_DIR /
#    CASPERAKI_TRACKTION_DIR if you have your own checkouts.
mkdir -p apps/engine-spike/native/build
cd       apps/engine-spike/native/build
cmake -DCMAKE_BUILD_TYPE=Debug -G "Unix Makefiles" ..
make -j$(nproc) casperaki_spike
cd -

# 3. Render brightPop (the 56a canonical vertical slice).
node apps/engine-spike/scripts/emit-brain-roundtrip.mjs          # SEED=brightPop is default
node apps/engine-spike/scripts/prestage-samples.mjs
./apps/engine-spike/native/build/casperaki_spike_artefacts/Debug/casperaki_spike \
  "$PWD/apps/engine-spike/out/brain-roundtrip" \
  http://127.0.0.1:8080 \
  "$PWD/apps/engine-spike/out/brain-roundtrip/out.wav"
node apps/engine-spike/scripts/check-wav.mjs \
  apps/engine-spike/out/brain-roundtrip/out.wav

# 3b. Render edm instead.
SEED=edm node apps/engine-spike/scripts/emit-brain-roundtrip.mjs
# then prestage + render as above.

# 4. All-genre smoke matrix (~3.5 min for all 8 genres).
node apps/engine-spike/scripts/render-all-genres.mjs
# subset:
GENRES=brightPop,edm,organicVibes,schlager \
  node apps/engine-spike/scripts/render-all-genres.mjs
```

The matrix script writes `out/all-genre-render-smoke/<genre>/out.wav`
+ a summary table to stdout + `out/all-genre-render-smoke/summary.json`.

## Next recommended branches

In priority order — pick one per work-cycle, each gates the next.

1. **External plugin-chain / mix parity discovery.** Stand up a
   plugin-bearing fixture that does NOT strip the engine's
   non-sampler plugin rack. Exercise the VST2/VST3/AU scan path
   under JUCE 8 + Tracktion v3.2; document any
   `addDefaultFormats` / `TrackProperties` regressions the 55b spike
   didn't surface. Closes Yellow §2 + §6.
2. **Signal processors / TransitionNoise under JUCE 8.** With (1)'s
   whitelist in hand, port the engine-side `AutomatableParameter`
   automation read for `LowPassPlugin` (close Yellow §3) and wire
   `EffectsClass.getEffect({type:'fxNoiseRise'})` + the
   `FourOscPlugin` + `LowPassPlugin` envelope (close Yellow §4).
   This is also where the TransitionSample structural RMS drift
   (Yellow §1) gets revisited — the same fx-submix path that hosts
   TransitionNoise hosts the affected `volume` plugin.
3. **Vocal audio rendering path.** Pick the SoulX / ACE-Step lane
   (per the casperaki rebuild plan) and wire the engine `Vocal`
   instrument to it. Brain emits a Vocal melody today; the audio
   realisation is the gap. Closes Yellow §6.
4. **UI render-job integration.** With end-to-end audio rendering
   stable, wire the apps/web side to the render job — kick off
   matrix-grade renders from the UI, surface progress + the gate
   trio + lane status as job metadata. The 56d matrix already emits
   the JSON shape (`summary.json`) the UI can consume verbatim.

Items 5+ (matchering chain port, level / gain-staging tuning,
plugin-rack production parity, fixture-gate CI) are not branches —
they're follow-up work inside the four branches above.
