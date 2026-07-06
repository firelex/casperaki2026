#!/usr/bin/env node
// Phase 3 step 10 — tiny WAV peak/RMS verifier.
//
// Parses a PCM WAV file's header (RIFF/WAVE/fmt /data), then scans the
// sample frames to compute peak and RMS. Used to assert "the engine
// rendered audible audio" without dragging in a full audio dependency.
// Supports 16- and 24-bit signed PCM; 32-bit float; the WAV produced by
// the Phase 2 baseline is 24-bit / 44.1k stereo so that's the primary
// target.
//
// CLI:   node scripts/check-wav.mjs path/to/file.wav [--min-peak-db -40]
// Library: import { analyseWav } from './check-wav.mjs'

import { readFileSync } from 'node:fs';

/**
 * @returns {{
 *   sampleRate: number, channels: number, bitsPerSample: number,
 *   frameCount: number, durationSec: number,
 *   peak: number, peakDb: number,
 *   rms: number, rmsDb: number,
 * }}
 */
export function analyseWav(path) {
  const buf = readFileSync(path);
  if (buf.length < 44) throw new Error(`wav too small: ${buf.length} bytes`);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE')
    throw new Error('not a RIFF/WAVE file');

  // Walk chunks until we hit fmt + data.
  let offset = 12;
  let fmt;
  let dataStart = -1;
  let dataSize = -1;
  while (offset + 8 <= buf.length) {
    const tag = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (tag === 'fmt ') {
      fmt = {
        audioFormat: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (tag === 'data') {
      dataStart = body;
      dataSize = size;
      break;
    }
    offset = body + size + (size % 2);
  }
  if (!fmt) throw new Error('wav missing fmt chunk');
  if (dataStart < 0) throw new Error('wav missing data chunk');

  // A truncated WAV can declare a dataSize larger than the bytes actually
  // present; clamp to the real buffer tail so we never read past the end.
  dataSize = Math.min(dataSize, buf.length - dataStart);

  const { channels, sampleRate, bitsPerSample, audioFormat } = fmt;
  if (channels < 1) throw new Error(`bad channel count: ${channels}`);
  if (sampleRate <= 0) throw new Error(`bad sample rate: ${sampleRate}`);

  const bytesPerSample = bitsPerSample / 8;
  const bytesPerFrame = bytesPerSample * channels;
  const frameCount = Math.floor(dataSize / bytesPerFrame);
  const durationSec = frameCount / sampleRate;

  // PCM int formats (audioFormat=1) or float (=3).
  let readSample;
  let scale;
  if (audioFormat === 1 && bitsPerSample === 16) {
    readSample = (o) => buf.readInt16LE(o);
    scale = 1 << 15; // 32768
  } else if (audioFormat === 1 && bitsPerSample === 24) {
    readSample = (o) => {
      const b0 = buf[o];
      const b1 = buf[o + 1];
      const b2 = buf[o + 2];
      const v = (b2 << 16) | (b1 << 8) | b0;
      return v & 0x800000 ? v | 0xff000000 : v;
    };
    scale = 1 << 23; // 8388608
  } else if (audioFormat === 1 && bitsPerSample === 32) {
    readSample = (o) => buf.readInt32LE(o);
    scale = 2 ** 31;
  } else if (audioFormat === 3 && bitsPerSample === 32) {
    readSample = (o) => buf.readFloatLE(o) * (2 ** 31);
    scale = 2 ** 31;
  } else {
    throw new Error(`unsupported wav format=${audioFormat} bits=${bitsPerSample}`);
  }

  let peak = 0;
  let sumSquares = 0;
  let totalSamples = 0;
  for (let f = 0; f < frameCount; f++) {
    for (let c = 0; c < channels; c++) {
      const s = readSample(dataStart + f * bytesPerFrame + c * bytesPerSample);
      const a = Math.abs(s);
      if (a > peak) peak = a;
      sumSquares += s * s;
      totalSamples++;
    }
  }
  const peakNorm = peak / scale;
  const rms = totalSamples > 0 ? Math.sqrt(sumSquares / totalSamples) / scale : 0;
  return {
    sampleRate,
    channels,
    bitsPerSample,
    frameCount,
    durationSec,
    peak: peakNorm,
    peakDb: peakNorm > 0 ? 20 * Math.log10(peakNorm) : Number.NEGATIVE_INFINITY,
    rms,
    rmsDb: rms > 0 ? 20 * Math.log10(rms) : Number.NEGATIVE_INFINITY,
  };
}

// CLI entry point.
if (import.meta.url === `file://${process.argv[1]}`) {
  const path = process.argv[2];
  if (!path) {
    console.error('usage: node check-wav.mjs <path> [--min-peak-db <db>]');
    process.exit(2);
  }
  let minPeakDb = -40;
  for (let i = 3; i < process.argv.length; i++) {
    if (process.argv[i] === '--min-peak-db') {
      minPeakDb = Number.parseFloat(process.argv[++i]);
    }
  }
  const stats = analyseWav(path);
  console.log(JSON.stringify(stats, null, 2));
  if (stats.durationSec <= 0) {
    console.error('FAIL: zero-length WAV');
    process.exit(1);
  }
  if (!Number.isFinite(stats.peakDb) || stats.peakDb < minPeakDb) {
    console.error(`FAIL: peakDb ${stats.peakDb} below threshold ${minPeakDb}`);
    process.exit(1);
  }
  console.error(`OK: ${stats.durationSec.toFixed(2)}s, peak ${stats.peakDb.toFixed(2)} dB, rms ${stats.rmsDb.toFixed(2)} dB`);
}
