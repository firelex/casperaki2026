# 57a — Plugin-chain / mix architecture discovery

Discovery-only checkpoint for the first of the four post-modernization
branches identified in [`57`](./57-state-of-port.md): _external
plugin-chain / mix parity_. No new behaviour, no plugin loading
attempts. Goal is to land the architecture map + a non-invasive
disk/XML smoke so the next slice (actually enabling plugin hosting
under JUCE 8) can be planned against an accurate baseline.

## TL;DR

- The legacy engine's mix architecture is a **fixed three-tier
  Tracktion topology** (per-instrument tracks → per-instrument-group
  folder submix tracks → 3 fx send tracks + 1 master track) wired up
  imperatively in `Sequencer.cpp` and shared by every genre.
- Each submix + master + send loads ONE rack VST chain via
  `FX::createRackPluginFromPreset`, fed from XML string literals in
  `PresetManager.h`. Every genre maps to the **same `PRESET_BALLAD_*`
  templates** (literally: `ballad_master` → `PRESET_BALLAD_MASTER`,
  `edm_master` → `PRESET_BALLAD_MASTER`, etc.) — genre-specific rack
  differentiation never landed.
- The rack chains reference **16 unique airwindows-family VST2
  plugins**: `Console8SubIn/Out`, `Console8BussIn/Out`, `Logical4`,
  `EQ`, `Pyewacket`, `TexturizeMS`, `StereoChorus`, `Huge`, `kPlateA`,
  `kPlateD`, `ValhallaFreqEcho`, `NC-17`, `Thunder`, `SimpleSide`,
  `ADClip7`, plus `Air2` not referenced by the racks but present on
  disk. Mac ships `.vst` bundles; Windows ships `.dll`s; **Linux has
  no shipped binaries.**
- The current `casperaki_spike` build defines **zero
  `JUCE_PLUGINHOST_*` flags**, so even if Linux binaries existed the
  engine could not host them. Combined with the harness's
  `removed non-sampler plugin` strip (`apps/engine-spike/native/
  harness.cpp:166-188`), nothing external is loaded at render today.
- A safe read-only smoke
  (`apps/engine-spike/scripts/check-plugin-chain.mjs`) inventories
  the 15 rack XMLs + 16 unique plugin filenames per platform without
  ever touching `addDefaultFormats()` or the VST scanner. Pinned by
  `apps/engine-spike/test/plugin-chain-discovery.spec.ts`.

## Architecture map

### Track topology (`Sequencer.cpp::Sequencer()`)

```
MASTER (audio track, name="MASTER")
├── Sample Transitions FX           (audio track, set output → MASTER)
├── Sample Transitions Percussion   (audio track, set output → MASTER)
├── kick   submix  (FolderTrack, group=kicks)        ─┐
├── snare  submix  (FolderTrack, group=snares)        │  Pre-created in
├── tom    submix  (FolderTrack, group=toms)          ├─ ctor, regardless
├── drums  submix  (FolderTrack, group=drums)         │  of instrument set
├── percussion submix … (lazy-created on first use)   │
├── bass / keys / synths / leadSynths / acousticGuitars / electricGuitars / orchestral / vocals … (lazy)
├── fx submix (FolderTrack, group=fx)                 │  Eagerly created on
│                                                      │  first transitionSample
│                                                      ┘  per patch 03 (54o).
├── fxPlateReverb send (audio track)
├── fxStereoDelay  send (audio track)
└── fxChorus       send (audio track)
```

Routing per the constructor:
- Every per-instrument audio track is moved into its
  `instrumentGroup` submix's FolderTrack via
  `prepareInstrumentTracksWithPlugins` /
  `Sequencer::prepareTrackWithPlugins`. The submix's `getOutput()` is
  pointed at `MASTER`.
- Three AuxSend plugins are inserted at fixed plugin-list positions
  `11`, `12`, `13` on each per-instrument track (auxNumbers
  `0`/`1`/`2`), feeding the `fxPlateReverb` / `fxStereoDelay` /
  `fxChorus` send tracks at per-group send gains (see _Send gain
  table_ below).
- Each send track owns an `AuxReturn` plugin at index 0 +
  `RackInstance` at index 1 (the rack VST chain). The first
  `DelayPlugin` on the `fxStereoDelay` send is auto-set to eighth-note
  length based on the song's bpm.

### Volume / gain staging stack (in order, top → bottom of the chain)

1. **Per-instrument pre-volume.** `applyPreVolumeToTrack(edit, track,
   FX::getInstrumentTargetVolume(lowLevelType, genre))` — a giant
   per-`lowLevelType` × genre lookup table in `FX.h`. Used for both
   the per-instrument tracks AND the Drums sub-track variants (kick /
   snare / tom / rest). Range observed: −25 dB to +5 dB; majority
   −15 dB to 0 dB. Genre clauses for `acousticGuitarsNylonMono`,
   `keysAcousticPiano`, `keysElectronicPiano`, `kickDrums*`,
   `hiHatsClosed*`, `cymbalsRideRim/Bell`, `clapsSnaps*`,
   `percussionLoops*`, `synthsSoftPad`, `synthsBrightPad`,
   `synthsPlucked`, `tomsAcoustic`. Everything else falls through to
   the base `lowLevelType` row.
2. **3 AuxSend plugins per per-instrument track** — fed by
   `FX::instrumentFxSettings.at(instrumentGroup)` returning
   `{reverbGainInDb, delayGainInDb, chorusGainInDb}`. Sends are gated
   to `-100 dB` ("silent") for groups that don't use a return; e.g.
   `kicks` / `bass` / `percussion` / `orchestral` / `snares` / `toms`
   are all `{-100, -100, -100}`. `leadSynths` and `electricGuitars`
   send most aggressively (`leadSynths` = `{-10, 0, -14}`).
3. **Submix folder-track inserts the group's rack VST chain** at
   index 0 via `addSubmixTrackPlugins(genre)`. Loaded from
   `PresetManager::getPresetXmlData("<genre>_<groupName>")` → ballad
   template.
4. **Sample-transitions tracks volume**: hard-coded `-10 dB` post-
   ctor.
5. **Master volume plugin**: hard-coded `-1 dB` post-ctor.
6. **Master rack VST chain**: loaded onto `MASTER` track via
   `addMasterTrackPlugins(genre)` → `PRESET_BALLAD_MASTER`.

Net: the harness's stripped renders today bypass items 3, 6 and the
send returns (item 2's bus is silent on every group with a
`-100,-100,-100` row, and the send track's rack chain is also
stripped).

### Where the racks come from — `PresetManager.h`

15 hard-coded `juce::String` literals, each an XML
`<PRESET type="rack" name="…"><RACK><PLUGININSTANCE>…</PLUGININSTANCE></RACK></PRESET>`
document:

| Constant | Routed to | Used by groups |
| --- | --- | --- |
| `PRESET_BALLAD_MASTER` | MASTER track | `<genre>_master` |
| `PRESET_BALLAD_FX_CHORUS` | fxChorus send | `<genre>_fxChorus` |
| `PRESET_BALLAD_FX_PLATE_REVERB` | fxPlateReverb send | `<genre>_fxPlateReverb` |
| `PRESET_BALLAD_FX_STEREO_DELAY` | fxStereoDelay send | `<genre>_fxStereoDelay` |
| `PRESET_BALLAD_FX` | fx submix | `<genre>_fx` |
| `PRESET_BALLAD_KICKS` | kicks submix | `<genre>_kicks` |
| `PRESET_BALLAD_DRUMS` | drums submix | `<genre>_drums` |
| `PRESET_BALLAD_PERCUSSION` | percussion submix | `<genre>_percussion` |
| `PRESET_BALLAD_BASS` | bass submix | `<genre>_bass` |
| `PRESET_BALLAD_KEYS` | keys submix | `<genre>_keys` |
| `PRESET_BALLAD_SYNTHS` | synths submix | `<genre>_synths` |
| `PRESET_BALLAD_LEAD_SYNTHS` | leadSynths submix | `<genre>_leadSynths` |
| `PRESET_BALLAD_ACOU_GUITARS` | acousticGuitars submix | `<genre>_acousticGuitars` |
| `PRESET_BALLAD_ELEC_GUITARS` | electricGuitars submix | `<genre>_electricGuitars` |
| `PRESET_BALLAD_ORCHESTRAL` | orchestral submix | `<genre>_orchestral` |

The `PresetManager::getPresetXmlData(presetName)` dispatch table at
the top of the file shows that every genre prefix (`ballad`, `rock`,
`edm`, `brightPop`, `organicVibes`, `latin`, `schlager`, `urban`)
routes to the **same `PRESET_BALLAD_*`** constant. Genre-specific
rack templates were stubbed out but never authored. The file is
guarded by `#if JUCE_PLUGINHOST_VST` — the `#else` branch defines
empty templates (no PLUGIN nodes), so even without VST hosting the
engine still creates rack instances, they just have no DSP inside.

### Path-rewriting at load — `FX.h::AudioPluginUtils::TracktionRack`

The hard-coded XMLs contain Windows-style paths like
`C:\Program Files\Common Files\VST2\Console8SubIn64.dll`. At load
time `TracktionRack::loadXmlWithPluginFilePaths` walks each PLUGIN
node and rewrites `filename` via `transformVSTPath`:

- `JUCE_WINDOWS`: rebases onto `<appBinaryDir>\ExternalPlugins\Windows\<basename>`, swapping `.vst` → `64.dll` as needed.
- `JUCE_MAC`: rebases onto `<appBinaryDir>/ExternalPlugins/Mac/<basename>`, swapping `64.dll`/`.dll` → `.vst`. Special-cases `ValhallaFreqEcho_x64.dll` → `ValhallaFreqEcho.vst`.
- **`#else`** (Linux is here): emits `std::cerr << "Warning: The plugin scanner is currently not intended for platforms other than Windows or Mac OS"` and returns the input string unchanged.

`createRackPluginFromPreset` then calls
`edit->getRackList().addRackTypeFrom(rackPreset)` and
`createNewPlugin(RackInstance::create(...))`. The inner plugin
instances are created via Tracktion's plugin cache, which routes
through `AudioPluginFormatManager`. Whether those resolve to real
DSP depends entirely on the compile-time `JUCE_PLUGINHOST_*` set.

### Send-gain table (`FX::instrumentFxSettings`)

| Group | reverb | delay | chorus |
| --- | --- | --- | --- |
| `fx` | −100 | −100 | −100 |
| `kicks` | −100 | −100 | −100 |
| `drums` | **−25** | −100 | −100 |
| `percussion` | −100 | −100 | −100 |
| `bass` | −100 | −100 | −100 |
| `keys` | **−25** | −100 | **−25** |
| `synths` | **−20** | **−25** | **−14** |
| `leadSynths` | **−10** | **0** | **−14** |
| `acousticGuitars` | **−25** | **−25** | **−25** |
| `electricGuitars` | **−20** | **−20** | **−10** |
| `orchestral` | −100 | −100 | −100 |
| `snares` | −100 | −100 | −100 |
| `toms` | −100 | −100 | −100 |
| `vocals` | **−25** | **−25** | **−14** |

`prepareInstrumentTracksWithPlugins` additionally applies per-
lowLevelType overrides on top of the group row (e.g. acousticGuitars
nylon/steel goes `{reverb − 8, delay − 8, chorus − 8}` from the row;
synthsPlucked overrides `delay` to `−10`; keysAcousticPiano overrides
`reverb` to `−14` and `delay` to `−10`). The full set is documented
inline in `Sequencer.cpp:240-336`.

## Plugin inventory

From the live `check-plugin-chain.mjs` run (16 unique plugins across
all 15 racks, 65 total `<PLUGIN>` references):

| Plugin | Vendor | Refs | Win disk | Mac disk | Linux disk |
| --- | --- | --- | --- | --- | --- |
| `Console8SubIn`  | airwindows | 14 | ✓ | ✓ | — |
| `Console8SubOut` | airwindows | 14 | ✓ | ✓ | — |
| `EQ`             | airwindows |  9 | ✓ | ✓ | — |
| `TexturizeMS`    | airwindows |  7 | ✓ | ✓ | — |
| `Logical4`       | airwindows |  7 | ✓ | ✓ | — |
| `Pyewacket`      | airwindows |  3 | ✓ | ✓ | — |
| `SimpleSide`     | airwindows |  2 | ✓ | ✓ | — |
| `kPlateD`        | airwindows |  1 | ✓ | ✓ | — |
| `kPlateA`        | airwindows |  1 | ✓ | ✓ | — |
| `ValhallaFreqEcho_x` | Valhalla | 1 | ✓ | ✓ (renamed `.vst`) | — |
| `Thunder`        | airwindows |  1 | ✓ | ✓ | — |
| `StereoChorus`   | airwindows |  1 | ✓ | ✓ | — |
| `NC-17`          | airwindows |  1 | ✓ (`NC-1764.dll`) | ✓ (`NCSeventeen.vst`) | — |
| `Huge`           | airwindows |  1 | ✓ | ✓ | — |
| `Console8BussIn`  | airwindows |  1 | ✓ | ✓ | — |
| `Console8BussOut` | airwindows |  1 | ✓ | ✓ | — |
| `ADClip7`        | Stillwell  |  1 | ✓ | **✗** | — |

Plus `Air2`, `DeEss`, `Pop2`, `SampleDelay`, `TapeDelay`,
`TripleSpread` present in `ExternalPlugins/Mac/` but not currently
referenced by any rack — historic / future fixtures.

The complete machine-readable inventory is
`scripts/check-plugin-chain.mjs` stdout.

## What's currently stripped — and why

The render harness
(`apps/engine-spike/native/harness.cpp:166-188`) walks every track in
the edit and removes every plugin that isn't a `SamplerPlugin` or a
`lowpass`. The comment + linked docs (54q) document the reasoning:

> _"Belt-and-braces: clear EVERY track's plugin list so usePlugins=true
> can't accidentally drag in phantom Windows-VST instances. We rely
> ONLY on SamplerPlugins that addInstrument installs on instrument
> tracks (those go through the SamplerPlugin constructor, not VST
> loading) AND on the new WaveAudioClip on the tone track."_

Per-render output observed today: **76 non-sampler plugins removed**
on a brightPop full-roster render. That number is the sum of:

| Source | Plugins per render | Why |
| --- | --- | --- |
| AuxSend plugins inserted on every per-instrument track (3 per track × N tracks) | most of the 76 | `prepareTrackWithPlugins` always inserts the 3 sends; the strip removes them too |
| Master rack instance (1) | 1 | `addMasterTrackPlugins` |
| Send-track AuxReturn + rack instances (2 per send × 3 sends) | 6 | `addSendTrackPlugins` |
| Submix rack instances (~6 per active group) | varies | `addSubmixTrackPlugins` |
| `MasterVolumePlugin` / `VolumePlugin` on submix / send tracks | preserved by Tracktion | NOT stripped — these are the items that DO survive into the render |

The strip leaves Tracktion's built-in `VolumePlugin` / `LevelMeterPlugin`
/ `AuxReturnPlugin` / `LowPassPlugin` ("lowpass") instances in place,
since the comparison is on `getPluginType() == SamplerPlugin::xmlTypeName`
OR `== "lowpass"`. Everything else — including the `AuxSend`s the
sequencer just inserted — is removed.

### Why the strip exists

Three interlocking reasons:

1. **No JUCE_PLUGINHOST_VST in `casperaki_spike` build.** The current
   CMake (`apps/engine-spike/native/CMakeLists.txt`) defines none of
   `JUCE_PLUGINHOST_VST`, `JUCE_PLUGINHOST_VST3`, `JUCE_PLUGINHOST_AU`,
   `JUCE_PLUGINHOST_LADSPA`, or `JUCE_PLUGINHOST_LV2`. JUCE's
   `AudioPluginFormatManager::addDefaultFormats()` produces an empty
   format list under these conditions, so `RackInstance`'s inner
   plugin slots all resolve to null processors. Audio still flows
   through the rack via bypass, but no DSP is applied.
2. **No Linux plugin binaries shipped.** `ExternalPlugins/Linux` does
   not exist. `transformVSTPath` returns the original Windows
   `C:\Program Files\…` path on Linux, which obviously won't load.
3. **VST2 is deprecated.** Steinberg stopped issuing VST2 licenses in
   2018. JUCE 8 still supports VST2 *hosting* if you ship the VST2
   SDK headers (present here at
   `casperaki_engine/VST_SDK/VST2_SDK/`), but no new ports of
   airwindows/Stillwell plugins to VST3 or LV2 are being made by the
   vendor distributors used here. A future plugin-bearing fixture
   needs to either bundle the VST3 builds (where they exist) or
   build LV2 equivalents.

JUCE 8 + Tracktion 3.2 specifically broke
`AudioPluginFormatManager::addDefaultFormats()` (made it `= delete`)
relative to JUCE 7 — see 55a path B. Tracktion 3.2's bundled
PluginManager works around this on its own, so the compile errors no
longer surface; but the run-time format set is still empty.

## What CAN be tested under JUCE 8 + Tracktion 3.2 right now

Without any plugin hosting enabled, the items we can verify
non-invasively today:

- **Rack XML well-formedness.** Every `PRESET_BALLAD_*` literal in
  PresetManager.h parses to a well-formed `<PRESET><RACK>…</RACK></PRESET>`
  document. The new smoke script catches a truncated heredoc, an
  unbalanced tag, or a future preset getting renamed.
- **Plugin-filename → disk presence.** Each Mac/Windows file referenced
  by the rack XML is on disk (or, where it isn't, the gap is
  recorded). Catches a future plugin being removed from disk without
  the rack XML being updated.
- **Path-rewrite alias coverage.** The `ValhallaFreqEcho_x64.dll` →
  `ValhallaFreqEcho.vst` Mac alias is mirrored in the smoke script so
  a future plugin rename that adds another such alias to FX.h gets
  flagged when the smoke doesn't see the new file.
- **Compile-time plugin-host flag set.** The smoke greps the spike
  build's `Defs.txt` for every `JUCE_PLUGINHOST_*=1` define and
  records the empty set. The next branch's first commit (enabling
  VST3 hosting) will flip this row.
- **Send-gain shape vs. group routing.** Already implicitly tested by
  the 56d matrix's per-segment RMS scan — the silently-bypassed sends
  + racks today mean we measure the dry sum of samplers. If a future
  partial enable lands the racks but not the sends, the per-genre
  RMS row would shift; the 56d matrix catches that.

What we **cannot** test until plugin hosting is enabled:
- Whether any of the 16 plugins actually load under
  `AudioPluginFormatManager::createPluginInstance()`.
- Whether the rack's encoded `state="…"` base64 blob round-trips
  correctly under JUCE 8's plugin-state serialisation.
- Whether the master / submix / send chains produce the expected
  audible output on each genre.

## Minimum safe plugin-smoke proposal

Already landed in this slice — see _Deliverables_ below. Concretely:

- **`scripts/check-plugin-chain.mjs`** is the smoke. Read-only, no
  runtime plugin enabling. Emits JSON to stdout + a human summary to
  stderr. Exits non-zero only if PresetManager.h is missing OR a rack
  XML fails the structural check.
- **`test/plugin-chain-discovery.spec.ts`** pins the smoke output's
  shape + the 15 expected presets + the 16 unique plugin filenames +
  the empty `JUCE_PLUGINHOST_*` flag set. Skipped silently when the
  sibling `casperaki_engine` checkout is absent.

The smoke can be extended **without** enabling plugin hosting in any
of these ways (all out of scope here, listed for the next slice):

1. **Hash the rack `state="…"` base64 strings** per plugin. Stable
   across builds today; any divergence would imply a hand-edit to
   PresetManager.h. Cheap to pin as part of the same spec.
2. **Bisect the strip set.** Today the harness strips every non-sampler,
   non-lowpass plugin. Future work can strip ONLY the `<PLUGIN type="vst">`
   instances (leaving AuxSends + AuxReturns + the Tracktion-built-in
   plugins) and re-run the 56d matrix — this proves whether the send
   bus is silently doing anything beyond what we measure with full
   strip. Belongs in the next slice, not this one.
3. **Mirror the 65 plugin refs into a manifest** the future scanner
   can consume. The smoke already emits this in JSON; the next slice
   can have the engine binary refuse to render if any referenced
   plugin is unreachable on disk (gating the rack-bearing fixture
   without crashing on the dry render).

## Risks (licensing, platform)

- **VST2 license**. Steinberg formally deprecated VST2 in 2018. The
  airwindows + Stillwell + Valhalla DLLs/VSTs are pre-2018 builds.
  **Hosting** VST2 is allowed (the host doesn't redistribute the
  SDK), but a future native build that re-ships the `VST2_SDK` would
  need each plugin's redistribution rights audited. The
  `casperaki_engine/VST_SDK/VST2_SDK/` tree present in the repo today
  includes Steinberg's
  `VST2_License_Agreement.pdf` — review before redistributing.
- **Plugin redistribution rights**. airwindows is MIT (Chris Johnson
  publishes source + permissive license). Stillwell `ADClip7` is
  commercial, currently licensed per-machine. Valhalla
  `ValhallaFreqEcho` is freeware but requires explicit registration
  for support. The ballad master rack uses a mix of all three —
  treating airwindows-only as the practical Phase-1 plugin set buys
  the rack architecture without licensing exposure; the Valhalla +
  Stillwell entries can be deferred or replaced.
- **Platform support**. **There is no Linux plugin binary set in the
  repo**, so the JUCE 8 + Tracktion 3.2 default Linux render path
  cannot load any of the 16 referenced plugins. The realistic
  options:
  1. Build airwindows from source as LV2 — they ship a free LV2 build
     of every plugin via the airwindows-lv2 community repo. JUCE 8's
     `JUCE_PLUGINHOST_LV2=1` would then resolve them. Cleanest, but
     requires rebuilding 13 plugins.
  2. Use the existing VST3 builds of airwindows (also community-
     maintained). `JUCE_PLUGINHOST_VST3=1` is the same flag Tracktion
     v3.2 sets for its bundled example targets, so it's the
     best-supported path under our stack.
  3. Re-ship Windows DLLs and run them through wine-vst / yabridge.
     Painful + brittle, recommend against.
- **ARM macOS gotcha**. The Mac `.vst` bundles are universal
  (x86_64 + arm64 per `file` output) — good. But the VST2 SDK
  itself wasn't updated for Apple-silicon JUCE 8; the future Mac
  build will want VST3 versions of these same plugins for clean ARM
  hosting.
- **Headless render**. The current spike binary runs headless via
  `HostedAudioDeviceInterface` + `juce::JUCEApplication`. A future
  plugin-bearing build that calls `AudioPluginFormatManager::scanAndAddFile`
  must NOT pop the VST2 plugin GUIs at scan time — JUCE 8's scanner
  by default opens an editor window briefly. The
  `juce::AudioPluginFormat::PluginCreationCallback` async path or the
  out-of-process scanner is what we want.

## How to run the smoke

```sh
# Default: assumes ../../../casperaki_engine sibling checkout.
node apps/engine-spike/scripts/check-plugin-chain.mjs

# Or point at a non-default engine repo:
CASPERAKI_ENGINE_REPO=/abs/path/to/casperaki_engine \
  node apps/engine-spike/scripts/check-plugin-chain.mjs

# Run the pinning test:
pnpm --filter @casperaki/engine-spike test \
  -- --run test/plugin-chain-discovery.spec.ts
```

Today's output (truncated stderr):

```
[plugin-chain] discovery summary
  racks parsed   : 15/15
  plugin refs    : 65
  unique plugins : 16
  on Mac disk    : 15/16   (ADClip7 is Windows-only)
  on Win disk    : 16/16
  Linux disk     : (no ExternalPlugins/Linux dir — see docs/57a)
  spike plugin-host flags: (none — render path cannot host external plugins under current build)
```

## Deliverables

- `apps/engine-spike/scripts/check-plugin-chain.mjs` — read-only
  smoke. Walks `casperaki_engine/Source/PresetManager.h`, parses the
  15 rack XMLs structurally, maps plugin filenames to disk presence,
  greps the `casperaki_spike` Defs.txt for `JUCE_PLUGINHOST_*`. Emits
  JSON + a human stderr summary.
- `apps/engine-spike/test/plugin-chain-discovery.spec.ts` — 7-test
  vitest spec that pins the rack list, plugin counts, disk-presence
  rows, and the empty plugin-host flag set. Skipped silently when
  the engine checkout is absent.
- `docs/57a-plugin-chain-discovery.md` — this file.

No engine-side or harness-side code changes — discovery only, per the
slice brief.

## What the next slice should land first

Bottom of the pyramid: enable `JUCE_PLUGINHOST_VST3=1` in
`apps/engine-spike/native/CMakeLists.txt`, audit the
`AudioPluginFormatManager` scan path under headless Linux,
build airwindows VST3s into a new `ExternalPlugins/Linux/`. Then
the harness's strip can graduate from "remove everything non-sampler"
to "remove only the non-loadable" — and the 56d matrix can grow a
plugin-bearing comparison row that's the actual close-out of the
55c §2 Yellow caveat.
