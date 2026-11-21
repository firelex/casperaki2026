// Casperaki streaming-render AudioWorkletProcessor (docs/60 Phase 1 step 6).
//
// The browser-side driver of the WASM streaming mixer (engine-render.wasm). It is
// the real-time analogue of the native casperaki_render loop: the WebAudio render
// thread PULLS one 128-frame quantum per process() call, and we forward that pull
// straight into the wasm mixer (mixer_pull -> mixer_left/right). Nothing blocks,
// no offline busy-loop — the structural answer to the 57f duplicate-lane hang
// (docs/57f): the audio callback drives the engine, never the other way round.
//
// All the heavy work (instantiate, resolve song.json, build the mixer, stage the
// decoded sample PCM) happens ONCE in the constructor, off the render callback —
// mirroring the /wasm-tone spike's dsp_init. Until that is done process() emits
// silence (a valid quantum), so the node always produces sound and never stalls.
//
// processorOptions:
//   wasmBytes   ArrayBuffer    engine-render.wasm
//   sampleRate  number         the AudioContext rate (mixer + decoded PCM rate)
//   masterGain  number         fixed RT gain (no look-ahead normalisation)
//   song        Uint8Array     song.json, UTF-8 bytes
//   insts       Uint8Array[]   inst-N.json, UTF-8 bytes, ascending id order
//               (bytes, not strings: AudioWorkletGlobalScope has no TextEncoder
//               in Chrome, so the main thread encodes)
//   samples     Float32Array[] decoded mono PCM, role order [kick,snare,hat,tone,bass]
//   realSamples  {key: Uint8Array (UTF-8), ch0, ch1?, sampleRate}[]  decoded real library PCM, keyed by
//                the join id (tonal slot id / drum name / "playsample-<id>.ogg");
//                tonal slices are already cut on the main thread. Optional — when
//                present they override the stubs per key; absent keys still fall
//                back to a stub, so a partial library renders.

const ROLE_COUNT = 5;

class CasperakiRenderProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.ready = false;
    this.done = false;
    this.frames = 128;
    this.masterGain = options.processorOptions.masterGain ?? 0.15;

    try {
      const o = options.processorOptions;
      const module = new WebAssembly.Module(o.wasmBytes);
      // The standalone build pulls in 5 unused WASI stdio imports; stub them — the
      // mixer never does real I/O, so no-ops are safe. Memory growth (needed for
      // the real sample library) adds env.emscripten_notify_memory_growth; it's a
      // no-op here because all heap growth happens during buildMixer (sample
      // staging + build), BEFORE the persistent L/R views are taken, and the
      // per-quantum mixer_pull never allocates — so the cached views never detach.
      const wasi = {
        fd_close: () => 0, fd_write: () => 0, fd_seek: () => 0,
        environ_sizes_get: () => 0, environ_get: () => 0,
      };
      const instance = new WebAssembly.Instance(module, {
        wasi_snapshot_preview1: wasi,
        env: { emscripten_notify_memory_growth: () => {} },
      });
      const e = instance.exports;
      if (typeof e._initialize === 'function') e._initialize(); // reactor init
      this.e = e;

      this.buildMixer(o);

      // Memory growth is disabled in the build, so the heap never detaches and the
      // L/R view pointers stay valid for the life of the node.
      this.leftPtr = e.mixer_left();
      this.rightPtr = e.mixer_right();
      this.left = new Float32Array(e.memory.buffer, this.leftPtr, this.frames);
      this.right = new Float32Array(e.memory.buffer, this.rightPtr, this.frames);

      this.ready = true;
      this.port.postMessage({
        type: 'ready', totalFrames: this.totalFrames, sampleRate: o.sampleRate,
        realCount: this.realCount || 0,
      });
    } catch (err) {
      this.port.postMessage({ type: 'error', message: String(err && err.stack ? err.stack : err) });
    }
  }

  buildMixer(o) {
    const e = this.e;
    const bytes = (v, what) => {
      if (!(v instanceof Uint8Array)) throw new Error(`${what} must be UTF-8 bytes (Uint8Array)`);
      return v;
    };
    const heapU8 = () => new Uint8Array(e.memory.buffer);
    const writeBytes = (bytes) => {
      const p = e.malloc(bytes.length);
      heapU8().set(bytes, p);
      return p;
    };

    e.mixer_config(o.sampleRate, this.frames);

    // Stage the 5 decoded PCM stubs (mono). The wasm copies them into its own
    // SampleData, so we free the staging buffer right after.
    for (let role = 0; role < ROLE_COUNT; role++) {
      const pcm = o.samples[role] || new Float32Array(0);
      const p = e.malloc(pcm.length * 4);
      new Float32Array(e.memory.buffer, p, pcm.length).set(pcm);
      e.mixer_set_sample(role, p, 0, pcm.length, 1, o.sampleRate);
      e.free(p);
    }

    // Stage the real (id-keyed) library samples, if supplied. Each may be stereo.
    // Malloc all buffers first, THEN take views over the (possibly grown) heap and
    // write — so a growth mid-staging can't leave us writing through a detached
    // view. mixer_set_sample_id copies the PCM, so we free our staging right away.
    const real = o.realSamples || [];
    for (const rs of real) {
      const ch0 = rs.ch0;
      const ch1 = rs.ch1 || null;
      const frames = ch0.length;
      const channels = ch1 ? 2 : 1;
      const keyBytes = bytes(rs.key, 'realSamples[].key');
      const keyPtr = e.malloc(keyBytes.length);
      const p0 = e.malloc(frames * 4);
      const p1 = ch1 ? e.malloc(frames * 4) : 0;
      heapU8().set(keyBytes, keyPtr);
      new Float32Array(e.memory.buffer, p0, frames).set(ch0);
      if (p1) new Float32Array(e.memory.buffer, p1, frames).set(ch1);
      e.mixer_set_sample_id(keyPtr, keyBytes.length, p0, p1, frames, channels, rs.sampleRate);
      e.free(keyPtr); e.free(p0); if (p1) e.free(p1);
    }
    this.realCount = real.length;

    // song.json + the concatenated inst-N.json blob + its per-file lengths.
    const songBytes = bytes(o.song, 'song');
    const songPtr = writeBytes(songBytes);

    const instBytes = o.insts.map((s, i) => bytes(s, `insts[${i}]`));
    const blobLen = instBytes.reduce((n, b) => n + b.length, 0);
    const blob = new Uint8Array(blobLen);
    let off = 0;
    for (const b of instBytes) { blob.set(b, off); off += b.length; }
    const blobPtr = writeBytes(blob);

    const lens = new Int32Array(instBytes.map((b) => b.length));
    const lensPtr = e.malloc(lens.byteLength);
    new Int32Array(e.memory.buffer, lensPtr, lens.length).set(lens);

    this.totalFrames = e.mixer_build(songPtr, songBytes.length, blobPtr, lensPtr, instBytes.length);
    if (e.mixer_last_error() !== 0) throw new Error('mixer_build failed (resolve/build threw)');
    e.mixer_set_master_gain(this.masterGain);

    e.free(songPtr);
    e.free(blobPtr);
    e.free(lensPtr);
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    if (!this.ready || this.done) {
      for (let c = 0; c < output.length; c++) output[c].fill(0);
      return true;
    }

    // Pull one block from the mixer; mixer_pull returns 0 once past the end.
    const more = this.e.mixer_pull(this.frames);
    const outL = output[0];
    const outR = output.length > 1 ? output[1] : null;
    for (let i = 0; i < outL.length; i++) {
      // Hard-clamp as a safety net (the RT path has no look-ahead normaliser).
      let l = this.left[i];
      l = l > 1 ? 1 : l < -1 ? -1 : l;
      outL[i] = l;
    }
    if (outR) {
      for (let i = 0; i < outR.length; i++) {
        let r = this.right[i];
        r = r > 1 ? 1 : r < -1 ? -1 : r;
        outR[i] = r;
      }
    }

    if (!more) {
      this.done = true;
      this.port.postMessage({ type: 'ended' });
    }
    return true; // keep the node alive
  }
}

registerProcessor('casperaki-render-processor', CasperakiRenderProcessor);
