// Level-meter worker: renders a song with engine-render.wasm as fast as the
// CPU allows (no audio output) just to collect each track's levels, for the
// sequencer's per-track waveforms. Module worker; shares the engine driver
// with the playback worklet.
//
// In:  { type: 'meter', wasmBytes, sampleRate, meterBinFrames, ...build options }
//      { type: 'mix', wasmBytes, sampleRate, ...build options }  -> { type: 'mix', mix } (no rendering)
// Out: { type: 'lanes', names, binCount, binSec, mix }   (mix: laneInfo, the resolved mix)
//      { type: 'progress', doneBins, peaks: Float32Array[] }   (repeated, then)
//      { type: 'done', doneBins, peaks }  |  { type: 'error', message }

import { buildMixer, instantiateEngine, laneInfo, laneNames } from '../engine/casperaki-engine.js';

const BLOCK = 1024;
const POST_EVERY_MS = 400;

self.onmessage = (ev) => {
  const o = ev.data;
  if (!o || (o.type !== 'meter' && o.type !== 'mix')) return;
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
    let frames = 0;
    let last = performance.now();
    while (e.mixer_pull(BLOCK)) {
      frames += BLOCK;
      const now = performance.now();
      if (now - last > POST_EVERY_MS) {
        last = now;
        const doneBins = Math.min(binCount, Math.floor(frames / o.meterBinFrames));
        const peaks = snapshot(doneBins);
        self.postMessage({ type: 'progress', doneBins, peaks }, peaks.map((p) => p.buffer));
      }
    }
    const peaks = snapshot(binCount);
    self.postMessage({ type: 'done', doneBins: binCount, peaks, totalFrames }, peaks.map((p) => p.buffer));
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.stack ? err.stack : err) });
  }
};
