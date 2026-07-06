// Per-slot audio slicer — docs/54l.
//
// Companion to audio-normalize.mjs (docs/54i). Where audio-normalize.mjs
// transcodes a whole source into a single Ogg-Vorbis cached file, this
// module slices a sub-range out of a source and transcodes that one
// slice into a cached Ogg. Cache key includes the slice boundaries so
// the 17 piano slices of one preset get 17 distinct cache entries.
//
// Used by the multisample-staging pipeline that mirrors the legacy
// vstSamples.controller.create + mp3split step (casperaki2-engine-js/
// api/v1.0/controllers/vstSamples.js:307-323) — the Dropbox library's
// canonical preset MP3 IS the rendered chromatic-scale `.rpp` file's
// MP3 output. We slice it at the same boundaries the legacy mp3splt
// would have used.
//
// Contract:
//   prepareNormalizedSlice({ sourcePath, sliceStart, sliceEnd, cacheDir, … }) →
//     | { kind: 'transcoded',  preparedPath, sourceFormat, cached, byteSize }
//     | { kind: 'no-ffmpeg',   error,        sourceFormat }
//     | { kind: 'error',       error,        sourceFormat }
//
// Unlike the whole-source normaliser, there is no `copy` branch — even
// when the source is already .ogg or .wav we still re-encode the slice
// because the engine sampler reads `vstsample-<id>.ogg` and expects
// one Ogg-Vorbis file per slot. (For one-off canonical staging without
// slicing, use audio-normalize.mjs.)

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, join, resolve as resolvePath } from 'node:path';

import { classifyByExtension } from './audio-normalize.mjs';

/**
 * @typedef {{
 *   kind: 'transcoded';
 *   preparedPath: string;
 *   sourceFormat: import('./audio-normalize.mjs').SourceFormat;
 *   cached: boolean;
 *   byteSize: number;
 * } | {
 *   kind: 'no-ffmpeg';
 *   sourceFormat: import('./audio-normalize.mjs').SourceFormat;
 *   error: string;
 * } | {
 *   kind: 'error';
 *   sourceFormat: import('./audio-normalize.mjs').SourceFormat;
 *   error: string;
 * }} SliceResult
 */

/**
 * Parse a legacy mp3splt timing string `MM.SS[.HH]` (hundredths of seconds)
 * into a floating-point seconds value. Examples:
 *   "00.00"      → 0.0
 *   "00.04.80"   → 4.80
 *   "01.21.60"   → 81.60
 *   "00.34.50"   → 34.50
 *
 * The format is anchored at minutes; the second `.` separates seconds
 * from hundredths. (mp3splt's `-t` accepts the same format, so the JSON
 * timing strings can be passed verbatim to it.)
 *
 * @param {string} ts
 * @returns {number} seconds (≥ 0)
 */
export function parseMmSsHh(ts) {
  if (typeof ts !== 'string') {
    throw new TypeError(`parseMmSsHh: expected string, got ${typeof ts}`);
  }
  const m = ts.match(/^(\d{1,3})\.(\d{1,2})(?:\.(\d{1,2}))?$/u);
  if (!m) {
    throw new RangeError(`parseMmSsHh: cannot parse "${ts}" (expected MM.SS[.HH])`);
  }
  const minutes = Number.parseInt(m[1], 10);
  const seconds = Number.parseInt(m[2], 10);
  // Hundredths: a 1-digit value means tenths-of-a-second; mp3splt's
  // own format pads to 2 digits (HH = 0..99). Treat "8" as 80
  // hundredths-of-a-second to match the legacy splitter.
  const hhRaw = m[3];
  let hundredths = 0;
  if (hhRaw !== undefined) {
    hundredths =
      hhRaw.length === 1
        ? Number.parseInt(hhRaw, 10) * 10
        : Number.parseInt(hhRaw, 10);
  }
  return minutes * 60 + seconds + hundredths / 100;
}

/**
 * Deterministic cache filename for a slice. Keyed on absolute source
 * path, mtime + size (so a sample swap invalidates), and the slice
 * boundaries in milliseconds (so the 17 piano slices share their
 * canonical source but each get their own cache entry).
 *
 * @param {{ sourcePath: string; size: number; mtimeMs: number; startSec: number; endSec: number; targetFormat?: 'ogg' | 'wav' }} input
 * @returns {string} cache filename (relative — caller joins with cacheDir)
 */
export function sliceCacheKey({ sourcePath, size, mtimeMs, startSec, endSec, targetFormat = 'ogg' }) {
  const abs = resolvePath(sourcePath);
  let h = 0x811c9dc5;
  for (let i = 0; i < abs.length; i++) {
    h ^= abs.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const hex = (h >>> 0).toString(16).padStart(8, '0');
  const safeBase = basename(sourcePath).replace(/[^A-Za-z0-9._-]/gu, '_');
  const startMs = Math.round(startSec * 1000);
  const endMs = Math.round(endSec * 1000);
  return `${safeBase}.${hex}.${size}.${Math.round(mtimeMs)}.slice-${startMs}-${endMs}.${targetFormat}`;
}

/**
 * Build the deterministic ffmpeg argv for a slice transcode.
 *   ffmpeg -y -hide_banner -loglevel error
 *     -i <source>
 *     -ss <start> -to <end>      # output-side seek + end (re-encoded for accuracy)
 *     -ac 2 -ar 44100 -c:a libvorbis -q:a 5
 *     <preparedPath>
 *
 * `-ss <start> -i <source>` (input seek before -i) is fast but coarse on
 * mp3s — placing -ss and -to AFTER -i forces frame-accurate decoding,
 * which is what mp3splt did. The slice boundaries from the legacy JSON
 * are at hundredths-of-a-second precision; we honour that.
 *
 * @param {{ sourcePath: string; preparedPath: string; startSec: number; endSec: number; targetFormat?: 'ogg' | 'wav' }} opts
 * @returns {string[]}
 */
export function buildSliceFfmpegArgs({ sourcePath, preparedPath, startSec, endSec, targetFormat = 'ogg' }) {
  if (!(endSec > startSec)) {
    throw new RangeError(`buildSliceFfmpegArgs: endSec (${endSec}) must be > startSec (${startSec})`);
  }
  const tail =
    targetFormat === 'wav'
      ? ['-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le']
      : ['-ac', '2', '-ar', '44100', '-c:a', 'libvorbis', '-q:a', '5'];
  return [
    '-y',
    '-hide_banner',
    '-loglevel', 'error',
    '-i', sourcePath,
    '-ss', startSec.toFixed(3),
    '-to', endSec.toFixed(3),
    ...tail,
    preparedPath,
  ];
}

/**
 * Prepare a sliced sample source. Slices [startSec, endSec) out of the
 * source via ffmpeg + caches the result keyed on (source + slice).
 *
 * @param {{
 *   sourcePath: string;
 *   sliceStart: number;
 *   sliceEnd: number;
 *   cacheDir: string;
 *   ffmpegPath?: string;
 *   targetFormat?: 'ogg' | 'wav';
 *   runFfmpeg?: (ffmpegPath: string, args: readonly string[]) => void;
 *   fileExists?: (path: string) => boolean;
 *   stat?: (path: string) => { size: number; mtimeMs: number };
 *   ensureDir?: (path: string) => void;
 *   ffmpegLookup?: () => string | undefined;
 * }} opts
 * @returns {SliceResult}
 */
export function prepareNormalizedSlice(opts) {
  const {
    sourcePath,
    sliceStart,
    sliceEnd,
    cacheDir,
    targetFormat = 'ogg',
    fileExists = existsSync,
    stat = (p) => {
      const s = statSync(p);
      return { size: s.size, mtimeMs: s.mtimeMs };
    },
    ensureDir = (p) => mkdirSync(p, { recursive: true }),
    ffmpegLookup = defaultFfmpegLookup,
    runFfmpeg = defaultRunFfmpeg,
  } = opts;

  const sourceFormat = classifyByExtension(sourcePath);

  if (!(sliceEnd > sliceStart)) {
    return {
      kind: 'error',
      sourceFormat,
      error: `slice end (${sliceEnd}s) must be > start (${sliceStart}s)`,
    };
  }
  if (!fileExists(sourcePath)) {
    return {
      kind: 'error',
      sourceFormat,
      error: `source ${sourcePath} not found`,
    };
  }

  const ffmpegPath = opts.ffmpegPath ?? ffmpegLookup();
  if (!ffmpegPath) {
    return {
      kind: 'no-ffmpeg',
      sourceFormat,
      error:
        'ffmpeg not found on PATH; cannot slice source. ' +
        'Install ffmpeg or fall back by unsetting CASPERAKI_SAMPLE_LIBRARY_ROOT.',
    };
  }

  const s = stat(sourcePath);
  const key = sliceCacheKey({
    sourcePath,
    size: s.size,
    mtimeMs: s.mtimeMs,
    startSec: sliceStart,
    endSec: sliceEnd,
    targetFormat,
  });
  ensureDir(cacheDir);
  const preparedPath = join(cacheDir, key);

  if (fileExists(preparedPath)) {
    const cs = stat(preparedPath);
    if (cs.size > 0) {
      return {
        kind: 'transcoded',
        preparedPath,
        sourceFormat,
        cached: true,
        byteSize: cs.size,
      };
    }
  }

  // Write to a temp sibling and atomically rename on success, so a
  // killed/crashed ffmpeg can't leave a truncated file that the
  // `fileExists && size>0` check above would treat as a permanent cache hit.
  const tmpPath = `${preparedPath}.tmp`;
  const args = buildSliceFfmpegArgs({
    sourcePath,
    preparedPath: tmpPath,
    startSec: sliceStart,
    endSec: sliceEnd,
    targetFormat,
  });
  try {
    runFfmpeg(ffmpegPath, args);
  } catch (err) {
    rmSync(tmpPath, { force: true });
    const msg = err instanceof Error ? err.message : String(err);
    return {
      kind: 'error',
      sourceFormat,
      error: `ffmpeg slice transcode failed: ${msg}`,
    };
  }

  if (!fileExists(tmpPath)) {
    return {
      kind: 'error',
      sourceFormat,
      error: `ffmpeg ran but no slice output at ${preparedPath}`,
    };
  }
  const outStat = stat(tmpPath);
  if (outStat.size === 0) {
    rmSync(tmpPath, { force: true });
    return {
      kind: 'error',
      sourceFormat,
      error: `ffmpeg produced an empty slice at ${preparedPath}`,
    };
  }
  renameSync(tmpPath, preparedPath);
  return {
    kind: 'transcoded',
    preparedPath,
    sourceFormat,
    cached: false,
    byteSize: outStat.size,
  };
}

/**
 * Format the per-slice log line.
 * @param {SliceResult} result
 * @param {string} sourcePath
 * @param {number} startSec
 * @param {number} endSec
 */
export function formatSliceLog(result, sourcePath, startSec, endSec) {
  const span = `[${startSec.toFixed(2)}, ${endSec.toFixed(2)}]s`;
  switch (result.kind) {
    case 'transcoded':
      return (
        `[normalize] ${result.sourceFormat} slice ${sourcePath} ${span} ` +
        `→ ${result.cached ? 'cache-hit' : 'cache-miss; ffmpeg-slice'} ` +
        `cache=${result.preparedPath} (${result.byteSize} B)`
      );
    case 'no-ffmpeg':
      return `[normalize] ${result.sourceFormat} slice ${sourcePath} ${span} → NO-FFMPEG ${result.error}`;
    case 'error':
      return `[normalize] ${result.sourceFormat} slice ${sourcePath} ${span} → ERROR ${result.error}`;
  }
}

function defaultFfmpegLookup() {
  try {
    const out = execFileSync('which', ['ffmpeg'], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

function defaultRunFfmpeg(ffmpegPath, args) {
  execFileSync(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
}
