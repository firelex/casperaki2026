// Phase 0 (docs/60) — the pull-based audio path, structurally.
//
// This AudioWorkletProcessor is the browser-side analogue of the native
// render's block callback. The WebAudio render thread *pulls* one 128-frame
// quantum at a time by calling process(); we forward that pull into the WASM
// engine (here: the bespoke tone spike). Nothing blocks, no offline busy-loop
// — this is the structural answer to the 57f duplicate-lane hang (docs/57f):
// the engine never drives itself, the audio callback drives the engine.
//
// The WASM module is passed in as raw bytes via processorOptions and
// instantiated with an EMPTY import object (the standalone build has zero
// JS/WASI imports). Worklet global scope permits synchronous compilation
// regardless of module size, so we instantiate in the constructor and are
// ready on the first quantum.

class EngineToneProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.ready = false;
    this.frames = 128; // WebAudio render-quantum size

    try {
      const bytes = options.processorOptions.wasmBytes;
      const freq = options.processorOptions.freq ?? 440;
      const module = new WebAssembly.Module(bytes);
      const instance = new WebAssembly.Instance(module, {});
      const e = instance.exports;
      // STANDALONE_WASM reactor: run static initializers if present.
      if (typeof e._initialize === 'function') e._initialize();
      e.dsp_init(sampleRate, freq); // `sampleRate` is a worklet global

      this.exports = e;
      this.leftPtr = e.dsp_left();
      this.rightPtr = e.dsp_right();
      // Memory growth is disabled in the build, so these views stay valid.
      this.left = new Float32Array(e.memory.buffer, this.leftPtr, this.frames);
      this.right = new Float32Array(e.memory.buffer, this.rightPtr, this.frames);
      this.ready = true;
      this.port.postMessage({ type: 'ready' });
    } catch (err) {
      this.port.postMessage({ type: 'error', message: String(err) });
    }
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    // Until the module is ready, emit silence (a valid quantum) — never block.
    if (!this.ready) {
      for (let c = 0; c < output.length; c++) output[c].fill(0);
      return true;
    }

    // Pull one block from the engine, then fan it out to the output channels.
    this.exports.dsp_render(this.frames);
    const outL = output[0];
    const outR = output.length > 1 ? output[1] : null;
    for (let i = 0; i < outL.length; i++) outL[i] = this.left[i];
    if (outR) for (let i = 0; i < outR.length; i++) outR[i] = this.right[i];

    return true; // keep the node alive
  }
}

registerProcessor('engine-tone-processor', EngineToneProcessor);
