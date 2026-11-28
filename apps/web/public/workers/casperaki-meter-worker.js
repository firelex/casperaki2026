// Level-meter worker: renders a song with engine-render.wasm as fast as the
// CPU allows (no audio output) just to collect each track's levels, for the
// sequencer's per-track waveforms. Module worker; shares the engine driver
// with the playback worklet.
//
// In:  { type: 'meter', wasmBytes, sampleRate, meterBinFrames, ...build options }
//      { type: 'mix', wasmBytes, sampleRate, ...build options }  -> { type: 'mix', mix } (no rendering)
//      { type: 'render', wasmBytes, sampleRate, ...build options } -> progress..., { type: 'rendered', left, right, sampleRate }
//      { type: 'impulse', wasmBytes, sampleRate, factory, params, seconds } -> { type: 'impulse', left, right, sampleRate }
//      { type: 'profile', wasmBytes, sampleRate, ...build options }
//          -> { type: 'profile', bytes }  (the matched-mastering profile of the unmastered mix,
//             for the playback worklet's live_set_profile)
//      { type: 'mixExport', wasmBytes, lameBytes, sampleRate, soloLanes?, ...build options }
//          -> { type: 'exportProgress', phase, share }..., { type: 'mixExport', files: {name: Uint8Array} }
//             the four mix downloads: mastered.mp3/.wav, unmastered.mp3/.wav (as the server's render);
//             soloLanes: only these tracks are heard (the pattern lab's "solo" download)
// Out: { type: 'lanes', names, binCount, binSec, mix }   (mix: laneInfo, the resolved mix)
//      { type: 'progress', doneBins, peaks: Float32Array[], busPeaks: Float32Array[4] }   (repeated, then)
//      { type: 'done', doneBins, peaks }  |  { type: 'error', message }

import { buildMixer, instantiateEngine, laneInfo, laneNames, lastError, masterSong, masteringProfile } from '../engine/casperaki-engine.js';
import { encodeMp3, encodeWav24, instantiateLame, MP3_HEADROOM_DB } from '../engine/casperaki-audio-files.js';

const BLOCK = 1024;
/** The mix's effects work per block, so the mastering renders pull 128-frame blocks
 *  like the playback worklet and the server's casperaki_render: the same mix. */
const MIX_BLOCK = 128;
const POST_EVERY_MS = 400;
/** LAME VBR quality: -V2, as the server's ffmpeg -q:a 2. */
const MP3_VBR_QUALITY = 2;

/** Only `solo` tracks heard (the others at gain 0), before the first pull. */
function soloOnly(e, solo) {
  const names = laneNames(e);
  for (const lane of solo) if (!names.includes(lane)) throw new Error(`solo: the song has no track "${lane}"`);
  names.forEach((name, i) => {
    if (e.mixer_set_lane_gain(i, solo.includes(name) ? 1 : 0) !== 1) throw new Error(`mixer_set_lane_gain failed: ${lastError(e)}`);
  });
}

/** The whole song, unmastered (mix on, no mastering stage), at MIX_BLOCK. */
function renderUnmastered(o, onShare) {
  if (o.mastered || o.liveMastering) throw new Error('the unmastered render must not ask for mastering');
  const e = instantiateEngine(o.wasmBytes);
  const totalFrames = buildMixer(e, { ...o, blockFrames: MIX_BLOCK });
  if (o.soloLanes) soloOnly(e, o.soloLanes);
  const left = new Float32Array(totalFrames);
  const right = new Float32Array(totalFrames);
  const l = new Float32Array(e.memory.buffer, e.mixer_left(), MIX_BLOCK);
  const r = new Float32Array(e.memory.buffer, e.mixer_right(), MIX_BLOCK);
  let last = performance.now();
  for (let pos = 0; pos < totalFrames; pos += MIX_BLOCK) {
    e.mixer_pull(MIX_BLOCK);
    const n = Math.min(MIX_BLOCK, totalFrames - pos);
    left.set(n === MIX_BLOCK ? l : l.subarray(0, n), pos);
    right.set(n === MIX_BLOCK ? r : r.subarray(0, n), pos);
    if (performance.now() - last > POST_EVERY_MS) {
      last = performance.now();
      onShare(pos / totalFrames);
    }
  }
  return { e, left, right };
}

self.onmessage = (ev) => {
  const o = ev.data;
  if (!o || !['meter', 'mix', 'render', 'impulse', 'profile', 'mixExport'].includes(o.type)) return;
  if (o.type === 'profile') {
    try {
      const { e, left, right } = renderUnmastered(o, () => undefined);
      // A genre recipe's mastering reference (Casperaki Pop), else Atemlos.
      const bytes = masteringProfile(e, left, right, 'sergree', o.masteringReference);
      self.postMessage({ type: 'profile', bytes }, [bytes.buffer]);
    } catch (err) {
      self.postMessage({ type: 'error', message: String(err && err.stack ? err.stack : err) });
    }
    return;
  }
  if (o.type === 'mixExport') {
    try {
      const progress = (phase, share) => self.postMessage({ type: 'exportProgress', phase, share });
      const { e, left, right } = renderUnmastered(o, (share) => progress('render', share));
      progress('master', 0);
      const mastered = masterSong(e, left, right, 'sergree', o.masteringReference);
      const files = {
        'unmastered.wav': encodeWav24(left, right, o.sampleRate, 'render'),
        'mastered.wav': encodeWav24(mastered.left, mastered.right, o.sampleRate, 'master'),
      };
      // The server encodes its 24-bit WAVs, so LAME gets the 24-bit values here too.
      const lame = instantiateLame(o.lameBytes);
      files['unmastered.mp3'] = encodeMp3(lame, left, right, {
        sampleRate: o.sampleRate, vbrQuality: MP3_VBR_QUALITY, rounding: 'render', gainDb: MP3_HEADROOM_DB, onProgress: (share) => progress('mp3 unmastered', share),
      });
      files['mastered.mp3'] = encodeMp3(lame, mastered.left, mastered.right, {
        sampleRate: o.sampleRate, vbrQuality: MP3_VBR_QUALITY, rounding: 'master', gainDb: MP3_HEADROOM_DB, onProgress: (share) => progress('mp3 mastered', share),
      });
      self.postMessage({ type: 'mixExport', files }, Object.values(files).map((f) => f.buffer));
    } catch (err) {
      self.postMessage({ type: 'error', message: String(err && err.stack ? err.stack : err) });
    }
    return;
  }
  if (o.type === 'impulse') {
    // One plugin's impulse response (a fresh instance with these settings), no song needed.
    try {
      const e = instantiateEngine(o.wasmBytes);
      const name = new TextEncoder().encode(o.factory);
      const namePtr = e.malloc(name.length);
      new Uint8Array(e.memory.buffer, namePtr, name.length).set(name);
      const paramsPtr = e.malloc(Math.max(1, o.params.length) * 4);
      new Float32Array(e.memory.buffer, paramsPtr, o.params.length).set(o.params);
      const frames = Math.round(o.seconds * o.sampleRate);
      const ptr = e.mixer_impulse(namePtr, name.length, paramsPtr, o.params.length, frames, o.sampleRate);
      if (!ptr) throw new Error(`mixer_impulse failed: ${lastError(e)}`);
      const all = new Float32Array(e.memory.buffer, ptr, frames * 2);
      const left = all.slice(0, frames);
      const right = all.slice(frames);
      self.postMessage({ type: 'impulse', left, right, sampleRate: o.sampleRate }, [left.buffer, right.buffer]);
    } catch (err) {
      self.postMessage({ type: 'error', message: String(err && err.stack ? err.stack : err) });
    }
    return;
  }
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
