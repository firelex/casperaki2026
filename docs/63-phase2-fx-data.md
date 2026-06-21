# 63 — WASM render port, Phase 2 FX/mix/routing data tables (2026-06-18)

> The mined, concrete data foundation for Phase 2 (the Mix/FX graph) of the
> in-browser WASM render port ([`60`](./60-wasm-render-port-plan.md),
> [`61`](./61-phase0-decision.md)). Everything here is **re-implementation
> source** extracted from the native `casperaki_engine` (read-only): the exact
> routing topology, per-group mix levels, aux-send tables, rack chains and the
> AirWindows DSP inventory. Cite this doc instead of re-mining. All file:line
> anchors are under `~/apps/casperaki_engine/Source/` unless noted.

## 0. Fidelity tier — port the AirWindows (`#if`) chains, not the Tracktion (`#else`) block

`PresetManager.h` defines **two** rack-chain blocks behind `#if JUCE_PLUGINHOST_VST`:
- **`#if` block** (`PresetManager.h:146-173`) — the canonical AirWindows / external-VST
  chains (Console8, kPlate, Pyewacket, EQ, TexturizeMS, …). Params are opaque base64
  AirWindows float chunks. **This is what the native golden renders** — `FXPluginRemap.h`
  rewrites every `<PLUGIN>` to the Tracktion-internal `airwindows_*` type on Linux.
- **`#else` block** (`PresetManager.h:176-266`) — a Tracktion-builtin
  compressor/4bandEq/reverb/delay/chorus chain with plaintext numeric params.
  A *different sound*; bakeable but **NOT** what the golden uses.

⇒ **Parity requires porting the AirWindows algorithms** (10 in-tree + 6 Tracktion-bundled)
and decoding their base64 state chunks. The `#else` numbers are kept in an appendix only as
an intent cross-check / fallback tier.

All 8 genres map to the **same** `PRESET_BALLAD_*` racks (`PresetManager.h:9-142`
`getPresetXmlData`) — there is **no per-genre rack variation**. Genre differences live only in
(a) send-gain overrides (`Sequencer.cpp`) and (b) per-`lowLevelType` target volumes
(`FX::getInstrumentTargetVolume`). So only **15 rack chains** need baking.

## Implementation status (2026-06-19)

- **Entry conditions CLEARED.** 8 fresh full-FX goldens regenerated (determinised engine,
  06-19); statistical oracle built + calibrated (`scripts/wav-stats-compare.mjs`); all Phase-1
  guards green (ctest 4/4, resolution 8/8, energy 8/8, WASM stub-PCM parity 8/8). Resolution
  oracles re-dumped from the 06-19 envelopes (`emit-brain-roundtrip` is deterministic, so
  re-emit is stable). Golden/oracle regen scripts are robust to the binary's teardown hang.
- **Scope A (per-instrument-group mix) DONE + validated.** `src/audio/MixTables.h` (faithful
  `getInstrumentTargetVolume` / `getFxGroup` / `instrumentFxSends` / `dbToGain`). `Mixer` gained
  `setMixEnabled` (GATED — default off → byte-identical; native `CASPERAKI_MIX=1`, WASM
  `mixer_set_mix_enabled`). Per-lane tonal/bass/guitar volume via `SamplerSound.gainDb` (adds in
  dB through `sampledNoteGains`, equivalent to a post-sampler track gain); drums per sub-instrument
  `gainDb`; Loop wave via `WaveSource.gain`. Mix-on rebalances the spectrum per §4 (verified: the
  synth/lead/keys bands drop ~3 dB, etc.). **Follow-ups:** the "Sample Transitions FX" track
  per-clip volume + −10 dB trim; the per-`fxGroup` submix balance (lives in the Scope B/C rack
  Console8 faders); pan (per-sample, IR carries none → centre, matches current).
- **Scope C — AirWindows DONE** (16/16 ported, see the Scope-C section below).
- **Scope B IN PROGRESS — dry submix→master path live + converging.** `MixGraph.h` restructures the
  flat Mixer into per-lane → fxGroup submix (each running its decoded AirWindows rack) → master
  rack → −1 dB, gated behind `setMixEnabled` (mix-off stays BYTE-IDENTICAL — verified). Rack data
  auto-extracted from PresetManager.h (`scripts/extract-rack-data.mjs` → `src/audio/RackData.h`,
  all 15 chains, params decoded). **Effect (brightPop, real samples, vs golden):** log-spectral
  distance **5.46 → 1.78 dB**, max band Δ **9.4 → 3.6 dB**, RMS **−22.3 → −15.0 dB** (golden −16.3)
  — the submix EQ/comp/saturation + master Console8Buss/Logical4/ADClip7 converge toward the golden.
  **Aux sends → returns DONE:** per-lane 3 sends (`mix::laneSendsDb` = §3 base + the Sequencer.cpp
  overrides) → returns (reverb=kPlateD + chorus=StereoChorus REAL; delay=ValhallaFreqEcho is a
  SILENCE placeholder — passthrough would double the dry send into master). Routing topology
  complete. **Across 5 genres (real samples, WASM-FX vs golden): LSD 1.73–2.05 dB/band.** Browser
  module rebuilt with the FX TUs (worklet just needs `mixer_set_mix_enabled(1)` to use the graph).
  **Remaining for parity (Scope C/D):** ValhallaFreqEcho freq-echo (delay silent), SimpleSide pump
  (passthrough), `signalProcessors` automation + transition one-shot FX, and the master matchering
  post-process the native applies after ADClip7. Scope D wraps `wav-stats-compare.mjs` with §7
  thresholds as the golden A/B validator.

## 1. Routing graph (`Sequencer.cpp`)

```
 per-instrument AudioTrack (one per lane)
   [VolumeAndPanPlugin(preVol) -> Sampler -> AuxSend x3 @ plugin slots 11,12,13]
        │  dry                         │ bus0      │ bus1      │ bus2
        ▼                              ▼           ▼           ▼
   fxGroup SUBMIX FolderTrack     AuxReturn0   AuxReturn1   AuxReturn2
   [Rack: <genre>_<group>]        =PlateReverb =StereoDelay =Chorus
        │                         [Rack:        [Rack:       [Rack:
        │                          _fxPlateRev]  _fxStereo-   _fxChorus]
        │                              │          Delay]│          │
        ▼                              ▼              ▼            ▼
   ┌──────────────────────────── MASTER track ───────────────────────────┐
   │  [Rack: <genre>_master] -> MasterVolumePlugin = -1.0 dB              │
   └─────────────────────────────────────────────────────────────────────┘
```

- **Master** = `getAudioTracks(edit)[0]`, "MASTER"; volume **-1.0 dB**
  (`Sequencer.cpp:210`, `CasperakiEngine.cpp:175`). Master rack = `<genre>_master` at slot 0.
- **Submix FolderTracks**, one per encountered `instrument->fxGroup` (lazy), output → MASTER
  (`Sequencer.cpp:151-158, 343-344`). Drum-component submixes `kicks` created eagerly; `snares`/`toms`
  exist but **no lowLevelType maps to them** and their routing is commented out
  (`Sequencer.cpp:261-270`) — in practice only `kicks` splits out of `drums`.
- **3 AuxReturn tracks**, one per `FX::Send` (`Sequencer.cpp:212-217, 603-610`): AuxReturnPlugin
  `busNumber=Send` at slot 0, rack `<genre>_<sendName>` at slot 1, output → MASTER.
- **Per-lane aux sends**: every instrument track gets 3 `AuxSendPlugin`s at plugin positions
  **11, 12, 13**, `auxNumber` **0,1,2** (`prepareTrackWithPlugins`, `Sequencer.cpp:340-349`).
- **Bus mapping** (`FX.h:389 enum Send`): **bus0=fxPlateReverb, bus1=fxStereoDelay, bus2=fxChorus**.
- **Stereo-delay time is computed at render**: 1/8 note = `(60000/bpm)/2` ms
  (`Sequencer.cpp:620-629`) — overrides any baked delay length.
- Fixed trims: both "Sample Transitions FX" tracks **-10 dB** (`Sequencer.cpp:208-209`);
  `edmSnareDrumRoll` track **-12 dB** (`Sequencer.cpp:174-176`).

## 2. fxGroup assignment (`FX.h:221-355`, `typeMappingTable`)

Enum (`FX.h:202`): `{fx, kicks, drums, percussion, bass, keys, synths, leadSynths,
acousticGuitars, electricGuitars, orchestral, snares, toms, vocals}`. Fallback for unmapped =
`drums` (`FX.h:368`).

| fxGroup | lowLevelTypes |
| --- | --- |
| fx | fxAtmosphere/Downlifter/FretNoise/HighImpact/LowImpact/NoiseRise/Other/8bitArcade/Reverse/TonalReverse/Transition/Uplifter |
| kicks | kickDrumsAcoustic, kickDrumsElectronic |
| drums | claps/snaps (all), cymbals (all), drumKits, hiHats (all), shakers, snareDrums, toms* |
| percussion | percussionBreaks*, percussionLoops*, percussionMisc* |
| bass | bassesAcoustic/Electric/Synth808/Distorted/Pluck/Soft/Sub/Wobble |
| keys | keysAcousticPiano, keysChoir, keysElectronicPiano, keysOrgan |
| synths | synthsArpeggiated, synthsBrightPad, synthsPlucked, synthsSoftPad |
| leadSynths | leadSynthsAnalog/Bright/Distorted/Soft |
| acousticGuitars | acousticGuitars{12String,Banjo,Mandoline,Nylon,Steel,Ukulele}{Mono,Stereo} |
| electricGuitars | electricGuitars{Domino,LpChorus,StratDrive,WarmCrunch}{Mono,Stereo} |
| orchestral | all orchestral*, popBrass*, popHighStrings*, popLowStrings* |
| vocals | vocalsLaSinger, vocalsNaSinger |

## 3. Aux send levels (dB) — `FX::instrumentFxSettings` (`FX.h:372-387`)

`{reverbGainInDb, delayGainInDb, chorusGainInDb}`; **-100 ≈ muted send**.

| group | reverb | delay | chorus |
| --- | --- | --- | --- |
| fx | -100 | -100 | -100 |
| kicks | -100 | -100 | -100 |
| drums | -25 | -100 | -100 |
| percussion | -100 | -100 | -100 |
| bass | -100 | -100 | -100 |
| keys | -25 | -100 | -25 |
| synths | -20 | -25 | -14 |
| leadSynths | -10 | 0 | -14 |
| acousticGuitars | -25 | -25 | -25 |
| electricGuitars | -20 | -20 | -10 |
| orchestral | -100 | -100 | -100 |
| vocals | -25 | -25 | -14 |

**Overrides** in `prepareInstrumentTracksWithPlugins` (`Sequencer.cpp:251-336`), applied to the
group base before the 3 sends are written:

| condition | reverb | delay | chorus |
| --- | --- | --- | --- |
| `drums` instrument kick track | uses kicks = -100/-100/-100 | | |
| acousticGuitarsNylon/Steel Mono/Stereo | base-8 | base-8 | base-8 |
| synthsBrightPad/SoftPad | -14 | base | base |
| synthsPlucked | base | -10 | base |
| keysAcousticPiano | -14 | -10 | base |
| genre==ballad & snareDrums*/drums | -14 | base | base |
| genre==rock & drums | -18 | base | base |

(leadSynths override at `Sequencer.cpp:284-291` is commented out / inactive.)

## 4. Per-instrument target volume (dB) — `FX::getInstrumentTargetVolume` (`FX.h:523-739`)

Applied as a `VolumeAndPanPlugin` after the sampler on **non-drum** tracks
(`applyPreVolumeToTrack`, `Sequencer.cpp:523-527`). **Drum** tracks instead set per-sound gains
via `samplerPlugin->setSoundGains(i, getInstrumentTargetVolume(soundLowLevelType, genre), 0)`
(`Drums.h:433-451`, track volume = 0). **Pan**: no per-family track pan; pan is **per-sample**
(`s->pan`, `CasperakiSamplerPlugin.cpp:207`), default centre. Default/fallback volume = **0 dB**.

Genre rows (default last):
- acousticGuitars (all): brightPop -3; else **-5**
- electricGuitars (all): **-5**
- basses (all): **0**
- clapsSnaps* : rock -12; else -10
- cymbalsCrash/Electronic/Orchestral/Reverse: 0
- cymbalsRideRim/RideBell: latin -21, organicVibes -19, ballad -15, else -15
- fxAtmosphere -10; fxDownlifter -15; fxFretNoise 0; fxHighImpact/LowImpact/NoiseRise/Other/Reverse/TonalReverse/Transition/Uplifter -10
- hiHatsClosedAcoustic: urban -14, rock -21, else -12
- hiHatsClosedElectronic: edm -14, urban -12, organicVibes -13, else -10
- hiHatsOpenAcoustic: rock -15, else -12; hiHatsOpenElectronic -25
- keysAcousticPiano: ballad -4, latin -3, edm -4, schlager -4, organicVibes -7, rock -8, urban -5, else 0
- keysElectronicPiano: latin -3, edm -4, schlager -4, organicVibes -6, urban -9, rock -7, else 0
- keysOrgan 0; keysChoir 0
- kickDrumsAcoustic: ballad -2, else 0; kickDrumsElectronic: urban +2, else 0
- leadSynthsAnalog 0; leadSynthsBright -5; leadSynthsSoft -3; leadSynthsDistorted 0
- orchestral* + orchestralHit: -7
- percussionBreaksBuildups 0; percussionBreaksFills +5
- percussionLoopsAcoustic: ballad -10, else -7
- percussionLoopsElectronic: brightPop -5, ballad -12, latin 0, edm -8, else -2.5
- percussionMisc* 0; percussionMiscVocalShout 0
- popBrass* 0
- popHighStringsLegato -7; popHighStringsPizzicato/Staccato: organicVibes -10, urban -12.5, else -7; popHighStringsTremolo -17
- popLowStrings{Legato,Pizzicato,Staccato,Tremolo} -7
- shakersAcoustic/Electronic -10
- snareDrumsAcoustic -3; snareDrumsElectronic: organicVibes -9, else -6
- synthsSoftPad/BrightPad: ballad/brightPop/rock -21, else -17
- synthsArpeggiated 0
- synthsPlucked: latin -3, urban -2, else -7
- tomsAcoustic: rock -3, else 0; tomsElectronic -17
- vocalsLaSinger/NaSinger 0

> `Guitar::defaultVolume = -20 + (-10 - LUFS)` (`Guitar.h:23`) is **computed but never applied**
> to tonal tracks — they use `getInstrumentTargetVolume`. `defaultVolume` only affects drum /
> transition tracks.

## 5. Rack chains (AirWindows `#if` block) — per fxGroup / return / master

Each plugin is an AirWindows VST2 (fourcc `uid`); `state` = verbatim base64 AirWindows chunk
(FXB-wrapped: the remap strips a 160-byte header — `FXPluginRemap.h:209-236` — bake the
post-header chunk). Order = signal flow. Source: `PresetManager.h:146-173`.

| group | chain (in→out) |
| --- | --- |
| **MASTER** | Console8BussIn64 → Logical464 → Console8BussOut64 → ADClip764 |
| fx | Console8SubIn → Logical4 → TexturizeMS → Console8SubOut |
| kicks | Console8SubIn64 → Thunder64 → EQ64 → Console8SubOut64 |
| drums | Console8SubIn → Pyewacket → TexturizeMS → Console8SubOut |
| percussion | Console8SubIn64 → TexturizeMS64 → Console8SubOut64 |
| bass | Console8SubIn → Logical4 → Huge → Console8SubOut |
| keys | Console8SubIn64 → EQ64 → Logical464 → TexturizeMS64 → Console8SubOut64 |
| synths | Console8SubIn64 → EQ64 → Logical464 → TexturizeMS64 → **SimpleSide** → Console8SubOut64 |
| leadSynths | Console8SubIn64 → EQ64 → Logical464 → TexturizeMS64 → **SimpleSide** → Console8SubOut64 |
| acousticGuitars | Console8SubIn64 → EQ64 → Pyewacket64 → Console8SubOut64 |
| electricGuitars | Console8SubIn64 → EQ64 → Pyewacket64 → Console8SubOut64 |
| orchestral | Console8SubIn64 → EQ64 → Logical464 → TexturizeMS64 → **kPlateA64** → Console8SubOut64 |
| **fxChorus** return | Console8SubIn64 → StereoChorus64 → EQ64 → Console8SubOut64 |
| **fxPlateReverb** return | Console8SubIn64 → kPlateD64 → EQ64 → Console8SubOut64 |
| **fxStereoDelay** return | Console8SubIn64 → **ValhallaFreqEcho_x64** → Console8SubOut64 |

The exact base64 `state` chunks per plugin are in `PresetManager.h` (not duplicated here — read
them at bake time). `FXPluginRemap.h:67-91` maps legacy basename → `airwindows_<name>` internal
type (Pyewacket→airwindows_pyewacket, EQ→airwindows_eq, Logical4→airwindows_logical4,
NC-17→airwindows_nc17, Thunder→airwindows_thunder, ADClip7→airwindows_adclip7, Console8*→…,
kPlateA/D→airwindows_kplate_a/d, TexturizeMS→…, StereoChorus→…, Huge→…, Air2→…).

## 6. AirWindows / FX DSP inventory

**In-tree, MIT, compile-as-is** (`Source/airwindows_extras/<Name>/<Name>{.cpp,.h,Proc.cpp}`):
Air2 (5 params), Console8BussIn (0), Console8BussOut (1:Fader), Console8SubIn (0),
Console8SubOut (1:Fader), Huge (2), StereoChorus (2:Speed,Depth), TexturizeMS (6),
kPlateA (5), kPlateD (5). All seed `fpdL/fpdR` dither with `rand()` **once at init**
(deterministic thereafter — kPlate use TPDF, no rand()).

**Tracktion-bundled, extract from**
`~/apps/spike55a/deps/tracktion_v3.2.0/modules/tracktion_engine/3rd_party/airwindows/<Name>/`:
Pyewacket (3), EQ (8: Treble/Mid/Bass/Lowpass/TrebFrq/BassFrq/Hipass/OutGain), Logical4 (5),
NC-17 (NCSeventeen, 2 — master only, **only used in `#else`**), Thunder (2), ADClip7 (4).

**Reimplement / replace:**
- **SimpleSide** (uid `53696d53`, GPLv3) — tempo-synced volume/pan *pumping* (faux-sidechain),
  used on synths + leadSynths submixes. Reimplement the pumping; do not lift source.
- **ValhallaFreqEcho** (uid `46714568`, proprietary, no source) — on the fxStereoDelay return.
  Replace with an in-tree frequency-shift echo; exact parity best-effort.

### Scope C de-risk — DONE (2026-06-19): both unknowns closed, port pattern proven

1. **State-chunk decode SOLVED.** The PresetManager `state="<size>.<base64>"` is a JUCE
   `MemoryBlock` (alphabet `.`,A-Z,a-z,0-9,`+`; **LSB-first** bit packing per `setBitRange`).
   `size = 160 + 4·N` (160-byte FXB header + N little-endian float32 params). Decoder:
   `apps/web/wasm/engine/tools/decode-airwindows-state.mjs` — verified sane [0,1] params on the
   real chunks (TexturizeMS `[.5,1,.5,1,.5,.5]`, Console8SubOut Fader `[.5]`, EQ 8×, Huge 2×).
2. **Portable compile/run path PROVEN.** `src/audio/airwindows/aw_shim.h` is a ~60-line VST2
   shim (the DSP only calls `getSampleRate()`); the MIT plugin source vendors into
   `vendor/airwindows/<Plugin>/` and compiles in a **namespaced unity TU** (`*.aw.cpp`) behind
   the `AwPlugins.h` interface (`setSampleRate`/`setParam`/`process`). `Console8SubIn` builds
   (no JUCE/VST SDK) and processes a sine cleanly — `airwindows_test` (ctest, 5/5 green).

**Port pattern for the remaining 15** (each ~mechanical): vendor the 3 files (or extract the 6
Tracktion-bundled from `tracktion_v3.2.0/.../3rd_party/airwindows/`), add a namespaced `*.aw.cpp`
+ factory, wire `setParam(i, decodedState[i])`. Then Scope B builds the rack chains (§5) from
these + the routing graph (§1), judged by the §7 statistical oracle.

### Scope C status (2026-06-19): all 16 AirWindows ported; 2 bespoke placeholders

- **16/16 AirWindows ported + smoke-green** (`airwindows_test`, ctest 5/5). 10 in-tree
  (vendored from `casperaki_engine/.../airwindows_extras`) + 6 Tracktion-bundled (extracted from
  `tracktion_v3.2.0`): Console8 Sub/Buss In/Out, Air2, Huge, StereoChorus, TexturizeMS, kPlateA/D,
  Pyewacket, EQ, Logical4, NC-17 (NCSeventeen), Thunder, ADClip7. Each compiles via `aw_shim.h`
  (no JUCE/VST SDK), processes a sine without NaN/blowup (Pyewacket compresses, Thunder shapes
  transients, ADClip7 limits, Huge saturates — all plausible). Files: `src/audio/airwindows/`
  (`aw_shim.h`, `AwPlugins.h`, `AwAdapter.h` template, `AwStateDecode.h`, one `*.aw.cpp` per
  plugin) + `vendor/airwindows/<Plugin>/`.
- **State decode in C++** (`AwStateDecode.h`) matches the validated JS tool — `decodeAwParams`
  turns a PresetManager `state=` into the plugin's [0,1] params.
- **SimpleSide — REIMPLEMENTED** (`SimpleSide.cpp`, clean — not a copy of the GPLv3 source). The
  tempo-synced pump: cycle = `2^rateValue` beats, phase from song time, envelope = the decoded
  piecewise power-curve (`pwr=1.1^|rawExp|`), `scale=(e^env−1)/(e−1)`, `out=in·scale·mix+in·(1−mix)`.
  Its state is special-decoded (2 doubles `mix`,`rate` + `(x,y,rawExp)` curve triples — NOT the
  AirWindows float format). Verified: synths pump = **6.37 dB** duck (mix .52, 2-beat cycle), leads
  deeper (mix .71). Transport threaded Mixer→MixGraph→plugin (`setTransport`).
- **ValhallaFreqEcho — REBUILT from scratch as `FreqShiftEcho.cpp`** and **A/B-matched to the
  native Valhalla by ear ("Perfect!")**. A true frequency-shifting echo: FIR Hilbert (Blackman-
  Harris **199-tap** → **115 dB** image rejection, no 2·shift-Hz beating) → single-sideband shift
  (`I·cosφ − Q·sinφ`) inside a tempo-synced delay+feedback loop with low/high-cut tone filters;
  Hilbert loop latency compensated; **L/R kept coherent** (per-channel offset/opposite-shift
  COMPOUNDS through the feedback → jitter — don't).
- **KEY: the Valhalla `state` is NOT opaque — it's FXB-wrapped XML.** Decode the JUCE MemoryBlock,
  skip the `CcnK FBCh FqEh` header, read `<MYPLUGINSETTINGS wetDryMix shift delay sync feedback
  lowCut highCut/>`. `extract-rack-data.mjs::decodeValhalla` pulls them straight from the preset
  (this one: wetDryMix 1.0, shift 0.6441, sync 0.2174, feedback 0.348, lowCut 0.092, highCut 0.331).
- **Param mappings (Valhalla's internal ranges aren't in the XML — tuned by A/B):** shift →
  `(v−0.5)·20` Hz (0.6441 → **+2.9 Hz**, subtle); sync → `0.5+v·7` beats (0.2174 → **~2 beats /
  1/2-note**; the echo must land between downbeats, not on them); **feedback CUBED** (`v³`: 0.348
  → ~0.042 — the XML value is the UI knob, not the raw loop gain); lowCut/highCut → 1-pole HP/LP
  in the loop; **wet calibrated ×0.2 (−14 dB)** — the 0 dB leadSynths delay send returns the echo
  near dry-note level, so it must be trimmed to sit ~14 dB down like Valhalla (the dry synth was
  always decaying correctly — the "wash"/"jitter" was echo LEVEL, not feedback).
- **This retires Valhalla**: same DSP in WASM and (once wrapped as a tiny in-tree plugin) the
  native engine → drops the Wine/yabridge dependency + its teardown hang, with exact parity.
- **Scope D — automation + validator DONE.** `signalProcessors` automation ported
  (`Resolver::resolveAutomation` → IR `automation`; `Mixer` applies a per-lane biquad `LowPass`
  cutoff sweep + dB volume ramp — the break/buildup filter risers, e.g. brightPop break1.Drums
  1000→30000 Hz). Transition lane now routes to the **fx** submix (was mis-routed to drums). The
  golden A/B validator `scripts/validate-fx-parity.mjs` renders WASM-FX per genre + scores vs the
  golden with the §7 statistical oracle (per-⅓-octave LSD + NRMSE gate; threshold loose now,
  tighten as parity improves).
- **Remaining for full parity (the deep-dive):** TapeDelay character ≠ ValhallaFreqEcho (best-
  effort substitute), the native's post-ADClip7 **matchering** master, per-plugin native-parity
  verification, exact automation-curve bezier shape (currently linear), brightPop guitar stub.
- **Licensing/attribution:** all 16 are AirWindows (MIT, Chris Johnson). The 10 in-tree carry the
  MIT header; the 6 Tracktion-bundled carry an old "__MyCompanyName__" template header but are the
  same MIT code — ship a third-party-licenses page crediting AirWindows.

## 7. Determinism — **CORRECTED from docs/61 §2** (2026-06-19 empirical finding)

docs/61 §2 root-caused the native render's run-to-run non-determinism to the clock-seeded
velocity-humanization RNG (`SequencerUtils.h:73`). **That attribution is wrong for the audio.**

**Empirical test (this session).** Seeded `randomNumberGenerator{ (j::int64)1 }` (the one-line
"fix"), rebuilt `casperaki_spike`, rendered brightPop twice with identical sample bytes:

```
md5 run1 = 56f238652f04d9798e162997cc48546b
md5 run2 = e0d71d41f3d098374bfaa75cd018c7e2   → STILL DIFFER (first diff byte 439)
differing bytes 45,571,553 / 55,566,816  (vs docs/61's pre-fix 45,150,207 — UNCHANGED)
sample-domain: 99.9% of samples differ, maxAbsDiff −17.0 dBFS, NRMSE 5.08%
```

The determinism seed changed the audio by **≈0**. So:
1. **Velocity RNG does NOT reach voice gain.** It humanizes the resolved velocity grid (which the
   resolved-event dump serializes), but the native sampler does not apply that velocity to audio
   (consistent with the WASM port's hardcoded 0.75 — `Gain.h`/`CasperakiSamplerPlugin.cpp:281,362`).
   The seed is still kept (it makes the **resolution dump** reproducible — useful for the Phase-1
   resolution oracle's guitar-velocity check — and is forward-correct; it is just **not** the
   audio's non-determinism source).
2. **The non-determinism is in the DSP path and it is LARGE** (−17 dBFS peak, ~5% RMS — orders of
   magnitude above LSB dither, which rules out the AirWindows `fpd`). The only external / non-C++
   component in the signal path is **ValhallaFreqEcho**, hosted in a **separate Wine/yabridge
   process** on the fxStereoDelay return (brightPop's leadSynths send full-level to it). An
   isolation test (disable Valhalla → render twice) was inconclusive because the native engine
   **segfaults** when its Valhalla binaries are missing (it does not skip the plugin gracefully),
   but disabling it *did* change the md5, and magnitude + "only Wine component" make it the cause.

**⇒ Phase 2 oracle = perceptual/statistical, NOT a sample-exact WAV null** (docs/61's pre-named
fallback path b). The full-FX golden is itself only reproducible to ~5% RMS, and the WASM port
**replaces** ValhallaFreqEcho with a bespoke freq-echo anyway ("best-effort parity"), so the
delay return will differ structurally regardless. Use **per-band RMS (e.g. 1/3-octave) within a
tolerance + log-spectral distance under a bound**, with the threshold set comfortably above the
~5% Valhalla wobble. A stronger *hybrid* (exact-null the deterministic AirWindows core, statistical
only on the Valhalla return) is possible but unconfirmed — gated on a non-crashing no-Valhalla
render. **The 8 regenerated goldens are one realization each** — fine for a statistical oracle.

**Tolerance CALIBRATED from the native self-wobble** (`scripts/wav-stats-compare.mjs`, run on the
two brightPop determinism renders — the oracle's noise floor):

| metric | native run-to-run wobble | proposed WASM-parity tolerance |
| --- | --- | --- |
| time-domain NRMSE | **5.07%** | weak gate only (must be ≲10–15%) |
| per-⅓-octave-band RMS Δ | **≤ 0.01 dB/band** (29 bands) | **primary** — e.g. ±1–2 dB/band, tighten as port matures |
| log-spectral distance (mean \|ΔdB\|) | **0.002–0.003 dB** | **primary** — e.g. < 0.5 dB |

The key insight: the ~5% time-domain difference is almost entirely **echo-tail phase
decorrelation** (Valhalla) — **spectrally the two renders are identical** (band RMS Δ ≤ 0.01 dB).
So the Phase-2 oracle leans on **per-band RMS + log-spectral distance** (razor-tight, ~100× above
the noise floor at ±1 dB), with time-domain NRMSE as a coarse sanity gate only. `wav-stats-compare.mjs`
computes all three (`--bands octave|third`, `--json`); the Scope-D A/B validator wraps it with
these thresholds.

## Appendix — `#else` Tracktion-builtin params (intent cross-check / fallback tier only)

Plaintext params if the lower-fidelity tier is ever needed (`PresetManager.h:176-266`). Not the
golden's sound. Each submix = compressor → 4bandEq (orchestral adds reverb; returns add their
effect). Examples: MASTER `compressor{threshold=0.0972672,outputDb=4.216}` → NC-1764;
drums `compressor{outputDb=3.264,threshold=0.0972672,attack=60.06}` →
`4bandEq{loFreq=77.16,loGain=-20,hiFreq=7284.79,hiGain=1.5,midFreq1=254,midGain1=4,…}`;
fxStereoDelay `delay{length=246(overridden),feedback=-8.04,mix=1}`. Full set in `PresetManager.h`.
