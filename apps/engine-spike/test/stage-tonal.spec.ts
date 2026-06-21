// Tonal-family staging integration — docs/54j.
//
// Generalised version of stage-bass.spec.ts. Covers the full prestage
// pipeline (decision → normalisation → vstsample-<id>.ogg writes) for
// Keys and Pad. Bass is already covered by stage-bass.spec.ts.

import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { stageTonalFamilyWithBridge } from '../scripts/lib/stage-tonal.mjs';

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

async function setup(opts: {
  withFixture: boolean;
  fixtureRel?: string;
  instSamples?: Array<{ id: number; note: string; type: string }>;
}): Promise<Harness> {
  const tmp = await mkdtemp(join(tmpdir(), 'casperaki-stage-tonal-'));
  const fixturesDir = join(tmp, 'samples');
  const tempDir = join(tmp, 'juce-temp');
  const cacheDir = join(tmp, 'cache');
  const libRoot = join(tmp, 'sample-library');
  await mkdir(fixturesDir, { recursive: true });
  await mkdir(tempDir, { recursive: true });
  await mkdir(cacheDir, { recursive: true });
  if (opts.withFixture) {
    await writeFile(
      join(fixturesDir, opts.fixtureRel ?? 'tone.ogg'),
      'fixture-ogg-bytes',
    );
  }
  const samples = opts.instSamples ?? [
    { id: 2048, note: 'c2', type: 'longNote' },
    { id: 2049, note: 'd#2', type: 'longNote' },
  ];
  const instPath = join(tmp, 'inst-3.json');
  await writeFile(instPath, JSON.stringify({ id: 38907, name: 'Keys', samples }));
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

describe('stageTonalFamilyWithBridge (Keys)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup({ withFixture: true });
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it('transcodes a real .mp3 catalog Keys sample into every vstsample slot', async () => {
    const rel = 'keys/keysAcousticPiano/Grand Mr Bright.mp3';
    const realPath = join(h.libRoot, rel);
    await mkdir(resolve(h.libRoot, 'keys/keysAcousticPiano'), { recursive: true });
    await writeFile(realPath, 'mp3-bytes');
    await writeFile(
      h.manifestPath,
      JSON.stringify({
        Keys: {
          status: 'resolved',
          matchKind: 'canonical',
          relativePath: rel,
          entryId: '7f7952be598f9294',
        },
      }),
    );

    let ffmpegInvocations = 0;
    const result = stageTonalFamilyWithBridge({
      family: 'Keys',
      fixtureRel: 'tone.ogg',
      instPath: h.instPath,
      manifestPath: h.manifestPath,
      sampleLibraryRoot: h.libRoot,
      fixtureSamplesDir: h.fixturesDir,
      tempDir: h.tempDir,
      normalizeCacheDir: h.cacheDir,
      log: () => {},
      prepareNormalized: ({ cacheDir }) => {
        ffmpegInvocations++;
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

    expect(result.decisionKind).toBe('real-tonal-sample');
    expect(result.normalizationKind).toBe('transcoded');
    expect(result.transcodedReal).toBe(true);
    expect(result.family).toBe('Keys');
    expect(result.staged).toBe(2);
    expect(ffmpegInvocations).toBe(1);
    expect(result.logs.some((l) => l.includes('real-keys-sample-transcoded'))).toBe(
      true,
    );

    for (const id of [2048, 2049]) {
      const dst = join(h.tempDir, `vstsample-${id}.ogg`);
      expect(await readFile(dst, 'utf-8')).toBe('real-ogg-bytes');
    }
  });

  it('byte-copies the bundled tone.ogg fixture when CASPERAKI_SAMPLE_LIBRARY_ROOT is unset', async () => {
    const result = stageTonalFamilyWithBridge({
      family: 'Keys',
      fixtureRel: 'tone.ogg',
      instPath: h.instPath,
      manifestPath: h.manifestPath,
      sampleLibraryRoot: undefined,
      fixtureSamplesDir: h.fixturesDir,
      tempDir: h.tempDir,
      normalizeCacheDir: h.cacheDir,
      log: () => {},
    });

    expect(result.decisionKind).toBe('fixture-tonal-sample');
    expect(result.staged).toBe(2);
    for (const id of [2048, 2049]) {
      const dst = join(h.tempDir, `vstsample-${id}.ogg`);
      expect(await readFile(dst, 'utf-8')).toBe('fixture-ogg-bytes');
    }
  });

  it('falls back to fixture when ffmpeg is missing for a real .mp3 source', async () => {
    const rel = 'keys/needs-transcode.mp3';
    await mkdir(resolve(h.libRoot, 'keys'), { recursive: true });
    await writeFile(join(h.libRoot, rel), 'mp3-bytes');
    await writeFile(
      h.manifestPath,
      JSON.stringify({
        Keys: {
          status: 'resolved',
          matchKind: 'canonical',
          relativePath: rel,
          entryId: 'k',
        },
      }),
    );

    let calls = 0;
    const result = stageTonalFamilyWithBridge({
      family: 'Keys',
      fixtureRel: 'tone.ogg',
      instPath: h.instPath,
      manifestPath: h.manifestPath,
      sampleLibraryRoot: h.libRoot,
      fixtureSamplesDir: h.fixturesDir,
      tempDir: h.tempDir,
      normalizeCacheDir: h.cacheDir,
      log: () => {},
      prepareNormalized: ({ sourcePath }) => {
        calls++;
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
    expect(result.decisionKind).toBe('real-tonal-sample');
    expect(result.normalizationKind).toBe('copy');
    expect(result.transcodedReal).toBe(false);
    expect(result.staged).toBe(2);
    expect(
      result.logs.some((l) => l.includes('real-keys-sample normalisation failed')),
    ).toBe(true);
  });
});

describe('stageTonalFamilyWithBridge (Pad)', () => {
  it('uses the Pad manifest entry verbatim (not Bass / Keys)', async () => {
    const h = await setup({ withFixture: true });
    try {
      const padRel = 'popStrings/popLowStringsLegato/Basses Legato.mp3';
      await mkdir(resolve(h.libRoot, 'popStrings/popLowStringsLegato'), {
        recursive: true,
      });
      await writeFile(join(h.libRoot, padRel), 'pad-mp3-bytes');
      await writeFile(
        h.manifestPath,
        JSON.stringify({
          Bass: {
            status: 'resolved',
            relativePath: 'unrelated.mp3',
            entryId: 'b',
          },
          Pad: {
            status: 'resolved',
            relativePath: padRel,
            entryId: 'p',
          },
        }),
      );

      const result = stageTonalFamilyWithBridge({
        family: 'Pad',
        fixtureRel: 'tone.ogg',
        instPath: h.instPath, // shape is the same for all tonal families
        manifestPath: h.manifestPath,
        sampleLibraryRoot: h.libRoot,
        fixtureSamplesDir: h.fixturesDir,
        tempDir: h.tempDir,
        normalizeCacheDir: h.cacheDir,
        log: () => {},
        prepareNormalized: ({ sourcePath, cacheDir }) => {
          expect(sourcePath).toBe(join(h.libRoot, padRel));
          const out = join(cacheDir, 'pad.ogg');
          writeFileSync(out, 'pad-ogg-bytes');
          return {
            kind: 'transcoded',
            preparedPath: out,
            sourceFormat: 'mp3',
            cached: false,
            byteSize: 'pad-ogg-bytes'.length,
          };
        },
      });
      expect(result.decisionKind).toBe('real-tonal-sample');
      expect(result.family).toBe('Pad');
      expect(result.transcodedReal).toBe(true);
    } finally {
      await h.cleanup();
    }
  });
});
