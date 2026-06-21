# Ticket: WASM FX/transition one-shots render wrong (ballad FX lane)

**Reporter:** Claude (forensics) · **For:** Codex · **Engine:** `apps/web/wasm/engine` (offline `casperaki_render` + browser)

## Symptoms (ballad, real-sample render)
Two distinct wrong sounds in the **FX / sound-effects lane** (transition samples), audible in WASM `out-alt.wav` but **not** in the native JUCE `out.wav`:
1. **~12.8–13 s:** a "completely wrong / far-too-low cymbal-ish" sound. User confirms by ear it does NOT match the real source samples — it's genuinely corrupted, not just a genre-odd FX.
2. **~16 s (shortly before):** an extra tick / "side stick" transient.

Reproduce: render ballad with the real library; isolate the lane with the debug flag below.
- `CASPERAKI_SOLO=fx CASPERAKI_MIX=1 CASPERAKI_SAMPLE_LIBRARY_ROOT=<lib> casperaki_render <balladDir> /tmp/fx.wav "" <lib>`
- Pre-rendered isolate: `/tmp/ballad-solo-fx.wav`.

## What fires there
`song.json` `arrangement.verse1.transitions` (verse1 = 12.80–38.40 s) schedules three one-shots, all `type:"wave"` clips on the "Sample Transitions FX" track:
| tag | id | source | clip duration |
|---|---|---|---|
| cymbalsCrashHit__verse1 | 40001 | cymbals…Crash3.mp3 | 3.343673 s |
| fxLowImpact__verse1 | 40002 | fx…VEH4 Impacts Low 35.mp3 | 11.598367 s |
| fxUplifter__verse1 | 40003 | fx…Uplifter_3.mp3 (starts ~22.9 s) | 15.516735 s |

(The crash is injected by the brain's `injectCrashAfterFxReverse`, which has **no genre gate** — a ballad gets a rock crash after the intro's `fxReverse`. Possibly a separate brain issue, but secondary.)

## Confirmed bug #1 — `WaveSource` tiles one-shots (causes the ~16 s tick)
`src/audio/Mixer.h` `WaveSource::addBlock` renders EVERY wave clip by tiling the source modulo its length:
```cpp
const int srcIdx = (int)((i - c.start) % data->frames);
```
That's correct for percussion **loops** (meant to repeat) but **wrong for one-shot transition/FX clips**, which must play exactly once. The clip length is `details.duration` (derived from the raw MP3), but the engine now decodes the **gapless-trimmed OGG**, which is ~30–46 ms **shorter**:
- Crash3: clip 3.343673 s vs decoded OGG **3.297234 s**
- Uplifter_3: clip 15.516735 s vs decoded OGG **15.483878 s**

So `(i - c.start)` exceeds `data->frames` near the end and **wraps**, re-triggering each one-shot's attack transient. For the crash that wrap lands at 12.80 + 3.2972 = **16.10 s** → the "side stick" tick. Every FX/transition one-shot has this tail re-attack.

**Fix direction:** distinguish loop clips (tile) from one-shot clips (play once, then silence) and gate the modulo. The clip type is known at resolve time:
- `src/Resolver.h::resolveLoopInstrument` → loops (should tile)
- `src/Resolver.h::resolveTransitionSamples` → one-shots (should NOT tile)

Add a `bool loop` (or `clip.kind`) to the IR `Clip`/`WaveClipRT` and in `WaveSource::addBlock` only wrap when `loop`; otherwise read `[0, min(frames, end-start))` and output silence past the sample end. (Also reasonable: clamp one-shot clip length to the decoded sample length.)

## Bug #2 — the ~13 s onset sounds genuinely wrong (needs A/B)
The FX onset at 12.8 s is spectrally low-dominated and the user (who knows the real samples) says it's corrupted, not a legit low-impact. **Ruled out:** sample rate (all sources + their normalized OGGs are 44.1 kHz, so unity playback is correct pitch); a now-fixed orphan-inst duplicate; placement (native reads the same arrangement). **To investigate:** A/B the isolated transition decode vs the raw/normalized source — is the OGG decode (stb_vorbis) of these specific FX files corrupted, or is `WaveSource` reading them wrong (e.g., channel/interleave, or the same wrap garbling a short impact)? `/tmp/ballad-solo-fx.wav` vs decoding `…VEH4 Impacts Low 35` and `…Crash3` directly.

## Ruled out / context
- **Sample rate:** all FX sources + normalized OGGs are 44.1 kHz → not a speed/pitch bug.
- **Orphan inst:** a stale `inst-14.json` (duplicate loop id) was found and the emit now cleans stale `inst-*.json` (`apps/engine-spike/scripts/emit-brain-roundtrip.mjs`); it was NOT this bug.
- **Why native is clean:** native plays the same transitions but its master chain is ~9.4 dB more compressed/limited (separate "master-drive gap" issue), which tucks/squashes these artifacts; WASM leaves them exposed.

## Tooling left in place
- `src/audio/Mixer.h`: `CASPERAKI_SOLO=<fxGroup|name-substr>` env flag gates lanes in both render paths (throwaway debug; no-op when unset). Used to isolate this. Strip when done if desired.

## Related follow-ups (separate tickets)
- `WaveSource` ignores `data->sampleRate` (unity tiling) — would mis-speed any non-44.1 kHz source.
- Master-drive gap: WASM master (`Console8BussIn→Logical4→Console8BussOut→ADClip7`) renders ~9.4 dB lower RMS than native (native −6.4 vs WASM −15.8 on ballad), making bass dry/digital + FX exposed.
- In the per-lane solos, `orchestral` and one `synths` lane render as **white noise** — likely a stub/voice bug; investigate separately.
