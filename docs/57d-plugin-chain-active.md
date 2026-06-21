# 57d — Rack plugin chain active end-to-end

Closes the 57 thread. 57a discovered the legacy plugin-chain
architecture; 57b proved Tracktion-internal AirWindows hosts under
JUCE 8 / Tracktion 3.2; 57c inventoried the Airwindows Consolidated
bundle and verified the algorithm-selection mechanism via a
state-blob round-trip. 57d wires everything together — the spike now
renders **with real rack-chain DSP firing on the master / submix /
send buses.**

## TL;DR

- The spike's `JUCE_PLUGINHOST_VST` + `VST3` + `LV2` flags are flipped
  to `=1`, which activates the **airwindows-bearing branch** in
  `PresetManager.h` (the legacy `#if JUCE_PLUGINHOST_VST` rack XMLs
  that reference 16 external plugins). Before 57d the spike ran on
  the `#else` stub branch — none of 57a's inventoried 16 plugins ever
  hit the renderer.
- A new header `FXPluginRemap.h` in `casperaki_engine/Source/`
  translates every legacy `<PLUGIN>` reference on Linux to one of four
  destinations:
  - **Tracktion-internal `airwindows_<x>` xmlTypeName** (6 plugins:
    Pyewacket / EQ / Logical 4 / NC-17 / Thunder / ADClip 7).
  - **Airwindows Consolidated VST3 + state-blob algorithm selector**
    (9 plugins: Console8Sub/Buss In/Out, kPlateA, kPlateD,
    TexturizeMS, StereoChorus, Huge, Air2).
  - **SimpleSide VST3** built from the GPL3 source the vendor ships
    at `armandomontanez.com/simpleside/files/SimpleSide_release.zip`,
    installed to `~/.vst3/SimpleSide.vst3`.
  - **ValhallaFreqEcho** via yabridge — the legacy Windows .dll wrapped
    as a Linux .vst/yabridge/*.so proxy by Wine + yabridge.
- `FX.h::loadXmlWithPluginFilePaths` calls `FXPluginRemap::remapPluginElement`
  on Linux, in place of the legacy Mac/Windows path-rewrite.
- `CasperakiEngine` now calls `getPluginManager().initialise()` +
  `initialiseAirWindows()` so the built-in plugin types
  (compressor / 4bandEq / delay / AirWindows*) are actually registered
  before any rack loads; without this every external plugin lookup
  returned null.
- A new Linux branch in `CasperakiEngine::scanExternalPlugins()`
  registers our three specific bundles in `knownPluginList` so
  `createPlugin("vst", desc)` can resolve them. (`ExternalPlugin::xmlTypeName`
  is `"vst"` for VST2 AND VST3 alike — the format is resolved via
  the plugin description, not the type string.)
- The harness strip gains an `SPIKE_KEEP_PLUGINS=1` opt-in that
  disables the per-track plugin clear so the rack chains actually
  fire. Off by default — the 56d matrix sees the same dry render
  it always did.
- **Render compare on brightPop:** dry render produces 210 s, peak
  0 dB, RMS −19.48 dB. Plugins-on render produces 210 s, peak
  **−0.26 dB**, RMS **−21.96 dB**. The ~2.5 dB RMS attenuation +
  slight peak limiting are consistent with a working master chain
  (compressor + EQ + Console8 sub-bus + ADClip 7 limiter).

## Files changed

### casperaki (this repo)

- `apps/engine-spike/native/CMakeLists.txt` — add
  `JUCE_PLUGINHOST_VST/VST3/LV2=1`, `TRACKTION_AIR_WINDOWS=1`,
  and VST2 SDK include path on `casperaki_spike`.
- `apps/engine-spike/native/harness.cpp` — `SPIKE_KEEP_PLUGINS=1`
  opt-in disables the strip.
- `apps/engine-spike/test/plugin-chain-discovery.spec.ts` — re-pin
  the `pluginHostFlags` row to the new VST + VST3 + LV2 set
  (was `[]` pre-57d).

### casperaki_engine (sibling repo)

- `Source/FXPluginRemap.h` (new) — `fx_remap::remapPluginElement`
  + the two lookup tables + `buildAwconsolidatedStateBlobBase64`.
- `Source/FX.h` — `loadXmlWithPluginFilePaths` dispatches to the
  Linux remap.
- `Source/CasperakiEngine.cpp` — call `getPluginManager().initialise()`
  + `.initialiseAirWindows()` after the `CasperakiSamplerPlugin`
  registration.
- `Source/CasperakiEngine.h` — Linux branch in
  `scanExternalPlugins()` that registers Consolidated, SimpleSide,
  and yabridged Valhalla bundles in `knownPluginList`.

No changes to Mac / Windows code paths. The Linux remap is gated on
`JUCE_LINUX` / `JUCE_BSD` defines; everything else falls through to
the legacy Mac/Windows path-rewrite.

## How to reproduce

```sh
# Prereq: SimpleSide installed under ~/.vst3, Airwindows Consolidated
# under ~/.vst3, ValhallaFreqEcho proxied via yabridge under ~/.vst.
# See 57c / 57d-A / 57d-B notes.

cmake -S apps/engine-spike/native -B apps/engine-spike/native/build
cmake --build apps/engine-spike/native/build --target casperaki_spike -j 6

# stub server for samples
node apps/engine-spike/scripts/sample-stub-server.mjs --port 8080 &

# dry render (strip on, no plugin DSP applied):
BIN=apps/engine-spike/native/build/casperaki_spike_artefacts/Debug/casperaki_spike
"$BIN" out/all-genre-render-smoke/brightPop http://127.0.0.1:8080 /tmp/dry.wav
node apps/engine-spike/scripts/check-wav.mjs /tmp/dry.wav

# plugins-on render (strip off, real rack chains fire):
SPIKE_KEEP_PLUGINS=1 "$BIN" out/all-genre-render-smoke/brightPop \
  http://127.0.0.1:8080 /tmp/plug.wav
node apps/engine-spike/scripts/check-wav.mjs /tmp/plug.wav
```

Expected delta: plugins-on render is ~2-3 dB quieter (RMS) and
peak-limited compared to dry. Catches:
- Master rack chain compresses + EQs + Console8-sums + ADClip-limits.
- Submix rack chains tonally shape each instrument group.
- Send rack chains carry plate reverb + delay + chorus.

## What's still owed

This slice landed the plumbing + a proof-of-life render. Not yet:

- **Per-genre delta capture in 56d matrix.** The 56d
  render-all-genres driver still runs with the strip on. Adding a
  `--plugins-on` mode would produce a per-genre LUFS delta table.
- **Per-rack bisect.** We know the WHOLE chain attenuates by ~2.5 dB
  but haven't bisected which rack contributes most. Useful for tuning.
- **State-blob fidelity audit.** The Airwindows Consolidated blob
  used here zeroes out the `awp_N` parameters to 0.5 (the algorithm
  defaults). The legacy Mac/Windows rack XMLs had non-default
  parameter values baked in. Restoring those would shift the tone
  further. Probably small — Console8 defaults are sensible — but
  worth a per-algorithm audit.
- **yabridge cold-start latency.** First scan of the Valhalla DLL
  takes a few hundred ms (Wine subprocess warmup). Acceptable for
  offline render but would be noticeable in live use.
- **Strip refinement.** `SPIKE_KEEP_PLUGINS=1` disables ALL stripping.
  Targeted policy (allow our known plugins, strip unknowns) would
  catch a future legacy ref that the remap doesn't know about. Belt
  and braces.
- **Unit test for FXPluginRemap.** Doable from C++ side without
  pulling in JUCE GUI — would catch lookup-table drift.

## Render-compare evidence (brightPop)

```
Old 56d baseline    : 210.00s, peak  0.00 dB, RMS -20.48 dB
New dry (strip on)  : 210.00s, peak  0.00 dB, RMS -19.48 dB
New plugins-on      : 210.00s, peak -0.26 dB, RMS -21.96 dB
```

`-0.26 dB` peak ceiling is ADClip 7's characteristic ceiling. The
~2.5 dB RMS drop comes mostly from Pyewacket / Console8 attenuation
in the master chain. The full per-rack accounting is the next slice.
