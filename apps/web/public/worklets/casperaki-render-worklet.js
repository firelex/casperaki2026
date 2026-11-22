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
// Messages in:  { type: 'probe', bus: Uint8Array, slot } (device views: level probe around a rack plugin)
//               { type: 'seek', frame, preroll? } (preroll frames; default seekPrerollFrames)  { type: 'laneGains', gains: {[lane]: gain} }
//               { type: 'loop', start, end } (frames; start null = no loop). Playback
//               that crosses `end` from inside the loop jumps to `start` on the exact
//               frame (instant seek: effect tails carry over, as in a DAW).
// Messages out: { type: 'ready', totalFrames, sampleRate, laneNames, realCount }
//               { type: 'probe', inPeak, inRms, outPeak, outRms, frames } (~30/s while a probe is set)
//               { type: 'probeRings', input, output } (Float32Array(4096) each, ~15/s)
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
    this.loopStart = -1;
    this.loopEnd = -1;

    try {
      const e = instantiateEngine(o.wasmBytes);
      this.e = e;
      this.totalFrames = buildMixer(e, { ...o, blockFrames: BLOCK });
      e.mixer_set_master_gain(this.masterGain);
      this.lanes = laneNames(e);
      this.applyLaneGains(o.laneGains || {});

      // A buffer for probe bus names, allocated now so no message ever grows the
      // heap (which would detach the views below).
      this.probeName = e.malloc(256);
      this.probeOn = false;
      this.probeEvery = Math.max(1, Math.round((o.sampleRate / BLOCK) / 30)); // ~30 readings a second
      this.probeCount = 0;

      // All allocation is done: these views stay valid for the node's life.
      this.left = new Float32Array(e.memory.buffer, e.mixer_left(), BLOCK);
      this.right = new Float32Array(e.memory.buffer, e.mixer_right(), BLOCK);

      // Handled on the audio thread between process() calls, so a pull never races them.
      this.port.onmessage = (ev) => {
        const d = ev.data;
        if (!d) return;
        if (d.type === 'seek') {
          const pos = e.mixer_seek(Math.max(0, Math.floor(d.frame)), d.preroll ?? this.seekPreroll);
          if (pos < 0) {
            this.port.postMessage({ type: 'error', message: `mixer_seek failed: ${lastError(e)}` });
            return;
          }
          this.done = false;
          this.port.postMessage({ type: 'seeked', frame: pos });
        } else if (d.type === 'loop') {
          if (d.start === null) {
            this.loopStart = this.loopEnd = -1;
          } else {
            const a = Math.floor(d.start), b = Math.floor(d.end);
            if (!(a >= 0 && b > a && b <= this.totalFrames)) {
              this.port.postMessage({ type: 'error', message: `bad loop ${a}..${b} (song has ${this.totalFrames} frames)` });
              return;
            }
            this.loopStart = a;
            this.loopEnd = b;
          }
        } else if (d.type === 'probe') {
          // { bus: Uint8Array (UTF-8), slot } — slot < 0 turns the probe off.
          const bytes = d.bus;
          if (bytes.length > 256) {
            this.port.postMessage({ type: 'error', message: 'probe bus name too long' });
            return;
          }
          new Uint8Array(e.memory.buffer, this.probeName, bytes.length).set(bytes);
          if (e.mixer_set_probe(this.probeName, bytes.length, d.slot) !== 1) {
            this.port.postMessage({ type: 'probeError', message: lastError(e) });
            this.probeOn = false;
            return;
          }
          this.probeOn = d.slot >= 0;
          this.probeCount = 0;
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

  /** Copy `n` frames of the engine's block into the outputs at `at`, hard-clamped
   *  as a last safety net (the limiter after this node does the real work). */
  copyOut(outL, outR, at, n) {
    for (let i = 0; i < n; i++) {
      const l = this.left[i];
      outL[at + i] = l > 1 ? 1 : l < -1 ? -1 : l;
    }
    if (outR) {
      for (let i = 0; i < n; i++) {
        const r = this.right[i];
        outR[at + i] = r > 1 ? 1 : r < -1 ? -1 : r;
      }
    }
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    if (!this.ready || this.done) {
      for (let c = 0; c < output.length; c++) output[c].fill(0);
      return true;
    }
    const outL = output[0];
    const outR = output.length > 1 ? output[1] : null;
    let more;
    const pos = this.e.mixer_position();
    if (this.loopEnd > 0 && pos < this.loopEnd && pos + BLOCK >= this.loopEnd) {
      // The loop end falls inside (or at the end of) this quantum: play up to it,
      // jump back, fill the rest from the loop start.
      const head = this.loopEnd - pos;
      this.e.mixer_pull(head);
      this.copyOut(outL, outR, 0, head);
      if (this.e.mixer_seek(this.loopStart, 0) < 0) {
        this.port.postMessage({ type: 'error', message: `loop seek failed: ${lastError(this.e)}` });
      }
      more = true;
      if (head < BLOCK) {
        more = this.e.mixer_pull(BLOCK - head);
        this.copyOut(outL, outR, head, BLOCK - head);
      }
    } else {
      more = this.e.mixer_pull(BLOCK);
      this.copyOut(outL, outR, 0, BLOCK);
    }
    if (this.probeOn && ++this.probeCount >= this.probeEvery) {
      this.probeCount = 0;
      if (this.e.mixer_probe_read() === 1) {
        const v = new Float32Array(this.e.memory.buffer, this.e.mixer_probe_buffer(), 5);
        this.port.postMessage({ type: 'probe', inPeak: v[0], inRms: v[1], outPeak: v[2], outRms: v[3], frames: v[4] });
        // Every other reading (~15 a second), the last 4096 samples in and out, for spectra.
        if ((this.probeRings = !this.probeRings) && this.e.mixer_probe_rings() === 1) {
          const r = new Float32Array(this.e.memory.buffer, this.e.mixer_probe_spectrum_buffer(), 8192);
          const input = r.slice(0, 4096);
          const output = r.slice(4096);
          this.port.postMessage({ type: 'probeRings', input, output }, [input.buffer, output.buffer]);
        }
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
