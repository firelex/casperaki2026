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
//   mastered          boolean?      legacy mastering stage (+5 dB into NC-17); needs mixConfig
//   liveMastering     boolean?      the live mastering layer instead (playback worklet): the same
//                                   stand-in until live_set_profile, then the matched master
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
  if (o.mastered && o.liveMastering) throw new Error('buildMixer: mastered and liveMastering exclude each other');
  if (o.mastered) {
    if (!o.mixConfig) throw new Error('buildMixer: mastered needs mixConfig (the mix on)');
    e.mixer_set_mastering(1);
  }
  if (o.liveMastering) {
    if (!o.mixConfig) throw new Error('buildMixer: liveMastering needs mixConfig (the mix on)');
    e.mixer_set_live_mastering(1);
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

/**
 * The mix as the engine resolved it (after buildMixer): per IR track its
 * instrument lane, lowLevelType, FX bus, target volume and send levels (dB).
 * See Mixer::laneInfoJson.
 */
export function laneInfo(e) {
  // Length first: each call re-serialises, and the pointer is valid until the next call.
  const len = e.mixer_lane_info_length();
  if (len < 0) throw new Error(`mixer_lane_info_length failed: ${lastError(e)}`);
  const ptr = e.mixer_lane_info();
  if (!ptr) throw new Error(`mixer_lane_info failed: ${lastError(e)}`);
  return JSON.parse(readUtf8(e, ptr, len));
}

// ---- matched mastering (audio/Matchering.h, = the server's casperaki_master) ----

const STYLES = { sergree: 0, boost: 1 };

/** Copy a stereo song into the heap and analyse it (master_analyze), towards `reference` when given (a genre
 *  recipe's mastering reference: { rms, peak, mid, side }, else Atemlos). Returns the padded frame count (songs
 *  under 15 s are looped to 15 s first). */
function analyse(e, left, right, style, reference) {
  if (left.length !== right.length) throw new Error('mastering: channel lengths differ');
  const code = STYLES[style];
  if (code === undefined) throw new Error(`mastering: unknown style ${style}`);
  const frames = left.length;
  const pL = e.malloc(frames * 4);
  const pR = e.malloc(frames * 4);
  if (!pL || !pR) throw new Error(`mastering: out of memory for ${frames} frames`);
  new Float32Array(e.memory.buffer, pL, frames).set(left);
  new Float32Array(e.memory.buffer, pR, frames).set(right);
  if (reference) setReference(e, reference);
  const padded = e.master_analyze(pL, pR, frames, code);
  if (reference) e.master_clear_reference();
  e.free(pL); e.free(pR);
  if (padded <= 0) throw new Error(`master_analyze failed: ${lastError(e)}`);
  return padded;
}

function setReference(e, r) {
  if (r.mid.length !== 8192 || r.side.length !== 8192) throw new Error('mastering: a reference needs 8192 mid and side values');
  const pM = e.malloc(8192 * 4);
  const pS = e.malloc(8192 * 4);
  if (!pM || !pS) throw new Error('mastering: out of memory for the reference');
  new Float32Array(e.memory.buffer, pM, 8192).set(r.mid);
  new Float32Array(e.memory.buffer, pS, 8192).set(r.side);
  const ok = e.master_set_reference(pM, pS, r.rms, r.peak);
  e.free(pM); e.free(pS);
  if (!ok) throw new Error(`master_set_reference failed: ${lastError(e)}`);
}

function profileBytes(e) {
  const len = e.master_profile_bytes_length();
  const ptr = e.master_profile_bytes();
  if (len <= 0 || !ptr) throw new Error(`mastering: no profile (${lastError(e)})`);
  return new Uint8Array(e.memory.buffer, ptr, len).slice();
}

/** Analyse an unmastered song: the serialised mastering profile (Uint8Array),
 *  to hand to the playback worklet (live_set_profile). */
export function masteringProfile(e, left, right, style = 'sergree', reference = undefined) {
  analyse(e, left, right, style, reference);
  const bytes = profileBytes(e);
  e.master_release();
  return bytes;
}

/** Master a whole unmastered song offline, from frame 0, exactly as
 *  `casperaki_master in.wav out.wav <style>` does. Returns the mastered PCM
 *  (as long as the song, or 15 s for a shorter one) and the profile. */
export function masterSong(e, left, right, style = 'sergree', reference = undefined) {
  analyse(e, left, right, style, reference);
  const profile = profileBytes(e);
  const n = e.master_apply();
  if (n <= 0) throw new Error(`master_apply failed: ${lastError(e)}`);
  const outL = new Float32Array(e.memory.buffer, e.master_output_left(), n).slice();
  const outR = new Float32Array(e.memory.buffer, e.master_output_right(), n).slice();
  e.master_release();
  return { left: outL, right: outR, profile };
}
