# 11 — Legacy audio engine: `casperaki_engine`

> Origin: `Casperaki/casperaki_engine` · C++ / JUCE / Tracktion Engine · last active
> 2024-05 (~199 commits, 13 branches). This is the **renderer**: it turns the brain's
> `song.json` into actual audio. It does **no** musical generation.

## What it is

A native audio engine built on **JUCE** + **Tracktion Engine** (a full DAW engine).
It loads a fully-specified song JSON, builds a Tracktion `Edit` (tracks, MIDI clips,
sampler/VST plugins, FX submixes, master chain), plays it back, and renders/masters
to WAV. Critically, it **compiles to WebAssembly** so the same engine can render
audio in a browser.

## Build targets & toolchain

Projucer (`.jucer`) projects, each producing a target:

| Target | Path | Output |
|---|---|---|
| **WASM** | `LibWASM/casperaki_engine_emscripten.jucer` | static lib → `emmake make CONFIG=Release` |
| Android | `LibAndroid/LibAndroid.jucer` | Android library (Android Studio) |
| iOS | `LibIOS/LibIOS.jucer` | iOS framework (Xcode) |
| Linux app | `LinuxApp/.../LinuxApp.jucer` | desktop/server app |
| Tester app | `TesterApp/TesterApp.jucer` | desktop test harness |
| InstrumentalGenerator | `InstrumentalGenerator/*.jucer` | batch-export CLI |
| SongGen | `SongGen/SongGen*.jucer` | macOS variant |

**Submodules** (in `.gitmodules`, currently **not initialized** in our clone):

```
dependencies/tracktion_engine            (+ _android, _emscripten forks)
dependencies/matchering                  audio mastering DSP
dependencies/choc                        header-only audio/MIDI utils
```

To build, you'll need: JUCE/Projucer, the submodules initialized, and (for WASM)
the Emscripten SDK. Recent commits ("WASM working again!") suggest the WASM path had
bit-rot that was being fixed — **expect to spend time getting it to build**.

`config.h` flags: `USE_TE_SAMPLER` vs `USE_CASPERAKI_SAMPLER`,
`SHOULD_RETAIN_PROJECT_FILES`, `SHOULD_RUN_TESTS`.

## Core architecture (`Source/`)

`CasperakiEngine` (`CasperakiEngine.h/.cpp`) owns:
- `te::Engine` + `te::Edit` (the Tracktion project), `te::TransportControl`.
- A `Sequencer` (builds the edit from JSON) and an `OwnedArray<Instrument>`.
- Lifecycle: `initialise()` (44.1 kHz), `prepareEdit/load/save/deleteEdit`,
  `play/pause/stop/seekTo`, `increaseTempo/decreaseTempo`.
- `setSong()` / `setVibe()` — load song JSON, delegate to `Sequencer`.
- Instrument control: `addInstrument`, `removeInstrument`, `setInstrumentMute`,
  `setInstrumentPostVolume`.
- Plugin hosting: `scanExternalPlugins()`, `scanAirWindowsPlugins()` (the bundled
  `ExternalPlugins/Mac/*.vst`: EQ, DeEss, console emulations, etc.).
- A 50 Hz `HighResolutionTimer` broadcasts a `ControlState` callback:

```cpp
struct ControlState {
  std::string state;        // stopped | playing | paused
  double position, length;  // seconds
  int step, beat, bar;      // musical grid
  std::string segment;      // "intro" | "verse" | ...
  int bpm; std::string chord;
};
```

### Tracktion edit layout
Arranger track (segment markers) · chord track · per-instrument MIDI/audio tracks
routed into folder submixes (kicks, snares, toms, synths, bass, keys, fx…) → master
track with limiter/EQ.

## Generation? No — rendering only

The engine **renders pre-generated data**. There is no algorithm that invents note
sequences; every note/chord/pattern comes from the JSON. The `Sequencer.setSong()`
walks `arrangement.<segment>` and, per instrument, calls `processSegment()` to insert
MIDI/audio clips.

Instrument classes (`Source/instruments/`): `Instrument` (abstract, 13 types),
`TonalInstrument` (abstract), `Bass`, `Drums`, `Synths`, `Guitar`, `Loop`,
`TransitionSample/Noise/Pattern`. Music theory in `Source/music/` (`Chord.h` — 40+
chord types, `Note.h`, `ChordData.json`) is used to **resolve** chord symbols into
concrete MIDI notes at render time, not to compose.

Supported note "types" inside the JSON (resolved by the engine):
`note`, `chord`, `noteRelative`, `EDMArpeggiator`, `virtualGuitarist`.

## API client & rendering

`CasperakiApi.h` — talks to the backend (default `https://staging.casperaki.com`),
JWT auth. Used to **download samples** (`/vstSample/load/`, `/playSample/`, streamed
MP3 decoded via `ChocMP3AudioFormat`). `SamplesDownloadTask` bulk-caches samples to
disk before render.

Render/export (`InstrumentalGenerator.h`):
- `exportSongWithMelody()` / `exportSongWithoutMelody()` / `exportVocalMelody()` →
  render Tracktion edit to WAV (44.1 kHz, resampled if device differs).
- `masterSongAtemlos()` → **Matchering** mastering (loudness/EQ/compression match)
  → `*_unmastered.wav` + mastered WAV.

## WASM tester — `LibWASM/casperaki-web-tester/`

A **Vue 3 + Vite** harness that loads the WASM engine, feeds it
`src/assets/songs/1/song.json` + `inst-*.json`, calls `engine.setSong()`, listens to
the `ControlState` callback, and drives play/seek/export. This is the proof that the
engine can run in a browser — and the template for wiring it into a modern web frontend.

## Branches (feature archaeology)

`main`, `make-wasm-great-again` (WASM revival — most recent), `wasm-rebuild`,
`InstrumentReorganization` / `instrumentReorganizationToMerge`,
`feature/guitar-strummer`, `LinuxApp`, `server_app`, `cmd_app`,
`fix/android-build`, `fix-tester-app`, `update-from-batchutility`.

## What to keep vs. drop

**Keep:** the whole engine as the **audio output layer** — especially the **WASM build**
(browser-side rendering removes the REAPER/S3 server dependency entirely) and the
Matchering mastering path. The `Sequencer` JSON→Tracktion mapping defines the
engine-facing contract ([`20-song-data-format.md`](20-song-data-format.md)).

**Drop / modernize:** the JWT/sample API client pointing at `staging.casperaki.com`
(repoint at the new backend), Projucer-based build if it proves painful (consider a
CMake/JUCE setup), and the desktop app variants unless needed.

**Open question for the rebuild:** browser WASM render vs. a server-side native render
service. WASM is the elegant answer (no server DAW); a headless native `server_app`
build is the fallback for heavy/offline renders. See
[`50-engineering-plan.md`](50-engineering-plan.md) and
[`52-phase2-engine-wasm-spike.md`](52-phase2-engine-wasm-spike.md).
