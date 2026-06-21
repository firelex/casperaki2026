#!/usr/bin/env node
// Read-only FFT analyser — point at a rendered WAV + a time window and
// list the dominant pitch peaks. Used to verify docs/54l multisample
// staging against the production render (NO staging override).
//
//   node scripts/analyse-wav-pitch.mjs <path-to-wav> [startSec] [windowSec]
//
// Default: startSec=64.5 (chorus1 bar 0 beat 1.0), windowSec=1.0.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const wavPath = resolve(process.argv[2] ?? 'out/brain-roundtrip/out.wav');
const startSec = Number.parseFloat(process.argv[3] ?? '64.5');
const windowSec = Number.parseFloat(process.argv[4] ?? '1.0');

const buf = readFileSync(wavPath);
const fmt = readWavHeader(buf);
console.error(`WAV: ${wavPath}`);
console.error(`  ${fmt.sampleRate} Hz, ${fmt.channels} ch, ${fmt.bitsPerSample}-bit, ${(fmt.frameCount / fmt.sampleRate).toFixed(2)}s`);
console.error(`  Window: [${startSec.toFixed(2)}, ${(startSec + windowSec).toFixed(2)}]s`);

const peaks = analysePeaks(buf, fmt, startSec, windowSec);
console.error(`\n  rank | freq (Hz) | nearest MIDI       | dB`);
for (let i = 0; i < peaks.length; i++) {
  const p = peaks[i];
  console.error(
    `  ${String(i + 1).padStart(4)} | ${p.hz.toFixed(2).padStart(9)} | ${midiFromHz(p.hz).padStart(18)} | ${p.db.toFixed(1)}`,
  );
}

function readWavHeader(buf) {
  if (buf.slice(0, 4).toString() !== 'RIFF' || buf.slice(8, 12).toString() !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let off = 12; let fmt; let dataOff = -1; let dataLen = 0;
  while (off + 8 <= buf.length) {
    const tag = buf.slice(off, off + 4).toString();
    const size = buf.readUInt32LE(off + 4);
    if (tag === 'fmt ') {
      fmt = {
        channels: buf.readUInt16LE(off + 10),
        sampleRate: buf.readUInt32LE(off + 12),
        bitsPerSample: buf.readUInt16LE(off + 22),
      };
    } else if (tag === 'data') { dataOff = off + 8; dataLen = size; break; }
    off += 8 + size + (size & 1);
  }
  if (!fmt || dataOff < 0) throw new Error('missing fmt or data chunk');
  const bytesPerSample = fmt.bitsPerSample / 8;
  const frameBytes = bytesPerSample * fmt.channels;
  const frameCount = Math.floor(dataLen / frameBytes);
  return { ...fmt, dataOff, dataLen, bytesPerSample, frameBytes, frameCount };
}

function readSamplesMono(buf, fmt, startFrame, lenFrames) {
  const out = new Float32Array(lenFrames);
  const bps = fmt.bytesPerSample;
  for (let i = 0; i < lenFrames; i++) {
    let acc = 0;
    for (let c = 0; c < fmt.channels; c++) {
      const off = fmt.dataOff + (startFrame + i) * fmt.frameBytes + c * bps;
      let s = 0;
      if (bps === 2) s = buf.readInt16LE(off) / 32768;
      else if (bps === 3) {
        const b0 = buf[off], b1 = buf[off + 1], b2 = buf[off + 2];
        let v = (b2 << 16) | (b1 << 8) | b0;
        if (v & 0x800000) v |= ~0xffffff;
        s = v / 8388608;
      } else if (bps === 4) s = buf.readInt32LE(off) / 2147483648;
      else throw new Error(`unsupported bitsPerSample ${fmt.bitsPerSample}`);
      acc += s;
    }
    out[i] = acc / fmt.channels;
  }
  return out;
}

function analysePeaks(buf, fmt, startSec, lenSec) {
  const startFrame = Math.floor(startSec * fmt.sampleRate);
  const lenFrames = Math.min(Math.floor(lenSec * fmt.sampleRate), fmt.frameCount - startFrame);
  if (lenFrames <= 1024) throw new Error('window too short');
  const samples = readSamplesMono(buf, fmt, startFrame, lenFrames);
  const win = new Float32Array(lenFrames);
  for (let i = 0; i < lenFrames; i++) {
    win[i] = samples[i] * 0.5 * (1 - Math.cos((2 * Math.PI * i) / (lenFrames - 1)));
  }
  const candidates = [];
  for (let midi = 24; midi <= 96; midi += 1) {
    const hz = midiToHz(midi);
    const k = (2 * Math.PI * hz) / fmt.sampleRate;
    const coeff = 2 * Math.cos(k);
    let q1 = 0, q2 = 0;
    for (let i = 0; i < lenFrames; i++) {
      const q0 = coeff * q1 - q2 + win[i];
      q2 = q1; q1 = q0;
    }
    const power = q1 * q1 + q2 * q2 - q1 * q2 * coeff;
    candidates.push({ midi, hz, power });
  }
  const peaks = [];
  for (let i = 1; i < candidates.length - 1; i++) {
    if (candidates[i].power > candidates[i - 1].power && candidates[i].power > candidates[i + 1].power) {
      const db = 10 * Math.log10(candidates[i].power / lenFrames + 1e-30);
      peaks.push({ midi: candidates[i].midi, hz: candidates[i].hz, db });
    }
  }
  peaks.sort((x, y) => y.db - x.db);
  return peaks.slice(0, 8);
}

function midiToHz(m) { return 440 * Math.pow(2, (m - 69) / 12); }
function midiName(m) {
  const N = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  return `${N[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
}
function midiFromHz(hz) {
  const m = 12 * Math.log2(hz / 440) + 69;
  const r = Math.round(m);
  const cents = Math.round((m - r) * 100);
  return `${midiName(r)} (${r}) ${cents >= 0 ? '+' : ''}${cents}c`;
}
