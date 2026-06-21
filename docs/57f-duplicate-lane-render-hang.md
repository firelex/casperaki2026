# 57f — Duplicate-lane render hang (message-thread proxy starvation)

Fixes the hang where a fresh **brightPop** render (and other genres that
emit duplicate tonal lanes) wedged ~56 s in, CPU pegged, with the output
WAV frozen mid-write at exactly **14,820,144 bytes** for 24+ minutes.

## TL;DR

- **Symptom:** render of a brightPop song with ≥2 *populated* leadSynths
  lanes (`Synths` + `Synths 2` + `Synths 3`, the duplicate lanes the
  engine-adapter allocates to `inst-10+`, `vstId 39300+`, `sampleBase
  10000+`) never finishes. Removing the staged samples for the duplicate
  lanes "fixed" it only because their samplers then produced silence.
- **Root cause:** the spike harness rendered with
  `Renderer::renderToFile(edit, file, /*useThread*/ false)`. That path is a
  tight `while (task->runJob() == jobNeedsRunningAgain) {}` loop **on the
  message thread** (`tracktion_Renderer.cpp:472`). It starves the message
  thread. Tracktion requests a clip **proxy** (a Loop / transition
  `WaveClip`'s rendered `.wav`) lazily while building the render graph and
  kicks proxy generation off through the `AudioFileManager`'s
  `juce::AsyncUpdater`. With the message thread wedged in the runJob loop,
  that async kick-off never dispatches, the proxy `.wav` is never written,
  and the clip's `WaveNode::isReadyToProcess()` returns **false forever**
  (its reader reports sample-rate 0). The render then spins/deadlocks
  waiting for a leaf node that can never become ready.
- **Why it took ≥2 leadSynths lanes:** pure timing. The harness deferred
  the render by a fixed `startTimer(3000)`. With one leadSynths lane all
  proxy kick-offs dispatched inside that 3 s window; the extra setup work
  of the additional populated samplers pushed one proxy kick-off past the
  moment the render started and grabbed the message thread. It was never a
  memory/bounds bug, an FX/rack bug, an octave bug, or sample-content bug
  (all ruled out by bisection — see below).
- **Fix:** render with `useThread = true`. That routes through
  `CasperakiEngine`'s `HeadlessUIBehaviour::runTaskWithProgressBar`, which
  already runs the render task on a background `TaskRunner` thread **and
  pumps the message loop** (`runDispatchLoopUntil`) on the calling thread.
  The proxy async kick-off now dispatches, proxies generate on the cache's
  background pool, the `WaveNode`s become ready, and the render completes.
  `JUCE_MODAL_LOOPS_PERMITTED` (set in the spike `CMakeLists.txt`) is what
  makes that nested pump legal.
- **Backstop:** a render watchdog was added to the harness so any future
  wedge fails fast instead of hanging the `render-all-genres` matrix.

## What changed

- `apps/engine-spike/native/harness.cpp`
  - `renderToFile(*ed, destFile, /*useThread*/ true)` (was `false`).
  - Render **watchdog**: a dedicated OS thread watches the output WAV; if it
    stops growing for `SPIKE_RENDER_STALL_SECS` (default 60) or the whole
    render exceeds `SPIKE_RENDER_TIMEOUT_SECS` (default 600), the process
    aborts with `rc=124` (timeout-style) and a diagnostic. `0` disables
    either guard.

No engine (`casperaki_engine`) source change was needed — the legacy
`lowLevelType → FX group` submix grouping was already correct, and the
duplicate lanes remain fully separate instruments/tracks/samplers.

## How it was root-caused

Reproduced deterministically (freeze at 14,820,144 B = 26.7 % of a 210 s
edit ≈ 56 s = `preChorus1`). Then:

1. **Live backtrace (gdb)** of the wedged process: the render thread spins
   in `std::find` inside `tracktion::graph::getNodes` /
   `NodeRenderContext::renderNextBlock`'s leaf-ready wait.
2. **Bisection** (toggling staged samples, FX sends, the submix rack,
   octaveAdjustment, sample content): ruled out FX (muting the leadSynths
   aux sends and skipping the leadSynths submix rack both still hung), the
   rack chains (leadSynths and synths racks are byte-identical), octave,
   and sample content. Established the trigger as *≥2 populated leadSynths
   samplers*, and that the `synths` submix runs 2 populated samplers
   (Pad + PluckedSynths) fine.
3. **ASan/UBSan build** (`-fsanitize=address,undefined`,
   `-fno-omit-frame-pointer`): no invalid write/read/UAF — it is **not** a
   memory bug. Instead it hit the JUCE assertion
   `tracktion_LockFreeMultiThreadedNodePlayer.cpp:340`
   (`jassert(playbackNode->node.isReadyToProcess())`), pointing at a leaf
   node that is never ready.
4. Drilling in identified the leaf as a `CombiningNode` (the
   sample-transitions track, 11 audio clips) whose inner `WaveNode` reads a
   **proxy** file `Temporary/edit_0_*/proxy_3a3816d2cba79dd2.wav` with
   sample-rate 0 — and that proxy file was **absent** from the stalled
   run's edit dir (present, 0.27–1.1 MB, in every successful run).

> ASan note: under ASan the yabridge/Wine VST (`ValhallaFreqEcho`) deadlocks
> on instantiation, so the ASan repro was run with `~/.vst/yabridge` moved
> aside. The hang is FX-independent, so this does not affect the diagnosis.

## Verification

- **brightPop**, all three leadSynths lanes populated → `renderToFile
  returned true`, **55,566,816 B**, 210 s, peak 0 dB, RMS −16.6 dB (valid
  audio, not silence). No watchdog trip.
- Watchdog proven on the pre-fix binary: stuck render aborts with `rc=124`
  in ~50 s instead of hanging.
- End-to-end `render-all-genres` smoke across the duplicate-lane genres
  (`brightPop, edm, latin, organicVibes, rock`).
