// Level-meter worker: renders a song with engine-render.wasm as fast as the
// CPU allows (no audio output) just to collect each track's levels, for the
// sequencer's per-track waveforms. Module worker; shares the engine driver
// with the playback worklet.
//
// In:  { type: 'meter', wasmBytes, sampleRate, meterBinFrames, ...build options }
//      { type: 'mix', wasmBytes, sampleRate, ...build options }  -> { type: 'mix', mix } (no rendering)
//      { type: 'render', wasmBytes, sampleRate, ...build options } -> progress..., { type: 'rendered', left, right, sampleRate }
// Out: { type: 'lanes', names, binCount, binSec, mix }   (mix: laneInfo, the resolved mix)
//      { type: 'progress', doneBins, peaks: Float32Array[], busPeaks: Float32Array[4] }   (repeated, then)
//      { type: 'done', doneBins, peaks }  |  { type: 'error', message }

import { buildMixer, instantiateEngine, laneInfo, laneNames } from '../engine/casperaki-engine.js';

const BLOCK = 1024;
const POST_EVERY_MS = 400;

self.onmessage = (ev) => {
  const o = ev.data;
  if (!o || (o.type !== 'meter' && o.type !== 'mix' && o.type !== 'render')) return;
  if (o.type === 'render') {
    // Offline render of the whole song to PCM (for a WAV download), as fast as possible.
    try {
      const e = instantiateEngine(o.wasmBytes);
      const totalFrames = buildMixer(e, { ...o, blockFrames: BLOCK });
      const left = new Float32Array(totalFrames);
      const right = new Float32Array(totalFrames);
      let pos = 0;
      let last = performance.now();
      for (;;) {
        const more = e.mixer_pull(BLOCK);
        const n = Math.min(BLOCK, totalFrames - pos);
        if (n > 0) {
          left.set(new Float32Array(e.memory.buffer, e.mixer_left(), n), pos);
          right.set(new Float32Array(e.memory.buffer, e.mixer_right(), n), pos);
        }
        pos += BLOCK;
        if (performance.now() - last > POST_EVERY_MS) {
          last = performance.now();
          self.postMessage({ type: 'progress', done: Math.min(pos, totalFrames), total: totalFrames });
        }
        if (!more || pos >= totalFrames) break;
      }
      self.postMessage({ type: 'rendered', left, right, sampleRate: o.sampleRate }, [left.buffer, right.buffer]);
    } catch (err) {
      self.postMessage({ type: 'error', message: String(err && err.stack ? err.stack : err) });
    }
    return;
  }
  if (o.type === 'mix') {
    // The resolved mix only: build (samples not needed) and report.
    try {
      const e = instantiateEngine(o.wasmBytes);
      buildMixer(e, { ...o, blockFrames: BLOCK });
      self.postMessage({ type: 'mix', mix: laneInfo(e) });
    } catch (err) {
      self.postMessage({ type: 'error', message: String(err && err.stack ? err.stack : err) });
    }
    return;
  }
  try {
    const e = instantiateEngine(o.wasmBytes);
    const totalFrames = buildMixer(e, { ...o, blockFrames: BLOCK });
    const names = laneNames(e);
    const binCount = e.mixer_meter_bin_count();
    self.postMessage({ type: 'lanes', names, binCount, binSec: o.meterBinFrames / o.sampleRate, mix: laneInfo(e) });

    const snapshot = (upTo) =>
      names.map((_, i) => new Float32Array(e.memory.buffer, e.mixer_lane_peaks(i), binCount).slice(0, upTo));
    // Bus meters: reverb, delay, chorus returns and the master.
    const busSnapshot = (upTo) =>
      [0, 1, 2, 3].map((k) => {
        const ptr = e.mixer_bus_peaks(k);
        if (!ptr) throw new Error(`mixer_bus_peaks(${k}) failed`);
        return new Float32Array(e.memory.buffer, ptr, binCount).slice(0, upTo);
      });
    let frames = 0;
    let last = performance.now();
    while (e.mixer_pull(BLOCK)) {
      frames += BLOCK;
      const now = performance.now();
      if (now - last > POST_EVERY_MS) {
        last = now;
        const doneBins = Math.min(binCount, Math.floor(frames / o.meterBinFrames));
        const peaks = snapshot(doneBins);
        const busPeaks = busSnapshot(doneBins);
        self.postMessage({ type: 'progress', doneBins, peaks, busPeaks }, [...peaks, ...busPeaks].map((p) => p.buffer));
      }
    }
    const peaks = snapshot(binCount);
    const busPeaks = busSnapshot(binCount);
    self.postMessage({ type: 'done', doneBins: binCount, peaks, busPeaks, totalFrames }, [...peaks, ...busPeaks].map((p) => p.buffer));
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.stack ? err.stack : err) });
  }
};
