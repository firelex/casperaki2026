#!/usr/bin/env node
// docs/54r — minimal per-window RMS comparator. Reads two PCM WAVs
// of identical format/duration and emits the per-window peak/RMS
// stats for a configurable list of named windows. Used to prove
// the percussion-loop wiring adds audible energy to verse segments
// without affecting non-verse segments.
//
// Usage: node window-rms.mjs WAV-A WAV-B w1:start:end w2:start:end …
//   start / end in seconds, end exclusive.

import { readFileSync } from 'node:fs';

function read24(buf, off) {
  const u = buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16);
  return u & 0x800000 ? u | 0xff000000 : u;
}

function decode(path) {
  const data = readFileSync(path);
  if (data.subarray(0, 4).toString() !== 'RIFF') throw new Error('not RIFF');
  let off = 12;
  let sampleRate = 0, bits = 0, channels = 0;
  let dataOff = -1, dataSize = -1;
  while (off < data.length) {
    const id = data.subarray(off, off + 4).toString();
    const sz = data.readUInt32LE(off + 4);
    off += 8;
    if (id === 'fmt ') {
      channels = data.readUInt16LE(off + 2);
      sampleRate = data.readUInt32LE(off + 4);
      bits = data.readUInt16LE(off + 14);
    } else if (id === 'data') {
      dataOff = off;
      dataSize = sz;
      break;
    }
    off += sz;
  }
  const bps = bits / 8;
  const stride = channels * bps;
  return { data, dataOff, dataSize, sampleRate, channels, bits, bps, stride };
}

function rmsWindow(decoded, startSec, endSec) {
  const { data, dataOff, dataSize, sampleRate, channels, bps, stride } = decoded;
  const sampleScale = bps === 2 ? 32768 : bps === 3 ? 8388608 : 2147483648;
  const startFrame = Math.floor(startSec * sampleRate);
  const endFrame = Math.floor(endSec * sampleRate);
  let sum2 = 0;
  let n = 0;
  let peak = 0;
  for (let f = startFrame; f < endFrame; f++) {
    const off = dataOff + f * stride;
    if (off + stride > dataOff + dataSize) break;
    for (let c = 0; c < channels; c++) {
      let s = 0;
      if (bps === 2) s = data.readInt16LE(off + c * 2);
      else if (bps === 3) s = read24(data, off + c * 3);
      else if (bps === 4) s = data.readInt32LE(off + c * 4);
      const v = s / sampleScale;
      sum2 += v * v;
      if (Math.abs(v) > peak) peak = Math.abs(v);
      n++;
    }
  }
  const rms = n > 0 ? Math.sqrt(sum2 / n) : 0;
  return { peak, rms };
}

const [a, b, ...rest] = process.argv.slice(2);
if (!a || !b || rest.length === 0) {
  console.error('usage: window-rms.mjs WAV-A WAV-B name:start:end [name:start:end ...]');
  process.exit(1);
}
const wa = decode(a);
const wb = decode(b);
console.log(`${a} vs ${b}`);
console.log(
  ['window', 'start-end', 'A peak (dB)', 'A rms (dB)', 'B peak (dB)', 'B rms (dB)', 'Δrms (dB)']
    .map((s) => s.padStart(11))
    .join(' | '),
);
for (const arg of rest) {
  const [name, s, e] = arg.split(':');
  const sa = rmsWindow(wa, Number.parseFloat(s), Number.parseFloat(e));
  const sb = rmsWindow(wb, Number.parseFloat(s), Number.parseFloat(e));
  const db = (x) => (x === 0 ? '-inf' : (20 * Math.log10(x)).toFixed(2));
  const diff = (Number(db(sb.rms)) - Number(db(sa.rms))).toFixed(2);
  console.log([
    name, `${s}-${e}`,
    db(sa.peak), db(sa.rms),
    db(sb.peak), db(sb.rms),
    diff,
  ].map((s) => String(s).padStart(11)).join(' | '));
}
