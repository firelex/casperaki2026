// Audio normalisation helper — docs/54i.
//
// Exercises the pure decision logic (extension classification, copy vs.
// transcode), the cache-key contract, and the ffmpeg-missing fall-back
// behaviour. ffmpeg invocations are mocked via the `runFfmpeg` /
// `ffmpegLookup` seams so the test suite stays hermetic.

import { mkdtemp, rm, writeFile, mkdir, stat } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import {
  buildFfmpegArgs,
  cacheKey,
  classifyByExtension,
  decideNormalizationAction,
  formatNormalizationLog,
  prepareNormalizedSource,
} from '../scripts/lib/audio-normalize.mjs';

interface Harness {
  tmp: string;
  cacheDir: string;
  cleanup: () => Promise<void>;
}

async function setup(): Promise<Harness> {
  const tmp = await mkdtemp(join(tmpdir(), 'casperaki-normalize-'));
  const cacheDir = join(tmp, 'cache');
  await mkdir(cacheDir, { recursive: true });
  return {
    tmp,
    cacheDir,
    cleanup: () => rm(tmp, { recursive: true, force: true }),
  };
}

describe('classifyByExtension', () => {
  it('recognises engine-native and convertible formats', () => {
    expect(classifyByExtension('/a/b.ogg')).toBe('ogg');
    expect(classifyByExtension('/a/b.OGA')).toBe('ogg');
    expect(classifyByExtension('/a/b.wav')).toBe('wav');
    expect(classifyByExtension('/a/b.WAVE')).toBe('wav');
    expect(classifyByExtension('/a/b.mp3')).toBe('mp3');
    expect(classifyByExtension('/a/b.flac')).toBe('flac');
    expect(classifyByExtension('/a/b.aiff')).toBe('aiff');
    expect(classifyByExtension('/a/b.aif')).toBe('aiff');
    expect(classifyByExtension('/a/b.opus')).toBe('unknown');
    expect(classifyByExtension('/a/b')).toBe('unknown');
  });
});

describe('decideNormalizationAction', () => {
  it('copies engine-native formats and transcodes the rest', () => {
    expect(decideNormalizationAction('/a/b.ogg')).toEqual({
      action: 'copy',
      sourceFormat: 'ogg',
    });
    expect(decideNormalizationAction('/a/b.wav')).toEqual({
      action: 'copy',
      sourceFormat: 'wav',
    });
    expect(decideNormalizationAction('/a/b.mp3')).toEqual({
      action: 'transcode',
      sourceFormat: 'mp3',
    });
    expect(decideNormalizationAction('/a/b.flac')).toEqual({
      action: 'transcode',
      sourceFormat: 'flac',
    });
    expect(decideNormalizationAction('/a/b.aiff')).toEqual({
      action: 'transcode',
      sourceFormat: 'aiff',
    });
    expect(decideNormalizationAction('/a/b')).toEqual({
      action: 'transcode',
      sourceFormat: 'unknown',
    });
  });
});

describe('cacheKey', () => {
  it('is deterministic for the same (path, size, mtime, target)', () => {
    const a = cacheKey({
      sourcePath: '/abs/sample.mp3',
      size: 12345,
      mtimeMs: 1_700_000_000_123,
    });
    const b = cacheKey({
      sourcePath: '/abs/sample.mp3',
      size: 12345,
      mtimeMs: 1_700_000_000_123,
    });
    expect(a).toBe(b);
    expect(a).toMatch(/sample\.mp3\.[0-9a-f]{8}\.12345\.1700000000123\.ogg$/u);
  });

  it('changes when the source size or mtime changes', () => {
    const base = cacheKey({ sourcePath: '/x.mp3', size: 10, mtimeMs: 1 });
    const sizeChanged = cacheKey({ sourcePath: '/x.mp3', size: 11, mtimeMs: 1 });
    const mtimeChanged = cacheKey({ sourcePath: '/x.mp3', size: 10, mtimeMs: 2 });
    expect(base).not.toBe(sizeChanged);
    expect(base).not.toBe(mtimeChanged);
  });

  it('escapes unsafe characters in the basename', () => {
    const key = cacheKey({
      sourcePath: '/lib/some spaced & path/Bass (1).mp3',
      size: 1,
      mtimeMs: 1,
    });
    expect(key).not.toContain(' ');
    expect(key).not.toContain('(');
    expect(key).not.toContain('&');
  });

  it('targetFormat is encoded in the filename', () => {
    const wav = cacheKey({
      sourcePath: '/a.mp3',
      size: 1,
      mtimeMs: 1,
      targetFormat: 'wav',
    });
    expect(wav.endsWith('.wav')).toBe(true);
  });
});

describe('buildFfmpegArgs', () => {
  it('targets Ogg-Vorbis by default with 2ch / 44.1kHz', () => {
    const args = buildFfmpegArgs({
      sourcePath: '/src.mp3',
      preparedPath: '/cache/out.ogg',
      targetFormat: 'ogg',
    });
    expect(args).toContain('libvorbis');
    expect(args).toContain('-q:a');
    expect(args).toContain('/src.mp3');
    expect(args[args.length - 1]).toBe('/cache/out.ogg');
    expect(args).toContain('44100');
    // Deterministic overwrite.
    expect(args).toContain('-y');
  });

  it('targets PCM WAV when targetFormat is wav', () => {
    const args = buildFfmpegArgs({
      sourcePath: '/src.mp3',
      preparedPath: '/cache/out.wav',
      targetFormat: 'wav',
    });
    expect(args).toContain('pcm_s16le');
    expect(args[args.length - 1]).toBe('/cache/out.wav');
  });
});

describe('prepareNormalizedSource', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it('copies .ogg sources without invoking ffmpeg', async () => {
    const src = join(h.tmp, 'fixture.ogg');
    await writeFile(src, 'ogg-bytes');
    let invoked = false;
    const result = prepareNormalizedSource({
      sourcePath: src,
      cacheDir: h.cacheDir,
      ffmpegPath: '/nope/ffmpeg',
      runFfmpeg: () => {
        invoked = true;
      },
    });
    expect(invoked).toBe(false);
    expect(result.kind).toBe('copy');
    if (result.kind === 'copy') {
      expect(result.preparedPath).toBe(src);
      expect(result.sourceFormat).toBe('ogg');
      expect(result.byteSize).toBe('ogg-bytes'.length);
    }
  });

  it('copies .wav sources without invoking ffmpeg', async () => {
    const src = join(h.tmp, 'fixture.wav');
    await writeFile(src, 'RIFFwav-bytes');
    let invoked = false;
    const result = prepareNormalizedSource({
      sourcePath: src,
      cacheDir: h.cacheDir,
      ffmpegPath: '/nope/ffmpeg',
      runFfmpeg: () => {
        invoked = true;
      },
    });
    expect(invoked).toBe(false);
    expect(result.kind).toBe('copy');
    if (result.kind === 'copy') {
      expect(result.sourceFormat).toBe('wav');
    }
  });

  it('transcodes .mp3 sources via ffmpeg and writes the cached output', async () => {
    const src = join(h.tmp, 'BA Trancy Bass.mp3');
    await writeFile(src, 'mp3-bytes');
    let lastArgs: readonly string[] = [];
    let lastBin = '';
    const result = prepareNormalizedSource({
      sourcePath: src,
      cacheDir: h.cacheDir,
      ffmpegPath: '/usr/bin/ffmpeg',
      runFfmpeg: (bin, args) => {
        lastBin = bin;
        lastArgs = args;
        const outPath = args[args.length - 1];
        writeFileSync(outPath, 'transcoded-ogg-bytes');
      },
    });
    expect(lastBin).toBe('/usr/bin/ffmpeg');
    expect(lastArgs).toContain('libvorbis');
    expect(result.kind).toBe('transcoded');
    if (result.kind === 'transcoded') {
      expect(result.cached).toBe(false);
      expect(result.preparedPath.startsWith(h.cacheDir)).toBe(true);
      expect(result.preparedPath).toMatch(/\.ogg$/u);
      const st = await stat(result.preparedPath);
      expect(st.size).toBe('transcoded-ogg-bytes'.length);
    }
  });

  it('returns kind=no-ffmpeg when ffmpeg is missing AND the source needs transcode', async () => {
    const src = join(h.tmp, 'sample.mp3');
    await writeFile(src, 'mp3-bytes');
    const result = prepareNormalizedSource({
      sourcePath: src,
      cacheDir: h.cacheDir,
      ffmpegLookup: () => undefined,
      runFfmpeg: () => {
        throw new Error('should not invoke ffmpeg');
      },
    });
    expect(result.kind).toBe('no-ffmpeg');
    if (result.kind === 'no-ffmpeg') {
      expect(result.sourceFormat).toBe('mp3');
      expect(result.error).toMatch(/ffmpeg not found/u);
    }
  });

  it('still copies a .ogg source when ffmpeg is absent (no transcode needed)', async () => {
    const src = join(h.tmp, 'fixture.ogg');
    await writeFile(src, 'ogg-bytes');
    const result = prepareNormalizedSource({
      sourcePath: src,
      cacheDir: h.cacheDir,
      ffmpegLookup: () => undefined,
    });
    expect(result.kind).toBe('copy');
  });

  it('reuses a cached transcode on a second call (cached=true, ffmpeg not re-invoked)', async () => {
    const src = join(h.tmp, 'sample.mp3');
    await writeFile(src, 'mp3-bytes');
    let invocations = 0;
    const opts = {
      sourcePath: src,
      cacheDir: h.cacheDir,
      ffmpegPath: '/usr/bin/ffmpeg',
      runFfmpeg: (_bin: string, args: readonly string[]) => {
        invocations++;
        writeFileSync(args[args.length - 1], 'cached-ogg-bytes');
      },
    } as const;
    const first = prepareNormalizedSource(opts);
    expect(first.kind).toBe('transcoded');
    if (first.kind === 'transcoded') expect(first.cached).toBe(false);

    const second = prepareNormalizedSource(opts);
    expect(invocations).toBe(1);
    expect(second.kind).toBe('transcoded');
    if (second.kind === 'transcoded') {
      expect(second.cached).toBe(true);
      expect(second.preparedPath).toBe(
        (first as { preparedPath: string }).preparedPath,
      );
    }
  });

  it('returns kind=error when ffmpeg throws', async () => {
    const src = join(h.tmp, 'sample.mp3');
    await writeFile(src, 'mp3-bytes');
    const result = prepareNormalizedSource({
      sourcePath: src,
      cacheDir: h.cacheDir,
      ffmpegPath: '/usr/bin/ffmpeg',
      runFfmpeg: () => {
        throw new Error('boom');
      },
    });
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.error).toMatch(/boom/u);
    }
  });

  it('returns kind=error when the source path does not exist', () => {
    const result = prepareNormalizedSource({
      sourcePath: join(h.tmp, 'nope.mp3'),
      cacheDir: h.cacheDir,
      ffmpegPath: '/usr/bin/ffmpeg',
      runFfmpeg: () => {
        throw new Error('should not run');
      },
    });
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.error).toMatch(/not found/u);
    }
  });
});

describe('formatNormalizationLog', () => {
  it('renders the copy / transcode / no-ffmpeg / error shapes', () => {
    expect(
      formatNormalizationLog(
        {
          kind: 'copy',
          preparedPath: '/p/x.ogg',
          sourceFormat: 'ogg',
          cached: false,
          byteSize: 42,
        },
        '/p/x.ogg',
      ),
    ).toMatch(/copy/u);
    expect(
      formatNormalizationLog(
        {
          kind: 'transcoded',
          preparedPath: '/p/x.ogg',
          sourceFormat: 'mp3',
          cached: true,
          byteSize: 100,
        },
        '/src.mp3',
      ),
    ).toMatch(/cache-hit/u);
    expect(
      formatNormalizationLog(
        {
          kind: 'transcoded',
          preparedPath: '/p/x.ogg',
          sourceFormat: 'mp3',
          cached: false,
          byteSize: 100,
        },
        '/src.mp3',
      ),
    ).toMatch(/cache-miss; transcode/u);
    expect(
      formatNormalizationLog(
        { kind: 'no-ffmpeg', sourceFormat: 'mp3', error: 'missing' },
        '/src.mp3',
      ),
    ).toMatch(/NO-FFMPEG/u);
    expect(
      formatNormalizationLog(
        { kind: 'error', sourceFormat: 'mp3', error: 'boom' },
        '/src.mp3',
      ),
    ).toMatch(/ERROR/u);
  });
});
