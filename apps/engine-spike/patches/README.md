# engine-spike patches

Local patches applied to the sibling `casperaki_engine` checkout for the
Phase 2 native render spike. Tracked here so a fresh clone can replay
them. Not upstreamed.

## Patches

- `01-edit-forRendering.patch` — `CasperakiEngine::prepareEdit` constructs
  the `te::Edit` with `Edit::forRendering` instead of `Edit::forEditing`.
  Root-cause fix for the silent render on headless / no-ALSA boxes.
  See [`../../../docs/52e-phase2-first-render.md`](../../../docs/52e-phase2-first-render.md)
  fix #7.
- `04-loop-skip-setlooprangebeats.patch` — `Loop.h::createSegmentClip`
  drops `setLoopRangeBeats(...)` entirely (the lone call that hangs
  `te::Renderer::renderToFile` indefinitely, proven via single-call
  bisection in docs/54o §Loop ablation matrix), drops `setLoopInfo`
  (the on-disk library carries per-bpm pre-stretched variants — we
  never want Tracktion's RubberBand time-stretch at render time), and
  computes `setNumberOfLoops(ceil(segmentSec/sourceSec))` so the
  source tiles correctly across the segment with `setLength(stretch=
  false)`. Verified non-silent uniform-RMS render across 8 bars.
  See [`../../../docs/54o-loop-transition-fills-render.md`](../../../docs/54o-loop-transition-fills-render.md).

- `03-sequencer-fx-submix-eager-create.patch` — `Sequencer.cpp`
  (constructor) eagerly creates the `fx` submix track on first
  `transitionSample` instrument. Originally `submixTracks[fx]` is only
  created lazily by instruments whose fxGroup == fx; cymbalsCrashHit
  and most other transition lowLevelTypes route to fxGroup == drums,
  so `submixTracks[fx]` stayed null. The subsequent
  `submixTracks[fx]->getOutput()` then null-deref'd via
  `juce_ReferenceCountedObject.h:394`. With this patch, a fresh
  transitionSample render reaches the engine's render path. See
  [`../../../docs/54o-loop-transition-fills-render.md`](../../../docs/54o-loop-transition-fills-render.md).

- `02-guitar-strum-soundindex-midi-offset.patch` — two layered fixes to
  the Guitar chord-strum render path:
  1. `Guitar::ensureSampleMidiNote` now sets the strum sound's
     `keyNote` to `soundIndex + 48` (was raw `soundIndex`), and
     `Guitar::createSegmentClip` uses `samplerPlugin->getKeyNote(
     soundIndex)` for `addNote` (was raw `soundIndex`). The original
     code emitted MIDI note 0/1/2 (C-1..D-1, inaudible) instead of
     C3+. The nearby `midiNoteIndex - 48` expression already assumed
     this offset; it was just never applied.
  2. `SequencerUtils.h getGuitarStrums` accepts integer-valued JSON
     durations (`{"duration": 4}`), not just `isDouble()`. JUCE's
     `var::isDouble()` returns false for ints; the original check
     silently dropped any non-decimal duration, leaving the default
     `TimeStrums::duration = -1` to be offset to `-0.8` by the
     strum-tail timing adjuster — Tracktion then silently dropped
     the note for having a negative duration.
  Together these restore audible chord-strum playback on the strums
  sampler track. See [`../../../docs/54m-guitar-render-spike.md`](../../../docs/54m-guitar-render-spike.md).

- `05-port-juce8-tracktion32.patch` — engine source port for the JUCE
  8.0.6 + Tracktion v3.2.0 stack landed by docs/55a / 55b / 55c. Five
  sites: `te::Edit::Options` ctor (subsumes patch 01's
  `Edit::forRendering` enum reference, keeping the role as a field on
  the Options struct), `TransportControl::setPosition`,
  `Renderer::renderToFile` gaining a `useACID` bool, hiding the now-
  private `DeviceManager::clearAllContextDevices` call, and
  `DynamicObject::clone()` returning `std::unique_ptr` under JUCE 8.
  Apply order matters — chain 01–04 first, then 05.

## Apply

```sh
./apply.sh
# or, against a non-default engine location:
CASPERAKI_ENGINE_REPO=/path/to/casperaki_engine ./apply.sh
```

`apply.sh` is idempotent — re-running on an already-patched tree skips
with a warning.

## Re-export (after editing the engine)

```sh
cd /path/to/casperaki_engine
git diff Source/CasperakiEngine.cpp \
  > /path/to/casperaki/apps/engine-spike/patches/01-edit-forRendering.patch
```

For multi-file patches, use `git diff -- <paths…>` and pipe to a new
`NN-name.patch` file. The apply script picks up every `*.patch` in lex
order.
