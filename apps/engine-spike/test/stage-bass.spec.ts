// Bass staging integration — docs/54i.
//
// Covers the full prestage pipeline for Bass (decision → normalisation
// → vstsample-<id>.ogg writes) without invoking the top-level prestage
// script. ffmpeg is mocked so the suite stays hermetic.

import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { stageBassWithBridge } from '../scripts/lib/stage-bass.mjs';

interface Harness {
  tmp: string;
  fixturesDir: string;
  tempDir: string;
  cacheDir: string;
  libRoot: string;
  instPath: string;
  manifestPath: string;
  cleanup: () => Promise<void>;
}

async function setup(opts: { withFixture: boolean; sampleRel?: string }): Promise<Harness> {
  const tmp = await mkdtemp(join(tmpdir(), 'casperaki-stage-bass-'));
  const fixturesDir = join(tmp, 'samples');
  const tempDir = join(tmp, 'juce-temp');
  const cacheDir = join(tmp, 'cache');
  const libRoot = join(tmp, 'sample-library');
  await mkdir(fixturesDir, { recursive: true });
  await mkdir(tempDir, { recursive: true });
  await mkdir(cacheDir, { recursive: true });
  if (opts.withFixture) {
    await writeFile(join(fixturesDir, 'bass-c2.ogg'), 'fixture-ogg-bytes');
  }
  const instPath = join(tmp, 'inst-2.json');
  await writeFile(
    instPath,
    JSON.stringify({
      id: 38842,
      name: 'Bass',
      samples: [
        { id: 945, note: 'c2', type: 'longNote' },
        { id: 946, note: 'd#2', type: 'longNote' },
        { id: 947, note: 'f#2', type: 'shortNote' },
      ],
    }),
  );
  const manifestPath = join(tmp, 'asset-manifest.json');
  return {
    tmp,
    fixturesDir,
    tempDir,
    cacheDir,
    libRoot,
    instPath,
    manifestPath,
    cleanup: () => rm(tmp, { recursive: true, force: true }),
  };
}

describe('stageBassWithBridge', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await setup({ withFixture: true });
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it('transcodes a real .mp3 catalog sample and emits the real-bass-sample-transcoded marker', async () => {
    const rel = 'basses/serum-BA-Trancy-Bass.mp3';
    const realPath = join(h.libRoot, rel);
    await mkdir(resolve(h.libRoot, 'basses'), { recursive: true });
    await writeFile(realPath, 'mp3-bytes-from-catalog');
    await writeFile(
      h.manifestPath,
      JSON.stringify({
        Bass: {
          status: 'resolved',
          matchKind: 'canonical',
          relativePath: rel,
          entryId: 'b1a76948693cbc65',
        },
      }),
    );

    let ffmpegInvocations = 0;
    const result = stageBassWithBridge({
      instPath: h.instPath,
      manifestPath: h.manifestPath,
      sampleLibraryRoot: h.libRoot,
      fixtureSamplesDir: h.fixturesDir,
      tempDir: h.tempDir,
      normalizeCacheDir: h.cacheDir,
      log: () => {},
      prepareNormalized: ({ sourcePath, cacheDir }) => {
        ffmpegInvocations++;
        // Pretend ffmpeg ran and produced a real Ogg file in the cache.
        const out = join(cacheDir, 'transcoded.ogg');
        writeFileSync(out, 'real-ogg-bytes');
        return {
          kind: 'transcoded',
          preparedPath: out,
          sourceFormat: 'mp3',
          cached: false,
          byteSize: 'real-ogg-bytes'.length,
        };
      },
    });

    expect(result.decisionKind).toBe('real-bass-sample');
    expect(result.normalizationKind).toBe('transcoded');
    expect(result.transcodedReal).toBe(true);
    expect(result.staged).toBe(3);
    expect(ffmpegInvocations).toBe(1);
    expect(result.logs.some((l) => l.includes('real-bass-sample-transcoded'))).toBe(
      true,
    );

    // The 3 vstsample-<id>.ogg slots must carry the transcoded bytes,
    // NOT the raw mp3-bytes-from-catalog source.
    for (const id of [945, 946, 947]) {
      const dst = join(h.tempDir, `vstsample-${id}.ogg`);
      expect(await readFile(dst, 'utf-8')).toBe('real-ogg-bytes');
    }
  });

  it('byte-copies a .ogg source (no transcode) and does not emit the transcoded marker', async () => {
    // No real-sample path; just exercise the fixture branch.
    const result = stageBassWithBridge({
      instPath: h.instPath,
      manifestPath: h.manifestPath, // missing -> fixture fallback
      sampleLibraryRoot: undefined,
      fixtureSamplesDir: h.fixturesDir,
      tempDir: h.tempDir,
      normalizeCacheDir: h.cacheDir,
      log: () => {},
    });

    expect(result.decisionKind).toBe('fixture-bass-sample');
    expect(result.normalizationKind).toBe('copy');
    expect(result.transcodedReal).toBe(false);
    expect(result.staged).toBe(3);
    expect(result.logs.some((l) => l.includes('real-bass-sample-transcoded'))).toBe(
      false,
    );

    // Fixture bytes copied to the vstsample slots verbatim.
    for (const id of [945, 946, 947]) {
      const dst = join(h.tempDir, `vstsample-${id}.ogg`);
      expect(await readFile(dst, 'utf-8')).toBe('fixture-ogg-bytes');
    }
  });

  it('falls back to the fixture when ffmpeg is missing and the real sample needs transcode', async () => {
    const rel = 'basses/needs-transcode.mp3';
    const realPath = join(h.libRoot, rel);
    await mkdir(resolve(h.libRoot, 'basses'), { recursive: true });
    await writeFile(realPath, 'mp3-bytes');
    await writeFile(
      h.manifestPath,
      JSON.stringify({
        Bass: {
          status: 'resolved',
          matchKind: 'canonical',
          relativePath: rel,
          entryId: 'abc',
        },
      }),
    );

    let calls = 0;
    const result = stageBassWithBridge({
      instPath: h.instPath,
      manifestPath: h.manifestPath,
      sampleLibraryRoot: h.libRoot,
      fixtureSamplesDir: h.fixturesDir,
      tempDir: h.tempDir,
      normalizeCacheDir: h.cacheDir,
      log: () => {},
      prepareNormalized: ({ sourcePath }) => {
        calls++;
        // First call (real .mp3) → no-ffmpeg. Second call (fixture
        // .ogg) → copy.
        if (sourcePath.endsWith('.mp3')) {
          return {
            kind: 'no-ffmpeg',
            sourceFormat: 'mp3',
            error: 'ffmpeg not found on PATH',
          };
        }
        return {
          kind: 'copy',
          preparedPath: sourcePath,
          sourceFormat: 'ogg',
          cached: false,
          byteSize: 'fixture-ogg-bytes'.length,
        };
      },
    });

    expect(calls).toBe(2);
    expect(result.decisionKind).toBe('real-bass-sample');
    expect(result.normalizationKind).toBe('copy');
    expect(result.transcodedReal).toBe(false);
    expect(result.staged).toBe(3);
    expect(
      result.logs.some((l) => l.includes('real-bass-sample normalisation failed')),
    ).toBe(true);
    for (const id of [945, 946, 947]) {
      const dst = join(h.tempDir, `vstsample-${id}.ogg`);
      expect(await readFile(dst, 'utf-8')).toBe('fixture-ogg-bytes');
    }
  });

  it('skips Bass staging when no Bass source is available at all', async () => {
    const h2 = await setup({ withFixture: false });
    try {
      const result = stageBassWithBridge({
        instPath: h2.instPath,
        manifestPath: h2.manifestPath,
        sampleLibraryRoot: undefined,
        fixtureSamplesDir: h2.fixturesDir,
        tempDir: h2.tempDir,
        normalizeCacheDir: h2.cacheDir,
        log: () => {},
      });
      expect(result.decisionKind).toBe('no-source');
      expect(result.staged).toBe(0);
    } finally {
      await h2.cleanup();
    }
  });
});
