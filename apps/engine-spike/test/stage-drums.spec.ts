// Drum-kit staging integration — docs/54j Stage 2.
//
// Exercises the catalog-driven drum kit assembly: each engine lane reads
// asset-manifest.json#Drums.lanes.<role>, resolves the catalog-bridged
// real sample (or falls back to bundled fixture), and normalises it
// through ffmpeg before writing the engine's playsample-<id>.ogg slot.

import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { stageDrumKit } from '../scripts/lib/stage-drums.mjs';

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

const ROLE_TO_FIXTURE = {
  bassDrum1: 'kick.ogg',
  snareDrum1: 'snare.ogg',
  hiHatClosed1: 'hat.ogg',
  hiHatOpen: 'hat.ogg',
  crash1: 'tone.ogg',
  tom1: 'tone.ogg',
  shaker: 'tone.ogg',
  clap: 'tone.ogg',
};

async function setup(opts: {
  withFixtures?: boolean;
  ids?: Record<string, number>;
}): Promise<Harness> {
  const tmp = await mkdtemp(join(tmpdir(), 'casperaki-stage-drums-'));
  const fixturesDir = join(tmp, 'samples');
  const tempDir = join(tmp, 'juce-temp');
  const cacheDir = join(tmp, 'cache');
  const libRoot = join(tmp, 'sample-library');
  await mkdir(fixturesDir, { recursive: true });
  await mkdir(tempDir, { recursive: true });
  await mkdir(cacheDir, { recursive: true });
  if (opts.withFixtures !== false) {
    await writeFile(join(fixturesDir, 'kick.ogg'), 'kick-fixture-bytes');
    await writeFile(join(fixturesDir, 'snare.ogg'), 'snare-fixture-bytes');
    await writeFile(join(fixturesDir, 'hat.ogg'), 'hat-fixture-bytes');
    await writeFile(join(fixturesDir, 'tone.ogg'), 'tone-fixture-bytes');
  }
  const instPath = join(tmp, 'inst-1.json');
  const ids = opts.ids ?? {
    bassDrum1: 26949,
    snareDrum1: 27175,
    hiHatClosed1: 27350,
  };
  await writeFile(instPath, JSON.stringify({ id: 100, name: 'Drums', ids }));
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

describe('stageDrumKit', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup({});
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it('resolves every lane to its catalog-bridged real sample (full real kit)', async () => {
    const kickRel = 'kickDrums/kickDrumsElectronic/kick.mp3';
    const snareRel = 'snareDrums/snareDrumsElectronic/snare.mp3';
    const hatRel = 'hiHatsClosed/hiHatsClosedElectronic/hat.mp3';
    for (const rel of [kickRel, snareRel, hatRel]) {
      await mkdir(resolve(h.libRoot, rel.replace(/\/[^/]+$/, '')), { recursive: true });
      await writeFile(join(h.libRoot, rel), `bytes-${rel}`);
    }
    await writeFile(
      h.manifestPath,
      JSON.stringify({
        Drums: {
          laneFamilyMap: {
            bassDrum1: 'kickDrums',
            snareDrum1: 'snareDrums',
            hiHatClosed1: 'hiHatsClosed',
          },
          lanes: {
            bassDrum1: {
              status: 'resolved',
              family: 'kickDrums',
              relativePath: kickRel,
              entryId: 'KKK',
              matchKind: 'canonical',
            },
            snareDrum1: {
              status: 'resolved',
              family: 'snareDrums',
              relativePath: snareRel,
              entryId: 'SSS',
              matchKind: 'canonical',
            },
            hiHatClosed1: {
              status: 'resolved',
              family: 'hiHatsClosed',
              relativePath: hatRel,
              entryId: 'HHH',
              matchKind: 'canonical',
            },
          },
        },
      }),
    );

    const result = stageDrumKit({
      instPath: h.instPath,
      manifestPath: h.manifestPath,
      sampleLibraryRoot: h.libRoot,
      fixtureSamplesDir: h.fixturesDir,
      tempDir: h.tempDir,
      normalizeCacheDir: h.cacheDir,
      roleToFixture: ROLE_TO_FIXTURE,
      log: () => {},
      prepareNormalized: ({ sourcePath, cacheDir }) => {
        const tag = sourcePath.split('/').pop();
        const out = join(cacheDir, `${tag}.ogg`);
        writeFileSync(out, `transcoded-${tag}`);
        return {
          kind: 'transcoded',
          preparedPath: out,
          sourceFormat: 'mp3',
          cached: false,
          byteSize: 10,
        };
      },
    });

    expect(result.staged).toBe(3);
    expect(result.realLaneCount).toBe(3);
    expect(result.fixtureLaneCount).toBe(0);
    expect(result.lanes.every((l) => l.kind === 'real-drum-sample')).toBe(true);

    expect(await readFile(join(h.tempDir, 'playsample-26949.ogg'), 'utf-8')).toBe(
      'transcoded-kick.mp3',
    );
    expect(await readFile(join(h.tempDir, 'playsample-27175.ogg'), 'utf-8')).toBe(
      'transcoded-snare.mp3',
    );
    expect(await readFile(join(h.tempDir, 'playsample-27350.ogg'), 'utf-8')).toBe(
      'transcoded-hat.mp3',
    );
  });

  it('falls back to bundled fixtures when CASPERAKI_SAMPLE_LIBRARY_ROOT is unset', async () => {
    const result = stageDrumKit({
      instPath: h.instPath,
      manifestPath: h.manifestPath,
      sampleLibraryRoot: undefined,
      fixtureSamplesDir: h.fixturesDir,
      tempDir: h.tempDir,
      normalizeCacheDir: h.cacheDir,
      roleToFixture: ROLE_TO_FIXTURE,
      log: () => {},
    });

    expect(result.staged).toBe(3);
    expect(result.realLaneCount).toBe(0);
    expect(result.fixtureLaneCount).toBe(3);
    for (const lane of result.lanes) {
      expect(lane.kind).toBe('fixture-drum-sample');
    }
    expect(await readFile(join(h.tempDir, 'playsample-26949.ogg'), 'utf-8')).toBe(
      'kick-fixture-bytes',
    );
    expect(await readFile(join(h.tempDir, 'playsample-27175.ogg'), 'utf-8')).toBe(
      'snare-fixture-bytes',
    );
    expect(await readFile(join(h.tempDir, 'playsample-27350.ogg'), 'utf-8')).toBe(
      'hat-fixture-bytes',
    );
  });

  it('mixed kit: some lanes resolved, others fall back to fixtures', async () => {
    const kickRel = 'kickDrums/kickDrumsElectronic/kick.mp3';
    await mkdir(resolve(h.libRoot, 'kickDrums/kickDrumsElectronic'), {
      recursive: true,
    });
    await writeFile(join(h.libRoot, kickRel), 'kick-bytes');
    await writeFile(
      h.manifestPath,
      JSON.stringify({
        Drums: {
          lanes: {
            bassDrum1: {
              status: 'resolved',
              family: 'kickDrums',
              relativePath: kickRel,
              entryId: 'k',
            },
            snareDrum1: {
              status: 'unresolved',
              family: 'snareDrums',
              reason: 'no validated catalog row',
            },
            // hiHatClosed1 missing from manifest entirely
          },
        },
      }),
    );

    const result = stageDrumKit({
      instPath: h.instPath,
      manifestPath: h.manifestPath,
      sampleLibraryRoot: h.libRoot,
      fixtureSamplesDir: h.fixturesDir,
      tempDir: h.tempDir,
      normalizeCacheDir: h.cacheDir,
      roleToFixture: ROLE_TO_FIXTURE,
      log: () => {},
      prepareNormalized: ({ sourcePath, cacheDir }) => {
        // Real .mp3 transcoded; fixture .ogg byte-copied.
        if (sourcePath.endsWith('.mp3')) {
          const out = join(cacheDir, 'kick.ogg');
          writeFileSync(out, 'kick-transcoded-bytes');
          return {
            kind: 'transcoded',
            preparedPath: out,
            sourceFormat: 'mp3',
            cached: false,
            byteSize: 10,
          };
        }
        return {
          kind: 'copy',
          preparedPath: sourcePath,
          sourceFormat: 'ogg',
          cached: false,
          byteSize: 10,
        };
      },
    });
    expect(result.realLaneCount).toBe(1);
    expect(result.fixtureLaneCount).toBe(2);
    expect(result.lanes.find((l) => l.role === 'bassDrum1')?.kind).toBe(
      'real-drum-sample',
    );
    expect(result.lanes.find((l) => l.role === 'snareDrum1')?.kind).toBe(
      'fixture-drum-sample',
    );
    expect(result.lanes.find((l) => l.role === 'snareDrum1')?.fallbackReason).toMatch(
      /snareDrum1 unresolved/u,
    );
    expect(result.lanes.find((l) => l.role === 'hiHatClosed1')?.fallbackReason).toMatch(
      /no manifest verdict/u,
    );
    expect(await readFile(join(h.tempDir, 'playsample-26949.ogg'), 'utf-8')).toBe(
      'kick-transcoded-bytes',
    );
    expect(await readFile(join(h.tempDir, 'playsample-27175.ogg'), 'utf-8')).toBe(
      'snare-fixture-bytes',
    );
  });

  it('falls back to fixture if ffmpeg is missing for a real .mp3 lane', async () => {
    const kickRel = 'kickDrums/x.mp3';
    await mkdir(resolve(h.libRoot, 'kickDrums'), { recursive: true });
    await writeFile(join(h.libRoot, kickRel), 'kick-bytes');
    await writeFile(
      h.manifestPath,
      JSON.stringify({
        Drums: {
          lanes: {
            bassDrum1: {
              status: 'resolved',
              family: 'kickDrums',
              relativePath: kickRel,
              entryId: 'k',
            },
          },
        },
      }),
    );

    const h2 = await setup({ ids: { bassDrum1: 1 } });
    try {
      // Copy fixtures into h2's dir for fallback.
      await writeFile(join(h2.fixturesDir, 'kick.ogg'), 'kick-fixture-bytes');
      await writeFile(
        h2.manifestPath,
        JSON.stringify({
          Drums: {
            lanes: {
              bassDrum1: {
                status: 'resolved',
                family: 'kickDrums',
                relativePath: kickRel,
                entryId: 'k',
              },
            },
          },
        }),
      );
      await mkdir(resolve(h2.libRoot, 'kickDrums'), { recursive: true });
      await writeFile(join(h2.libRoot, kickRel), 'kick-mp3-bytes');
      const result = stageDrumKit({
        instPath: h2.instPath,
        manifestPath: h2.manifestPath,
        sampleLibraryRoot: h2.libRoot,
        fixtureSamplesDir: h2.fixturesDir,
        tempDir: h2.tempDir,
        normalizeCacheDir: h2.cacheDir,
        roleToFixture: ROLE_TO_FIXTURE,
        log: () => {},
        prepareNormalized: ({ sourcePath }) => {
          if (sourcePath.endsWith('.mp3')) {
            return {
              kind: 'no-ffmpeg',
              sourceFormat: 'mp3',
              error: 'no ffmpeg',
            };
          }
          return {
            kind: 'copy',
            preparedPath: sourcePath,
            sourceFormat: 'ogg',
            cached: false,
            byteSize: 10,
          };
        },
      });
      expect(result.lanes[0]!.kind).toBe('fixture-drum-sample');
      expect(result.realLaneCount).toBe(0);
      expect(result.fixtureLaneCount).toBe(1);
    } finally {
      await h2.cleanup();
    }
  });

  it('skips drum staging when inst-1.json is missing', async () => {
    const result = stageDrumKit({
      instPath: join(h.tmp, 'missing.json'),
      manifestPath: h.manifestPath,
      sampleLibraryRoot: undefined,
      fixtureSamplesDir: h.fixturesDir,
      tempDir: h.tempDir,
      normalizeCacheDir: h.cacheDir,
      roleToFixture: ROLE_TO_FIXTURE,
      log: () => {},
    });
    expect(result.staged).toBe(0);
    expect(result.lanes).toEqual([]);
  });
});
