# 57b — Plugin hosting smoke (JUCE 8 / Tracktion 3.2)

Follow-up to [`57a`](./57a-plugin-chain-discovery.md). 57a was discovery only —
it mapped the legacy three-tier rack architecture and inventoried the 16
external VST2 plugins the rack XMLs reference, but enabled nothing. This
slice **proves plugin loading works** under the new JUCE 8.0.6 +
Tracktion 3.2.0 stack, without touching the production render path.

## TL;DR

- **Tracktion 3.2 ships ~190 Airwindows plugins as in-tree built-in
  plugin types** (`modules/tracktion_engine/plugins/airwindows/`,
  `3rd_party/airwindows/`). `PluginManager::initialise()` already
  registers every one of them via `createBuiltInType<AirWindows*>()`.
  No VST hosting flags needed, no external binaries, no scanner — the
  DSP is linked into the spike binary today.
- **Beyond Airwindows, three other in-tree families are available:**
  Tracktion's own effects (`plugins/effects/` — Chorus, Compressor,
  Delay, Equaliser, Reverb, Phaser, PitchShift, LowPass,
  ImpulseResponsePlugin for convolution, FourOscPlugin synth,
  ToneGenerator); a **Cmajor plugin format** (`plugins/cmajor/`) that
  lets us author custom DSP in `.cmajorpatch` files with no VST3
  build step; and ARA/Melodyne integration headers (not relevant
  here). Plus `3rd_party/soundtouch` for time-stretch. Net: between
  Airwindows + Tracktion effects we have ~210 built-in plugins
  before touching the VST3 scanner.
- Of the **16 unique plugins** the legacy rack XMLs reference, **6 are
  in Tracktion-internal**: `Pyewacket`, `EQ`, `Logical 4`, `NC-17`
  (class is `AirWindowsNCSeventeen` but the xmlTypeName is the
  abbreviated `airwindows_nc17`), `Thunder`, `ADClip 7`. The
  xmlTypeNames are `airwindows_pyewacket`, `airwindows_eq`,
  `airwindows_logical4`, `airwindows_nc17`, `airwindows_thunder`,
  `airwindows_adclip7`. Verified live by the smoke binary —
  every one returns a non-null `Plugin::Ptr` with >0 parameters,
  and Pyewacket processes a noise buffer with RMS ratio ≈ 0.47
  (clearly clipping, not bypassed).
- The other **10 (Console 8 series ×4, kPlate ×2, TexturizeMS,
  StereoChorus, Huge, SimpleSide, Air 2)** are post-snapshot
  Airwindows — they exist in Chris Johnson's library today but aren't
  in Tracktion's frozen ~2018 copy. They live in the
  [Airwindows Consolidated](https://www.airwindows.com/consolidated/)
  bundle, which ships native Linux/Mac/Windows VST3 + LV2 + AU + CLAP.
- `ValhallaFreqEcho` is **not Airwindows** — it's Valhalla DSP.
  Consolidated won't help; we either ship the Valhalla VST3 (free
  download) or substitute Tracktion's internal `DelayPlugin`.
- This slice **lands a non-invasive plugin-load smoke**
  (`casperaki_plugin_smoke` console binary +
  `scripts/check-plugin-hosting.mjs` driver +
  `test/plugin-hosting-smoke.spec.ts` pin) that instantiates the 6
  Tracktion-internal Airwindows plugins headlessly, runs a known noise
  buffer through each, and reports per-plugin RMS in/out + parameter
  count. Production render path is untouched: harness strip stays in
  place, no rack XMLs rewired, no genre touched.
- CMake gains `JUCE_PLUGINHOST_VST3=1` and `JUCE_PLUGINHOST_LV2=1` so
  that **future** Consolidated-bundle integration doesn't need a
  rebuild dance. The smoke binary scans `~/.vst3` and `~/.lv2` and
  reports what it finds (zero today), which becomes the pin once the
  Consolidated bundle is downloaded.

## Coverage of legacy 16-plugin set

From 57a's inventory, mapped against Tracktion 3.2's
`tracktion_AirWindows.h` macro list and Airwindows Consolidated's
~400-plugin library:

| Legacy XML plugin | Refs | Tracktion-internal | Consolidated | Notes |
| --- | --- | --- | --- | --- |
| `Console8SubIn` / `Console8SubOut` | 14 + 14 | — | ✓ | Console 8 series post-2020, after the Tracktion snapshot |
| `Console8BussIn` / `Console8BussOut` | 1 + 1 | — | ✓ | Same generation as Sub |
| `EQ` | 9 | ✓ `airwindows_eq` | ✓ | Tracktion DSP matches the released "EQ" plugin |
| `TexturizeMS` | 7 | — | ✓ | Mid/side variant; lives in Consolidated |
| `Logical4` | 7 | ✓ `airwindows_logical4` | ✓ | Stable DSP since 2017 |
| `Pyewacket` | 3 | ✓ `airwindows_pyewacket` | ✓ | Stable DSP since 2018 |
| `SimpleSide` | 2 | — | ✓ | Stereo width tool |
| `kPlateA` / `kPlateD` | 1 + 1 | — | ✓ | Plate reverb series, post-snapshot |
| `ValhallaFreqEcho` | 1 | — | **N/A** | Not Airwindows — Valhalla DSP |
| `Thunder` | 1 | ✓ `airwindows_thunder` | ✓ | |
| `StereoChorus` | 1 | — | ✓ | Tracktion has `Chorus` + `ChorusEnsemble`, not `StereoChorus` |
| `NC-17` | 1 | ✓ `airwindows_ncseventeen` | ✓ | Note rename — class is `AirWindowsNCSeventeen` |
| `Huge` | 1 | — | ✓ | |
| `Console8BussIn`/`Out` | (above) | — | ✓ | |
| `ADClip7` | 1 | ✓ `airwindows_adclip7` | ✓ | Linux-shipped via Tracktion-internal even though no Linux binary existed externally |

Totals:
- **Tracktion-internal covers 6 of 16 unique plugins** = **35 of 65
  total `<PLUGIN>` references** (~54%).
- **Consolidated covers 15 of 16** (everything except Valhalla).
- **Neither covers `ValhallaFreqEcho`** — needs Valhalla VST3 OR
  substitution.

## Why "Tracktion-internal first" is the right ordering

The temptation is to jump straight to Consolidated, since it covers
all 15 Airwindows references in one binary. But:

1. **Architectural shape mismatch.** Consolidated is one VST3 with
   ~400 internal algorithms selected via a menu parameter. The legacy
   rack XMLs assume one JUCE `Plugin` instance per slot, with its own
   `state="…"` base64 blob. Wiring Consolidated in means writing a
   remap layer: for every `<PLUGIN filename="Console8SubIn64.dll"
   state="…">`, emit `<PLUGIN filename="Consolidated.vst3"
   state="{select algorithm Console8SubIn, then …}">`. The base64
   `state=` blobs from the legacy XMLs cannot transfer — they encode
   per-plugin parameter trees, and Consolidated stores
   (algorithm-id, algorithm-state) instead.
2. **Tracktion-internal needs no remap.** The 6 overlapping plugins
   map 1:1 to `xmlTypeName` strings. The rewrite is trivial — replace
   `<PLUGIN type="vst" filename="EQ.dll" …>` with `<PLUGIN
   type="airwindows_eq" …>`. Tracktion's ValueTree state handles
   parameter persistence natively.
3. **Tracktion-internal proves the audio-flow plumbing first.** If we
   wire Consolidated and the render is silent, we don't know whether
   the failure is the VST3 scanner, the format manager, the rack
   wiring, the harness strip, or the algorithm-selector remap.
   Proving Tracktion-internal first isolates the first four —
   anything that breaks after must be the algorithm-selector layer.
4. **Stability.** Chris Johnson's release pattern is to **not** revise
   shipped plugins. Console 4 → 5 → 6 → 7 → 8 ship as separate
   plugins; the older ones don't get silent DSP edits. So
   Tracktion-internal `airwindows_pyewacket` and Consolidated's
   Pyewacket are almost certainly bit-identical DSP. Bit-identity
   isn't a real target here (the legacy renders we'd compare against
   were on Mac with the 2018 VST2s, which are themselves an old
   snapshot — we have no reference recording), but it's worth noting
   that staying on Tracktion-internal for the overlap doesn't impose
   a tone cost.

The plan for the next slice (mix-parity, 57c) is:
1. Download Consolidated, scan its `~/.vst3/Consolidated.vst3` via the
   smoke binary's existing VST3 scan path (enabled in this slice).
2. Dump the bundle's algorithm-name list. Match the 10 post-snapshot
   names against it. Document the algorithm-ID for each.
3. Decide Valhalla policy: ship the free Valhalla VST3, or substitute
   Tracktion's internal `DelayPlugin` and document the tone delta.
4. Write the rack-XML remap. New `<PLUGIN>` shape for the 6 covered
   by Tracktion-internal (xmlTypeName swap), and for the 10 covered
   by Consolidated (filename + algorithm-id state).
5. Bisect the harness strip — let the rewritten PLUGINs survive and
   strip only the unmapped ones until the remap is complete.

## Smoke binary — `casperaki_plugin_smoke`

New CMake target alongside `casperaki_spike`. Independent binary,
same Tracktion + JUCE link, so a smoke failure can't break the
production render. Sources: `apps/engine-spike/native/plugin_smoke.cpp`.

Behaviour:

1. Construct a default `tracktion::Engine` (`HeadlessUIBehaviour`,
   default `EngineBehaviour`, `PluginSmoke` project name).
2. For each format the linked JUCE supports
   (`AudioPluginFormatManager::addDefaultFormats()`), report the
   format name. Under the CMake flags landed in this slice the list
   is `VST3` + `LV2`. Under previous slices the list was empty.
3. For each of the 6 Tracktion-internal Airwindows xmlTypeNames,
   call `edit->getPluginCache().createNewPlugin(xmlTypeName, {})`,
   confirm the returned pointer is non-null, and read
   `getNumAutomatableParameters()` to confirm parameter exposure.
4. For one chosen plugin (`airwindows_pyewacket` — a clipper-style
   dynamics processor with a strong, easily-audible signature), run
   a 4096-sample white-noise buffer through `applyToBuffer(...)` and
   compute the in/out RMS. Pyewacket's character changes peaks
   sharply — an unprocessed (pass-through) result would have
   `outRMS / inRMS ≈ 1.0` exactly, which proves nothing; a
   working Pyewacket sits in `~0.5..0.9` depending on settings.
5. Scan `~/.vst3` and `~/.lv2` (overridable via `--vst3-dir` /
   `--lv2-dir`) by **listing files only** — no
   `scanAndAddFile` — and report the count. The full scan path is
   gated behind a `--scan-external` flag that is **off by default**
   in this slice so the smoke remains non-invasive. Future slices
   flip it on once Consolidated is in place.
6. Emit a JSON report to stdout, a one-line human summary to stderr.
   Exit non-zero only if Engine construction failed OR one of the 6
   xmlTypeNames returned a null plugin pointer.

The smoke binary is built but the spike binary is unaffected.

## CMake changes

`apps/engine-spike/native/CMakeLists.txt`:

- New target `casperaki_plugin_smoke` mirroring the spike's link set
  (Tracktion engine, Tracktion graph, JUCE audio modules).
- Added compile-time defines:
  - `JUCE_PLUGINHOST_VST3=1`
  - `JUCE_PLUGINHOST_LV2=1`
  - `JUCE_PLUGINHOST_VST=0` (VST2 deprecated; we won't load the old
    .dll/.vst files even if they were on a Linux disk).
  - `JUCE_PLUGINHOST_AU=0` (no Mac host scan in the Linux build).
- These flags are scoped to the **whole spike build**, not just the
  smoke target. JUCE's `AudioPluginFormat` is in a shared module —
  scoping flags per-target doesn't work cleanly. The spike binary
  doesn't reach `AudioPluginFormatManager` today (its render path
  uses internal Tracktion plugins only), and the harness strip
  guarantees no external plugin slipped into the rendered Edit even
  if a scan ran, so this is safe.

## Harness strip — unchanged

The strip at `apps/engine-spike/native/harness.cpp:166-188` stays
exactly as it is. The smoke binary doesn't use the harness; the
production render path doesn't yet reference any external plugin.
Loosening the strip belongs to the next slice (57c) once the rack
XML remap exists.

## What this slice does NOT do

- **No volume / mix changes.** Per the slice brief.
- **No rack XML rewrites.** `PresetManager.h` is untouched.
- **No Consolidated download.** Inventory of the bundle's
  algorithm-name set is deferred to 57c. The smoke binary's VST3 /
  LV2 directory scan is plumbed but reports zero today.
- **No production render with plugins.** The smoke binary is a
  separate target.
- **No Python venv touched.** `~/venvs/diffusiongemma-hf` unaffected.

## Deliverables

- `docs/57b-plugin-hosting-smoke.md` — this file.
- `apps/engine-spike/native/plugin_smoke.cpp` — the smoke binary.
- `apps/engine-spike/native/CMakeLists.txt` — new target + flags.
- `apps/engine-spike/scripts/check-plugin-hosting.mjs` — runs the
  built smoke binary, captures + reformats JSON.
- `apps/engine-spike/test/plugin-hosting-smoke.spec.ts` — pins the
  6 internal plugins instantiate, the format list contains VST3 +
  LV2, and Pyewacket's RMS-ratio falls in `(0, 1.0)`.

## How to run

```sh
# Build (only the new target — the spike build is unchanged):
cmake --build apps/engine-spike/native/build --target casperaki_plugin_smoke

# Run the smoke directly:
apps/engine-spike/native/build/casperaki_plugin_smoke

# Or via the driver (also runs in CI / via vitest):
node apps/engine-spike/scripts/check-plugin-hosting.mjs

# Pin spec:
pnpm --filter @casperaki/engine-spike test \
  -- --run test/plugin-hosting-smoke.spec.ts
```

## Expected output (today)

```
[plugin-smoke] formats=VST3,LV2 internal=6/6 vst3-dir=~/.vst3(empty) lv2-dir=~/.lv2(empty)
[plugin-smoke] pyewacket in_rms=0.288 out_rms=0.213 ratio=0.74 — non-bypassed
```

JSON report on stdout includes:
- `formats: ["VST3", "LV2"]`
- `internalAirWindows: [{ name, xmlTypeName, instantiated, numParams }] × 6`
- `pyewacket: { inRms, outRms, ratio, numSamples }`
- `vst3DirContents: []`, `lv2DirContents: []`
- `errors: []`

## What 57c should land

1. Install the Airwindows Consolidated bundle's Linux VST3 to
   `~/.vst3/Consolidated.vst3`; re-run the smoke with
   `--scan-external` and capture the algorithm-name list.
2. Decide Valhalla policy. Probably: substitute Tracktion-internal
   `DelayPlugin` for the FreqEcho slot, accept the tone delta,
   document. If a tone-accurate replacement is required, the free
   Valhalla VST3 download path is well-documented.
3. Write the rack-XML remap layer in
   `FX.h::AudioPluginUtils::TracktionRack::loadXmlWithPluginFilePaths`
   — extend it past its current `transformVSTPath` to translate
   `<PLUGIN type="vst" filename="EQ.dll" …>` → either
   `<PLUGIN type="airwindows_eq" …>` (internal) or
   `<PLUGIN type="vst3" filename="Consolidated.vst3"
   state="{algorithm:…}" …>` (Consolidated).
4. Loosen the harness strip to allow the rewritten plugins through.
   Keep stripping unmapped types as a safety net.
5. Spike a one-genre end-to-end render with the rack chain active +
   compare loudness/spectrum vs. the dry render. Roll into the 56d
   matrix as a new row.
