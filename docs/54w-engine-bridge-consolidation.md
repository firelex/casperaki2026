# 54w — Engine-bridge consolidation pass

> **STATUS: DOC PASS — no behavioural changes.** This doc captures the
> current shape of the brain → adapter → CLI → engine bridge as it
> exists after 54r/54s/54t/54u/54v landed. It is a single jumping-off
> reference: which module owns which lane, which engine patches must be
> applied at runtime, and what is provably audible vs. still deferred.
> No new lane wiring lands here.
>
> Companion to [`50-engineering-plan.md`](50-engineering-plan.md)
> (phases + parallel-track plan),
> [`53k-legacy-import-inventory.md`](53k-legacy-import-inventory.md)
> §"Engine-bridge inventory" (the original campaign list),
> [`54n-unproven-audio-lanes.md`](54n-unproven-audio-lanes.md)
> §"Render-conformance scoreboard" (the LIVE per-lane status board —
> the table at the bottom of this doc mirrors 54n; 54n stays
> authoritative if the two ever drift), and
> [`55c-modernization-reclassification.md`](55c-modernization-reclassification.md)
> (the parked JUCE 8.0.6 / Tracktion 3.2 lane this consolidation does
> NOT touch).

## Why this doc exists

The engine bridge grew incrementally — one lane per slice doc from
`53t` (initial Drums adapter) through `54v` (virtualGuitarist chord
strums). Each slice doc is local to its own lane and reads as a
self-contained story. Newcomers have no single page that says
"here is everything that crosses the brain → engine seam, and which
parts are proven." This doc is that page.

Scope guardrails:

- **No code redesign.** Module boundaries are not moved; ids and
  filename indices are not renumbered; the staging diagnostics keep
  their existing per-lane shapes.
- **No new lanes.** Vocal rendering, TransitionNoise, TransitionPattern,
  per-string guitar strums, and any further pattern-bank import remain
  deferred — see the scoreboard at the bottom.
- **JUCE/Tracktion modernization landed.** The production baseline is
  now JUCE 8.0.6 + Tracktion v3.2.0 + spike patches 01-05 (the 55a
  port `05-port-juce8-tracktion32.patch` is now part of the canonical
  chain). The parallel `native55a/` tree was retired; `native/` is the
  single build root. See `docs/55d-modernization-landing.md`.

## Bridge architecture — top to bottom

```
                  ┌──────────────────────────────────────────┐
                  │  apps/brain (Express) — generates a      │
                  │  canonical Song via                      │
                  │  @casperaki/arrangement.orchestrate()    │
                  └─────────────────┬────────────────────────┘
                                    │ canonical Song (validated by
                                    │ packages/song-schema)
                                    ▼
                  ┌──────────────────────────────────────────┐
                  │  packages/engine-adapter                 │
                  │  toEngineFixture(song, options)          │
                  │    → { songJson, instruments[], diags }  │
                  │  Pure: no FS, no child_process, no       │
                  │  catalog queries beyond the validated    │
                  │  snapshot the caller passes in.          │
                  └─────────────────┬────────────────────────┘
                                    │ EngineFixture (in memory)
                                    ▼
                  ┌──────────────────────────────────────────┐
                  │  apps/engine-spike/scripts/              │
                  │   emit-brain-roundtrip.mjs               │
                  │     • orchestrates the brain Song        │
                  │     • runs toEngineFixture()             │
                  │     • probes per-lane sample durations   │
                  │     • writes out/brain-roundtrip/        │
                  │       {song.json, inst-*.json,           │
                  │        asset-manifest.json}              │
                  └─────────────────┬────────────────────────┘
                                    ▼
                  ┌──────────────────────────────────────────┐
                  │  apps/engine-spike/scripts/              │
                  │   prestage-samples.mjs                   │
                  │     • per-lane stagers under lib/        │
                  │     • normalises MP3/WAV → OGG via       │
                  │       audio-normalize cache              │
                  │     • writes playsample-<id>.ogg +       │
                  │       vstsample-<id>.ogg into the JUCE   │
                  │       temp dir                           │
                  └─────────────────┬────────────────────────┘
                                    ▼
                  ┌──────────────────────────────────────────┐
                  │  apps/engine-spike/native/...            │
                  │   casperaki_spike binary                 │
                  │     (patched casperaki_engine 7.0.5)     │
                  │   reads out/brain-roundtrip/* + temp dir │
                  │   → out.wav                              │
                  └──────────────────────────────────────────┘
```

The brain → adapter boundary is the `Song` schema (`@casperaki/song-schema`).
The adapter → CLI boundary is the in-memory `EngineFixture` struct.
The CLI → engine boundary is the `out/brain-roundtrip/` directory +
the JUCE temp dir.

## Adapter modules (`packages/engine-adapter/src/`)

| Module | Lane(s) | Pure? | Owns |
| --- | --- | --- | --- |
| `index.ts` (1337 LOC) | Drums hits/fills, Bass/Keys/Pad multisamples, signal processors, orchestrator | yes | `toEngineFixture` entrypoint; tonal-bars projection (shared by Bass/Keys/Pad/Guitar); base envelope read; per-segment override emission; transition + loop + guitar dispatch |
| `guitars.ts` (320 LOC) | Acoustic + electric Guitar (chord comp), fret noises, virtualGuitarist strums | yes | `buildGuitarInst`, `collectStrumPoolEntries`, `guitarDefinition`, the id-range constants (`DEFAULT_GUITAR_VST_ID=39111`, `*_SAMPLE_ID_BASE=9000`, `*_FRET_NOISE_ID_BASE=9100`, `*_STRUM_ID_BASE=9200`) |
| `loops.ts` (163 LOC) | Percussion loops | yes | `loopDefinitions`, `buildLoopInst`, `segmentHasLoopActive`; `LoopSampleProbe` interface |
| `transitions.ts` (275 LOC) | TransitionSample (10 tags) | yes | `TRANSITION_TAG_TO_LOW_LEVEL` map; `resolveTransitionRow`, `computeTransitionTiming`, `buildTransitionAssets`; `defaultClimaxForTag` |
| `signal-processors.ts` (118 LOC) | Signal processors (LP sweeps) | yes | `SUPPORTED_SP_TAGS`, `computeSignalProcessor`, `isSupportedSignalProcessorTag`; tag → per-32nd LP cutoff automation point port |

All five modules are pure — no `fs`, `child_process`, or external
network calls. The CLI layer owns every side effect.

### Id-range conventions

The id ranges are spread across `index.ts` (Bass/Keys/Pad wrapper +
transition + loop defaults) and `guitars.ts` (Guitar wrapper + the
three guitar pools). They are documented in 54v §"Engine instrument id
range" — reproduced here for cross-reference:

| Range | Owner | Source of truth |
| --- | --- | --- |
| 100 | Drums (inst-1.json) | `fixtures/base-drums-inst.json` |
| 945-960 | Bass VST samples | `fixtures/base-bass-inst.json` |
| 2048-2064 | Keys VST samples | `fixtures/base-keys-inst.json` |
| 3153-3169 | Pad VST samples | `fixtures/base-pad-inst.json` |
| 4000-4016 | Synths multisamples (54z) | `synths.ts::DEFAULT_SYNTHS_SAMPLE_ID_BASE` |
| 4020-4036 | PluckedSynths multisamples (55a) | `synths.ts::DEFAULT_PLUCKED_SYNTHS_SAMPLE_ID_BASE` |
| 9000-9029 | Guitar per-note multisamples | `guitars.ts::DEFAULT_GUITAR_SAMPLE_ID_BASE` |
| 9100-9107 | Guitar fret-noise pool | `guitars.ts::DEFAULT_GUITAR_FRET_NOISE_ID_BASE` |
| 9200+ | Guitar virtualGuitarist chord-strum pool | `guitars.ts::DEFAULT_GUITAR_STRUM_ID_BASE` |
| 26929-27770 | Drum kit playsamples | brain catalog rows → adapter graft |
| 38842 / 38907 / 38972 / 39111 / 39140 / 39160 | Bass / Keys / Pad / Guitar / Synths / PluckedSynths inst wrappers | `index.ts` defaults + `guitars.ts::DEFAULT_GUITAR_VST_ID` + `synths.ts::DEFAULT_*_VST_ID` |
| 40000+ | TransitionSample ids | `index.ts::transitionPlaysampleIdBase` default |
| 50000+ | Percussion loop ids | `index.ts::loopPlaysampleIdBase` default |

Each new lane gets its own range with a comment pointing at the
neighbours it must stay clear of. There is no centralised "id
allocator" because the existing per-lane defaults are easy to audit
locally and never collide.

### TonalInstrument patterns[] stub invariant — load-bearing

Every inst-N.json the adapter emits whose engine `type` routes to a
TonalInstrument-derived class — `basses` → `Bass.h`; `leadSynths` /
`synths` / `keys` / `popBrass` / `popStrings` / `orchestral` /
`vocals` → `Synths.h`; `acousticGuitars` / `electricGuitars` →
`Guitar.h` (`CasperakiEngine.cpp:440-456`) — MUST also appear at
`envelope.patterns[0].pattern[*].instrumentId`. The legacy engine's
`TonalInstrument::processSegment` (`TonalInstrument.h:36-43`) opens
with

```cpp
j::var pattern = getInstrumentPattern (songData, inst->id);
if (pattern.isUndefined()) return;
```

and only then (at `:60-67`) replaces `pattern` with the per-segment
override. So a missing pattern entry silently drops every override
on the floor — the inst loads, the multisamples stage, the override
events route through `tonalBarsFromBrainBars`, but no note ever
reaches the sampler. Diagnosed in [`56b`](56b-edm-vertical-slice.md)
§"Engine patterns[] gap" after Synths (id=39140) and PluckedSynths
(id=39160) were silently dropped on every active segment of the
edm-vertical-slice canonical seed.

The adapter enforces the invariant at the bottom of
`toEngineFixture`: it walks every emitted inst, and for each whose
`type` is in `TONAL_INSTRUMENT_TYPES`, calls
`ensureTonalPatternStub(patternList, instJson)`. That helper:

1. **Skips** any inst whose id is already present in
   `patterns[0].pattern` — preserving byte-stability for the
   pre-existing Phase-2 entries (Drums=100, Bass=38842, Keys=38907,
   Pad=38972, Guitar=39111, Loop=31384/37297 from
   `fixtures/base-engine-song.json`).
2. **Pushes** a stub `{bars: [{notes: {}}], instrumentId, instrumentName,
   instrumentType, instrumentType1, patternType: 'instrument'}` for
   any tonal id that is missing. Bass/Keys/Pad/Guitar are no-ops on
   the brightPop seed (legacy entries already cover them). Synths
   and PluckedSynths get fresh stubs on every seed that activates
   them.

The stub's `bars` MUST be non-empty: the engine walks pattern bars
with `patternBarIndex = barIndex % bars->size()`
(`TonalInstrument.h:83`), and an empty `bars: []` triggers
modulo-by-zero → SIGSEGV. A single `{notes: {}}` bar is sufficient
because the override replaces the pattern wholesale on every active
segment, and the engine's `isInstrumentInSegment` defaults to true
on a missing entry (`Sequencer.cpp:45`) — the stub is also the safe
fallback if a downstream mutation drops the explicit
`instruments.<Family>: false` flag.

The invariant is asserted by
`packages/engine-adapter/test/tonal-patterns-stub.spec.ts` (12
tests): every emitted tonal inst id has a matching entry; the
entry's `bars[]` is non-empty; no duplicates are introduced; no
stubs are emitted for non-tonal lanes; the
`patterns.tonalStubs` diagnostic surfaces what was added vs what
was already present in the base envelope.

`Drums.h::processSegment` has the same early-return shape but
currently uses id=100, which is in the base fixture, so the bug
cannot surface unless someone introduces a new Drums inst id
without updating the base. The invariant is scoped to tonal lanes
today because that is where the bug actually bit; if a future
slice introduces a second drum kit at a fresh id, the same shape
should be applied there.

### Filename indices

`inst-N.json` filenames are 1-indexed in lex order. The orchestrator
in `index.ts` walks the lanes in a fixed sequence:

```
1. Drums (always, even when silent — Phase 2 invariant)
2. Bass / Keys / Pad — only when the brain emits any event for the family
3. Guitar (54s/54u) — only when brain emits any Guitar event
4. TransitionSamples (54p) — one inst per resolved transition
5. Percussion loops (54r) — one inst per resolved loop
```

Each successive lane advances `nextFilenameIdx = instruments.length + 1`.
The hard-coded ordering is the only assumption — the prestage script
in `prestage-samples.mjs:138-150` hardcodes `Bass=inst-2`, `Keys=inst-3`,
`Pad=inst-4`, `Guitar=inst-5` and breaks if a future genre slice skips
any of those families. That fragility is called out in the script's
own comment block and is tracked as a follow-up; it is intentionally
NOT fixed in this consolidation pass.

## Staging modules (`apps/engine-spike/scripts/`)

Driver scripts:

| Script | Role |
| --- | --- |
| `emit-brain-roundtrip.mjs` (559 LOC) | The production CLI driver: orchestrates the brain Song, runs `toEngineFixture` with the live catalog + ffprobe duration probes, writes `out/brain-roundtrip/`. Tracks asset resolutions per family + emits `asset-manifest.json`. |
| `prestage-samples.mjs` (384 LOC) | The production stager: reads `out/brain-roundtrip/inst-*.json` + `asset-manifest.json`, dispatches to per-lane stagers under `lib/`, writes `~/.config/CasperakiSpike/Temporary/{playsample,vstsample}-<id>.ogg`. |
| `emit-{guitar,loop,fills,transition,loop-transition}-spike.mjs` | Self-contained fixture spike emitters — used during initial lane proofs (54m / 54o), kept as canonical reproduction harnesses. |
| `emit-engine-envelope.mjs` / `emit-minimal-drums.mjs` | Earlier Phase 2 driver shells; superseded by `emit-brain-roundtrip.mjs` for production use, kept for fast local repro / smoke tests. |
| `window-rms.mjs` | A/B compare two WAVs over named windows — the standard render-proof tool every audible-lane doc since 54p uses. |
| `analyse-wav-pitch.mjs` | FFT analyser used to verify chord-tone presence in the proven-render docs. |
| `check-wav.mjs` | Quantitative gates: peak/RMS/duration vs the 54l acceptance bar. |

Shared helpers under `lib/`:

| Helper | Owns |
| --- | --- |
| `audio-normalize.mjs` (373 LOC) | The ffmpeg MP3/WAV → OGG cache, keyed on `(absolute source path, size, mtime)`. Every lane (drums kit, multisample slices, loops, transitions, strums, fret noises) routes its source files through this. |
| `audio-slice.mjs` (317 LOC) | The ffmpeg slice variant of the same cache, keyed on `(source, size, mtime, sliceStart, sliceEnd)`. Used by `stage-multisample.mjs` and the inline Guitar fret-noise block in `prestage-samples.mjs`. |
| `audio-cache-root.mjs` | Resolves the audio cache root from env var or repo-local fallback. |
| `multisample-resolver.mjs` (280 LOC) | Pure resolver: walks the engine inst's `samples[]` against the lane's timing JSON (`bassNotes` / `pianoNotes` / `padAndSynthNotes` / `guitarNotes`), pops first-match by `(note, type)`, skips IGNOREs. |
| `stage-multisample.mjs` (333 LOC) | Driver for Bass / Keys / Pad / Guitar per-note multisample staging. Handles per-slot fixture fallback. |
| `stage-drums.mjs` (273 LOC) | Per-lane drum kit assembly: walks the brain catalog verdict per role, falls back to bundled fixtures (kick / snare / hat / tone). |
| `stage-bass.mjs` / `stage-tonal.mjs` + `bass-asset-bridge.mjs` / `tonal-asset-bridge.mjs` | Pre-54l single-source stagers. Retained as back-compat for existing spec files (the entrypoint in `prestage-samples.mjs` no longer calls them). |
| `stage-guitar-strums.mjs` (184 LOC) | Per-strum-pool staging — looks up each `<chord>_Pos_<N>_<Long\|Short> Strum_<Down\|Up>.mp3` and normalises through the cache. Used by the production stager via the chord-alias translation. |
| `guitar-chord-alias.mjs` | Pure helper: engine sharp form → disk-canonical form (`A# → Bb`, `C# → C#`, `D# → Eb`, `F# → F#`, `G# → Ab`, …). |

### Per-lane sample sourcing

| Lane | Source resolution | sourcePath / matchedPath flow |
| --- | --- | --- |
| Drums per-lane | brain catalog verdict (per-role; `kickDrums` / `snareDrums` / `hiHatsClosed` …) | `asset-manifest.json#Drums.lanes[role].relativePath` (from emit) → prestage joins with `SAMPLE_LIBRARY_ROOT` |
| Bass / Keys / Pad multisample | brain catalog row → `<preset>.mp3` canonical source → mp3split timings | `asset-manifest.json#<Family>.canonicalRelativePath` + per-slot `multisample.slots[]` plan |
| Guitar per-note | same as Bass/Keys/Pad — `guitarNotes.json` timings on `<preset> - Default Notes.mp3` | `asset-manifest.json#Guitar.canonicalRelativePath` + per-slot multisample plan |
| Guitar fret noises | `<preset> - Default FX.mp3` sibling of Default Notes — 8 equal slices | `asset-manifest.json#Guitar.fretNoiseSibling.relativePath` |
| Guitar virtualGuitarist strums | `<preset>/chords/<chord>_Pos_<N>_<…>.mp3` direct file lookup | `asset-manifest.json#Guitar.chordsAbsDir` + chord-alias translation at the FS edge |
| TransitionSample | brain transition tag → catalog `(family, lowLevel)` → row id → `matchedPath` | embedded in the inst's `sourcePath` field (transitions.ts → emit-brain-roundtrip writes it onto each inst-N.json) |
| Percussion loops | brain Loop selection → `<preset>_<bpm>bpm_modified.mp3` | embedded in the inst's `sourcePath` field (loops.ts) + catalog→disk lowLevel alias translation in the CLI |

### Per-lane "missing sample" behaviour

| Lane | If source not on disk |
| --- | --- |
| Drums per-lane | fixture fallback (`kick.ogg` / `snare.ogg` / `hat.ogg` / `tone.ogg`); explicit `[prestage] <role> ← fixture(…)` log; lane count `M/N from real catalog samples, K from bundled fixtures` |
| Bass / Keys / Pad / Guitar multisample slot | fixture fallback per-slot (`bass-c2.ogg` / `tone.ogg`); per-slot log line with reason; family summary `M/N slots from real slices, K/N from fixture fallback` |
| Guitar fret-noise pool | fixture fallback (`tone.ogg`) across the whole pool when the sibling is missing or library not mounted; explicit `fxFretNoise: N dummy slot(s) staged via tone.ogg — <reason>` |
| Guitar virtualGuitarist strums | explicit skip with error; NO silent fallback per 54v's staging policy; reports `Guitar strums: X/N staged, Y skipped` |
| TransitionSample | explicit skip + `transition <inst>: source MISSING (<path>)` + roll-up `transitions: X staged, Y skipped` |
| Percussion loops | explicit skip + `loop <inst>: source MISSING (<path>)` + roll-up `loops: X staged, Y skipped` |

The two policies (fixture fallback vs. explicit skip) are intentional
and reflect each lane's source semantics: the Drums kit and tonal
multisamples have bundled fixtures that play SOMETHING audible when
the library is absent; the strum pool has no fixture analogue (each
chord file is a unique recording), and a missing transition / loop
would silently mis-render rather than fail-loud, so we prefer the
diagnostic. This is documented per-lane in the slice docs (54l / 54p /
54r / 54v); the table here exists so the choice is auditable in one
place.

### Staging diagnostic shapes

The per-lane summary log lines currently use three different shapes:

```
[prestage] drum kit summary: 17/17 lanes from real catalog samples, 0 lanes from bundled fixtures
[prestage] bass multisample summary: 16/16 slots from real slices, 0/16 slots from fixture fallback, 0 skipped
[prestage] Guitar strums: 5/5 staged, 0 skipped
[prestage] transitions: 11 staged, 0 skipped
[prestage] loops: 1 staged, 0 skipped
```

The inconsistency (`lanes` vs `slots` vs `entries` vs bare counts;
`real vs fixture-fallback` vs `staged vs skipped`) is intentionally
left alone in this pass — every lane's count semantics differ enough
that a forced normalisation would lose information. If a future slice
brings a consumer that depends on a structured parse of these lines
(e.g. CI assertions), promote them to a single `diagnostics.json`
artefact rather than mangling the human-readable logs.

## Engine patches required at runtime

The four spike-local patches live at
`apps/engine-spike/patches/`. `apply.sh` is idempotent. All four are
required for the production render of the canonical
`brightPop-vertical-slice` seed.

| Patch | What it fixes | Lane(s) it gates |
| --- | --- | --- |
| `01-edit-forRendering.patch` | `CasperakiEngine::prepareEdit` constructs `te::Edit` with `Edit::forRendering` instead of `Edit::forEditing` — silent render on headless hosts. | All rendered lanes. Docs/52e fix #7. |
| `02-guitar-strum-soundindex-midi-offset.patch` | `Guitar::ensureSampleMidiNote` adds `+48` MIDI offset on strum keyNote + `Guitar::createSegmentClip` uses `getKeyNote(soundIndex)` (was raw index → C-1/C#-1/D-1 inaudible). `SequencerUtils::getGuitarStrums` accepts integer-valued JSON durations (was `isDouble()`-gated → silent drop). | Guitar virtualGuitarist chord strums (54v). |
| `03-sequencer-fx-submix-eager-create.patch` | `Sequencer.cpp` eagerly creates the `submixTracks[fx]` track on first transitionSample so cymbalsCrashHit etc. don't null-deref. | TransitionSample (54p). |
| `04-loop-skip-setlooprangebeats.patch` | `Loop.h::createSegmentClip` drops `setLoopRangeBeats(...)` (hangs `Renderer::renderToFile`) + drops `setLoopInfo` (library is pre-stretched per bpm) + uses `setNumberOfLoops(ceil(seg/source))` for tiling. | Percussion loops (54r). |

Patch persistence policy: all four stay spike-local until the brain
side actually exercises legacy DB-driven songs that might depend on
the original behaviour. Promote to `casperaki_engine` only after the
legacy JSON-emit shapes have been audited. A fifth patch
`05-port-juce8-tracktion32.patch` was added in the 55a/55b/55c/55d
modernization landing — it ports the engine to JUCE 8.0.6 + Tracktion
v3.2.0 (5 sites; `te::Edit::Options` ctor subsumes patch 01's
`Edit::forRendering` enum reference, `TransportControl::setPosition`,
`Renderer::renderToFile` `useACID` arg, hide `clearAllContextDevices`,
`DynamicObject::clone` returns `unique_ptr`). The native55a/ parallel
tree was retired into `native/` once the upgrade landed.

## Proven / deferred scoreboard

The authoritative live source is
[`54n-unproven-audio-lanes.md` §"Render-conformance scoreboard"](54n-unproven-audio-lanes.md#render-conformance-scoreboard-current--refreshed-2026-06-08-post-54v).
Snapshot at the time of this consolidation:

**Green — production-wired with audible render proof on the canonical
`brightPop-vertical-slice` seed:**

| Lane | Adapter module | Staging | Doc |
| --- | --- | --- | --- |
| Drums component hits | `index.ts` | `lib/stage-drums.mjs` | 53t / 54j |
| Drum fills | `index.ts` (pass-through) | `lib/stage-drums.mjs` | 54o |
| Bass per-note multisamples | `index.ts` (tonal-bars) | `lib/stage-multisample.mjs` | 53w / 54l |
| Keys per-note multisamples | `index.ts` (tonal-bars) | `lib/stage-multisample.mjs` | 53y / 54l |
| Pad per-note multisamples | `index.ts` (tonal-bars) | `lib/stage-multisample.mjs` | 53y / 54l |
| Acoustic + electric Guitar chord comp | `guitars.ts` | `lib/stage-multisample.mjs` (Guitar family) | 54s / 54u |
| Guitar fret noises | `guitars.ts` (pool emit) | inline `audio-slice` block in `prestage-samples.mjs` | 54t |
| Guitar virtualGuitarist chord strums + fx | `guitars.ts::collectStrumPoolEntries` (chord-strum + fx entries) | `lib/stage-guitar-strums.mjs` + `lib/guitar-chord-alias.mjs` + `<preset>/fx/` lookup | 54v + 54y |
| Synths (leadSynths / EDMArpeggiator) | `synths.ts::buildSynthsInst` + `index.ts` EDMArpeggiator passthrough | reuses `lib/stage-multisample.mjs` (padAndSynthNotes timing) — no new staging code | 54z |
| Synths (leadSynths / EDMSynthsPlucked + EDMSynthsStabs) | reuses `synths.ts::buildSynthsInst`; `index.ts` adds noteRelative passthrough; `arrangement/src/patterns/piano-bank.ts` does the library expansion | reuses `lib/stage-multisample.mjs` | 56a |
| PluckedSynths (`synths/synthsPlucked`) | `synths.ts::buildPluckedSynthsInst` (type='synths' vs leadSynths' 'leadSynths'); `index.ts` adds PluckedSynths override branch | reuses `lib/stage-multisample.mjs` | 56a |
| Guitar per-string strums (`type: 'strum'`) | `index.ts::tonalBarsFromBrainBars` passthrough | reuses 54s per-note multisample pool — no new staging | 54x |
| TransitionSample (10 tags) | `transitions.ts` | inline transition/loop block in `prestage-samples.mjs` | 54p |
| Percussion loops (verse-only) | `loops.ts` | inline transition/loop block in `prestage-samples.mjs` | 54r |

**Yellow — wired but not fully audibly proven, OR partially deferred:**

| Lane | Notes |
| --- | --- |
| Signal processors (LP sweeps) | `signal-processors.ts` ports the tag → per-32nd LP cutoff automation point array (54q); engine's `Instrument::applySignalProcessor` reads it; **audible attenuation ≪ expected**. Open gap is the engine-side `AutomatableParameter` read — tracked in 54q §"Engine investigation required". |

**Deferred — brain emits nothing today, or upstream blocker:**

| Lane | Blocker |
| --- | --- |
| TransitionNoise (`fxNoiseRise`) | Brain doesn't emit for brightPop today; harness plugin-cleanup whitelist for `FourOscPlugin` + `LowPassPlugin` needed; `EffectsClass.getEffect({type:'fxNoiseRise'})` parameter port. Tracked in 54n §2 + 54p. |
| TransitionPattern (`edmSnareDrumRoll`) | Zero validated catalog rows in the snapshot. Blocked on a DB-backed import. |
| Vocal rendering | Brain emits vocal melody (53f / 53ac-ah); engine adapter has NO Vocal lowering path today. Decision-gated on SoulX-Singer vs. legacy Vocaloid (50-engineering-plan §"Phase 4"). |

## Known mix / plugin-chain caveats

These are not lane bugs — they are honest deficits of the current
render pipeline that any future "mastering / mix parity" lane will
need to resolve. None are blockers for adding new audible lanes.

1. **Peak at 0 dBFS post-54p.** The full brain-roundtrip peak sits at
   0.00 dBFS because the cymbalsCrashHit + percussionBreaks fx
   transitions stack on top of the dense Drums/Bass/Keys/Pad mix
   without a master pad. Tracked in 54p §"Headroom — render-quality
   follow-up". Every new audible-content slice since 54r re-checks
   peak/RMS and flags worsening.
2. **External plugin-chain parity is untested.** The native harness
   (`harness.cpp:167-183`) strips ALL non-Sampler plugins from every
   track at render time. Production-equivalent plugin behaviour
   (Dune, Serum, FourOsc, LowPassPlugin in particular) is therefore
   not exercised. The 55c migration-branch CI gate is the planned
   forcing function. Until then, neither the pinned 7.0.5 nor the
   55a 8.0.6 stack can claim plugin-chain parity.
3. **TransitionNoise + signal-processor automation read gaps** depend
   on the same plugin-cleanup whitelist + a clean engine-side
   `AutomatableParameter` read path. Both are tracked under
   55a/55c modernization.
4. **Per-WAV PCM byte non-determinism.** Tracktion's render pipeline
   has minor per-sample non-determinism between runs at the
   amplitudes we render. Every Green-lane doc since 54l notes that
   per-WAV md5 / sha256 drifts run-to-run; per-window peak/RMS is
   stable to ±0.5 dB. Determinism gates therefore live at the brain
   layer (`canonicalStringifySong` byte equality + selection /
   pattern goldens), not at the WAV layer.
5. **`base-engine-song.json` carries stale legacy `instrumentName`
   strings** with un-resolved `${vstSuffix}` placeholders
   (`instrumentName: "Loop - undefined - 99"` etc.). Cosmetic only —
   the engine treats these as opaque labels — but the fixture is
   misleading authoring data. Tracked in `53k` §"Engine-bridge
   inventory" → "Base-envelope fixture hygiene". Out of scope here.

## What this consolidation pass changed in code

- `packages/engine-adapter/src/index.ts` header block (lines 5-27):
  updated the wired-lane bullets to include Loop (54r), Guitar
  (54s/54t/54u/54v), and signal processors (54q — partial); moved
  signal processors out of the "Still deferred" list (it has a port
  now, even though the engine-side read is still under investigation).
- `docs/54n-unproven-audio-lanes.md` §"Where each lane landed":
  collapsed the duplicate "Acoustic guitar — strum samplers" entry
  (the virtualGuitarist half is Green via 54v; the per-string half
  is the existing "Guitar — per-string strums" Yellow row).

No behavioural changes. No id-range moves. No new tests.

## What this consolidation pass deliberately did NOT do

- **No module restructuring.** `index.ts` is 1337 LOC and grew
  organically across 53t..54v. A future "extract per-lane orchestrator
  blocks out of index.ts" pass is possible but is a refactor, not a
  consolidation — out of scope per the slice brief.
- **No id-allocator centralisation.** Each lane owns its base
  constant locally (`guitars.ts` exports the four Guitar bases;
  `index.ts` carries the transition + loop defaults). They never
  collide and the existing layout is easy to audit; a central
  allocator would be ceremony without payoff today.
- **No staging-log unification.** The three diagnostic shapes (`lanes`
  vs `slots` vs bare counts) reflect three legitimately different
  count semantics; forcing one shape would lose information.
  Documented honestly in §"Staging diagnostic shapes" above.
- **No engine-patch promotion.** All four patches stay spike-local
  per their current persistence decisions.
- **No JUCE / Tracktion modernization.** 55c's "do not migrate main"
  recommendation stands.
- **No new lane wiring.** fxNoiseRise, edmSnareDrumRoll, and vocal
  rendering remain deferred with the same blockers they had before
  this pass. (Per-string guitar strums went Green via 54x; see the
  whole-WAV stats table below.)

## Workspace status after this pass

- Build clean (`pnpm -r build`).
- Typecheck clean (`pnpm -r typecheck`).
- Tests: workspace test count unchanged from post-54v (no behavioural
  changes; only one source comment update + one doc cleanup).
- Brain-roundtrip render: unchanged. Same `out.wav` shape as 54v's
  post-strum render (210 s, peak 0.00 dB, RMS ≈ -20.11 dB).

## Whole-WAV stats per landed lane (brightPop-vertical-slice seed)

Cumulative on-top stack — each row's "RMS" is the full
brain-roundtrip render after that lane landed (every prior lane is
also active).

| Lane landed | Doc | Duration | Peak | RMS |
| --- | --- | --- | --- | --- |
| Baseline (Drums + Bass + Keys + Pad + transitions + loops) | 54p / 54r | 210 s | 0.00 dB | -20.21 dB |
| Guitar chord comp (54s + 54u) | 54s / 54u | 210 s | 0.00 dB | -20.18 dB |
| Guitar fret noises (54t) | 54t | 210 s | 0.00 dB | -20.15 dB |
| Guitar virtualGuitarist chord strums (54v) | 54v | 210 s | 0.00 dB | -20.11 dB |
| Guitar per-string strums (54x) | 54x | 210 s | 0.00 dB | -20.14 dB |
| Guitar virtualGuitarist multi-event + fx pool (54y — replaces 54v) | 54y | 210 s | 0.00 dB | -20.12 dB |
| Synths (leadSynths / EDMArpeggiator) (54z) | 54z | 210 s | 0.00 dB | -20.40 dB |
| Synths (leadSynths / EDMSynthsStabs picked) + piano-bank port (56a) | 56a | 210 s | -0.00 dB | -20.14 dB |
| EDM vertical slice — full render (56b) | 56b | 95.6 s | -4.63 dB | **-22.63 dB** |

Reading: per-string strums (54x) add +0.12 dB RMS over the post-54v
baseline (the WITH/WITHOUT A/B in 54x's render proof). Peak stays at
0 dBFS — no new clipping. The slight RMS drop from -20.11 to -20.14
is within run-to-run variability of the Tracktion render pipeline
(see "Per-WAV PCM byte non-determinism" caveat above) — the per-
window Δrms in 54x's table is the authoritative measure.
