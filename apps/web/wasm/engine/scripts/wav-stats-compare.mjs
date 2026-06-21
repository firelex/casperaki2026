#!/usr/bin/env node
// Statistical WAV comparator — the core of the Phase-2 parity oracle (docs/63 §7).
//
// The native full-FX render is NOT bit-reproducible (~5% RMS run-to-run, from the
// Wine-hosted ValhallaFreqEcho on the delay return — see docs/63 §7 / memory
// phase2-determinism-valhalla), and the WASM port replaces Valhalla with a bespoke
// echo anyway. So Phase-2 parity is judged perceptually/statistically, not by a
// sample-exact null:
//   - overall NRMSE (RMS of the difference / RMS of the reference)
//   - per-1/3-octave-band RMS, and the dB delta per band (the spectral envelope)
//   - log-spectral distance (mean |ΔdB| across bands)
//
// Both inputs are decoded to mono (L+R averaged) for the band analysis; overall
// NRMSE is computed per channel then averaged. WAVs may differ in length (compared
// over the common prefix). Run with two paths; optionally a JSON tolerance file.
//
//   node wav-stats-compare.mjs a.wav b.wav [--bands octave|third] [--json]
//
// Exit 0 always (this is a measurement tool); a separate validator applies
// pass/fail thresholds. Used standalone here to CALIBRATE the tolerance by
// measuring the native render's own run-to-run wobble (det-run1 vs det-run2).

import { readFileSync } from 'node:fs';

function parseWav(path) {
  const b = readFileSync(path);
  if (b.toString('ascii', 0, 4) !== 'RIFF') throw new Error(`${path}: not RIFF`);
  let off = 12, fmt = null, dataOff = -1, dataSize = 0;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const sz = b.readUInt32LE(off + 4);
    off += 8;
    if (id === 'fmt ') {
      fmt = {
        channels: b.readUInt16LE(off + 2),
        sampleRate: b.readUInt32LE(off + 4),
        bits: b.readUInt16LE(off + 14),
      };
    } else if (id === 'data') { dataOff = off; dataSize = sz; break; }
    off += sz + (sz & 1);
  }
  if (!fmt || dataOff < 0) throw new Error(`${path}: missing fmt/data`);
  const bps = fmt.bits / 8;
  const frames = Math.floor(dataSize / (fmt.channels * bps));
  const ch = [];
  for (let c = 0; c < fmt.channels; c++) ch.push(new Float32Array(frames));
  const read = (o) => {
    if (bps === 2) { const v = b.readInt16LE(o); return v / 32768; }
    if (bps === 3) { let u = b[o] | (b[o + 1] << 8) | (b[o + 2] << 16); if (u & 0x800000) u |= 0xff000000; return u / 8388608; }
    if (bps === 4) return b.readInt32LE(o) / 2147483648;
    return 0;
  };
  for (let f = 0; f < frames; f++)
    for (let c = 0; c < fmt.channels; c++)
      ch[c][f] = read(dataOff + (f * fmt.channels + c) * bps);
  return { ...fmt, frames, ch };
}

function mono(wav) {
  const n = wav.frames, out = new Float32Array(n), k = 1 / wav.ch.length;
  for (let i = 0; i < n; i++) { let s = 0; for (const c of wav.ch) s += c[i]; out[i] = s * k; }
  return out;
}

function rms(arr, lo = 0, hi = arr.length) {
  let s = 0; for (let i = lo; i < hi; i++) s += arr[i] * arr[i];
  return Math.sqrt(s / Math.max(1, hi - lo));
}
const dB = (x) => 20 * Math.log10(Math.max(x, 1e-12));

// Welch-style power spectrum: average |FFT|^2 over Hann-windowed hops.
function powerSpectrum(sig, sr, fftSize = 4096, hop = 2048) {
  const re = new Float64Array(fftSize), im = new Float64Array(fftSize);
  const win = new Float64Array(fftSize);
  for (let i = 0; i < fftSize; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (fftSize - 1));
  const acc = new Float64Array(fftSize / 2);
  let frames = 0;
  for (let start = 0; start + fftSize <= sig.length; start += hop) {
    for (let i = 0; i < fftSize; i++) { re[i] = sig[start + i] * win[i]; im[i] = 0; }
    fftRadix2(re, im);
    for (let k = 0; k < fftSize / 2; k++) acc[k] += re[k] * re[k] + im[k] * im[k];
    frames++;
  }
  if (frames) for (let k = 0; k < acc.length; k++) acc[k] /= frames;
  return { acc, fftSize, sr };
}

// In-place iterative radix-2 FFT (fftSize must be a power of two).
function fftRadix2(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cwr = 1, cwi = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cwr - im[i + k + len / 2] * cwi;
        const vi = re[i + k + len / 2] * cwi + im[i + k + len / 2] * cwr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncwr = cwr * wr - cwi * wi; cwi = cwr * wi + cwi * wr; cwr = ncwr;
      }
    }
  }
}

// Band edges: 1/1-octave or 1/3-octave from 31.5 Hz up to ~16 kHz.
function bandEdges(kind) {
  const ratio = kind === 'octave' ? 2 : Math.cbrt(2);
  const edges = [];
  let f = 22.097; // lower edge so centres land on standard 31.5/63/...
  while (f < 20000) { edges.push(f); f *= ratio; }
  return edges;
}

function bandRms(spec, edges) {
  const binHz = spec.sr / spec.fftSize;
  const out = [];
  for (let bi = 0; bi < edges.length - 1; bi++) {
    const k0 = Math.max(1, Math.ceil(edges[bi] / binHz));
    const k1 = Math.min(spec.acc.length - 1, Math.floor(edges[bi + 1] / binHz));
    let p = 0; for (let k = k0; k <= k1; k++) p += spec.acc[k];
    out.push({ loHz: edges[bi], hiHz: edges[bi + 1], rms: Math.sqrt(p) });
  }
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const kind = args.includes('--bands') ? args[args.indexOf('--bands') + 1] : 'third';
  const asJson = args.includes('--json');
  // Paths = non-flag args, excluding the value consumed by --bands.
  const bandsValIdx = args.includes('--bands') ? args.indexOf('--bands') + 1 : -1;
  const paths = args.filter((a, i) => !a.startsWith('--') && i !== bandsValIdx);
  if (paths.length !== 2) { console.error('usage: wav-stats-compare.mjs a.wav b.wav [--bands octave|third] [--json]'); process.exit(2); }

  const A = parseWav(paths[0]), B = parseWav(paths[1]);
  const n = Math.min(A.frames, B.frames);
  const chN = Math.min(A.ch.length, B.ch.length);

  // Overall NRMSE per channel (over common prefix), averaged.
  let nrmseSum = 0;
  for (let c = 0; c < chN; c++) {
    let d2 = 0, s2 = 0;
    for (let i = 0; i < n; i++) { const d = A.ch[c][i] - B.ch[c][i]; d2 += d * d; s2 += A.ch[c][i] * A.ch[c][i]; }
    nrmseSum += Math.sqrt(d2) / Math.sqrt(Math.max(s2, 1e-12));
  }
  const nrmse = nrmseSum / chN;

  const mA = mono(A).subarray(0, n), mB = mono(B).subarray(0, n);
  const edges = bandEdges(kind);
  const sA = bandRms(powerSpectrum(mA, A.sampleRate), edges);
  const sB = bandRms(powerSpectrum(mB, B.sampleRate), edges);

  let lsdSum = 0, lsdMax = 0;
  const bands = sA.map((ba, i) => {
    const delta = dB(ba.rms) - dB(sB[i].rms);
    const ad = Math.abs(delta);
    lsdSum += ad; lsdMax = Math.max(lsdMax, ad);
    return { centerHz: Math.round(Math.sqrt(ba.loHz * ba.hiHz)), aDb: +dB(ba.rms).toFixed(2), bDb: +dB(sB[i].rms).toFixed(2), deltaDb: +delta.toFixed(2) };
  });
  const lsd = lsdSum / bands.length;

  const result = {
    a: paths[0], b: paths[1],
    framesA: A.frames, framesB: B.frames, comparedFrames: n,
    nrmse: +nrmse.toFixed(5), nrmsePct: +(100 * nrmse).toFixed(2),
    rmsA_dB: +dB(rms(mA)).toFixed(2), rmsB_dB: +dB(rms(mB)).toFixed(2),
    logSpectralDistance_dB: +lsd.toFixed(3), maxBandDelta_dB: +lsdMax.toFixed(2),
    bands,
  };

  if (asJson) { console.log(JSON.stringify(result, null, 2)); return; }
  console.log(`A: ${paths[0]} (${A.frames} fr)`);
  console.log(`B: ${paths[1]} (${B.frames} fr)`);
  console.log(`overall NRMSE        ${result.nrmsePct}%  (${dB(nrmse).toFixed(1)} dB)`);
  console.log(`rms A / B            ${result.rmsA_dB} / ${result.rmsB_dB} dBFS`);
  console.log(`log-spectral dist    ${result.logSpectralDistance_dB} dB (mean |ΔdB| over ${bands.length} ${kind}-octave bands)`);
  console.log(`max band delta       ${result.maxBandDelta_dB} dB`);
  console.log('band centre(Hz)   A(dB)    B(dB)   Δ(dB)');
  for (const bd of bands)
    console.log(`  ${String(bd.centerHz).padStart(7)}   ${String(bd.aDb).padStart(7)}  ${String(bd.bDb).padStart(7)}  ${String(bd.deltaDb).padStart(6)}`);
}

main();
