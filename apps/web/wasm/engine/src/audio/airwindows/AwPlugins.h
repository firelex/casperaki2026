// Uniform interface over the vendored AirWindows plugins (each compiled in its
// own namespaced TU, *.aw.cpp). The mix/FX graph (Scope B/C) drives plugins
// through this — setSampleRate once, setParam from the decoded state chunk
// (decode-airwindows-state.mjs / the C++ equivalent), then process per block.
// Params are the raw AirWindows [0,1] values (one per kNumParameters).
#pragma once

#include <memory>

namespace casperaki {
namespace aw {

struct Plugin {
    virtual ~Plugin() = default;
    virtual int  numParams() const = 0;
    virtual void setSampleRate(double sr) = 0;
    virtual void setParam(int index, float value) = 0;       // raw AirWindows [0,1]
    // Transport for tempo-synced FX (SimpleSide). secPerBeat = 60/bpm; timeSec =
    // the absolute song time at the START of the next block. AirWindows ignore it.
    virtual void setTransport(double /*secPerBeat*/, double /*timeSec*/) {}
    // A play-position jump (Mixer::seek): set any state that is a pure function of
    // how many samples have been processed since the start — an LFO / oscillator
    // phase — to its value at `songSample`, so a seek lands on the same phase as a
    // render from the start. State that decays (delay lines, filters, envelopes)
    // is left alone: the seek pre-roll refills it. Default: nothing to do.
    virtual void seek(long long /*songSample*/) {}
    // Process `frames` of stereo audio IN PLACE-capable form: in/out are 2 planar
    // float channel pointers (may alias). AirWindows processReplacing semantics.
    virtual void process(float* const* in, float* const* out, int frames) = 0;
};

// Factories — one per vendored plugin (added as each is ported). The 10 in-tree
// MIT AirWindows (docs/63 §6). N = kNumParameters.
std::unique_ptr<Plugin> makeConsole8SubIn();    // 0
std::unique_ptr<Plugin> makeConsole8SubOut();   // 1: Fader
std::unique_ptr<Plugin> makeConsole8BussIn();   // 0
std::unique_ptr<Plugin> makeConsole8BussOut();  // 1: Fader
std::unique_ptr<Plugin> makeAir2();             // 5
std::unique_ptr<Plugin> makeDeEss();            // 3: Intense, Max DS, Freq
std::unique_ptr<Plugin> makeHuge();             // 2
std::unique_ptr<Plugin> makeStereoChorus();     // 2: Speed, Depth
std::unique_ptr<Plugin> makeTexturizeMS();      // 6
std::unique_ptr<Plugin> makeKPlateA();          // 5
std::unique_ptr<Plugin> makeKPlateD();          // 5

// The 6 Tracktion-bundled AirWindows (extracted from tracktion_v3.2.0).
std::unique_ptr<Plugin> makePyewacket();        // 3 (compressor)
std::unique_ptr<Plugin> makeEQ();               // 8
std::unique_ptr<Plugin> makeLogical4();         // 5 (compressor)
std::unique_ptr<Plugin> makeNC17();             // 2 (NCSeventeen)
std::unique_ptr<Plugin> makeThunder();          // 2
std::unique_ptr<Plugin> makeADClip7();          // 4 (limiter)
std::unique_ptr<Plugin> makeTapeDelay();        // 6 (Dry/Wet/Delay/Feedbak/Lean/Depth) — Valhalla substitute

// Bespoke (no usable source — reimplemented from the algorithm). SimpleSide =
// tempo-synced volume pump (SimpleSide.cpp). FreqShiftEcho = the from-scratch
// frequency-shifting echo replacing ValhallaFreqEcho (FreqShiftEcho.cpp). See docs/63 §6.
std::unique_ptr<Plugin> makeSimpleSide();
std::unique_ptr<Plugin> makeFreqShiftEcho();
std::unique_ptr<Plugin> makeValhallaFreqEcho();   // legacy silence fallback (BespokeFx.cpp)

} // namespace aw
} // namespace casperaki
