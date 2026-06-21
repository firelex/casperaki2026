// docs/54l audio-slice helper specs.

import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import {
  buildSliceFfmpegArgs,
  formatSliceLog,
  parseMmSsHh,
  prepareNormalizedSlice,
  sliceCacheKey,
} from '../scripts/lib/audio-slice.mjs';

describe('parseMmSsHh (legacy mp3split timing parser)', () => {
  it('parses zero', () => expect(parseMmSsHh('00.00')).toBeCloseTo(0));
  it('parses MM.SS', () => expect(parseMmSsHh('01.30')).toBeCloseTo(90));
  it('parses MM.SS.HH (two-digit hundredths)', () =>
    expect(parseMmSsHh('00.04.80')).toBeCloseTo(4.8));
  it('parses MM.SS.HH for a typical piano slice end', () =>
    expect(parseMmSsHh('01.21.60')).toBeCloseTo(81.6));
  it('parses 1-digit hundredths as tenths-of-a-second (mp3splt convention)', () =>
    expect(parseMmSsHh('00.34.5')).toBeCloseTo(34.5));
  it('parses minutes > 9', () => expect(parseMmSsHh('12.34')).toBeCloseTo(754));
  it('rejects garbage', () => expect(() => parseMmSsHh('abc')).toThrow());
  it('rejects empty', () => expect(() => parseMmSsHh('')).toThrow());
});

describe('sliceCacheKey', () => {
  it('is deterministic for the same inputs', () => {
    const k1 = sliceCacheKey({ sourcePath: '/x/y.mp3', size: 100, mtimeMs: 1000, startSec: 4.8, endSec: 9.6 });
    const k2 = sliceCacheKey({ sourcePath: '/x/y.mp3', size: 100, mtimeMs: 1000, startSec: 4.8, endSec: 9.6 });
    expect(k1).toBe(k2);
  });
  it('encodes slice boundaries (different slices → different keys)', () => {
    const k1 = sliceCacheKey({ sourcePath: '/x/y.mp3', size: 100, mtimeMs: 1000, startSec: 0, endSec: 4.8 });
    const k2 = sliceCacheKey({ sourcePath: '/x/y.mp3', size: 100, mtimeMs: 1000, startSec: 4.8, endSec: 9.6 });
    expect(k1).not.toBe(k2);
    expect(k1).toMatch(/slice-0-4800\.ogg$/);
    expect(k2).toMatch(/slice-4800-9600\.ogg$/);
  });
  it('encodes source mtime/size (sample swap → different key)', () => {
    const k1 = sliceCacheKey({ sourcePath: '/x/y.mp3', size: 100, mtimeMs: 1000, startSec: 0, endSec: 1 });
    const k2 = sliceCacheKey({ sourcePath: '/x/y.mp3', size: 100, mtimeMs: 2000, startSec: 0, endSec: 1 });
    expect(k1).not.toBe(k2);
  });
  it('sanitises filename', () => {
    const k = sliceCacheKey({ sourcePath: '/x/has space & odd:chars.mp3', size: 1, mtimeMs: 1, startSec: 0, endSec: 1 });
    expect(k).not.toContain(' ');
    expect(k).not.toContain('&');
    expect(k).not.toContain(':');
  });
});

describe('buildSliceFfmpegArgs', () => {
  it('puts -ss/-to AFTER -i for frame-accurate slicing', () => {
    const args = buildSliceFfmpegArgs({
      sourcePath: '/x/a.mp3',
      preparedPath: '/cache/a.slice.ogg',
      startSec: 4.8,
      endSec: 9.6,
    });
    const iIdx = args.indexOf('-i');
    const ssIdx = args.indexOf('-ss');
    const toIdx = args.indexOf('-to');
    expect(iIdx).toBeGreaterThan(-1);
    expect(ssIdx).toBeGreaterThan(iIdx);
    expect(toIdx).toBeGreaterThan(ssIdx);
    expect(args[ssIdx + 1]).toBe('4.800');
    expect(args[toIdx + 1]).toBe('9.600');
    expect(args.at(-1)).toBe('/cache/a.slice.ogg');
    expect(args).toContain('libvorbis');
  });
  it('targetFormat=wav uses pcm_s16le', () => {
    const args = buildSliceFfmpegArgs({
      sourcePath: '/x/a.mp3',
      preparedPath: '/cache/a.slice.wav',
      startSec: 0,
      endSec: 1,
      targetFormat: 'wav',
    });
    expect(args).toContain('pcm_s16le');
    expect(args).not.toContain('libvorbis');
  });
  it('rejects zero/negative slice', () => {
    expect(() =>
      buildSliceFfmpegArgs({ sourcePath: '/x/a.mp3', preparedPath: '/y', startSec: 5, endSec: 5 }),
    ).toThrow();
  });
});

describe('prepareNormalizedSlice', () => {
  let tmp: string;
  let cacheDir: string;
  let sourcePath: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'casperaki-audio-slice-'));
    cacheDir = join(tmp, 'cache');
    await mkdir(cacheDir, { recursive: true });
    sourcePath = join(tmp, 'src.mp3');
    await writeFile(sourcePath, 'pretend-mp3-bytes');
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('writes a cache-miss transcode and returns transcoded', () => {
    let calls = 0;
    const res = prepareNormalizedSlice({
      sourcePath,
      sliceStart: 0,
      sliceEnd: 1,
      cacheDir,
      ffmpegLookup: () => '/usr/bin/ffmpeg-stub',
      runFfmpeg: (path, args) => {
        calls++;
        // Stub ffmpeg by writing the expected output file.
        const out = args.at(-1)!;
        writeFileSync(out, 'sliced-ogg-bytes');
      },
    });
    expect(res.kind).toBe('transcoded');
    if (res.kind === 'transcoded') {
      expect(res.cached).toBe(false);
      expect(res.byteSize).toBe('sliced-ogg-bytes'.length);
    }
    expect(calls).toBe(1);
  });

  it('cache-hit on second call (no ffmpeg invocation)', () => {
    let calls = 0;
    const runFfmpeg = (_p: string, args: readonly string[]) => {
      calls++;
      writeFileSync(args.at(-1)!, 'x'.repeat(10));
    };
    const opts = {
      sourcePath, sliceStart: 0, sliceEnd: 1, cacheDir,
      ffmpegLookup: () => '/usr/bin/ffmpeg-stub',
      runFfmpeg,
    };
    prepareNormalizedSlice(opts);
    prepareNormalizedSlice(opts);
    expect(calls).toBe(1);
  });

  it('no-ffmpeg branch when ffmpegLookup returns undefined', () => {
    const res = prepareNormalizedSlice({
      sourcePath, sliceStart: 0, sliceEnd: 1, cacheDir,
      ffmpegLookup: () => undefined,
    });
    expect(res.kind).toBe('no-ffmpeg');
  });

  it('error branch when source missing', () => {
    const res = prepareNormalizedSlice({
      sourcePath: join(tmp, 'nope.mp3'),
      sliceStart: 0, sliceEnd: 1, cacheDir,
      ffmpegLookup: () => '/usr/bin/ffmpeg-stub',
    });
    expect(res.kind).toBe('error');
  });

  it('error branch on invalid slice range', () => {
    const res = prepareNormalizedSlice({
      sourcePath, sliceStart: 5, sliceEnd: 5, cacheDir,
      ffmpegLookup: () => '/usr/bin/ffmpeg-stub',
    });
    expect(res.kind).toBe('error');
  });
});

describe('formatSliceLog', () => {
  it('formats cache-hit', () => {
    const msg = formatSliceLog(
      { kind: 'transcoded', preparedPath: '/c/x.ogg', sourceFormat: 'mp3', cached: true, byteSize: 1234 },
      '/src.mp3', 4.8, 9.6,
    );
    expect(msg).toContain('cache-hit');
    expect(msg).toContain('[4.80, 9.60]s');
  });
  it('formats no-ffmpeg', () => {
    const msg = formatSliceLog(
      { kind: 'no-ffmpeg', sourceFormat: 'mp3', error: 'not found' },
      '/src.mp3', 0, 1,
    );
    expect(msg).toContain('NO-FFMPEG');
  });
});
