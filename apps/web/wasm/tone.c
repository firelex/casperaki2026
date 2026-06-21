// Phase 0 (docs/60) engine-base spike — the *bespoke* WASM DSP path.
//
// Deliberately ZERO JUCE and zero JS/WASI imports: a pure-C sine generator
// compiled by emcc to a standalone .wasm that an AudioWorkletProcessor pulls
// from, one block at a time. It exists to prove the structural pipeline the
// real render will use (C++ DSP -> emcc -> WASM -> worklet pull), not to make
// music. If this compiles clean and emits a tone in the browser, the bespoke
// engine-base path is feasible without linking GPL'd JUCE into the client.
//
// Static block buffers (no malloc) keep the module import-free so the worklet
// can WebAssembly.instantiate(bytes) with an empty import object.

#include <math.h>

#define MAX_FRAMES 2048

static float  g_left[MAX_FRAMES];
static float  g_right[MAX_FRAMES];
static double g_phase = 0.0;
static double g_sample_rate = 48000.0;
static double g_freq = 440.0;
static double g_gain = 0.2;

// Configure the generator. Called once from the worklet after instantiation.
__attribute__((export_name("dsp_init")))
void dsp_init(double sample_rate, double freq) {
    g_sample_rate = sample_rate > 0.0 ? sample_rate : 48000.0;
    g_freq = freq;
    g_phase = 0.0;
}

// Pointers into linear memory for the worklet to read after each render.
__attribute__((export_name("dsp_left")))  float* dsp_left(void)  { return g_left; }
__attribute__((export_name("dsp_right")))  float* dsp_right(void) { return g_right; }
__attribute__((export_name("dsp_max_frames"))) int dsp_max_frames(void) { return MAX_FRAMES; }

// Pull `frames` samples of stereo audio into the static L/R buffers.
// This is the analogue of the future engine's per-block render callback.
__attribute__((export_name("dsp_render")))
void dsp_render(int frames) {
    if (frames > MAX_FRAMES) frames = MAX_FRAMES;
    const double two_pi = 6.283185307179586;
    const double inc = two_pi * g_freq / g_sample_rate;
    for (int i = 0; i < frames; ++i) {
        const float s = (float)(g_gain * sin(g_phase));
        g_left[i] = s;
        g_right[i] = s;
        g_phase += inc;
        if (g_phase >= two_pi) g_phase -= two_pi;
    }
}
