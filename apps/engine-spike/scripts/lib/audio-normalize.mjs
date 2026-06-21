// Audio normalisation helper — docs/54i (format-normalisation slice).
//
// The Bass real-sample bridge (docs/54h) resolves the brain-selected
// Bass catalog row to a real sample-library file and copies its bytes
// into the engine's `vstsample-<id>.ogg` slots. The catalog's canonical
// Bass file is almost always an `.mp3`; the engine's JUCE/Tracktion
// `AudioFormatManager` sniffs file *contents*, not the `.ogg` extension,
// so byte-copying mp3 bytes into a `.ogg` filename only works if the
// pinned JUCE build was compiled with `JUCE_USE_MP3AUDIOFORMAT=1`. On
// the operator's stack it isn't — Tracktion errors at render time.
//
// This helper normalises the resolved source into a format Tracktion
// reliably decodes (Ogg-Vorbis) *before* prestage-samples.mjs writes
// the `vstsample-<id>.ogg` files. The decision is pure (extension-
// based) and the transcode shells out to `ffmpeg`. The transcoded
// bytes are cached on disk keyed on `(source-abs-path, size, mtime)`
// so the 16 Bass ids share one transcode and re-runs are idempotent.
//
// Contract:
//   prepareNormalizedSource({ sourcePath, cacheDir, … }) →
//     | { kind: 'copy',        preparedPath, sourceFormat: 'ogg' | 'wav', cached: false, byteSize }
//     | { kind: 'transcoded',  preparedPath, sourceFormat,                cached, byteSize }
//     | { kind: 'no-ffmpeg',   error,        sourceFormat }
//     | { kind: 'error',       error,        sourceFormat }
//
// The prestage script then copies `preparedPath` over every
// `vstsample-<id>.ogg`. When the kind is `no-ffmpeg` or `error`, the
// caller is expected to log loudly and fall back to the bundled fixture
// (the fixture is already a real .ogg, so it normalises trivially via
// the `copy` branch).

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  statSync,
} from 'node:fs';
import { basename, extname, join, resolve as resolvePath } from 'node:path';

/**
 * Recognised source formats. Anything else is treated as "unknown" and
 * routed through the transcode path (ffmpeg figures it out from the
 * file header — we don't try to be cleverer than libavformat).
 *
 * @typedef {'ogg' | 'wav' | 'mp3' | 'flac' | 'aiff' | 'unknown'} SourceFormat
 */

/**
 * @typedef {{
 *   kind: 'copy';
 *   preparedPath: string;
 *   sourceFormat: 'ogg' | 'wav';
 *   cached: false;
 *   byteSize: number;
 * } | {
 *   kind: 'transcoded';
 *   preparedPath: string;
 *   sourceFormat: SourceFormat;
 *   cached: boolean;
 *   byteSize: number;
 * } | {
 *   kind: 'no-ffmpeg';
 *   sourceFormat: SourceFormat;
 *   error: string;
 * } | {
 *   kind: 'error';
 *   sourceFormat: SourceFormat;
 *   error: string;
 * }} NormalizationResult
 */

const ENGINE_NATIVE_FORMATS = new Set(['ogg', 'wav']);

/**
 * Map a file extension to one of our recognised source formats. Lower-
 * cased, leading "." stripped.
 *
 * @param {string} sourcePath
 * @returns {SourceFormat}
 */
export function classifyByExtension(sourcePath) {
  const ext = extname(sourcePath).toLowerCase().replace(/^\./u, '');
  switch (ext) {
    case 'ogg':
    case 'oga':
      return 'ogg';
    case 'wav':
    case 'wave':
      return 'wav';
    case 'mp3':
      return 'mp3';
    case 'flac':
      return 'flac';
    case 'aif':
    case 'aiff':
      return 'aiff';
    default:
      return 'unknown';
  }
}

/**
 * Decide whether a given source path can be copied as-is or needs a
 * transcode pass before being staged as `vstsample-<id>.ogg`.
 *
 * Tracktion/JUCE registers WAV / AIFF / FLAC / Ogg-Vorbis on the pinned
 * stack. AIFF and FLAC would decode fine if dropped into a `.ogg`
 * filename (AudioFormatManager content-detects), but the bridge's
 * single-source-pitch-shifted-across-16-ids contract is happier with a
 * tight Ogg-Vorbis on disk — so we normalise everything that isn't
 * already Ogg or WAV through ffmpeg.
 *
 * @param {string} sourcePath
 * @returns {{ action: 'copy' | 'transcode'; sourceFormat: SourceFormat }}
 */
export function decideNormalizationAction(sourcePath) {
  const sourceFormat = classifyByExtension(sourcePath);
  if (ENGINE_NATIVE_FORMATS.has(sourceFormat)) {
    return { action: 'copy', sourceFormat };
  }
  return { action: 'transcode', sourceFormat };
}

/**
 * Compute the deterministic cache filename for a transcoded source.
 * Key on (absolute source path, byte size, mtime ms) so:
 *  - the cache invalidates when the catalog sample is replaced on disk;
 *  - re-running prestage with the same library is a no-op (skipped-cached);
 *  - multiple Bass kits sharing a source hit the same cached file.
 *
 * @param {{ sourcePath: string; size: number; mtimeMs: number; targetFormat?: 'ogg' | 'wav' }} input
 * @returns {string} cache filename (relative — caller joins with cacheDir)
 */
export function cacheKey({ sourcePath, size, mtimeMs, targetFormat = 'ogg' }) {
  const abs = resolvePath(sourcePath);
  // 32-bit FNV-1a is plenty to disambiguate per-source; collisions are
  // not security-sensitive here — they would only mean the wrong cache
  // entry survives a sample swap, which the (size, mtime) suffix already
  // disambiguates further.
  let h = 0x811c9dc5;
  for (let i = 0; i < abs.length; i++) {
    h ^= abs.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const hex = (h >>> 0).toString(16).padStart(8, '0');
  const safeBase = basename(sourcePath).replace(/[^A-Za-z0-9._-]/gu, '_');
  return `${safeBase}.${hex}.${size}.${Math.round(mtimeMs)}.${targetFormat}`;
}

/**
 * Prepare a sample source for staging.
 *
 * @param {{
 *   sourcePath: string;
 *   cacheDir: string;
 *   ffmpegPath?: string;
 *   targetFormat?: 'ogg' | 'wav';
 *   runFfmpeg?: (ffmpegPath: string, args: readonly string[]) => void;
 *   fileExists?: (path: string) => boolean;
 *   stat?: (path: string) => { size: number; mtimeMs: number };
 *   ensureDir?: (path: string) => void;
 *   ffmpegLookup?: () => string | undefined;
 * }} opts
 * @returns {NormalizationResult}
 */
export function prepareNormalizedSource(opts) {
  const {
    sourcePath,
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

  const { action, sourceFormat } = decideNormalizationAction(sourcePath);

  if (action === 'copy') {
    if (!fileExists(sourcePath)) {
      return {
        kind: 'error',
        sourceFormat,
        error: `source ${sourcePath} not found`,
      };
    }
    const s = stat(sourcePath);
    return {
      kind: 'copy',
      preparedPath: sourcePath,
      sourceFormat: /** @type {'ogg' | 'wav'} */ (sourceFormat),
      cached: false,
      byteSize: s.size,
    };
  }

  // Transcode path.
  const ffmpegPath = opts.ffmpegPath ?? ffmpegLookup();
  if (!ffmpegPath) {
    return {
      kind: 'no-ffmpeg',
      sourceFormat,
      error:
        'ffmpeg not found on PATH; cannot transcode non-Ogg/Wav source. ' +
        'Install ffmpeg or fall back by unsetting CASPERAKI_SAMPLE_LIBRARY_ROOT.',
    };
  }
  if (!fileExists(sourcePath)) {
    return {
      kind: 'error',
      sourceFormat,
      error: `source ${sourcePath} not found`,
    };
  }

  const s = stat(sourcePath);
  const key = cacheKey({
    sourcePath,
    size: s.size,
    mtimeMs: s.mtimeMs,
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

  const args = buildFfmpegArgs({
    sourcePath,
    preparedPath,
    targetFormat,
  });
  try {
    runFfmpeg(ffmpegPath, args);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      kind: 'error',
      sourceFormat,
      error: `ffmpeg transcode failed: ${msg}`,
    };
  }

  if (!fileExists(preparedPath)) {
    return {
      kind: 'error',
      sourceFormat,
      error: `ffmpeg ran but no output produced at ${preparedPath}`,
    };
  }
  const outStat = stat(preparedPath);
  if (outStat.size === 0) {
    return {
      kind: 'error',
      sourceFormat,
      error: `ffmpeg produced an empty file at ${preparedPath}`,
    };
  }
  return {
    kind: 'transcoded',
    preparedPath,
    sourceFormat,
    cached: false,
    byteSize: outStat.size,
  };
}

/**
 * Build the deterministic ffmpeg argv. Exported for tests.
 *
 * @param {{ sourcePath: string; preparedPath: string; targetFormat: 'ogg' | 'wav' }} opts
 * @returns {string[]}
 */
export function buildFfmpegArgs({ sourcePath, preparedPath, targetFormat }) {
  if (targetFormat === 'wav') {
    return [
      '-y',
      '-hide_banner',
      '-loglevel', 'error',
      '-i', sourcePath,
      '-ac', '2',
      '-ar', '44100',
      '-c:a', 'pcm_s16le',
      preparedPath,
    ];
  }
  return [
    '-y',
    '-hide_banner',
    '-loglevel', 'error',
    '-i', sourcePath,
    '-ac', '2',
    '-ar', '44100',
    '-c:a', 'libvorbis',
    '-q:a', '5',
    preparedPath,
  ];
}

/**
 * Format the per-source normalisation log line, matching the
 * `[normalize] <source-format> → <action> <preparedPath> (<bytes> B<,cached>)`
 * shape the prestage script writes to stderr.
 *
 * @param {NormalizationResult} result
 * @param {string} sourcePath
 * @returns {string}
 */
export function formatNormalizationLog(result, sourcePath) {
  switch (result.kind) {
    case 'copy':
      return (
        `[normalize] ${result.sourceFormat} source ${sourcePath} ` +
        `→ copy (no transcode needed) cache=${result.preparedPath} (${result.byteSize} B)`
      );
    case 'transcoded':
      return (
        `[normalize] ${result.sourceFormat} source ${sourcePath} ` +
        `→ ${result.cached ? 'cache-hit' : 'cache-miss; transcode'} ` +
        `cache=${result.preparedPath} (${result.byteSize} B)`
      );
    case 'no-ffmpeg':
      return (
        `[normalize] ${result.sourceFormat} source ${sourcePath} ` +
        `→ NO-FFMPEG ${result.error}`
      );
    case 'error':
      return (
        `[normalize] ${result.sourceFormat} source ${sourcePath} ` +
        `→ ERROR ${result.error}`
      );
  }
}

/**
 * Default ffmpeg discovery — checks the PATH via `which` (Linux/macOS).
 * Returns the absolute path or undefined when ffmpeg is not available.
 *
 * @returns {string | undefined}
 */
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

/**
 * @param {string} ffmpegPath
 * @param {readonly string[]} args
 */
function defaultRunFfmpeg(ffmpegPath, args) {
  execFileSync(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
}
