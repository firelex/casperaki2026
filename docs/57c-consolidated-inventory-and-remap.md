# 57c — Airwindows Consolidated inventory + rack-XML remap design

Follow-up to [`57b`](./57b-plugin-hosting-smoke.md). 57b proved the
Tracktion-internal AirWindows path covers 6 of the 16 legacy rack
plugins and that the spike binary can host VST3 / LV2 plugins. This
slice covers the other 10: Consolidated is downloaded, inventoried,
loaded under JUCE, and — crucially — the algorithm-selection
mechanism is **mechanically proven** with a state-blob round-trip.

The actual engine-side rewrite (rack-XML remap layer + harness
strip loosening + end-to-end render) is **deferred to 57d** —
deliberate pause point so the user can sanity-check the remap
shape before edits land in `casperaki_engine`.

## TL;DR

- **Consolidated bundle is installed** under `~/.vst3` and `~/.lv2`
  (MIT-source / GPL3-binary because of JUCE), version `1.2026.159`
  (build `07d8756`, 2026-06-07). Linux x86_64 VST3 + LV2 + CLAP +
  standalone, ~32 MB unzipped.
- **JUCE 8 hosts both formats cleanly.** `--scan-external` instantiates
  the VST3 (14 params) and the LV2 (15 params) without errors.
- **All 10 post-snapshot legacy plugins are in Consolidated**, except
  one: **SimpleSide is NOT in the bundle.** Closest matches are
  `SideDull`, `Sidepass`, `SideL`, `SideR`, `SideH`, `SideM`. The
  legacy chain references `SimpleSide` exactly twice — fx/master rack
  side-channel processing.
- **Algorithm selection is via plugin state blob, not VST3 params or
  programs.** The state-blob XML shape is
  `<awconsolidated currentProcessorName="Console8SubIn" awp_0=… inlev=… outlev=… monoBehaviour=…/>`.
  JUCE's VST3 host wraps that in
  `<VST3PluginState><IComponent>base64(awconsolidated-bytes)</IComponent></VST3PluginState>`.
  The smoke binary round-trips a `Console8SubIn` selection successfully:
  read-back blob's inner XML reports `currentProcessorName=Console8SubIn`.
- **The rack-XML remap is mechanically defined.** Every legacy
  `<PLUGIN type="vst" filename="<X>.dll" state="…b64…">` becomes one of:
  - **Tracktion-internal path** (for the 6 overlap plugins):
    `<PLUGIN type="airwindows_<x>"/>` — Tracktion's built-in DSP,
    no external dependency.
  - **Consolidated path** (for 9 of the 10 post-snapshot):
    `<PLUGIN type="vst3" filename="…/Airwindows Consolidated.vst3"
    state="…b64-VST3PluginState-wrapper-of-awconsolidated…"/>` —
    the algorithm name is in `currentProcessorName`.
  - **SimpleSide**: no exact match in Consolidated, **needs decision**.
    Options: substitute with `SideDull` (closest tonal cousin), or
    drop the slot entirely. Both refs are in `PRESET_BALLAD_FX` and
    `PRESET_BALLAD_MASTER` side-channel processing — low-impact slot.
- **ValhallaFreqEcho**: not Airwindows. **Needs decision** still:
  install the free Valhalla VST3, or substitute with Tracktion's
  built-in `DelayPlugin`. Recommendation below.
- **57d is the engine-side change** — gated on user signoff.

## Bundle inventory

### How it was acquired

```sh
gh release download DAWPlugin --repo baconpaul/airwin2rack \
    --pattern "*Linux.zip"
# → AirwindowsConsolidated-2026-06-07-07d8756-Linux.zip
```

License: MIT for source (the `airwindows` DSP code is Chris Johnson's
release-into-public-domain set; `airwin2rack` packaging is MIT). The
binary inherits **GPL3** because it links JUCE.

### Files installed

| Path | Size | Purpose |
|---|---|---|
| `~/.vst3/Airwindows Consolidated.vst3/Contents/x86_64-linux/Airwindows Consolidated.so` | ~28 MB | VST3 binary — our primary host target. |
| `~/.vst3/Airwindows Consolidated.vst3/Contents/Resources/moduleinfo.json` | small | Static module manifest; declares a single Audio Module class. |
| `~/.lv2/Airwindows Consolidated.lv2/libAirwindows Consolidated.so` | ~28 MB | LV2 binary. |
| `~/.lv2/Airwindows Consolidated.lv2/{manifest,dsp,ui}.ttl` | small | LV2 Turtle metadata. |

### Static module info

`moduleinfo.json` declares **one** Audio Module Class
(`CID ABCDEF019182FAEB44746872616C4658`) + a Controller class + a
Plugin Compatibility class. That's it — Consolidated is structurally
a single plugin instance. The ~400 algorithms are **internal state**.

### How algorithm selection actually works

From [`airwin2rack/src-juce/AWConsolidatedProcessor.cpp:433`](https://github.com/baconpaul/airwin2rack/blob/main/src-juce/AWConsolidatedProcessor.cpp#L433):

```cpp
void AWConsolidatedAudioProcessor::getStateInformation(juce::MemoryBlock &destData) {
    std::unique_ptr<juce::XmlElement> xml(new juce::XmlElement("awconsolidated"));
    xml->setAttribute("streamingVersion", (int)8524);
    xml->setAttribute("currentProcessorName",
                      AirwinRegistry::registry[curentProcessorIndex].name);
    for (int i = 0; i < nAWParams; ++i) {
        juce::String nm = juce::String("awp_") + std::to_string(i);
        float val = (i < nProcessorParams) ? *(fxParams[i]) : 0.f;
        xml->setAttribute(nm, val);
    }
    xml->setAttribute("inlev", inLev->get());
    xml->setAttribute("outlev", outLev->get());
    xml->setAttribute("monoBehaviour", monoBehaviourParameter->get());
    copyXmlToBinary(*xml, destData);
}
```

So the plugin's own state is a flat XML element with attributes —
`currentProcessorName` is the algorithm's stable name, looked up via
`AirwinRegistry::registry`. The 10 `awp_N` floats are the
currently-selected algorithm's parameters (0..1 normalized).
`inlev`/`outlev` are pre/post gain, `monoBehaviour` is a stereo
imaging knob.

### JUCE's VST3 wrapper envelope

JUCE's VST3 host wrapper does NOT pass `setStateInformation` bytes
straight to the plugin's IComponent. It wraps them in:

```xml
<VST3PluginState>
  <IComponent>{MemoryBlock::toBase64Encoding(innerStateBytes)}</IComponent>
</VST3PluginState>
```

(The base64 is JUCE's custom alphabet — `MemoryBlock::toBase64Encoding`,
not standard base64. `MemoryBlock::fromBase64Encoding` reverses it.)
For round-trip with the algorithm selected, the smoke binary builds:

```cpp
juce::XmlElement xml("awconsolidated");
xml.setAttribute("streamingVersion", (int) 8524);
xml.setAttribute("currentProcessorName", "Console8SubIn");
for (int i = 0; i < 10; ++i)
    xml.setAttribute(juce::String("awp_") + juce::String(i), 0.5);
xml.setAttribute("inlev", 0.5);
xml.setAttribute("outlev", 0.5);
xml.setAttribute("monoBehaviour", 0.0);

juce::MemoryBlock innerBlob;
juce::AudioProcessor::copyXmlToBinary(xml, innerBlob);

juce::XmlElement wrapper("VST3PluginState");
auto* ic = wrapper.createNewChildElement("IComponent");
ic->addTextElement(innerBlob.toBase64Encoding());

juce::MemoryBlock blob;
juce::AudioProcessor::copyXmlToBinary(wrapper, blob);
inst->setStateInformation(blob.getData(), (int) blob.getSize());
```

Verified via the smoke binary:

```
targetAlgo: Console8SubIn
selectedAlgo: Console8SubIn
matched: true
writtenBlobSize: 500
readBlobSize: 539
readBackRootTag: VST3PluginState
readBackChildren: IComponent
```

Pinned by
`apps/engine-spike/test/plugin-hosting-smoke.spec.ts::"algorithm-selector round-trip succeeds"`,
skipped silently when the Consolidated bundle isn't installed.

## Legacy 16-plugin coverage table (final)

The 57b table refined with this slice's runtime evidence:

| Legacy plugin | Refs | Tracktion-internal | Consolidated | Path for 57d remap |
| --- | --- | --- | --- | --- |
| `Console8SubIn` | 14 | — | ✓ | Consolidated, `currentProcessorName=Console8SubIn` |
| `Console8SubOut` | 14 | — | ✓ | Consolidated, `currentProcessorName=Console8SubOut` |
| `EQ` | 9 | ✓ `airwindows_eq` | (in bundle but unnecessary) | Tracktion-internal |
| `TexturizeMS` | 7 | — | ✓ | Consolidated, `currentProcessorName=TexturizeMS` |
| `Logical4` | 7 | ✓ `airwindows_logical4` | ✓ | Tracktion-internal |
| `Pyewacket` | 3 | ✓ `airwindows_pyewacket` | ✓ | Tracktion-internal |
| `SimpleSide` | 2 | — | **— (absent)** | **Build from GPL3 source as Linux VST3** — see correction below |
| `kPlateA` | 1 | — | ✓ | Consolidated, `currentProcessorName=kPlateA` |
| `kPlateD` | 1 | — | ✓ | Consolidated, `currentProcessorName=kPlateD` |
| `ValhallaFreqEcho` | 1 | — | **N/A** (not Airwindows) | **Decision needed** — see below |
| `Thunder` | 1 | ✓ `airwindows_thunder` | ✓ | Tracktion-internal |
| `StereoChorus` | 1 | — | ✓ | Consolidated, `currentProcessorName=StereoChorus` |
| `NC-17` | 1 | ✓ `airwindows_nc17` | ✓ | Tracktion-internal |
| `Huge` | 1 | — | ✓ | Consolidated, `currentProcessorName=Huge` |
| `Console8BussIn` | 1 | — | ✓ | Consolidated, `currentProcessorName=Console8BussIn` |
| `Console8BussOut` | 1 | — | ✓ | Consolidated, `currentProcessorName=Console8BussOut` |
| `ADClip7` | 1 | ✓ `airwindows_adclip7` | ✓ | Tracktion-internal |

Net: **35 of 65 plugin references → Tracktion-internal** (54%);
**27 of 65 → Consolidated** (~42%); **3 of 65 → needs decision**
(`SimpleSide`×2 + `ValhallaFreqEcho`×1, all low-impact slots).

## Open decisions

### SimpleSide — CORRECTION + decision

The first pass of this doc misidentified SimpleSide as an Airwindows
side-channel processor. **Both are wrong:**

- **Vendor:** `com.armandomontanez.SimpleSide` (Armando Montanez, 2017),
  NOT Airwindows. CFBundleIdentifier in the legacy Mac .vst confirms.
- **Function:** "a simplified volume curve LFO utility" — a
  tempo-synced drawable volume LFO (you draw a curve, the plugin
  modulates output volume along that curve at tempo). NOT side-channel
  filtering. The "Side" in the name appears to refer to "alongside" /
  "sidechain LFO", not mid/side decoding.
- **License:** GPL3 (vendor's release page states this explicitly).
- **Source:** Included in the official release zip at
  `http://armandomontanez.com/simpleside/files/SimpleSide_release.zip`
  — full JUCE plugin: PluginProcessor + PluginEditor + automation
  (MixAutomator / RateAutomator) + SSCurve / SSMultiCurve types + UI.
  Originally Projucer-built (no CMakeLists / .jucer in the zip).

Refs in the legacy chain: `PRESET_BALLAD_FX` (×1) and
`PRESET_BALLAD_MASTER` (×1). That's a tempo-synced volume swell on
the master + fx sub-bus — distinctive character, not a minor slot.

**Decision (57d):** Build SimpleSide as a Linux VST3 from the GPL3
source. Steps:
1. Drop the source into `apps/engine-spike/external/SimpleSide/`
2. Author a `CMakeLists.txt` for it using JUCE 8's `juce_add_plugin`
   macro (VST3 format only — we don't need AU/VST2 on Linux).
3. Port any 2017→2026 JUCE API drift (likely a handful of one-liners:
   `AudioProcessorValueTreeState` defaults, `MidiBuffer` accessors,
   maybe a missing `using namespace juce`).
4. Build → `SimpleSide.vst3` → install to `~/.vst3/`.
5. Remap legacy ref to it: `<PLUGIN type="vst3" filename="SimpleSide.vst3"/>`
   (no algorithm selector — SimpleSide is one effect, not a consolidator).

The earlier "SideDull substitute" suggestion is withdrawn — it was
based on the wrong understanding of what SimpleSide does. Side-channel
EQ is not a substitute for a tempo-synced volume LFO.

### ValhallaFreqEcho — CORRECTION + decision

**Linux build does NOT exist.** Valhalla DSP's
[FreqEcho compatibility list](https://valhalladsp.com/shop/delay/valhalla-freq-echo/)
shows Windows VST2/VST3/AAX and Mac VST2/VST3/AAX/AU only — no Linux
binary. The earlier "install free Valhalla VST3" recommendation was
based on a wrong assumption. Source isn't open either (Valhalla DSP
is closed-source commercial).

What IS available:
- The original Windows DLL is already on disk at
  `casperaki_engine/ExternalPlugins/Windows/ValhallaFreqEcho_x64.dll`.
- It's a Windows VST2 x86_64 .dll. JUCE on Linux can't dlopen it.

**Decision (57d):** Bridge the Windows DLL via
[yabridge](https://github.com/robbert-vdh/yabridge). yabridge wraps a
Windows VST .dll inside a Linux .vst3/.so that the JUCE VST3 host can
load like a native plugin; the Windows DSP runs in a Wine subprocess.
Mature project, the canonical way to host Windows VSTs on Linux.

Cost:
- Adds **Wine** (~50 MB) + yabridge (~5 MB) as runtime deps.
- One-time bridge handshake per plugin: `yabridgectl add <path-to-dll>`
  produces a `~/.vst3/ValhallaFreqEcho.vst3` proxy file.
- Per-render overhead: small (the Wine subprocess is long-lived once
  warmed; not measurably worse than a native VST3 in our offline
  render context).

Trade-off vs. substitution:
- (1) **yabridge** = exact FreqEcho tone, +Wine dep — selected.
- (2) Substitute Consolidated `PurestEcho`/`TapeDelay` — zero deps,
  loses the pitch-shifting frequency-domain delay character. Reach for
  this if yabridge causes WSL2-specific issues.

WSL2 caveat: Wine runs in WSL2 but has occasional surprises around
audio subsystems. Our render path is offline (no live audio device)
so this shouldn't bite us, but it's a known unknown until we try.

## The remap layer (57d work)

The current path-rewriting site is
`casperaki_engine/Source/FX.h::AudioPluginUtils::TracktionRack::loadXmlWithPluginFilePaths`
(see 57a §"Path-rewriting at load"). The 57d change extends that
function to *transform plugin nodes*, not just rewrite their filename.

Sketch (pseudo-code):

```cpp
static juce::String loadXmlWithPluginFilePaths(const juce::String& rackXml)
{
    auto xml = parseXML(rackXml);
    forEachPluginNode(xml, [&](juce::XmlElement& plugin) {
        const auto legacyName = plugin.getStringAttribute("filename")
                                     .upToLastOccurrenceOf(".", false, false)
                                     .fromLastOccurrenceOf("/", false, false)
                                     .fromLastOccurrenceOf("\\", false, false);

        if (auto type = kLegacyToTracktionInternal.find(legacyName);
            type != kLegacyToTracktionInternal.end()) {
            // Tracktion-internal path: swap type, drop filename / state.
            plugin.setAttribute("type", type->second);
            plugin.removeAttribute("filename");
            plugin.removeAttribute("state");
        }
        else if (auto algo = kLegacyToConsolidatedAlgorithm.find(legacyName);
                 algo != kLegacyToConsolidatedAlgorithm.end()) {
            // Consolidated path: rewrite to VST3 + algorithm state blob.
            plugin.setAttribute("type", "vst3");
            plugin.setAttribute("filename", consolidatedVst3Path());
            plugin.setAttribute("state", buildAwconsolidatedStateBlob(*algo));
        }
        else if (legacyName == "ValhallaFreqEcho_x") {
            // policy: substitute with Tracktion DelayPlugin OR external Valhalla VST3
            applyValhallaSubstitution(plugin);
        }
        else if (legacyName == "SimpleSide") {
            applySimpleSideSubstitution(plugin);   // SideDull recommended
        }
        else {
            // Unknown plugin — log and drop so the rack still loads.
            plugin.deleteFromParent();
        }
    });
    return xml->toString();
}
```

The two lookup tables (`kLegacyToTracktionInternal`,
`kLegacyToConsolidatedAlgorithm`) live in a new header
`FXPluginRemap.h` so the mapping is centralised and unit-testable
without dragging in JUCE.

### Harness strip — what changes

`apps/engine-spike/native/harness.cpp:166-188` currently strips
**every non-sampler, non-lowpass plugin**. Under 57d:

- Permit `vst3` plugins **only when their filename matches our
  installed Consolidated path** — defence against an unmapped legacy
  ref slipping through after a future PresetManager.h edit.
- Permit `airwindows_*` types (they're built-in, can't be a phantom
  Windows VST instance).
- Continue stripping `vst` (VST2) — the legacy format is fully gone
  from our render path.

### End-to-end render comparison

After the remap lands, render one genre (recommend `brightPop` —
busiest plugin chain) with:
- The harness strip set to "remove only unmapped types"
- All 6 send/submix racks active

Compare loudness + spectral peak vs. the dry render baseline
captured in 56d. Expect:
- Output LUFS shifted down 1–3 dB (the master rack chain has
  Console8BussOut + EQ + Pyewacket etc., all of which add net
  attenuation).
- Spectral peak moved by the EQ + sub-bass shaping.
- No new silence intervals (would mean a rack chain failed to load
  silently — see the strip-only-unmapped guarantee).

Roll the result into the 56d matrix as a new "plugin-bearing"
column.

## What this slice landed

- `~/.vst3/Airwindows Consolidated.vst3/` — Consolidated VST3 installed.
- `~/.lv2/Airwindows Consolidated.lv2/` — Consolidated LV2 installed.
- `apps/engine-spike/native/plugin_smoke.cpp` — extended with
  `--scan-external` flag + Consolidated algorithm-selector probe
  (state-blob round-trip).
- `apps/engine-spike/test/plugin-hosting-smoke.spec.ts` — extended
  with 2 new tests in the `describeIfConsolidated` block that pin
  the scanner output + the algorithm round-trip.

No engine source changes. No harness changes. No production render
path changes. The slice is **non-invasive proof of the remap
mechanism**, not the remap itself.

## What 57d will land

1. `casperaki_engine/Source/FXPluginRemap.h` — the two lookup tables
   + the `buildAwconsolidatedStateBlob(algoName)` helper.
2. `casperaki_engine/Source/FX.h::loadXmlWithPluginFilePaths` —
   extended to transform plugin nodes per the tables.
3. `apps/engine-spike/native/harness.cpp` — strip loosened to
   "remove only unmapped types".
4. `apps/engine-spike/test/plugin-chain-remap.spec.ts` — pin the
   remap output for each of the 15 rack XMLs.
5. A 57d render-comparison report — loudness/spectrum delta vs. 56d.

## How to reproduce the inventory + probe

```sh
# Build the smoke binary (if not already built):
cmake --build apps/engine-spike/native/build --target casperaki_plugin_smoke

# Run the scan + algorithm probe:
apps/engine-spike/native/build/casperaki_plugin_smoke_artefacts/Debug/casperaki_plugin_smoke \
    --scan-external | tee /tmp/smoke-out.json

# Pin spec (covers both 57b and 57c):
pnpm --filter @casperaki/engine-spike test \
    -- --run test/plugin-hosting-smoke.spec.ts
```
