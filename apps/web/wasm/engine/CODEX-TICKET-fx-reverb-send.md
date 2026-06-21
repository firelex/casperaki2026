# RESOLVED: WASM FX/transition lane tone ≠ native — transition clip gain

**Status:** FIXED (Mixer.h `buildWaveSource`). All bands within 0.2 dB of native.
**Engine:** `apps/web/wasm/engine`

## Root cause (code-confirmed)
Native `TransitionSample::createSegmentClip` (instruments/TransitionSample.h:73-76) inserts the
transition wave clip at **UNITY** — `track->insertWaveClip(segName, sampleFile, pos, false)`, no
`setGain`, and **no `getInstrumentTargetVolume`** is ever applied to transitions. The ONLY gain on
a transition is the **−10 dB "Sample Transitions FX" track trim** (`Sequencer.cpp:208`). So every
transition (cymbalsCrashHit, fxLowImpact, fxUplifter, …) plays at `unity × −10 dB`, regardless of
lowLevelType.

The WASM mixer had been applying `getInstrumentTargetVolume(lowLevel) − 10` per transition clip.
That is `0 − 10 = −10` for cymbalsCrashHit (target 0 — looked correct by luck) but `−10 − 10 = −20`
for fxLowImpact (target −10) → the low "Impacts Low" boom was **10 dB too quiet**, which is the
−8 dB low / −6 dB tail deficit the band analysis kept surfacing.

## Fix
`Mixer.h::buildWaveSource`: transition clip gain = `dbToGain(−10.0)` (unity × −10 dB trim),
dropping `getInstrumentTargetVolume` for transition clips.

## Result (ballad, region 12.8–16.0 s, CASPERAKI_SOLO=Transitions, 24-bit, NO_NORM)
| band | native | WASM | Δ |
|---|---|---|---|
| total | −27.5 | −27.4 | 0.1 |
| low<250 | −30.5 | −30.5 | 0.0 |
| mid | −33.0 | −32.8 | 0.2 |
| high>5k | −37.9 | −37.7 | 0.2 |
| tail 14–16 s | −33.0 | −33.0 | 0.0 |

## Note on the per-clip reverb send
The per-clip aux-send mechanism added to `WaveClipRT` (cymbalsCrashHit → fxGroup "drums" →
reverb −25 dB) is **kept** — it matches native's wiring
(`prepareInstrumentTracksWithPlugins`/`insertSendPlugin`). Its measured effect is small (−25 dB
send), so it was NOT the cause of the audible difference, but it's correct and harmless.

## Earlier red herrings (for the record)
- "Missing reverb send" — real wiring gap, but negligible effect; not the cause.
- The reverb send change alone moved the bands <0.1 dB.
- The actual cause was the transition clip gain (getInstrumentTargetVolume mis-applied).
