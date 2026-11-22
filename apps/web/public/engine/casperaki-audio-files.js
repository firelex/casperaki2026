// Audio files for the browser's mix export: 24-bit WAV and MP3 (LAME VBR).
// Plain ES module, used by the engine worker (public/workers/casperaki-meter-worker.js)
// and by the web unit tests. No TextEncoder needed.
//
// WAV rounding follows the two native writers the server's files come from, so the
// browser's files equal the server's up to the engine's own float differences:
//   'render'  = casperaki_render's writeWav24 (audio/WavIO.h): clamp to [-1, 1], then
//               lround(s * 8388607) in float (the server's out-unmastered.wav).
//   'master'  = casperaki_master's writeWav24File (audio/WavFile.h): round(s * 2^23) in
//               double, clamped to [-2^23, 2^23 - 1] (the server's out.wav).
//
// MP3: LAME 3.100 compiled to WebAssembly (public/wasm/lame.wasm, LGPL, built by
// wasm/lame/build-lame-wasm.sh), a module of its own that is loaded here and never
// linked into the engine.

/** Round half away from zero (C lround / round). */
function roundAway(x) {
  return x < 0 ? -Math.round(-x) : Math.round(x);
}

const QUANTIZE = {
  render(s) {
    const c = s > 1 ? 1 : s < -1 ? -1 : s;
    return roundAway(Math.fround(Math.fround(c) * 8388607));
  },
  master(s) {
    const q = roundAway(s * 8388608);
    return q > 8388607 ? 8388607 : q < -8388608 ? -8388608 : q;
  },
};

/** Stereo float PCM → 24-bit PCM WAV bytes, at natural level (no normalising). */
export function encodeWav24(left, right, sampleRate, rounding) {
  if (left.length !== right.length) throw new Error('encodeWav24: channel lengths differ');
  const quantize = QUANTIZE[rounding];
  if (!quantize) throw new Error(`encodeWav24: unknown rounding "${rounding}" (want render or master)`);
  const frames = left.length;
  const dataBytes = frames * 6;
  const out = new Uint8Array(44 + dataBytes);
  const v = new DataView(out.buffer);
  const text = (o, t) => { for (let i = 0; i < t.length; i++) out[o + i] = t.charCodeAt(i); };
  text(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 2, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 6, true);
  v.setUint16(32, 6, true);
  v.setUint16(34, 24, true);
  text(36, 'data');
  v.setUint32(40, dataBytes, true);
  let o = 44;
  for (let i = 0; i < frames; i++) {
    const a = quantize(left[i]);
    out[o] = a & 0xff; out[o + 1] = (a >> 8) & 0xff; out[o + 2] = (a >> 16) & 0xff;
    const b = quantize(right[i]);
    out[o + 3] = b & 0xff; out[o + 4] = (b >> 8) & 0xff; out[o + 5] = (b >> 16) & 0xff;
    o += 6;
  }
  return out;
}


/** Instantiate lame.wasm (standalone build: four WASI imports, none used on the encode path). */
export function instantiateLame(lameBytes) {
  const fail = (what) => () => { throw new Error(`lame.wasm called ${what}`); };
  const instance = new WebAssembly.Instance(new WebAssembly.Module(lameBytes), {
    wasi_snapshot_preview1: {
      proc_exit: fail('proc_exit (abort)'),
      fd_close: () => 0,
      fd_write: () => 0,
      fd_seek: () => 0,
    },
  });
  const m = instance.exports;
  if (typeof m._initialize === 'function') m._initialize();
  return m;
}

/**
 * Stereo float PCM → MP3 bytes, LAME VBR at `vbrQuality` (2 = `lame -V2`, what the
 * server's ffmpeg `-q:a 2` asks of LAME), with the Xing/LAME tag frame filled in.
 * `rounding`: 'render' or 'master' encodes the 24-bit values the WAV with that
 * rounding holds (the server encodes its 24-bit WAVs), 'none' the floats as given.
 * `onProgress(share)` gets 0..1.
 */
export function encodeMp3(lame, left, right, { sampleRate, vbrQuality, rounding, onProgress }) {
  const quantize = rounding === 'none' ? undefined : QUANTIZE[rounding];
  if (rounding !== 'none' && !quantize) throw new Error(`encodeMp3: unknown rounding "${rounding}"`);
  if (left.length !== right.length) throw new Error('encodeMp3: channel lengths differ');
  if (lame.mp3_init(sampleRate, vbrQuality) !== 1) throw new Error(`LAME could not start (${sampleRate} Hz, -V${vbrQuality})`);
  try {
    const chunk = lame.mp3_input_frames();
    const parts = [];
    let total = 0;
    const take = (n, what) => {
      if (n < 0) throw new Error(`LAME ${what} failed (code ${n})`);
      if (n > 0) {
        parts.push(new Uint8Array(lame.memory.buffer, lame.mp3_output(), n).slice());
        total += n;
      }
    };
    const inL = new Float32Array(lame.memory.buffer, lame.mp3_input_left(), chunk);
    const inR = new Float32Array(lame.memory.buffer, lame.mp3_input_right(), chunk);
    for (let pos = 0; pos < left.length; pos += chunk) {
      const n = Math.min(chunk, left.length - pos);
      if (quantize) {
        for (let i = 0; i < n; i++) {
          inL[i] = quantize(left[pos + i]) / 8388608;
          inR[i] = quantize(right[pos + i]) / 8388608;
        }
      } else {
        inL.set(left.subarray(pos, pos + n));
        inR.set(right.subarray(pos, pos + n));
      }
      take(lame.mp3_encode(n), 'encode');
      if (onProgress && (pos / chunk) % 64 === 0) onProgress(pos / left.length);
    }
    take(lame.mp3_flush(), 'flush');
    const mp3 = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { mp3.set(p, o); o += p.length; }
    // The tag frame replaces the placeholder first frame LAME wrote (same size).
    const tagLen = lame.mp3_tag();
    if (tagLen < 0) throw new Error(`LAME tag failed (code ${tagLen})`);
    if (tagLen > mp3.length) throw new Error('LAME tag is longer than the stream');
    mp3.set(new Uint8Array(lame.memory.buffer, lame.mp3_output(), tagLen), 0);
    if (onProgress) onProgress(1);
    return mp3;
  } finally {
    lame.mp3_close();
  }
}
