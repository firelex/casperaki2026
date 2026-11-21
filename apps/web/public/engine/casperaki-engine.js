// Shared driver for engine-render.wasm, used by the playback AudioWorklet
// (public/worklets/casperaki-render-worklet.js) and the level-meter worker
// (public/workers/casperaki-meter-worker.js). Plain ES module: both scopes
// lack TextEncoder/TextDecoder, so text arrives as UTF-8 bytes and names are
// decoded by hand.
//
// Build options (from the main thread):
//   sampleRate        number        mixer + decoded PCM rate
//   blockFrames       number        frames per pull
//   song              Uint8Array    song.json, UTF-8
//   insts             Uint8Array[]  inst-N.json, UTF-8, ascending id order
//   samples           Float32Array[] the 5 fallback samples, mono, role order
//   realSamples       {key: Uint8Array, ch0, ch1?, sampleRate}[]  library PCM by join key
//   mixConfig         Uint8Array?   mix-config.json; turns the mix + rack FX on
//   meterBinFrames    number?       record per-lane peak/RMS per bin of this many frames

const ROLE_COUNT = 5;

export function instantiateEngine(wasmBytes) {
  const module = new WebAssembly.Module(wasmBytes);
  // Standalone build: 5 unused WASI stdio imports (no-ops are safe, the mixer
  // never does I/O) and the memory-growth notification (all growth happens
  // while building, before any persistent views are taken).
  const wasi = {
    fd_close: () => 0, fd_write: () => 0, fd_seek: () => 0,
    environ_sizes_get: () => 0, environ_get: () => 0,
  };
  const instance = new WebAssembly.Instance(module, {
    wasi_snapshot_preview1: wasi,
    env: { emscripten_notify_memory_growth: () => {} },
  });
  const e = instance.exports;
  if (typeof e._initialize === 'function') e._initialize();
  return e;
}

/** NUL-terminated or length-delimited UTF-8 in the heap → string. */
export function readUtf8(e, ptr, length) {
  const heap = new Uint8Array(e.memory.buffer);
  let end = ptr;
  if (length === undefined) { while (heap[end] !== 0) end++; } else end = ptr + length;
  let s = '';
  for (let i = ptr; i < end; ) {
    const b = heap[i++];
    if (b < 0x80) s += String.fromCharCode(b);
    else if (b < 0xe0) s += String.fromCharCode(((b & 0x1f) << 6) | (heap[i++] & 0x3f));
    else if (b < 0xf0) s += String.fromCharCode(((b & 0x0f) << 12) | ((heap[i++] & 0x3f) << 6) | (heap[i++] & 0x3f));
    else {
      const cp = ((b & 0x07) << 18) | ((heap[i++] & 0x3f) << 12) | ((heap[i++] & 0x3f) << 6) | (heap[i++] & 0x3f);
      s += String.fromCodePoint(cp);
    }
  }
  return s;
}

export function lastError(e) {
  return readUtf8(e, e.mixer_last_error_message());
}

function bytes(v, what) {
  if (!(v instanceof Uint8Array)) throw new Error(`${what} must be UTF-8 bytes (Uint8Array)`);
  return v;
}

/** Stage samples, configure and build the mixer. Returns totalFrames. */
export function buildMixer(e, o) {
  const heapU8 = () => new Uint8Array(e.memory.buffer);
  const writeBytes = (b) => {
    const p = e.malloc(b.length);
    heapU8().set(b, p);
    return p;
  };

  e.mixer_config(o.sampleRate, o.blockFrames);

  for (let role = 0; role < ROLE_COUNT; role++) {
    const pcm = o.samples[role];
    if (!pcm) throw new Error(`fallback sample ${role} missing`);
    const p = e.malloc(pcm.length * 4);
    new Float32Array(e.memory.buffer, p, pcm.length).set(pcm);
    e.mixer_set_sample(role, p, 0, pcm.length, 1, o.sampleRate);
    e.free(p);
  }

  // Malloc first, then take views (a heap growth mid-staging detaches views).
  for (const rs of o.realSamples || []) {
    const keyBytes = bytes(rs.key, 'realSamples[].key');
    const frames = rs.ch0.length;
    const keyPtr = e.malloc(keyBytes.length);
    const p0 = e.malloc(frames * 4);
    const p1 = rs.ch1 ? e.malloc(frames * 4) : 0;
    heapU8().set(keyBytes, keyPtr);
    new Float32Array(e.memory.buffer, p0, frames).set(rs.ch0);
    if (p1) new Float32Array(e.memory.buffer, p1, frames).set(rs.ch1);
    e.mixer_set_sample_id(keyPtr, keyBytes.length, p0, p1, frames, rs.ch1 ? 2 : 1, rs.sampleRate);
    e.free(keyPtr); e.free(p0); if (p1) e.free(p1);
  }

  if (o.mixConfig) {
    const cfg = bytes(o.mixConfig, 'mixConfig');
    const p = writeBytes(cfg);
    e.mixer_set_mix_enabled(1);
    const ok = e.mixer_set_mix_config(p, cfg.length);
    e.free(p);
    if (ok !== 1) throw new Error(`mixer_set_mix_config failed: ${lastError(e)}`);
  }
  if (o.meterBinFrames) {
    if (e.mixer_enable_meters(o.meterBinFrames) !== 1) throw new Error(`mixer_enable_meters failed: ${lastError(e)}`);
  }

  const songBytes = bytes(o.song, 'song');
  const songPtr = writeBytes(songBytes);
  const instBytes = o.insts.map((s, i) => bytes(s, `insts[${i}]`));
  const blob = new Uint8Array(instBytes.reduce((n, b) => n + b.length, 0));
  let off = 0;
  for (const b of instBytes) { blob.set(b, off); off += b.length; }
  const blobPtr = writeBytes(blob);
  const lens = new Int32Array(instBytes.map((b) => b.length));
  const lensPtr = e.malloc(lens.byteLength);
  new Int32Array(e.memory.buffer, lensPtr, lens.length).set(lens);

  const totalFrames = e.mixer_build(songPtr, songBytes.length, blobPtr, lensPtr, instBytes.length);
  e.free(songPtr); e.free(blobPtr); e.free(lensPtr);
  if (e.mixer_last_error() !== 0) throw new Error(`mixer_build failed: ${lastError(e)}`);
  return totalFrames;
}

/** The mixer's lanes (one per instrument name), in lane order. */
export function laneNames(e) {
  const n = e.mixer_lane_count();
  if (n < 0) throw new Error(`mixer_lane_count failed: ${lastError(e)}`);
  const names = [];
  for (let i = 0; i < n; i++) names.push(readUtf8(e, e.mixer_lane_name(i), e.mixer_lane_name_length(i)));
  return names;
}
