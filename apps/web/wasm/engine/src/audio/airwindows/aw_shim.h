// Minimal portable shim that lets the in-tree AirWindows plugins
// (~/apps/casperaki_engine/Source/airwindows_extras, MIT) compile as-is into the
// bespoke WASM engine — no JUCE, no VST2 SDK. The AirWindows DSP only ever calls
// getSampleRate() from its AudioEffectX base; everything else the host SDK
// provides (setNumInputs/Outputs, setUniqueID, can*Replacing, programsAreChunks,
// vst_strncpy, the VST typedefs) is a no-op stub here.
//
// Usage (one TU per plugin, namespaced — each plugin's file-scope consts like
// kNumInputs and its createEffectInstance would otherwise clash):
//   #include "aw_shim.h"
//   namespace aw_console8subin {
//     #include ".../Console8SubIn/Console8SubIn.h"
//     #include ".../Console8SubIn/Console8SubInProc.cpp"
//     #include ".../Console8SubIn/Console8SubIn.cpp"
//   }
// The plugin headers guard their VST include with `#ifndef __audioeffect__`, so
// defining it here makes them skip the real audioeffectx.h and use these decls.
#pragma once
#ifndef __audioeffect__
#define __audioeffect__

#include <cstdint>
#include <cstring>

using VstInt32 = std::int32_t;
using audioMasterCallback = void*;
enum VstPlugCategory { kPlugCategUnknown = 0, kPlugCategEffect = 1 };

static const int kVstMaxProgNameLen = 24;
static const int kVstMaxParamStrLen = 8;
static const int kVstMaxVendorStrLen = 64;
static const int kVstMaxProductStrLen = 64;
static const int kVstMaxEffectNameLen = 32;

inline char* vst_strncpy(char* dst, const char* src, std::size_t n) {
    std::strncpy(dst, src, n);
    dst[n] = 0;
    return dst;
}

// VST GUI display helpers — only used by getParameterDisplay (never called in the
// offline render). No-op stubs so the plugin .cpp compiles.
inline void float2string(float, char* text, int) { if (text) text[0] = 0; }
inline void int2string(int, char* text, int) { if (text) text[0] = 0; }
inline void dB2string(float, char* text, int) { if (text) text[0] = 0; }

// The only base behaviour the AirWindows DSP relies on is the sample rate.
class AudioEffect {
public:
    virtual ~AudioEffect() = default;
};

class AudioEffectX : public AudioEffect {
public:
    AudioEffectX(audioMasterCallback /*master*/, VstInt32 /*numPrograms*/, VstInt32 /*numParams*/) {}

    double getSampleRate() const { return sampleRate_; }
    void   setSampleRate(double sr) { sampleRate_ = sr; }   // host sets this before processing

    // No-op host-SDK surface the AirWindows constructors call.
    void setNumInputs(VstInt32) {}
    void setNumOutputs(VstInt32) {}
    void setUniqueID(VstInt32) {}
    void setUniqueID(unsigned long) {}
    bool canProcessReplacing(bool = true) { return true; }
    bool canDoubleReplacing(bool = true) { return true; }
    bool programsAreChunks(bool = true) { return true; }
    VstInt32 getProcessLevel() const { return 0; }
    void isSynth(bool = true) {}

private:
    double sampleRate_ = 44100.0;
};

#endif // __audioeffect__
