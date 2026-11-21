// Casperaki streaming-render AudioWorkletProcessor (docs/60).
//
// The browser-side driver of the WASM streaming mixer (engine-render.wasm): the
// WebAudio render thread PULLS one 128-frame quantum per process() call and we
// forward that pull straight into the mixer. Nothing blocks, no offline busy
// loop — the audio callback drives the engine, never the other way round
// (the structural answer to the docs/57f duplicate-lane hang).
//
// All heavy work (instantiate, stage samples, resolve + build) happens once in
// the constructor via the shared ../engine/casperaki-engine.js; until then
// process() emits silence.
//
// processorOptions: the build options documented in casperaki-engine.js, plus
//   wasmBytes          ArrayBuffer   engine-render.wasm
//   masterGain         number        fixed real-time gain (no look-ahead normaliser)
//   seekPrerollFrames  number        frames rendered silently after a seek so
//                                    effect tails refill (mix on)
//   laneGains          {[lane: string]: number}  initial mute/solo gains
//
// Messages in:  { type: 'seek', frame }  { type: 'laneGains', gains: {[lane]: gain} }
// Messages out: { type: 'ready', totalFrames, sampleRate, laneNames, realCount }
//               { type: 'seeked', frame }  { type: 'ended' }  { type: 'error', message }

import { buildMixer, instantiateEngine, laneNames, lastError } from '../engine/casperaki-engine.js';

const BLOCK = 128;

class CasperakiRenderProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.ready = false;
    this.done = false;
    const o = options.processorOptions;
    this.masterGain = o.masterGain ?? 0.15;
    this.seekPreroll = o.seekPrerollFrames ?? 0;

    try {
      const e = instantiateEngine(o.wasmBytes);
      this.e = e;
      this.totalFrames = buildMixer(e, { ...o, blockFrames: BLOCK });
      e.mixer_set_master_gain(this.masterGain);
      this.lanes = laneNames(e);
      this.applyLaneGains(o.laneGains || {});

      // All allocation is done: these views stay valid for the node's life.
      this.left = new Float32Array(e.memory.buffer, e.mixer_left(), BLOCK);
      this.right = new Float32Array(e.memory.buffer, e.mixer_right(), BLOCK);

      // Handled on the audio thread between process() calls, so a pull never races them.
      this.port.onmessage = (ev) => {
        const d = ev.data;
        if (!d) return;
        if (d.type === 'seek') {
          const pos = e.mixer_seek(Math.max(0, Math.floor(d.frame)), this.seekPreroll);
          if (pos < 0) {
            this.port.postMessage({ type: 'error', message: `mixer_seek failed: ${lastError(e)}` });
            return;
          }
          this.done = false;
          this.port.postMessage({ type: 'seeked', frame: pos });
        } else if (d.type === 'laneGains') {
          try {
            this.applyLaneGains(d.gains);
          } catch (err) {
            this.port.postMessage({ type: 'error', message: String(err) });
          }
        }
      };

      this.ready = true;
      this.port.postMessage({
        type: 'ready',
        totalFrames: this.totalFrames,
        sampleRate: o.sampleRate,
        laneNames: this.lanes,
        realCount: (o.realSamples || []).length,
      });
    } catch (err) {
      this.port.postMessage({ type: 'error', message: String(err && err.stack ? err.stack : err) });
    }
  }

  /** gains: lane name → gain. Lanes not listed play at unity. */
  applyLaneGains(gains) {
    for (const name of Object.keys(gains)) {
      if (!this.lanes.includes(name)) throw new Error(`unknown lane "${name}"`);
    }
    this.lanes.forEach((name, i) => {
      const g = gains[name] ?? 1;
      if (this.e.mixer_set_lane_gain(i, g) !== 1) throw new Error(`mixer_set_lane_gain failed: ${lastError(this.e)}`);
    });
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    if (!this.ready || this.done) {
      for (let c = 0; c < output.length; c++) output[c].fill(0);
      return true;
    }
    const more = this.e.mixer_pull(BLOCK);
    const outL = output[0];
    const outR = output.length > 1 ? output[1] : null;
    // Hard clamp as a last safety net (the limiter after this node does the real work).
    for (let i = 0; i < outL.length; i++) {
      const l = this.left[i];
      outL[i] = l > 1 ? 1 : l < -1 ? -1 : l;
    }
    if (outR) {
      for (let i = 0; i < outR.length; i++) {
        const r = this.right[i];
        outR[i] = r > 1 ? 1 : r < -1 ? -1 : r;
      }
    }
    if (!more) {
      this.done = true;
      this.port.postMessage({ type: 'ended' });
    }
    return true;
  }
}

registerProcessor('casperaki-render-processor', CasperakiRenderProcessor);
