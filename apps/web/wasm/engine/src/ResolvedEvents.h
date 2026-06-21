// The engine's internal Resolved-Timeline IR (docs/60 §"Internal Resolved-
// Timeline IR + the dump oracle"). Resolution fills these structs; the
// serializer emits them as `casperaki/resolved-events/v1` — the SAME schema the
// native harness dumps (harness.cpp dumpResolvedEvents), so the two can be
// diffed to validate musical resolution independently of any audio comparison.
//
// Phase 1 scope: the timeline/structure envelope is resolved here; per-lane
// note/step/wave resolution is filled in as each instrument family is ported.
#pragma once

#include <string>
#include <vector>

namespace casperaki {

// A resolved MIDI note. Pitch/timing are exact run-to-run; `vel` carries the
// (now-deterministic) humanization RNG — see Random.h.
struct Note {
    int n = 0;             // MIDI note number
    std::string name;      // render-independent note name, e.g. "G3"
    double startBeat = 0;  // beats from clip start
    double lenBeats = 0;
    int vel = 0;
};

// type == "step" — a drum-grid clip (Drums.h). `channels` are the sampler
// sounds (one per drum sub-instrument routed to this track); `hits` reference a
// channel by its index in `channels`. The native dump's channel order is the
// sampler's std::unordered_map hash order (Drums.h createSampler over the
// FileMap) — non-musical and non-portable — so the validator compares hits by
// (channel note/name, step) rather than by raw channel index, the same way it
// treats std::sort note ties.
struct StepChannel {
    int n = 0;             // MIDI note the sampler maps this sound to (48 + idsIndex*2)
    std::string name;      // sub-instrument name, e.g. "bassDrum1"
};
struct StepHit {
    int ch = 0;            // index into Clip::channels
    int step = 0;          // 16th-note step (32 per bar); abs = barIndex*32 + offset
    int vel = 0;
};
struct StepPattern {
    std::string name;      // te pattern name — "" in the fixtures
    int numSteps = 0;      // 32 * barsCount
    std::vector<StepHit> hits;
};

struct Clip {
    std::string name;
    std::string type;      // "midi" | "step" | "wave"
    double startSec = 0;
    double endSec = 0;

    // type == "midi"
    std::vector<Note> notes;

    // type == "wave"
    std::string source;    // resolved asset filename, e.g. "playsample-50000.ogg"
    bool loop = false;     // internal render hint: loops tile, transition FX play once
    std::string lowLevel;  // transition clip's lowLevelType (for per-clip mix gain via
                           // getInstrumentTargetVolume); "" => use the lane gain

    // type == "step"
    std::vector<StepChannel> channels;
    std::vector<StepPattern> patterns;
};

struct Track {
    std::string name;
    std::vector<Clip> clips;
};

// Per-instrument automation from arrangement[seg].signalProcessors (docs/63 Scope
// D). Absolute song seconds. `lowPass` value = cutoff Hz (a filter sweep/riser);
// `volume` value = dB (fadeIn etc.). Applies to every track whose baseName matches.
// `curve` = the Tracktion AutomationCurve segment curvature stored on this (the
// LEFT) point, driving interp to the NEXT point: 0 = linear; native lowPass steps
// use 0.5 (a one-control-point bezier). Volume steps are linear (0). See
// Mixer::evalCurve / Instrument.cpp:63-71.
struct AutoPoint { double tSec = 0; double value = 0; double curve = 0.0; };
struct AutoLane {
    std::string instName;
    std::vector<AutoPoint> lowPass;
    std::vector<AutoPoint> volume;
};

// docs/62 A7 — a transitionNoise riser (fxNoiseRise). A self-contained white-
// noise swell over [startSec, startSec+decayOffset+decayDuration): the LP cutoff
// sweeps freqStart->freqEnd over the attack (then holds), and the volume follows
// a 3-segment dB envelope (volAttack -> volSustain over the attack, hold, then
// -> volDecay over the decay). Port of casperaki_engine TransitionNoise.h, params
// from EffectsClass.getEffect('fxNoiseRise'). Absolute song seconds.
struct NoiseRise {
    double startSec = 0;
    double attackDuration = 0;   // rise time (sec)
    double decayOffset = 0;      // sec into clip where the decay begins (== attack)
    double decayDuration = 0;    // fall time (sec)
    double freqStart = 100;      // LP cutoff Hz at clip start
    double freqEnd = 20000;      // LP cutoff Hz at end of attack
    double volAttack = -30;      // dB at clip start
    double volSustain = -20;     // dB at end of attack (held through decayOffset)
    double volDecay = -50;       // dB at end of decay
};

struct ResolvedEvents {
    std::string genre;
    double lengthSec = 0;
    // Single-tempo beat->second factor (60/tempo). Not serialized into
    // resolved-events/v1 (the validator's schema is unchanged); carried here so
    // the offline render driver (Render.h) can turn note startBeat/lenBeats into
    // sample positions without re-parsing song.json. Clip startSec/endSec are
    // already absolute seconds.
    double secPerBeat = 0.5;
    std::vector<Track> tracks;
    std::vector<AutoLane> automation;   // Scope D — signalProcessors per instrument
    std::vector<NoiseRise> noiseRises;  // docs/62 A7 — fxNoiseRise transition risers
};

} // namespace casperaki
