# 54n — Inventory of unproven audio lanes (drum loops + transitions)

> **STATUS: DISCOVERY / PLAN — scoreboard kept current as lanes land.**
> The scoreboard table below is the live source of truth for lane
> status; the per-lane planning sections (drum loops / transitions /
> signal processors) are kept verbatim for historical traceability but
> have been overtaken by the implementation docs they spawned. See the
> "Where each lane landed" pointer table immediately below the
> scoreboard.
>
> Companion to [`54o-loop-transition-fills-render.md`](54o-loop-transition-fills-render.md)
> (drum fills pass-through + TransitionSample spike + Loop spike),
> [`54p-transition-adapter-wiring.md`](54p-transition-adapter-wiring.md)
> (TransitionSample production wiring),
> [`54q-signal-processor-port.md`](54q-signal-processor-port.md)
> (signal-processor port — partial),
> [`54r-loop-adapter-wiring.md`](54r-loop-adapter-wiring.md)
> (percussion-loop production wiring),
> [`54m-guitar-render-spike.md`](54m-guitar-render-spike.md)
> (the per-lane render-spike playbook),
> [`54l-multisample-staging.md`](54l-multisample-staging.md)
> (frozen Bass/Keys/Pad baseline that subsequent spikes must not
> destabilise), [`53aa-step16-arrangement-polish-import.md`](53aa-step16-arrangement-polish-import.md)
> (the brain-side import of fills/transitions/SP),
> [`55a-juce-tracktion-modernization.md`](55a-juce-tracktion-modernization.md)
> (the modernization lane gating TransitionNoise / SP-automation), and
> [`53k-legacy-import-inventory.md`](53k-legacy-import-inventory.md)
> (the engine-bridge inventory this doc updates).

## Render-conformance scoreboard (current — refreshed 2026-06-09 post-56b patterns-stub fix)

> docs/56b adds a second canonical render target — `edm-vertical-slice`
> (genre=edm, key=C, bpm=128) — alongside the brightPop seed. EDM
> activates Drums + Bass + Synths + **PluckedSynths** (the lane 55a/56a
> kept dormant for brightPop) + Loop, with no Keys/Pad/Guitar (zero
> edm catalog rows). All audible Green lanes (Drums/Bass/Loop)
> reconfirm. **Synths/PluckedSynths render-silence on edm fixed**: the
> root cause was `TonalInstrument::processSegment` early-returning when
> `getInstrumentPattern(songData, inst->id)` found no matching entry,
> BEFORE the override path was consulted. The adapter now registers
> stub pattern entries for Synths (id=39140) and PluckedSynths
> (id=39160) so the engine's lookup succeeds. EDM render proof
> (post-fix): Synths/PluckedSynths audible at intro +14.6 dB,
> chorus1 +3.48 dB, bridge1 +1.05 dB, outro +2.80 dB. See 56b
> §"Engine patterns[] gap — diagnosis + fix" for the full diagnosis.

> Status legend: **Green** = brain-emits + adapter-lowers + audible
> render proof in the full brain-roundtrip. **Yellow** = wired but not
> audibly proven (or proven only in a fixture spike). **Red** =
> brain emits the tag but the adapter drops it. **Deferred** = blocked
> on an upstream question (plugin chain, JUCE/Tracktion modernization,
> DB-backed import, vocal model wiring).
>
> JUCE/Tracktion modernization is tracked separately in
> [`55a`](55a-juce-tracktion-modernization.md) — every Yellow / Deferred
> row that names "plugin-cleanup whitelist" or "FourOsc parameter
> port" is gated by that lane.

| Lane | Engine class | Brain emit | Adapter wiring | Audible-render proof | Status |
| --- | --- | --- | --- | --- | --- |
| Drums component hits | `Drums.h` (kick/snare/hat lanes) | ✓ (53u drum bank) | ✓ (53t/53y per-lane MIDI grids) | ✓ (54j Stage 2 + 54l baseline) | **Green** |
| Bass per-note tonal | `Bass.h` → SamplerPlugin | ✓ (53v bass bank) | ✓ (53w noteAbsolute lowering) | ✓ (54l baseline, FFT-verified) | **Green** |
| Keys per-note tonal | `Synths.h` → SamplerPlugin | ✓ (53x keys bank) | ✓ (53y chord+chordType lowering) | ✓ (54l baseline, FFT-verified) | **Green** |
| Pad per-note tonal | `Synths.h` → SamplerPlugin | ✓ (53x pad bank) | ✓ (53y chord lowering) | ✓ (54l baseline, FFT-verified) | **Green** |
| **Synths (leadSynths) — 3 of 4 brightPop styles** | `Synths.h` → SamplerPlugin (`getEDMArpeggiatorNotes` for EDMArpeggiator + `getRelativeNote` for noteRelative from the piano-bank styles) | ✓ (54z + 56a — selection from 26-row brightPop `leadSynths` catalog pool; per-fork style pick from EDMArpeggiator / EDMSynthsPlucked / EDMSynthsStabs) | ✓ (54z + 56a + 56b patterns-stub — `buildSynthsInst` 17-slot `padAndSynthNotes` multisample at ids 4000..4016; vst 39140; `tonalBarsFromBrainBars` passthrough; **patterns[0].pattern stub at id=39140** so the engine's getInstrumentPattern lookup succeeds and processSegment falls through to the per-segment override) | ✓ (56b — edm seed: intro +14.6 dB, chorus1 +3.48 dB, bridge1 +1.05 dB, outro +2.80 dB; brightPop seed: chorus1 +0.50 dB, bridge +0.15 dB. The 54z/56a +0.02..+0.22 dB measurement was Tracktion non-determinism — the lane was silently swallowed pre-fix.) | **Green** |
| Synths (leadSynths) — `playful` style | same Synths.h path | Deferred — needs `PlayfulSynthPatternGeneratorClass` port | n/a | n/a | **Deferred** |
| PluckedSynths (`synths/synthsPlucked` lane) | `Synths.h` → SamplerPlugin via `getRelativeNote` (`edmSynthsPluckedLibrary` style) | ✓ — brightPop seed dormant (no catalog rows); **edm seed picks `Tropical Square2` and emits 468 noteRelative events** (56b) | ✓ (56a + 56b patterns-stub — `buildPluckedSynthsInst` 17-slot `padAndSynthNotes` multisample at ids 4020..4036; vst 39160; `tonalBarsFromBrainBars` passthrough; **patterns[0].pattern stub at id=39160** so the engine's getInstrumentPattern lookup succeeds — same fix as Synths above) | ✓ (56b — edm seed: chorus1 +3.48 dB combined with Synths, break1 +0.15 dB PluckedSynths-only, chorus2/bridge1/chorus3 audible alongside Synths) | **Green** |
| **Drum fills (per-segment)** | `Drums.h::applyFill` | ✓ (53aa generateFills) | ✓ (54o pass-through) | ✓ (54o brain-roundtrip bar-RMS bump) | **Green** |
| **Transition samples** (cymbalsCrashHit / fxDownlifter / fxHighImpact / fxLowImpact / fxReverse / fxTonalReverse / fxTransition / fxUplifter / percussionBreaksBuildups / percussionBreaksFills) | `TransitionSample.h` | ✓ (53aa, tag + placement) | ✓ (54p resolver + timing port) | ✓ (54p brain-roundtrip — 11 insts across 6 segments, per-window RMS bumps +3.7 to +5.0 dB at onsets) | **Green** |
| **Percussion loops** (verse-only) | `Loop.h` (after engine patch 04 — see 54o) | ✓ (54r `selectLoop` + verse activation) | ✓ (54r `buildLoopInst` + per-seg flags) | ✓ (54r brain-roundtrip — +0.59 to +1.06 dB on every verse, ≈0 dB elsewhere) | **Green** |
| **Acoustic / electric guitar — chord comp** (per-note multisample pool) | `Guitar.h` (long/short notes sampler) | ✓ (54s + 54u — `selectInstruments` guitar role spans both families + chord-event pattern) | ✓ (54s + 54u — `buildGuitarInst` emits inst type from picked row's family) | ✓ (54s acoustic + 54u electric brain-roundtrip — +0.25 to +0.43 dB on every preChorus/chorus/bridge, 0.00 dB elsewhere) | **Green** |
| **Guitar fret noises** | `Guitar.h` (fretNoises sampler) | ✓ (54t — one fretNoise event per bar at beat 3.875, cycling sounds[0] through 8-slot pool) | ✓ (54t — 8-slot fxFretNoise pool at ids 9100..9107; per-family sibling resolution picks the right Default FX) | ✓ (54t — +0.16 to +0.46 dB on every Guitar-active bar-0 fret window, 0.00 dB on Guitar-inactive segments) | **Green** |
| **Guitar — chord strums** (`virtualGuitarist` pool) | `Guitar.h` (strums sampler, after engine patch 02) | ✓ (54y — full virtualGuitaristPatterns.json bank port replaces 54v's single-event-per-bar shape; multi-event-per-bar chord-strum + fx1..fx7 with per-genre BPM-aware style map) | ✓ (54y — extended `collectStrumPoolEntries` emits chord-strum AND fx pool entries; prestage stages chord files via 54v alias + fx files from `<preset>/fx/`) | ✓ (54y — +0.03 to +0.16 dB on narrow per-VG-onset windows, 0.00 dB on Guitar-inactive controls) | **Green** |
| **Guitar — per-string strums** (`type: 'strum'`, per-note pool) | `Guitar.h` (long/short notes sampler) via `SequencerUtils.h::getStrumNotes` | ✓ (54x — per-segment pick from legacy `guitarPatterns.json` Pop subset; 6 per-string events per bar) | ✓ (54x — `tonalBarsFromBrainBars` passes `strings/offset/durations/velocities` through; engine resolves per-string MIDI from `GuitarChord::getLowestPosition()` = `positions[0].midi`) | ✓ (54x — +0.06 to +0.31 dB on Guitar-active bar windows, 0.00 dB on Guitar-inactive controls) | **Green** |
| **Signal processors (LP sweep)** | `Instrument::applySignalProcessor` → Tracktion `LowPassPlugin` | ✓ (53aa, tag only) | ✓ (54q — tag → automation-point array port) | ⚠ partial (54q: render-path wired + LP plugin verifiably installed, but audible attenuation ≪ expected — engine-side `AutomatableParameter` automation read is the open gap) | **Yellow — partial** (see 54q §"Engine investigation required") |
| **Guitar fret noises** | `Guitar.h` (fretNoises sampler) | ✓ (54t — one fretNoise event per bar at beat 3.875, cycling sounds[0] through 8-slot pool) | ✓ (54t — 8-slot fxFretNoise pool at ids 9100..9107) | ✓ (54t — +0.16 to +0.46 dB on every Guitar-active bar-0 fret window, 0.00 dB on Guitar-inactive segments) | **Green** |
| **Drum mutes (per-segment)** | `Drums.h::createSegmentClip mute` | stub (legacy dead code) | ✗ | n/a (intentional no-op) | **Deferred — n/a** |
| **Transition noise** (fxNoiseRise — synthesized) | `TransitionNoise.h` (FourOscPlugin + LowPassPlugin envelope) | ✓ (53aa) | ✗ | ✗ | **Deferred** — needs `EffectsClass.getEffect({type:'fxNoiseRise'})` param port + harness plugin-cleanup whitelist (gated by [55a](55a-juce-tracktion-modernization.md)) |
| **Transition patterns** (edmSnareDrumRoll) | `TransitionPattern.h` | ✓ (53aa lists it; 0 audit-valid rows) | ✗ | ✗ | **Deferred** — 0 catalog rows; blocked on DB-backed import |
| Vocal melody | (none — adapter doesn't lower Vocal) | ✓ (53f/53ac/…) | ✗ | ✗ | **Deferred** — out of scope here (SoulX / ACE-Step path; separate post-port slice) |

**Cross-cutting**

| Concern | Status | Notes |
| --- | --- | --- |
| JUCE / Tracktion modernization | **Green (landed)** | Tracked in [`55a`](55a-juce-tracktion-modernization-spike.md) / [`55b`](55b-tracktion3-guitar-silence.md) / [`55c`](55c-modernization-reclassification.md) / [`55d`](55d-modernization-landing.md). JUCE 8.0.6 + Tracktion v3.2.0 is now the default `apps/engine-spike/native/` build; the parallel `native55a/` tree was retired and the 5-site port is captured as `05-port-juce8-tracktion32.patch` in the canonical chain (apply.sh now applies 01-05). Sampler-driven lanes (Drums / Bass / Keys / Pad / Guitar / Loop / TransitionSample) verified across the 5 proven fixtures + brain-roundtrip. External plugin-chain parity (VST2/VST3/AU scan + render) still **Yellow** — out of scope for 55a-d, deferred to the next plugin-bearing fixture gate. |
| Mix headroom (peak at 0 dBFS post-54p) | **Yellow** | Per-transition gain trim or `sampleTransitionsTrackFX` master pad — see 54p §"Headroom — render-quality follow-up". Not a blocker for new audible-content slices but each new lane should re-check peak/RMS and flag any worsening. |

**Bolded rows** were the original 54n in-scope set. Two of them
(Drum fills, Transition samples, Percussion loops) have since gone
Green. Signal processors are Yellow (partial); Transition noise +
Transition patterns + Drum mutes remain Deferred.

### Where each lane landed

| Lane | Landed in | Status |
| --- | --- | --- |
| Drum fills | [`54o`](54o-loop-transition-fills-render.md) — adapter pass-through | Green |
| TransitionSample | [`54o`](54o-loop-transition-fills-render.md) (spike) + [`54p`](54p-transition-adapter-wiring.md) (production wiring) | Green |
| Percussion loops | [`54o`](54o-loop-transition-fills-render.md) (engine patch 04 + spike) + [`54r`](54r-loop-adapter-wiring.md) (production wiring) | Green |
| Acoustic guitar — chord comp | [`54m`](54m-guitar-render-spike.md) (engine spike) + [`54s`](54s-guitar-adapter-wiring.md) (production wiring) | Green |
| Acoustic guitar — fret noises | [`54m`](54m-guitar-render-spike.md) (structural) + [`54t`](54t-guitar-fret-noise-wiring.md) (production wiring) | Green |
| Guitar — chord strums (`virtualGuitarist` pool) | [`54m`](54m-guitar-render-spike.md) (engine spike + patch 02) + [`54v`](54v-guitar-strum-wiring.md) (initial single-event wiring) + [`54y`](54y-guitar-pattern-bank.md) (full bank port — multi-event + fx) | Green |
| Guitar — per-string strums (`type: 'strum'`, per-note pool) | [`54x`](54x-guitar-per-string-strums.md) — Lane A pattern-bank import + per-string event passthrough | Green |
| Synths (leadSynths) — EDMArpeggiator | [`54z`](54z-synths-leadsynths-wiring.md) — production wiring via padAndSynthNotes multisample + EDMArpeggiator passthrough | Green |
| Synths (leadSynths) — EDMSynthsPlucked / EDMSynthsStabs | [`56a`](56a-piano-bank-port.md) — piano-bank port (LibraryPianoPatternGeneratorClass) + noteRelative passthrough | Green |
| PluckedSynths (`synths/synthsPlucked`) | [`56a`](56a-piano-bank-port.md) wired + [`56b`](56b-edm-vertical-slice.md) activated on edm seed + 56b patterns-stub fix (audible across every active segment) | Green |
| EDM vertical-slice canonical proof | [`56b`](56b-edm-vertical-slice.md) — `genre=edm` end-to-end pipeline + audible Drums/Bass/Loop/Synths/PluckedSynths after the patterns-stub fix | Green |
| Signal processors | [`54q`](54q-signal-processor-port.md) | Yellow (partial — see 54q §"Engine investigation required") |
| TransitionNoise | — | Deferred (blocked by [`55a`](55a-juce-tracktion-modernization.md)) |
| TransitionPattern (edmSnareDrumRoll) | — | Deferred (0 catalog rows) |
| Electric guitar | [`54u`](54u-electric-guitar-wiring.md) — multi-family selection + adapter inst-type mirroring | Green |

Per-lane planning sections below ("1. Drum loops / percussion loops",
"2. Transitions", "3. Signal processors") are **historical** — they
documented the discovery + sequencing for each row at the time of
write-up. The actual landed wiring (and its baseline numbers) is in
the implementation docs linked in the table above. Read those for the
current contract; read the sections below only to understand how the
sequencing was reasoned about.

---

## 1. Drum loops / percussion loops

### Legacy brain source

- **Selection**: `casperaki2-engine-js/api/v1.0/services/classes/arrangements/ArrangementsClass.js:681-708`. The legacy arranger filters `allUsedInstruments` for `type ∈ {percussionLoopsAcoustic, percussionLoopsElectronic}` and, in `verse` segments only, when genre ∈ {`ballad`, `edm`, `latin`, `brightPop`, `organicVibes`, `schlager`}, adds the FIRST already-newly-added percussion-loop instrument to the segment's instrument list. Per-verse only — no chorus / break / outro loops.
- **Renderer/per-track item**: `services/classes/renderer/reaperClasses/tracks/percussionLoops/item.js`. Reaper-side it emits a per-segment `<ITEM>` with `POSITION = previousSegmentsLengthInBars * 4 + offset + hit/8` and `LENGTH = (60/tempo) * (round(bpm * duration / 8 / 32) * 32) / 8`. I.e. the loop is laid down at the segment start (per-hit pattern indices), looped enough times to fill the segment.

### Catalog families

| Family | lowLevel sub-types **(per catalog snapshot)** | Validated rows | brightPop subset | Naming convention |
| --- | --- | --- | --- | --- |
| `percussionLoops` | `…Acoustic_60-89bpm`, `…Acoustic_90-119bpm`, `…Acoustic_120-150bpm`, plus `…Electronic_*` triplets | **7204** | 384 | `<preset> <BPM>bpm_modified.mp3` (e.g. `Pop Shaker 55bpm_modified.mp3`) |
| `percussionBreaks` | `percussionBreaksBuildups`, `percussionBreaksFills` | **3283** | 2839 + 500 | `<preset>_<BPM>bpm_modified[_extended].mp3` |
| `percussionMisc` | `percussionMisc{Acoustic,Electronic}{High,Low}` | 39 | 1 | one-shots; not loops |

> **CORRECTION (verified 2026-06-07): the catalog snapshot and the on-disk
> directory layout for `percussionLoops` are PARTIALLY OUT OF SYNC.** The
> committed audit reports matched paths under `_60-89bpm` / `_90-119bpm`
> / `_120-150bpm`, but the live Dropbox library has directories
> `_50-89bpm` / `_90-119bpm` / `_120-160bpm` (wider bpm ranges than
> the catalog's). Per-lowLevel audit-vs-disk reconciliation:
>
> ```
> percussionLoopsAcoustic_120-150bpm        0/3319 files exist on disk
> percussionLoopsAcoustic_60-89bpm          0/244  files exist on disk
> percussionLoopsAcoustic_90-119bpm      1493/1493 files exist on disk
> percussionLoopsElectronic_120-150bpm      0/694  files exist on disk
> percussionLoopsElectronic_60-89bpm        0/402  files exist on disk
> percussionLoopsElectronic_90-119bpm    1052/1052 files exist on disk
> ```
>
> Only the `_90-119bpm` rows (2545 of 7204) are loadable today; the
> `_60-89bpm` and `_120-150bpm` row matched paths point at disk
> directories the live library no longer has. Until the audit is
> regenerated against the current library, **only `_90-119bpm` rows
> are render-safe**. For the brightPop-vertical-slice's bpm=120 the
> brain would have to either round to the nearest in-range bpm (a
> ~9-10% timing mismatch) or fall back to the `tone.ogg`-style fixture.
> percussionBreaks + cymbals + all fx subdirs are 100% on-disk —
> the issue is specific to `percussionLoops`.

Disk layout under `/mnt/d/Scissero Dropbox/.../instruments/percussionLoops/<lowLevel>/`. Library tool that produced the variants: **`/mnt/d/Scissero Dropbox/.../loopStretcher/loopStretcher.js`** — shells `rubberband <src> <dst> --tempo <srcBpm>:<dstBpm> --fine --formant` for every integer bpm in `[bpmRangeLowerEnd=60, bpmRangeUpperEnd=100]`. (NB: the stretcher's hard-coded `[60, 100]` range is the SOURCE of the catalog's `_60-89bpm` and `_90-119bpm` buckets — files outside the script's range live in `_120-160bpm` from a different production run; the disk's `_50-89bpm` reflects a wider re-render.) **One row per (preset, bpm)** — all matched via the `simple` audit rule.

### Engine class — `Loop.h`

Inherits `Instrument` (not `TonalInstrument`). One audio track per loop. `processSegment` flow:

```cpp
loopInstrument->createSegmentClip (segName, segTimeRange, mute);
// inside:
auto waveClip = track->insertWaveClip(segName, sampleFile, ClipPosition{segTimeRange}, true);
// auto-detect bars from audio length:
auto b = edit.tempoSequence.toBarsAndBeats(waveClip->getSourceLength());
waveClip->setNumberOfLoops(b.bars);
waveClip->setLoopRangeBeats({0, b.bars * 4});
waveClip->setLength(segTimeRange.getLength(), true);
loopInfo.setBpm(bpm, fileInfo);   // bpm from inst.details.bpm
```

So the engine:
1. Inserts the source as a single WaveClip across the segment time range.
2. Reads the source's bar count from its audio length + the song tempo.
3. Sets the clip's loop range to that bar count and asks for enough loops to fill the segment.
4. **Tells the clip its sourceBpm via `LoopInfo::setBpm(bpm, fileInfo)`** — but does NOT trigger Tracktion's time-stretch. Because the file is **already** stretched to `song.bpm` offline by `loopStretcher.js` (the `<bpm>bpm_modified` variant), the clip plays at native rate with no resampling required.

**Conclusion: no live time-stretching needed.** Resolver picks the per-bpm catalog row matching `song.bpm`; staged playsample plays at native rate.

### Inst-N.json contract for `Loop`

```jsonc
{
  "id":            <playsample id>,
  "name":          "Loop",
  "type":          "percussionLoops",   // routed to Loop class via CasperakiEngine.cpp:458-460
  "lowLevelType":  "percussionLoopsAcoustic_60-89bpm",
  "details": {
    "bpm":      55,             // REQUIRED — Loop ctor parses via std::stoi
    "duration": 4.0             // REQUIRED — sample duration in seconds (currently unused after the ctor read; kept for parity)
  }
}
```

Sample loading: `SampleDownloader.downloadSamples(edit, playSamplePath, "playsample", {id})` → writes `playsample-<id>.ogg` into the JUCE temp dir. **Identical to Drums playsample staging.** Engine emits NO `samples[]` array.

### Expected `song.json` shape for loop activation

Per legacy convention (`arrangements/ArrangementsClass.js` + Sequencer):

```jsonc
"arrangement": {
  "verse1": {
    "instruments": { "Loop": true /* boolean — `isInstrumentInSegment` */ },
    "overrides":   { /* none — Loop doesn't take overrides */ },
    "fills": {}, "mutes": {}, "signalProcessors": {}, "transitions": {}
  }
}
```

`Loop::processSegment` accepts `segmentBars` but ignores them (uses segment time range). It DOES read `mute` (`getInstrumentMute`).

### Current status

| Layer | Loop coverage |
| --- | --- |
| Brain selection (`packages/arrangement/src/selection/index.ts`) | ✗ — `BRIGHTPOP_ROLES = ['drums', 'bass', 'keys', 'pad']`. No `loop` / `percussionLoop` role; not in `ROLE_CONFIG` either. |
| Brain orchestrate | ✗ — `selectInstruments` is the only entry point; no loop generator. |
| Engine adapter (`packages/engine-adapter/src/index.ts`) | ✗ — no `Loop` `inst-N.json` emit; no `instruments.Loop` flag. |
| Asset resolver | ✓ — `simple` rule handles per-bpm rows automatically (one row = one match). |
| Prestage | ✗ — no `playsample-<id>.ogg` staging for loops. |

### Smallest possible loop render spike — **54n-b** (proposed)

Mirrors the 54m guitar-spike playbook (self-contained `out/loop-spike/`):

1. Pick the brightPop-vertical-slice `song.bpm = 120` and a brightPop catalog row from `percussionLoopsAcoustic_120-150bpm` with `bpm = 120` (~32 candidates; pick deterministically by id-sort).
2. Build `song.json`: 1 segment (`verse1`) × 8 bars at 120bpm, Drums silenced, Loop = true.
3. Build `inst-1.json` (Drums silenced kit) + `inst-2.json` (Loop): `{id, name: "Loop", type: "percussionLoops", lowLevelType, details: {bpm: 120, duration: <ffprobe seconds>}}`.
4. Stage the loop's canonical .mp3 via `audio-normalize.mjs` (existing 54i ffmpeg cache, MP3→OGG) → write `playsample-<id>.ogg`.
5. Native render → measure RMS per bar (should be ≥ -30 dB and FAIRLY uniform across the 8 bars). FFT will be broad-spectrum percussive — no specific pitch verification needed, just sustained energy.
6. Write `docs/54n-b-loop-render-spike.md` with the same shape as 54m.

**No engine changes anticipated.** `Loop.h` doesn't have a sound-index-vs-MIDI parallel to the 54m bug.

### Stretch goals (NOT in the minimum spike)

- Detect & fall back when no exact-bpm variant exists (e.g., `song.bpm = 120` but only `119bpm` / `121bpm` rows are validated — round to nearest, log "best-match bpm").
- Per-genre verse-only activation rule from `ArrangementsClass.js:681-708`.
- Multi-loop layering (a verse can have multiple percussion loops if the legacy "newlyAddedTonalInstruments" filter selects more than one).

---

## 2. Transitions

### Legacy brain source

- **`api/v1.0/services/classes/arrangements/instruments/transitions.js#getArrangement`** — per-segment-type transition POOLS (the rules already imported into `packages/arrangement/data/arrangement-polish/rules.json` by 53aa).
- **`api/v1.0/services/classes/transitions/TransitionsClass.js#_getTransition`** — sample-id resolution + per-transition timing math:
  - **`fxNoiseRise`** branch (lines 70-93): calls `EffectsClass.getEffect({type:'fxNoiseRise', ...})` to build the synthesized white-noise + low-pass-sweep envelope (no sample id; consumed by engine `TransitionNoise.h`).
  - **`edmSnareDrumRoll`** branch (95-103): `sequenceStartPosition = floor(segDur * tempo/60 * 8) - min(segLen,4)*32`; writes `urls: ['/playSample/' + id, ...]` (multi-sample drum-roll pattern; consumed by `TransitionPattern.h`).
  - **`fxUplifter` / `percussionBreaksBuildups` / `percussionBreaksFills` / `fxReverse` / `fxTonalReverse`** branch (105-145): `climax = sampleDetails.climax || sampleDetails.duration`; `startPosition = (segDur - climax) * tempo/60 * 8` (with rounding tweaks per transition type). Writes `urls: ['/playSample/' + id]`. Consumed by `TransitionSample.h`.
  - **`cymbalsCrashHit` / `fxDownlifter` / `fxHighImpact` / `fxLowImpact` / `fxTransition` / `fxOther`** branch (147-172): `climax = sampleDetails.climax || 0`; `startPosition = (-climax) * tempo/60 * 8`. Writes `urls: ['/playSample/' + id]`. Also consumed by `TransitionSample.h`.

The brain's per-segment `arrangement[seg].transitions.<tag>` carries only `{type, placement}` today (53aa). The bridge layer (engine adapter) needs to:
1. Resolve the tag → catalog row (matching `tag === lowLevel`, brightPop addStyles filter, deterministic pick).
2. Compute `{sequenceStartPosition, sequenceStartPositionOffsetInSeconds, duration, climax}` from `TransitionsClass._getTransition`'s math.
3. Emit `inst-N.json` for the picked sample id + a `transitions.<tag>` block on the segment.

### Catalog families (transition tag → catalog `lowLevel`)

| Tag | Catalog `family/lowLevel` | Validated | brightPop subset | Engine class |
| --- | --- | --- | --- | --- |
| `cymbalsCrashHit` | `cymbals/cymbalsCrashHit` | 39 | 27 | `TransitionSample` |
| `fxDownlifter` | `fx/fxDownlifter` | 44 | 0 (edm-only) | `TransitionSample` |
| `fxHighImpact` | `fx/fxHighImpact` | 40 | 0 (edm-only) | `TransitionSample` |
| `fxLowImpact` | `fx/fxLowImpact` | 29 | 0 (edm-only) | `TransitionSample` |
| `fxReverse` | `fx/fxReverse` | 44 | 0 (edm-only) | `TransitionSample` |
| `fxTonalReverse` | `fx/fxTonalReverse` | 120 | 0 (edm-only) | `TransitionSample` |
| `fxTransition` | `fx/fxTransition` | 3 | 0 (edm-only) | `TransitionSample` |
| `fxUplifter` | `fx/fxUplifter` | 5 | 0 (edm-only) | `TransitionSample` |
| `percussionBreaksBuildups` | `percussionBreaks/…Buildups` | 2339 | 2339 | `TransitionSample` |
| `percussionBreaksFills` | `percussionBreaks/…Fills` | 944 | 500 | `TransitionSample` |
| `edmSnareDrumRoll` | `?` | **0** | **0** | `TransitionPattern` |
| `fxNoiseRise` | (synthesized, no sample) | 26 catalog rows but engine doesn't load — uses 4OSC + LP plugin instead | 0 | `TransitionNoise` |

**Two blockers in this table:**
1. **All `fx*` transitions are edm-only in the validated catalog** — 0 brightPop rows. The brain emits `fxDownlifter` / `fxTransition` / etc. tags for brightPop chorus / preChorus segments (per 53aa §"Slice seed concrete picks"), but the catalog has no brightPop-tagged rows. Sample resolution will fail with `unresolved`. **Acceptable for the spike** — we can use the `addStyles.includes('brightPop')` fallback (returns 0), then fall back to the edm-tagged rows (the legacy backend almost certainly did the same — fx samples are largely style-agnostic).
2. **`edmSnareDrumRoll` has zero validated rows.** The legacy backend likely populated this via a different mechanism (similar to virtualGuitaristSamples — DB BLOBs not in the Dropbox library). **Deferred** until the DB-backed import path lands.

`fxNoiseRise` doesn't need any sample at all — `TransitionNoise.h` synthesizes white noise + LP-filter automation entirely from `transitionData["frequencyStart"]` / `["volumeAttack"]` / `["decayDuration"]` parameters. Brain would emit those via the `EffectsClass` port (see "Signal processors" below).

### Engine class — `TransitionSample.h` (the most common)

Inherits `Instrument`. `processSegment(songData, inst, segName, segTimeRange, transitionData)` — the 5th arg is the **transition data var**, not segmentBars (unlike TonalInstrument). Flow:

```cpp
TimeRange transitionPlayRange{
  segTimeRange.getStart(),
  segTimeRange.getStart() + TimeDuration::fromSeconds(instrument->getDuration())
};
TimePosition sequenceStartPosition = edit.tempoSequence.toTime(
  BeatPosition::fromBeats((double) transitionData["sequenceStartPosition"]) / 8.0);
sequenceStartPosition += TimeDuration::fromSeconds(
  (double) transitionData["sequenceStartPositionOffsetInSeconds"]);
transitionPlayRange = transitionPlayRange.movedToStartAt(
  transitionPlayRange.getStart() + TimeDuration::fromSeconds(sequenceStartPosition.inSeconds()));
instrument->createSegmentClip(segName, transitionPlayRange, sampleTransitionsTrack);
// inserts a WaveClip on the sampleTransitionsTrack at transitionPlayRange.
```

Sequencer routes per-instrument: `Sequencer.cpp:444-457` checks `inst->type == transitionSample` and calls `processSegment(..., transitionData)` with the result of `getTransitionSegmentData(songData, inst, segmentName)`. `getTransitionSegmentData` is the per-transition fetch from `arrangement[seg].transitions.<inst-display-name>`.

### Inst-N.json contract for `TransitionSample`

```jsonc
{
  "id":            <playsample id>,
  "name":          "fx - fxDownlifter - edm - bigZ - Downlifter_1.mp3",  // display name from catalog matched path
  "type":          "transitionSample",     // routed to TransitionSample class via CasperakiEngine.cpp:461-462
  "lowLevelType":  "fxDownlifter",
  "details": {
    "bpm":      0,             // REQUIRED — ctor jassertfalse without it
    "duration": 3.2,           // REQUIRED — sample duration in seconds (used for clip length)
    "climax":   1.6            // OPTIONAL (defaults to 0) — when the impact / drop lands
  }
}
```

Sample loading: same `playSample/<id>` endpoint → `playsample-<id>.ogg`. Engine emits NO `samples[]` array (the inst IS the sample). One inst-N.json per transition picked. **Multiple transitions in the same segment = multiple inst files** (the engine instantiates one TransitionSample per id and routes them via `Sequencer.cpp:444`).

### Engine class — `TransitionNoise.h` (synthesized — fxNoiseRise only)

NO sample file. The ctor reads `details.frequencyStart` only. `createSegmentClip` reads ~9 parameters from `transitionData`:

```
sequenceStartPosition       (beats × 8)
sequenceStartPositionOffsetInSeconds
attackDuration, decaySequenceStartPositionOffsetInSeconds, decayDuration   (sec)
frequencyStart, frequencyEnd                                                (Hz)
volumeAttack, volumeSustain, volumeDecay                                    (dB)
```

Constructs a 4-oscillator white-noise plugin + LowPassPlugin via embedded XML preset, adds a single C1 MIDI note for the duration, and writes 2 automation curves (volume + LP frequency). The brain side needs to port `EffectsClass.getEffect({type:'fxNoiseRise'})` to compute these 10 parameters from genre/tempo — currently NOT in `packages/arrangement` (see §3 below).

### Engine class — `TransitionPattern.h` (edmSnareDrumRoll only)

Same shape as a multi-sample VST kit (carries `samples: [{id, note, type}, …]`) + a `transitionData["config"]["details"]["pattern"]` block mapping channel names → 32nd-note ASCII grids. The pattern is staged onto a StepClip; channels map to per-sample MIDI notes. Effectively a per-clip mini-Drums.

Sample loading: `if (isSample) playSample/`, else `vstSample/` — `transitionData["sampleOrVst"]` decides. Either way, `inst.samples[]` carries `{note, id}` and the engine builds a sampler.

**Zero catalog rows today (no `edmSnareDrumRoll` family/lowLevel pair found).** This lane is blocked until the DB-import path lands.

### Smallest possible transition render spike — **54n-a** (proposed)

Two-stage:

**54n-a-1** — `TransitionSample` proof, fxDownlifter on chorus1:

1. Pick the brightPop-vertical-slice `chorus1` segment. Catalog: query `fx/fxDownlifter` (edm-only — accept), pick `Downlifter_1.mp3` (id-sorted first).
2. Build `out/transition-spike/` self-contained envelope: `song.json` with 14 segments (or just chorus1 trimmed to 8s for a quick proof), Drums + Bass + Keys + Pad active (so we can hear the transition land OVER the existing tonal mix — proves it doesn't get muted), plus a `transitions.fxDownlifter = {type, placement}` block on chorus1.
3. Build `inst-1.json` (Drums) + tonal inst files (re-use brain-roundtrip outputs verbatim — copies of inst-2/3/4.json) + `inst-N.json` (`type: 'transitionSample'`, `lowLevelType: 'fxDownlifter'`, `details: {bpm: 0, duration: <ffprobe>, climax: <ffprobe loop info>}`).
4. Compute `_getTransition`'s math for the picked transition + emit `transitions.fxDownlifter = { id, sequenceStartPosition, sequenceStartPositionOffsetInSeconds, duration, urls: ['/playSample/<id>'] }` on chorus1. (NB: that block goes UNDER `arrangement[chorus1].transitions.<inst-display-name>` per `getInstrumentArrangementData`, not the `transitions.<tag>` shape the brain emits today; the adapter slice needs to translate.)
5. Stage the .mp3 → `playsample-<id>.ogg` via the existing `audio-normalize.mjs`.
6. Native render. Verify: chorus1's first ~3 seconds carries an audible downlifter sweep on top of the tonal mix (FFT not strictly required — the perceptual signature is a falling LP-sweep; we can confirm via per-time-window RMS jumps near the chorus boundary).

**54n-a-2** — `TransitionNoise` proof, fxNoiseRise:

1. Skip catalog (no sample). Build `inst-N.json` `type: 'transitionNoise'`, `lowLevelType: 'fxNoiseRise'`, `details: {frequencyStart: 200}`.
2. Hand-author `transitions.fxNoiseRise = {sequenceStartPosition, attackDuration: 2, decaySequenceStartPositionOffsetInSeconds: 1, decayDuration: 0.5, frequencyStart: 200, frequencyEnd: 8000, volumeAttack: -40, volumeSustain: -10, volumeDecay: -40}` — i.e. inline the EffectsClass output we'd later port.
3. Render; verify the noise sweep is audible just before chorus1.

`TransitionPattern` (edmSnareDrumRoll) — **deferred** until we have a catalog source for the per-channel pattern samples (the existing 0-row gap is the blocker).

### Engine integer-duration / type-check risks

The `var::isDouble()` bug we hit on Guitar strums (54m bug 2) recurs at:

- `TransitionPattern.h` ctor reads `instrumentData["sampleOrVst"]` — string, safe.
- `TransitionSample.h` ctor reads `instrumentData["details"]["bpm"]` (int), `["duration"]` (double), `["climax"]` (double). All accessed via raw `(double)` / `(int)` cast — those work on either JUCE var int or double. **No isDouble check here. Safe.**
- `TransitionNoise.h::createSegmentClip` reads 9 numeric fields from `transitionData` via raw `(double)` casts. **Safe.**
- `TransitionPattern.h::createSegmentClip` reads `(int) transitionData["sequenceStartPosition"]` + `(double) transitionData["sequenceStartPositionOffsetInSeconds"]`. **Safe.**
- `Loop.h` ctor reads `details["bpm"]` via `std::stoi(detailsData["bpm"].toString().toStdString())` — string-roundtrip, safe for both int and double JSON.
- `Drums.h::applyFill` (the fills path) reads only the `pattern` strings — no numeric properties; safe.
- `SequencerUtils.h getStrumNotes` — uses arrays, no isDouble checks. Safe.
- `SequencerUtils.h getSimpleNote` — `noteData["duration"].toString().getDoubleValue()`, no isDouble check. **Safe.**
- `SequencerUtils.h getFretNoises` — array iteration on sounds/offsets/durations/velocities; raw `(int)`/`(double)` casts. **Safe.**
- **`SequencerUtils.h getRelativeNote`** (used for `type: 'noteRelative'` events) — `(int) noteData["distanceFromMiddleC"]`, `(int) noteData["note"]`. The `int` cast works on both. **Safe.**
- **`SequencerUtils.h getArpeggioNotes`** — `(int) noteData["note"]`, `(int) noteData["octave"]`. **Safe.**
- **`SequencerUtils.h getEDMArpeggiatorNotes`** — needs spot check.
- **`SequencerUtils.h::getGuitarStrums`** — the one we patched in 54m (`hasProperty()` now, was `isDouble()`).

**Audit verdict for transition / loop paths: no additional `isDouble()` traps.** All numeric reads use raw casts which JUCE's `var` happily applies to either int or double. The Guitar strum bug was specifically the `isDouble()` gate, not the cast itself.

### Smallest possible loop / transition adapter wiring spike — **54n-c**

The two spikes above are fixture-driven (hand-authored inst-N + arrangement JSON). The full adapter wiring needs:

1. Lower brain `arrangement[seg].transitions.<tag>` (53aa output: `{type, placement}`) into the engine's `arrangement[seg].transitions.<inst-display-name>` (the fully-resolved transition data the engine reads via `getTransitionSegmentData`). Requires:
   - Tag → catalog row resolution (with brightPop / edm-fallback policy).
   - `_getTransition` port: sequenceStartPosition + climax math per tag type.
   - Per-segment `inst-N.json` emit (one inst file per picked transition).
2. Same for `Loop`: lower the per-genre verse-only activation rule + per-bpm catalog pick.
3. Same for `Drums.fills`: brain emits `arrangement[seg].fills.Drums.patterns.<slot>.<lane> = <ASCII grid>` already (53aa). Adapter currently writes `fills: {}`. Needs to PASS THROUGH that block verbatim — the engine's `Drums::applyFill` reads it directly from `getInstrumentArrangementData(songData, inst, segmentName, "fills")`.
4. Same for `signalProcessors` — but the engine consumes them differently (per-segment LP filter automation per `EffectsClass`; not yet ported to brain — see §3).

---

## 3. Signal processors / automation

### Brain emit today (53aa)

`arrangement[seg].signalProcessors.Drums = { type: '<tag>' }` for `break` / `bridge` segments only. **Tag only — no automation point arrays.** The legacy `EffectsClass.getEffect({type: 'lowPassFilter1000SweepUp', ...})` expands the tag into per-32nd-note `{time, value, curvature}` points (low-pass cutoff frequency over time + volume envelope). The brain currently records the tag; expanding it requires porting `EffectsClass` — explicitly deferred per 53aa §"Deferred" item #3.

### Engine consumption

| Path | Reads | Status |
| --- | --- | --- |
| `Drums::applySignalProcessor(segmentTimeRange, signalProcessorData)` | called from `Sequencer.cpp:468-472` if `signalProcessorData` is truthy | engine SIDE expects the expanded per-32nd-note automation array — exact format documented in `EffectsClass.getEffect` |
| `TransitionNoise.h::createSegmentClip` | builds its OWN automation in-line | independent — doesn't read signalProcessors at all |
| All other instruments | none | ignored |

Looking at `Drums::applySignalProcessor` is the next step (not done in this discovery — it's enough to know it exists and the tag-only brain emit doesn't satisfy it).

### Render proof shape

Once `EffectsClass.getEffect` is ported, the proof for a `break` segment's `lowPassFilter1000SweepUp`:

1. Render the same `break1` segment with and without the SP block.
2. Per-time-window FFT of an upper-frequency band (e.g. 8-16 kHz). The SP-on render should show falling energy in that band across the segment (sweep down) AND a 32nd-note-quantized step pattern in the LP cutoff envelope (audible "wobble" on percussive content).
3. RMS reduction in the upper band ≥ -12 dB vs the SP-off render.

### Scope decision

**Signal processors are out of scope for the immediate spike sequence.** The brain emit (tag only) doesn't carry enough to drive the engine; porting `EffectsClass` is its own slice (~500 LOC of legacy automation math). Document this fully in 54n; defer the spike to a `54p-signal-processor-port.md` (post-loops, post-transitions).

---

## 4. Known engine quirks (from patch-02 + this inventory)

Lessons from 54m's two-fix engine patch (`02-guitar-strum-soundindex-midi-offset.patch`) that apply to the upcoming spikes:

1. **`jassert` on missing `details.bpm` or `details.duration`** — both `TransitionSample` and `Loop` ctors call `jassertfalse` if those fields are missing. Debug builds crash before we even reach `processSegment`. Spikes MUST emit these fields.
2. **`jassert` on missing `fx.fxFretNoise` for Guitar** (54m fix) — analogous to the above; the pattern is "engine ctor requires a side-block that the spike fixture might forget". Audit checklist: every engine instrument class ctor needs its side-block requirements documented in the spike emitter.
3. **`getInstrumentPattern` returns `juce::var::undefined()` when `patterns[]` is missing → `processSegment` returns early** (54m fix). For Loop / TransitionSample / TransitionNoise / TransitionPattern, the engine uses different processSegment signatures that DO NOT call `getInstrumentPattern` (the routing in `Sequencer.cpp:444` decides by `inst->type`). So this trap is Guitar/Bass/Synths-only — the transition/loop spikes don't need the patterns stub. **Worth verifying with a fresh render** but documented here so the spike author doesn't add unnecessary plumbing.
4. **`var::isDouble()` gate** (54m fix). Audited above (§2) — no occurrences in Transition / Loop paths. All numeric reads use raw casts which work on either int or double.
5. **Plugin cleanup in harness** (`harness.cpp:167-183`) removes ALL non-SamplerPlugin plugins from EVERY track at render time. `TransitionNoise` installs a `LowPassPlugin` + `FourOscPlugin` (4OSC) onto its track — **the harness cleanup will remove them**, leaving the track silent. **The transition-noise spike will need the harness to be updated** (whitelist LowPass + FourOsc plugins, or skip cleanup for `transitionNoise` tracks) OR we accept that fxNoiseRise won't render until that's done.
6. **Sample-id vs MIDI-note confusion** (54m core fix) lives in `Guitar::ensureSampleMidiNote` — analogous patterns might exist in:
   - `Drums.h` — drum sample sound-index setup. Worth re-reading createSampler / ensureSampleMidiNote during 54n-c (drums fill insertion).
   - `TransitionPattern.h::createSampler` uses `getSampleNoteNumber(it->first)` (= `getMidiNoteNumber(noteName)`) for both keyNote and zone bounds, then writes `channel->noteNumber = getSampleNoteNumber(soundName)` for StepClip — looks correct (uses sample NOTE NAMES, not indices). **Safe.**
   - `TransitionSample.h` / `Loop.h` — no sampler at all; uses WaveClip. **Safe.**

---

## 5. Proposed sequencing

Five slices, two grouped pairs + one optional:

| Slice | Goal | Estimated complexity | Blockers |
| --- | --- | --- | --- |
| **54n-a-1** | `TransitionSample` render spike (fxDownlifter on chorus1, hand-authored fixture) | small (≈ one day) — mirrors 54m playbook | none |
| **54n-a-2** | `TransitionNoise` render spike (fxNoiseRise, hand-authored fixture) | small + harness change | harness plugin-cleanup needs to whitelist LowPass+4OSC for transitionNoise tracks |
| **54n-b** | `Loop` render spike (percussionLoopsAcoustic_120-150bpm, brightPop, hand-authored fixture) | small — even simpler than 54m (no sampler/MIDI; just a WaveClip) | none |
| **54n-c** | Adapter wiring: `arrangement[seg].{fills, transitions}` brain block → engine-envelope blocks + per-transition `inst-N.json` emit + per-loop selection rule | medium (≈ several days) — adds catalog-driven selection for loop role + per-tag transition resolver to engine-adapter + `_getTransition` math port | depends on 54n-a-1 + 54n-b passing |
| **54p** | `EffectsClass.getEffect` port (per-segment SP automation point arrays) + Drums `applySignalProcessor` proof | medium-large (≈ 500 LOC port + per-32nd automation math + render comparison) | independent — can run in parallel with 54n-c |

**Suggested order**: **54n-b → 54n-a-1 → 54n-a-2 → 54n-c → 54p**.

Rationale:
- **54n-b first** because it's the simplest (Loop class uses no sampler / no MIDI / no sound-index trickery — just a WaveClip). If it works first try, it gives confidence the playsample pipeline is reusable for non-Drums playsample-only families.
- **54n-a-1 second** because TransitionSample is structurally similar to Loop (single WaveClip on a dedicated track) with one added concept (the `sequenceStartPosition`/`climax` timing math).
- **54n-a-2 third** because TransitionNoise needs the harness plugin-whitelist change AND the inline EffectsClass parameter computation — best done after the simpler proofs land.
- **54n-c fourth** because by then we know the engine envelope shape required for both transitions and loops; the adapter just translates the brain's 53aa-emit into that shape.
- **54p in parallel or last** — SP automation is musically the most subtle and least production-blocking.

### Per-slice acceptance bar

Each render spike must:
- Produce a self-contained `out/<slice>/` directory with `song.json` + `inst-*.json` + `asset-manifest.json`.
- Stage the required samples (or, for TransitionNoise, install the synthesized plugins).
- Successfully render `out/<slice>/out.wav` (non-zero size, ≥ minimum duration).
- Show audible energy in the right per-time-window per `pnpm check:wav` + the existing `analyse-wav-pitch.mjs` (or per-window RMS for non-pitched lanes).
- Bass/Keys/Pad/Guitar baselines (54l + 54m) must remain green.
- Document the result + any new spike-local engine patch in `docs/54n-<slice>.md` mirroring the 54m structure.

---

## 6. What this doc deliberately does NOT do

- **No code changes.** No production-path edits, no engine patches, no fixture rewrites, no schema additions.
- **No baseline re-freeze.** 54l Bass/Keys/Pad numbers stand; 54m Guitar numbers stand.
- **No commitment to slice scope.** The "small / medium / large" labels are sketches — actual scope confirmed per slice when each one starts.
- **No claim of audio parity.** Until each lane has its own audible-render proof doc (54n-{a-1,a-2,b,c} + 54p), the render-conformance scoreboard at the top of this doc remains the authoritative status table.

## Files

### Added
- `docs/54n-unproven-audio-lanes.md` (this doc).

### Changed
- `docs/54l-multisample-staging.md` — added a short header note that
  patch 02 (54m) does not change the quantitative Bass/Keys/Pad
  baseline (stats unchanged, byte hash drifts non-deterministically).

### Not touched
- Engine source.
- `packages/engine-adapter`.
- `packages/arrangement`.
- `apps/engine-spike` scripts / fixtures.
- All workspace tests (710 still pass).
