#!/usr/bin/env node
// docs/65 — statistical WAV difference between two PCM WAVs of identical
// format/length. Byte-identity is the WRONG gate for this engine (sub-LSB
// rounding / run-to-run non-determinism flips most bytes while leaving the
// audio essentially unchanged — see memory phase2-determinism-valhalla). This
// reports the difference SIGNAL: max abs sample delta (LSB + dBFS), RMS of the
// per-sample difference (dBFS), and the per-window difference RMS so a localized
// change (e.g. drum reverb in one genre) is distinguishable from the broadband
// non-determinism floor.
//
// Usage: node wav-diff.mjs A.wav B.wav [--win 2.0]
import { readFileSync } from 'node:fs';

function decode(path) {
  const d = readFileSync(path);
  if (d.subarray(0, 4).toString() !== 'RIFF') throw new Error(path + ': not RIFF');
  let off = 12, sampleRate = 0, bits = 0, channels = 0, dataOff = -1, dataSize = -1;
  while (off + 8 <= d.length) {
    const id = d.subarray(off, off + 4).toString();
    const sz = d.readUInt32LE(off + 4);
    off += 8;
    if (id === 'fmt ') { channels = d.readUInt16LE(off + 2); sampleRate = d.readUInt32LE(off + 4); bits = d.readUInt16LE(off + 14); }
    else if (id === 'data') { dataOff = off; dataSize = sz; }
    off += sz + (sz & 1);
  }
  if (dataOff < 0) throw new Error(path + ': no data chunk');
  const bytesPerSample = bits / 8;
  const n = Math.floor(dataSize / bytesPerSample);
  const out = new Float64Array(n);
  const full = bits === 24 ? 0x7fffff : bits === 16 ? 0x7fff : 1;
  for (let i = 0; i < n; i++) {
    const p = dataOff + i * bytesPerSample;
    let v;
    if (bits === 24) { const u = d[p] | (d[p + 1] << 8) | (d[p + 2] << 16); v = (u & 0x800000 ? u | 0xff000000 : u); }
    else if (bits === 16) v = d.readInt16LE(p);
    else if (bits === 32) v = d.readFloatLE(p) * 0x7fffffff; // treat float as normalized
    else throw new Error('unsupported bits ' + bits);
    out[i] = v / full; // normalize to [-1,1]
  }
  return { sampleRate, channels, bits, samples: out };
}

const [, , A, B, ...rest] = process.argv;
let win = 2.0;
for (let i = 0; i < rest.length; i++) if (rest[i] === '--win') win = parseFloat(rest[++i]);

const a = decode(A), b = decode(B);
if (a.bits !== b.bits || a.channels !== b.channels) throw new Error('format mismatch');
const n = Math.min(a.samples.length, b.samples.length);
const db = (x) => x <= 0 ? -Infinity : 20 * Math.log10(x);

let maxAbs = 0, sumSq = 0, sumSqA = 0, diffCount = 0;
for (let i = 0; i < n; i++) {
  const dlt = a.samples[i] - b.samples[i];
  const ad = Math.abs(dlt);
  if (ad > 0) diffCount++;
  if (ad > maxAbs) maxAbs = ad;
  sumSq += dlt * dlt;
  sumSqA += a.samples[i] * a.samples[i];
}
const rms = Math.sqrt(sumSq / n);
const rmsA = Math.sqrt(sumSqA / n);
const lsb = a.bits === 24 ? 0x7fffff : a.bits === 16 ? 0x7fff : 1;

console.log(`A=${A.split('/').pop()}  B=${B.split('/').pop()}`);
console.log(`  format: ${a.sampleRate}Hz ${a.channels}ch ${a.bits}bit  samples=${n}  (${(n / a.channels / a.sampleRate).toFixed(1)}s)`);
console.log(`  samples differing: ${diffCount} (${(100 * diffCount / n).toFixed(1)}%)`);
console.log(`  max |Δ|: ${maxAbs.toExponential(3)} = ${(maxAbs * lsb).toFixed(1)} LSB = ${db(maxAbs).toFixed(1)} dBFS`);
console.log(`  diff RMS: ${db(rms).toFixed(1)} dBFS    signal RMS(A): ${db(rmsA).toFixed(1)} dBFS    diff-below-signal: ${(db(rms) - db(rmsA)).toFixed(1)} dB`);

// per-window diff RMS (helps localize a real change vs broadband floor)
const spw = Math.floor(win * a.sampleRate) * a.channels;
const wins = Math.ceil(n / spw);
let worst = { i: -1, rms: -Infinity };
const rows = [];
for (let w = 0; w < wins; w++) {
  let s = 0, c = 0;
  for (let i = w * spw; i < Math.min((w + 1) * spw, n); i++) { const dlt = a.samples[i] - b.samples[i]; s += dlt * dlt; c++; }
  const r = db(Math.sqrt(s / c));
  rows.push(r);
  if (r > worst.rms) worst = { i: w, rms: r };
}
const finite = rows.filter((x) => isFinite(x));
const mean = finite.reduce((p, c) => p + c, 0) / (finite.length || 1);
console.log(`  per-window diff RMS (${win}s): mean=${mean.toFixed(1)} dBFS  worst=${worst.rms.toFixed(1)} dBFS @win#${worst.i} (t=${(worst.i * win).toFixed(0)}s)`);
