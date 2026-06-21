// Local dev render artifact route.
//
// The native engine-spike harness produces a single multi-segment WAV at
// a configurable path (BRAIN_RENDER_ARTIFACT_PATH, defaults to
// ../engine-spike/out/brain-roundtrip/out.wav). This router exposes that
// file to the editor without taking on render-queue duties:
//
//   GET /api/renders/latest      → JSON metadata { exists, ... }
//   GET /api/renders/latest.wav  → WAV bytes, or 404 if missing
//
// This is a DEV/LOCAL bridge. The browser cannot trigger a native render,
// there is no job lifecycle, no per-song artifact mapping, and the path
// is process-local. The future render-job architecture is sketched in
// docs/54c-ui-render-artifact.md.

import { createReadStream, promises as fsp, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { Router } from 'express';
import { z } from 'zod';

export interface RendersRouterDeps {
  /** Absolute or cwd-relative path to the local WAV artifact. */
  readonly artifactPath: string;
}

export interface RenderMetadata {
  readonly exists: boolean;
  readonly durationSec?: number;
  readonly peakDb?: number;
  readonly rmsDb?: number;
  readonly sampleRate?: number;
  readonly bitDepth?: number;
  readonly channels?: number;
  readonly sizeBytes?: number;
  readonly updatedAt?: string;
  readonly url?: string;
}

interface CacheKey {
  readonly path: string;
  readonly mtimeMs: number;
  readonly size: number;
}

interface CacheValue {
  readonly key: CacheKey;
  readonly meta: RenderMetadata;
}

// Module-level cache so we don't re-scan a 55 MB WAV on every poll.
// Invalidated whenever (path, mtime, size) drifts.
let cached: CacheValue | undefined;

export function createRendersRouter({ artifactPath }: RendersRouterDeps): Router {
  const router = Router();
  // Resolve once at construction so error messages report the actual path
  // tried, regardless of where Express invokes the handler from.
  const resolvedPath = resolve(artifactPath);

  router.get('/api/renders/latest', async (_req, res) => {
    const meta = await readRenderMetadata(resolvedPath);
    res.json(meta);
  });

  router.get('/api/renders/latest.wav', (_req, res) => {
    let stat;
    try {
      stat = statSync(resolvedPath);
    } catch {
      return res.status(404).json({ error: 'not_found', path: resolvedPath });
    }
    res.setHeader('content-type', 'audio/wav');
    res.setHeader('content-length', String(stat.size));
    res.setHeader('accept-ranges', 'none');
    res.setHeader('cache-control', 'no-store');
    const stream = createReadStream(resolvedPath);
    stream.on('error', () => {
      if (!res.headersSent) res.status(500).end();
      else res.destroy();
    });
    stream.pipe(res);
    return undefined;
  });

  router.get('/api/renders/latest/peaks', async (req, res) => {
    const parsed = PeaksQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'invalid_query',
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
    }
    const bins = parsed.data.bins ?? 512;
    const peaks = await readRenderPeaks(resolvedPath, bins);
    return res.json(peaks);
  });

  return router;
}

const PeaksQuerySchema = z
  .object({
    bins: z.coerce.number().int().positive().max(4096).optional(),
  })
  .strict();

export interface RenderPeaks {
  readonly exists: boolean;
  readonly bins: number;
  readonly sampleRate?: number;
  readonly channels?: number;
  readonly durationSec?: number;
  /** Per-bin amplitudes in [0, 1], computed as the max-absolute
   *  amplitude of the bin's frames averaged across channels. */
  readonly peaks: readonly number[];
  /** Per-bin RMS amplitudes in [0, 1], same averaging strategy. Useful
   *  for a center-of-mass overlay; matches what audio editors call
   *  the "soft" waveform. */
  readonly rms: readonly number[];
  readonly updatedAt?: string;
}

interface PeaksCacheValue {
  readonly key: { path: string; mtimeMs: number; size: number; bins: number };
  readonly value: RenderPeaks;
}

// Process-local cache keyed by (path, mtime, size, bins). Re-binning at a
// different resolution recomputes; otherwise the 55 MB WAV is only
// scanned once per render generation.
let peaksCached: PeaksCacheValue | undefined;

export function resetRenderPeaksCache(): void {
  peaksCached = undefined;
}

export async function readRenderPeaks(path: string, bins: number): Promise<RenderPeaks> {
  let stat;
  try {
    stat = await fsp.stat(path);
  } catch {
    peaksCached = undefined;
    return { exists: false, bins, peaks: [], rms: [] };
  }
  if (!stat.isFile()) {
    peaksCached = undefined;
    return { exists: false, bins, peaks: [], rms: [] };
  }
  if (
    peaksCached &&
    peaksCached.key.path === path &&
    peaksCached.key.mtimeMs === stat.mtimeMs &&
    peaksCached.key.size === stat.size &&
    peaksCached.key.bins === bins
  ) {
    return peaksCached.value;
  }
  let computed;
  try {
    computed = await computePeaksFromWav(path, bins);
  } catch {
    const failed: RenderPeaks = {
      exists: true,
      bins,
      peaks: [],
      rms: [],
      updatedAt: stat.mtime.toISOString(),
    };
    peaksCached = {
      key: { path, mtimeMs: stat.mtimeMs, size: stat.size, bins },
      value: failed,
    };
    return failed;
  }
  const value: RenderPeaks = {
    exists: true,
    bins,
    sampleRate: computed.sampleRate,
    channels: computed.channels,
    durationSec: round(computed.durationSec, 3),
    peaks: computed.peaks,
    rms: computed.rms,
    updatedAt: stat.mtime.toISOString(),
  };
  peaksCached = {
    key: { path, mtimeMs: stat.mtimeMs, size: stat.size, bins },
    value,
  };
  return value;
}

interface ComputedPeaks {
  readonly sampleRate: number;
  readonly channels: number;
  readonly durationSec: number;
  readonly peaks: readonly number[];
  readonly rms: readonly number[];
}

async function computePeaksFromWav(path: string, bins: number): Promise<ComputedPeaks> {
  const buf = await fsp.readFile(path);
  const fmt = parseWavHeader(buf);
  const { sampleRate, channels, bitsPerSample, audioFormat, dataStart, dataSize } = fmt;
  const reader = readerFor(audioFormat, bitsPerSample);
  if (!reader) {
    throw new Error(`unsupported wav format=${audioFormat} bits=${bitsPerSample}`);
  }
  const bytesPerSample = bitsPerSample / 8;
  const bytesPerFrame = bytesPerSample * channels;
  const frameCount = Math.floor(dataSize / bytesPerFrame);
  if (frameCount === 0 || bins === 0) {
    return {
      sampleRate,
      channels,
      durationSec: 0,
      peaks: [],
      rms: [],
    };
  }
  // Bin frames into `bins` equal-width buckets. The last bin may pick up
  // the remainder so every sample is accounted for.
  const peaks = new Array<number>(bins).fill(0);
  const rms = new Array<number>(bins).fill(0);
  const framesPerBin = Math.max(1, Math.floor(frameCount / bins));
  for (let b = 0; b < bins; b++) {
    const startFrame = b * framesPerBin;
    const endFrame = b === bins - 1 ? frameCount : Math.min(frameCount, startFrame + framesPerBin);
    let peak = 0;
    let sumSquares = 0;
    let sampleCount = 0;
    for (let f = startFrame; f < endFrame; f++) {
      for (let c = 0; c < channels; c++) {
        const offset = dataStart + f * bytesPerFrame + c * bytesPerSample;
        const normalized = reader(buf, offset);
        const a = Math.abs(normalized);
        if (a > peak) peak = a;
        sumSquares += normalized * normalized;
        sampleCount++;
      }
    }
    peaks[b] = round(Math.min(1, peak), 5);
    rms[b] = round(sampleCount > 0 ? Math.min(1, Math.sqrt(sumSquares / sampleCount)) : 0, 5);
  }
  return {
    sampleRate,
    channels,
    durationSec: frameCount / sampleRate,
    peaks,
    rms,
  };
}

interface ParsedWavHeader {
  readonly sampleRate: number;
  readonly channels: number;
  readonly bitsPerSample: number;
  readonly audioFormat: number;
  readonly dataStart: number;
  readonly dataSize: number;
}

function parseWavHeader(buf: Buffer): ParsedWavHeader {
  if (buf.length < 44) throw new Error(`wav too small: ${buf.length} bytes`);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE')
    throw new Error('not a RIFF/WAVE file');
  let offset = 12;
  let fmt: { audioFormat: number; channels: number; sampleRate: number; bitsPerSample: number } | undefined;
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
  return {
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    bitsPerSample: fmt.bitsPerSample,
    audioFormat: fmt.audioFormat,
    dataStart,
    dataSize,
  };
}

/** Returns a normalised [-1, 1] sample reader for the given format, or
 *  `undefined` if the format isn't supported. */
function readerFor(audioFormat: number, bitsPerSample: number): ((buf: Buffer, offset: number) => number) | undefined {
  if (audioFormat === 1 && bitsPerSample === 16) {
    const scale = 1 << 15;
    return (buf, o) => buf.readInt16LE(o) / scale;
  }
  if (audioFormat === 1 && bitsPerSample === 24) {
    const scale = 1 << 23;
    return (buf, o) => {
      const b0 = buf[o]!;
      const b1 = buf[o + 1]!;
      const b2 = buf[o + 2]!;
      const v = (b2 << 16) | (b1 << 8) | b0;
      const signed = v & 0x800000 ? v | 0xff000000 : v;
      return signed / scale;
    };
  }
  if (audioFormat === 1 && bitsPerSample === 32) {
    const scale = 2 ** 31;
    return (buf, o) => buf.readInt32LE(o) / scale;
  }
  if (audioFormat === 3 && bitsPerSample === 32) {
    return (buf, o) => buf.readFloatLE(o);
  }
  return undefined;
}

export async function readRenderMetadata(path: string): Promise<RenderMetadata> {
  let stat;
  try {
    stat = await fsp.stat(path);
  } catch {
    cached = undefined;
    return { exists: false };
  }
  if (!stat.isFile()) {
    cached = undefined;
    return { exists: false };
  }
  if (
    cached &&
    cached.key.path === path &&
    cached.key.mtimeMs === stat.mtimeMs &&
    cached.key.size === stat.size
  ) {
    return cached.meta;
  }
  let analysis;
  try {
    analysis = await analyseWav(path);
  } catch {
    // Header malformed or unsupported format: return a minimal "exists"
    // record so the UI can still link to the WAV via <audio>. Better to
    // play and let the browser surface a decode error than to claim no
    // artifact is present.
    const meta: RenderMetadata = {
      exists: true,
      sizeBytes: stat.size,
      updatedAt: stat.mtime.toISOString(),
      url: '/api/renders/latest.wav',
    };
    cached = { key: { path, mtimeMs: stat.mtimeMs, size: stat.size }, meta };
    return meta;
  }
  const meta: RenderMetadata = {
    exists: true,
    durationSec: round(analysis.durationSec, 3),
    peakDb: roundDb(analysis.peakDb),
    rmsDb: roundDb(analysis.rmsDb),
    sampleRate: analysis.sampleRate,
    bitDepth: analysis.bitsPerSample,
    channels: analysis.channels,
    sizeBytes: stat.size,
    updatedAt: stat.mtime.toISOString(),
    url: '/api/renders/latest.wav',
  };
  cached = { key: { path, mtimeMs: stat.mtimeMs, size: stat.size }, meta };
  return meta;
}

// Reset the metadata cache. Exposed so tests don't carry state between specs.
export function resetRenderMetadataCache(): void {
  cached = undefined;
}

interface WavAnalysis {
  readonly sampleRate: number;
  readonly channels: number;
  readonly bitsPerSample: number;
  readonly durationSec: number;
  readonly peakDb: number;
  readonly rmsDb: number;
}

// Lightweight PCM WAV analyzer — mirrors apps/engine-spike/scripts/check-wav.mjs
// but reads the file as a buffer in one shot. The engine-spike artifact is
// ~55 MB at 210 s / 24-bit / 44.1k stereo, well within node's default
// buffer limits; the result is cached so this only runs on mtime drift.
async function analyseWav(path: string): Promise<WavAnalysis> {
  const buf = await fsp.readFile(path);
  if (buf.length < 44) throw new Error(`wav too small: ${buf.length} bytes`);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE')
    throw new Error('not a RIFF/WAVE file');

  let offset = 12;
  let fmt: { audioFormat: number; channels: number; sampleRate: number; bitsPerSample: number } | undefined;
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

  const { channels, sampleRate, bitsPerSample, audioFormat } = fmt;
  if (channels < 1) throw new Error(`bad channel count: ${channels}`);
  if (sampleRate <= 0) throw new Error(`bad sample rate: ${sampleRate}`);

  const bytesPerSample = bitsPerSample / 8;
  const bytesPerFrame = bytesPerSample * channels;
  const frameCount = Math.floor(dataSize / bytesPerFrame);
  const durationSec = frameCount / sampleRate;

  let readSample: (offset: number) => number;
  let scale: number;
  if (audioFormat === 1 && bitsPerSample === 16) {
    readSample = (o) => buf.readInt16LE(o);
    scale = 1 << 15;
  } else if (audioFormat === 1 && bitsPerSample === 24) {
    readSample = (o) => {
      const b0 = buf[o]!;
      const b1 = buf[o + 1]!;
      const b2 = buf[o + 2]!;
      const v = (b2 << 16) | (b1 << 8) | b0;
      return v & 0x800000 ? v | 0xff000000 : v;
    };
    scale = 1 << 23;
  } else if (audioFormat === 1 && bitsPerSample === 32) {
    readSample = (o) => buf.readInt32LE(o);
    scale = 2 ** 31;
  } else if (audioFormat === 3 && bitsPerSample === 32) {
    readSample = (o) => buf.readFloatLE(o) * 2 ** 31;
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
    durationSec,
    peakDb: peakNorm > 0 ? 20 * Math.log10(peakNorm) : Number.NEGATIVE_INFINITY,
    rmsDb: rms > 0 ? 20 * Math.log10(rms) : Number.NEGATIVE_INFINITY,
  };
}

function round(value: number, decimals: number): number {
  const m = 10 ** decimals;
  return Math.round(value * m) / m;
}

function roundDb(value: number): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  return round(value, 2);
}
