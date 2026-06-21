// docs/54l stage-multisample integration specs.
//
// Covers the full per-slot pipeline (resolver → ffmpeg slice → write
// vstsample-<id>.ogg) with synthetic manifest + inst-N.json + timing
// data. ffmpeg is mocked so the suite stays hermetic.

import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { stageMultisampleFamily } from '../scripts/lib/stage-multisample.mjs';

interface H {
  tmp: string;
  fixturesDir: string;
  tempDir: string;
  cacheDir: string;
  libRoot: string;
  instPath: string;
  manifestPath: string;
}

async function setup(opts: {
  family?: 'Bass' | 'Keys' | 'Pad';
  catalogFamily?: 'basses' | 'keys' | 'popStrings';
  fixtureRel?: string;
  withRealSource?: boolean;
  manifestEntry?: Record<string, unknown> | null;
  samples?: Array<{ id: number; note: string; type: string }>;
}): Promise<H> {
  const tmp = await mkdtemp(join(tmpdir(), 'casperaki-stage-msmpl-'));
  const fixturesDir = join(tmp, 'samples');
  const tempDir = join(tmp, 'juce-temp');
  const cacheDir = join(tmp, 'cache');
  const libRoot = join(tmp, 'sample-library');
  await mkdir(fixturesDir, { recursive: true });
  await mkdir(tempDir, { recursive: true });
  await mkdir(cacheDir, { recursive: true });
  await writeFile(join(fixturesDir, opts.fixtureRel ?? 'tone.ogg'), 'fixture-bytes');
  const samples = opts.samples ?? [
    { id: 100, note: 'c2', type: 'longNote' },
    { id: 101, note: 'd#2', type: 'longNote' },
    { id: 102, note: 'c4', type: 'longNote' },
  ];
  const instPath = join(tmp, 'inst.json');
  await writeFile(instPath, JSON.stringify({ id: 1, name: opts.family ?? 'Keys', samples }));
  const manifestPath = join(tmp, 'asset-manifest.json');
  if (opts.manifestEntry !== null) {
    if (opts.withRealSource) {
      const rel = 'keys/canonical.mp3';
      await mkdir(join(libRoot, 'keys'), { recursive: true });
      await writeFile(join(libRoot, rel), 'pretend-mp3-bytes');
      await writeFile(
        manifestPath,
        JSON.stringify({
          [opts.family ?? 'Keys']: {
            status: 'resolved',
            relativePath: rel,
            family: opts.catalogFamily ?? 'keys',
            ...(opts.manifestEntry ?? {}),
          },
        }),
      );
    } else {
      await writeFile(
        manifestPath,
        JSON.stringify({
          [opts.family ?? 'Keys']: {
            status: 'unresolved',
            reason: 'env unset',
            family: opts.catalogFamily ?? 'keys',
            ...(opts.manifestEntry ?? {}),
          },
        }),
      );
    }
  }
  return { tmp, fixturesDir, tempDir, cacheDir, libRoot, instPath, manifestPath };
}

afterEach(async () => {/* per-test cleanup happens inline */});

describe('stageMultisampleFamily — full real-slice path', () => {
  let h: H;
  beforeEach(async () => {
    h = await setup({
      family: 'Keys',
      catalogFamily: 'keys',
      fixtureRel: 'tone.ogg',
      withRealSource: true,
    });
  });
  afterEach(() => rm(h.tmp, { recursive: true, force: true }));

  it('stages a distinct slice per slot (no duplicate-source fanout)', async () => {
    let sliceCalls = 0;
    /** @type {Set<string>} */
    const sliceBoundaries = new Set<string>();
    const result = stageMultisampleFamily({
      family: 'Keys',
      fixtureRel: 'tone.ogg',
      instPath: h.instPath,
      manifestPath: h.manifestPath,
      sampleLibraryRoot: h.libRoot,
      fixtureSamplesDir: h.fixturesDir,
      tempDir: h.tempDir,
      normalizeCacheDir: h.cacheDir,
      log: () => {},
      prepareSlice: ({ sliceStart, sliceEnd, cacheDir }) => {
        sliceCalls++;
        const key = `${sliceStart}-${sliceEnd}`;
        sliceBoundaries.add(key);
        const out = join(cacheDir, `slice-${key}.ogg`);
        writeFileSync(out, `bytes-for-${key}`);
        return {
          kind: 'transcoded',
          preparedPath: out,
          sourceFormat: 'mp3',
          cached: false,
          byteSize: `bytes-for-${key}`.length,
        };
      },
    });

    expect(result.realSliceCount).toBe(3);
    expect(result.fixtureFallbackCount).toBe(0);
    expect(result.timingName).toBe('pianoNotes');
    expect(sliceCalls).toBe(3);
    expect(sliceBoundaries.size).toBe(3);

    // Each slot has DISTINCT bytes (no duplicate-source fanout).
    const bytes = await Promise.all([
      readFile(join(h.tempDir, 'vstsample-100.ogg'), 'utf-8'),
      readFile(join(h.tempDir, 'vstsample-101.ogg'), 'utf-8'),
      readFile(join(h.tempDir, 'vstsample-102.ogg'), 'utf-8'),
    ]);
    expect(new Set(bytes).size).toBe(3);
  });
});

describe('stageMultisampleFamily — full fixture-fallback path (no library / unresolved)', () => {
  it('falls back per-slot when CASPERAKI_SAMPLE_LIBRARY_ROOT is unset', async () => {
    const h = await setup({ family: 'Keys', catalogFamily: 'keys', fixtureRel: 'tone.ogg', withRealSource: false });
    try {
      const result = stageMultisampleFamily({
        family: 'Keys',
        fixtureRel: 'tone.ogg',
        instPath: h.instPath,
        manifestPath: h.manifestPath,
        sampleLibraryRoot: undefined,
        fixtureSamplesDir: h.fixturesDir,
        tempDir: h.tempDir,
        normalizeCacheDir: h.cacheDir,
        log: () => {},
        prepareSlice: () => {
          throw new Error('prepareSlice should not be called when no real source');
        },
      });
      expect(result.realSliceCount).toBe(0);
      expect(result.fixtureFallbackCount).toBe(3);
      // Each slot was copied from the SAME fixture (only one fixture exists).
      const bytes = await readFile(join(h.tempDir, 'vstsample-100.ogg'), 'utf-8');
      expect(bytes).toBe('fixture-bytes');
      // Per-slot logs name the fallback reason.
      const reasonLogs = result.slots
        .filter((s) => s.kind === 'fixture-fallback')
        .map((s) => s.fallbackReason ?? '');
      for (const r of reasonLogs) expect(r.length).toBeGreaterThan(0);
    } finally {
      await rm(h.tmp, { recursive: true, force: true });
    }
  });
});

describe('stageMultisampleFamily — partial: some slots resolved, others unresolved', () => {
  it('mixes real slices for resolved slots and fixture fallback for the rest', async () => {
    // Add a c7 slot that pianoNotes does NOT cover (range stops at c6).
    const h = await setup({
      family: 'Keys',
      catalogFamily: 'keys',
      fixtureRel: 'tone.ogg',
      withRealSource: true,
      samples: [
        { id: 100, note: 'c2', type: 'longNote' },
        { id: 200, note: 'c7', type: 'longNote' }, // unresolved — no piano timing for c7
      ],
    });
    try {
      const result = stageMultisampleFamily({
        family: 'Keys',
        fixtureRel: 'tone.ogg',
        instPath: h.instPath,
        manifestPath: h.manifestPath,
        sampleLibraryRoot: h.libRoot,
        fixtureSamplesDir: h.fixturesDir,
        tempDir: h.tempDir,
        normalizeCacheDir: h.cacheDir,
        log: () => {},
        prepareSlice: ({ cacheDir }) => {
          const out = join(cacheDir, 'real.ogg');
          writeFileSync(out, 'real-slice-bytes');
          return { kind: 'transcoded', preparedPath: out, sourceFormat: 'mp3', cached: false, byteSize: 16 };
        },
      });
      expect(result.realSliceCount).toBe(1);
      expect(result.fixtureFallbackCount).toBe(1);
      expect(await readFile(join(h.tempDir, 'vstsample-100.ogg'), 'utf-8')).toBe('real-slice-bytes');
      expect(await readFile(join(h.tempDir, 'vstsample-200.ogg'), 'utf-8')).toBe('fixture-bytes');
      const unresolved = result.slots.find((s) => s.slotId === 200);
      expect(unresolved?.kind).toBe('fixture-fallback');
      expect(unresolved?.fallbackReason).toMatch(/slot unresolved/);
    } finally {
      await rm(h.tmp, { recursive: true, force: true });
    }
  });
});

describe('stageMultisampleFamily — slice failure falls back to fixture for that slot only', () => {
  it('ffmpeg missing during slice triggers per-slot fixture fallback', async () => {
    const h = await setup({ family: 'Keys', catalogFamily: 'keys', fixtureRel: 'tone.ogg', withRealSource: true });
    try {
      const result = stageMultisampleFamily({
        family: 'Keys',
        fixtureRel: 'tone.ogg',
        instPath: h.instPath,
        manifestPath: h.manifestPath,
        sampleLibraryRoot: h.libRoot,
        fixtureSamplesDir: h.fixturesDir,
        tempDir: h.tempDir,
        normalizeCacheDir: h.cacheDir,
        log: () => {},
        prepareSlice: () => ({
          kind: 'no-ffmpeg',
          sourceFormat: 'mp3',
          error: 'ffmpeg not found',
        }),
      });
      expect(result.realSliceCount).toBe(0);
      expect(result.fixtureFallbackCount).toBe(3);
      // The fallback reason names the slice failure.
      for (const s of result.slots) {
        expect(s.fallbackReason).toMatch(/slice failed/);
      }
    } finally {
      await rm(h.tmp, { recursive: true, force: true });
    }
  });
});

describe('stageMultisampleFamily — no manifest entry → graceful fallback', () => {
  it('falls back per-slot when manifest is missing entirely', async () => {
    const h = await setup({ family: 'Keys', catalogFamily: 'keys', fixtureRel: 'tone.ogg', manifestEntry: null });
    try {
      const result = stageMultisampleFamily({
        family: 'Keys',
        fixtureRel: 'tone.ogg',
        instPath: h.instPath,
        manifestPath: join(h.tmp, 'definitely-missing.json'),
        sampleLibraryRoot: h.libRoot,
        fixtureSamplesDir: h.fixturesDir,
        tempDir: h.tempDir,
        normalizeCacheDir: h.cacheDir,
        log: () => {},
      });
      expect(result.realSliceCount).toBe(0);
      expect(result.fixtureFallbackCount).toBe(3);
    } finally {
      await rm(h.tmp, { recursive: true, force: true });
    }
  });
});

describe('stageMultisampleFamily — Bass shape (16 slots: 8 longNote + 8 shortNote)', () => {
  it('stages distinct slices per (note, type) pair for Bass', async () => {
    const noteRow = ['c2', 'd#2', 'f#2', 'a2', 'c3', 'd#3', 'f#3', 'a3'] as const;
    const samples = [
      ...noteRow.map((n, i) => ({ id: 945 + i, note: n, type: 'longNote' })),
      ...noteRow.map((n, i) => ({ id: 953 + i, note: n, type: 'shortNote' })),
    ];
    const h = await setup({
      family: 'Bass',
      catalogFamily: 'basses',
      fixtureRel: 'bass-c2.ogg',
      withRealSource: true,
      samples,
    });
    try {
      const result = stageMultisampleFamily({
        family: 'Bass',
        fixtureRel: 'bass-c2.ogg',
        instPath: h.instPath,
        manifestPath: h.manifestPath,
        sampleLibraryRoot: h.libRoot,
        fixtureSamplesDir: h.fixturesDir,
        tempDir: h.tempDir,
        normalizeCacheDir: h.cacheDir,
        log: () => {},
        prepareSlice: ({ sliceStart, sliceEnd, cacheDir }) => {
          const key = `${sliceStart}-${sliceEnd}`;
          const out = join(cacheDir, `slice-${key}.ogg`);
          writeFileSync(out, `bytes-for-${key}`);
          return { kind: 'transcoded', preparedPath: out, sourceFormat: 'mp3', cached: false, byteSize: 16 };
        },
      });
      expect(result.timingName).toBe('bassNotes');
      expect(result.realSliceCount).toBe(16);
      expect(result.fixtureFallbackCount).toBe(0);

      // long-c2 (id 945) and short-c2 (id 953) must use DIFFERENT slices.
      const longC2  = await readFile(join(h.tempDir, 'vstsample-945.ogg'), 'utf-8');
      const shortC2 = await readFile(join(h.tempDir, 'vstsample-953.ogg'), 'utf-8');
      expect(longC2).not.toBe(shortC2);
    } finally {
      await rm(h.tmp, { recursive: true, force: true });
    }
  });
});
