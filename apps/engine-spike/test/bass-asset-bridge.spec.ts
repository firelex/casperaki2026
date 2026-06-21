// Bass asset bridge — first real-sample slice (docs/54h).
//
// Exercises the pure decision logic that picks between the resolver-
// returned real catalog sample and the bundled fixture. The decision
// helper is the seam the prestage script uses to bridge from
// `@casperaki/arrangement`'s resolver verdict to the engine's
// `vstsample-<id>.ogg` staging convention.

import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import {
  decideBassSource,
  formatStageDecisionLabel,
} from '../scripts/lib/bass-asset-bridge.mjs';

interface Harness {
  tmp: string;
  fixturesDir: string;
  cleanup: () => Promise<void>;
}

async function setup(opts: { withFixture: boolean }): Promise<Harness> {
  const tmp = await mkdtemp(join(tmpdir(), 'casperaki-bass-bridge-'));
  const fixturesDir = join(tmp, 'samples');
  await mkdir(fixturesDir, { recursive: true });
  if (opts.withFixture) {
    await writeFile(join(fixturesDir, 'bass-c2.ogg'), 'fixture-ogg-bytes');
  }
  return {
    tmp,
    fixturesDir,
    cleanup: () => rm(tmp, { recursive: true, force: true }),
  };
}

describe('decideBassSource', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await setup({ withFixture: true });
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it('returns the resolver-bridged real sample when root + manifest + file agree', async () => {
    const libRoot = join(h.tmp, 'sample-library');
    const realRel = 'basses/bassesSynthDistorted/basses - serum - BA Trancy Bass.mp3';
    const realPath = join(libRoot, realRel);
    await mkdir(resolve(libRoot, 'basses/bassesSynthDistorted'), { recursive: true });
    await writeFile(realPath, 'real-catalog-bytes');

    const manifestPath = join(h.tmp, 'asset-manifest.json');
    await writeFile(
      manifestPath,
      JSON.stringify({
        Bass: {
          status: 'resolved',
          matchKind: 'canonical',
          relativePath: realRel,
          entryId: 'b1a76948693cbc65',
        },
      }),
    );

    const decision = decideBassSource({
      sampleLibraryRoot: libRoot,
      manifestPath,
      fixtureSamplesDir: h.fixturesDir,
    });
    expect(decision.kind).toBe('real-bass-sample');
    expect(decision.sourcePath).toBe(realPath);
    expect(decision.catalogId).toBe('b1a76948693cbc65');
    expect(decision.relativePath).toBe(realRel);
    expect(decision.fallbackReason).toBeUndefined();
    expect(formatStageDecisionLabel(decision)).toContain('real-bass-sample');
    expect(formatStageDecisionLabel(decision)).toContain(realRel);
  });

  it('falls back to fixture when CASPERAKI_SAMPLE_LIBRARY_ROOT is unset', async () => {
    const manifestPath = join(h.tmp, 'asset-manifest.json');
    await writeFile(
      manifestPath,
      JSON.stringify({
        Bass: { status: 'resolved', relativePath: 'whatever', entryId: 'x' },
      }),
    );
    const decision = decideBassSource({
      sampleLibraryRoot: undefined,
      manifestPath,
      fixtureSamplesDir: h.fixturesDir,
    });
    expect(decision.kind).toBe('fixture-bass-sample');
    expect(decision.fallbackReason).toMatch(/CASPERAKI_SAMPLE_LIBRARY_ROOT/u);
    expect(decision.sourcePath).toBe(resolve(h.fixturesDir, 'bass-c2.ogg'));
  });

  it('falls back to fixture when the manifest file is missing', async () => {
    const decision = decideBassSource({
      sampleLibraryRoot: '/somewhere',
      manifestPath: join(h.tmp, 'does-not-exist.json'),
      fixtureSamplesDir: h.fixturesDir,
    });
    expect(decision.kind).toBe('fixture-bass-sample');
    expect(decision.fallbackReason).toMatch(/asset-manifest\.json missing/u);
  });

  it('falls back to fixture when the manifest Bass entry is unresolved', async () => {
    const manifestPath = join(h.tmp, 'asset-manifest.json');
    await writeFile(
      manifestPath,
      JSON.stringify({
        Bass: { status: 'unresolved', reason: 'no brain Bass definition' },
      }),
    );
    const decision = decideBassSource({
      sampleLibraryRoot: '/anything',
      manifestPath,
      fixtureSamplesDir: h.fixturesDir,
    });
    expect(decision.kind).toBe('fixture-bass-sample');
    expect(decision.fallbackReason).toMatch(/Bass entry unresolved/u);
    expect(decision.fallbackReason).toMatch(/no brain Bass definition/u);
  });

  it('falls back to fixture when the resolved sample is not on disk', async () => {
    const manifestPath = join(h.tmp, 'asset-manifest.json');
    await writeFile(
      manifestPath,
      JSON.stringify({
        Bass: {
          status: 'resolved',
          relativePath: 'basses/does-not-exist.mp3',
          entryId: 'b1a76948693cbc65',
        },
      }),
    );
    const decision = decideBassSource({
      sampleLibraryRoot: h.tmp,
      manifestPath,
      fixtureSamplesDir: h.fixturesDir,
    });
    expect(decision.kind).toBe('fixture-bass-sample');
    expect(decision.fallbackReason).toMatch(/not on disk/u);
    expect(decision.fallbackReason).toContain(h.tmp);
  });

  it('falls back to fixture when the manifest fails to parse', async () => {
    const manifestPath = join(h.tmp, 'asset-manifest.json');
    await writeFile(manifestPath, 'this is not json {');
    const decision = decideBassSource({
      sampleLibraryRoot: '/anywhere',
      manifestPath,
      fixtureSamplesDir: h.fixturesDir,
    });
    expect(decision.kind).toBe('fixture-bass-sample');
    expect(decision.fallbackReason).toMatch(/failed to parse/u);
  });

  it('returns no-source when both real sample and fixture are missing', async () => {
    // Tear down the default fixture for this case.
    const h2 = await setup({ withFixture: false });
    try {
      const decision = decideBassSource({
        sampleLibraryRoot: undefined,
        manifestPath: join(h2.tmp, 'asset-manifest.json'),
        fixtureSamplesDir: h2.fixturesDir,
      });
      expect(decision.kind).toBe('no-source');
      expect(decision.sourcePath).toBeUndefined();
      expect(decision.fallbackReason).toMatch(/fixture .* also missing/u);
    } finally {
      await h2.cleanup();
    }
  });
});
