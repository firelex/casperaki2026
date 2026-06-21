// Tonal-family asset bridge — generalised (docs/54j).
//
// Bass branch is already covered by `bass-asset-bridge.spec.ts`; here
// we exercise Keys + Pad to prove the generalisation. The decision
// helper is the seam stage-tonal.mjs uses to bridge from the resolver
// verdict to the engine's `vstsample-<id>.ogg` staging convention.

import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import {
  decideTonalSource,
  formatTonalStageDecisionLabel,
} from '../scripts/lib/tonal-asset-bridge.mjs';

interface Harness {
  tmp: string;
  fixturesDir: string;
  cleanup: () => Promise<void>;
}

async function setup(opts: {
  withFixture: boolean;
  fixtureRel?: string;
}): Promise<Harness> {
  const tmp = await mkdtemp(join(tmpdir(), 'casperaki-tonal-bridge-'));
  const fixturesDir = join(tmp, 'samples');
  await mkdir(fixturesDir, { recursive: true });
  if (opts.withFixture) {
    await writeFile(
      join(fixturesDir, opts.fixtureRel ?? 'tone.ogg'),
      'fixture-ogg-bytes',
    );
  }
  return {
    tmp,
    fixturesDir,
    cleanup: () => rm(tmp, { recursive: true, force: true }),
  };
}

describe('decideTonalSource (Keys)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup({ withFixture: true, fixtureRel: 'tone.ogg' });
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it('returns the resolver-bridged real Keys sample when everything agrees', async () => {
    const libRoot = join(h.tmp, 'lib');
    const rel = 'keys/keysAcousticPiano/Grand Mr Bright.mp3';
    await mkdir(resolve(libRoot, 'keys/keysAcousticPiano'), { recursive: true });
    await writeFile(join(libRoot, rel), 'mp3-bytes');
    const manifestPath = join(h.tmp, 'asset-manifest.json');
    await writeFile(
      manifestPath,
      JSON.stringify({
        Keys: {
          status: 'resolved',
          matchKind: 'canonical',
          relativePath: rel,
          entryId: '7f7952be598f9294',
        },
      }),
    );
    const decision = decideTonalSource({
      family: 'Keys',
      fixtureRel: 'tone.ogg',
      sampleLibraryRoot: libRoot,
      manifestPath,
      fixtureSamplesDir: h.fixturesDir,
    });
    expect(decision.kind).toBe('real-tonal-sample');
    expect(decision.family).toBe('Keys');
    expect(decision.catalogId).toBe('7f7952be598f9294');
    expect(decision.relativePath).toBe(rel);
    expect(formatTonalStageDecisionLabel(decision, 'tone.ogg')).toContain(
      'real-keys-sample',
    );
  });

  it('falls back to fixture when Keys entry is unresolved', async () => {
    const manifestPath = join(h.tmp, 'asset-manifest.json');
    await writeFile(
      manifestPath,
      JSON.stringify({
        Keys: { status: 'unresolved', reason: 'no brain Keys definition' },
      }),
    );
    const decision = decideTonalSource({
      family: 'Keys',
      fixtureRel: 'tone.ogg',
      sampleLibraryRoot: '/anywhere',
      manifestPath,
      fixtureSamplesDir: h.fixturesDir,
    });
    expect(decision.kind).toBe('fixture-tonal-sample');
    expect(decision.family).toBe('Keys');
    expect(decision.sourcePath).toBe(resolve(h.fixturesDir, 'tone.ogg'));
    expect(decision.fallbackReason).toMatch(/Keys entry unresolved/u);
  });
});

describe('decideTonalSource (Pad)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup({ withFixture: true, fixtureRel: 'tone.ogg' });
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it('selects the Pad manifest entry, not Bass or Keys', async () => {
    const libRoot = join(h.tmp, 'lib');
    const padRel = 'popStrings/popLowStringsLegato/Basses Legato.mp3';
    const keysRel = 'keys/keysAcousticPiano/Grand Mr Bright.mp3';
    await mkdir(resolve(libRoot, 'popStrings/popLowStringsLegato'), {
      recursive: true,
    });
    await mkdir(resolve(libRoot, 'keys/keysAcousticPiano'), { recursive: true });
    await writeFile(join(libRoot, padRel), 'pad-bytes');
    await writeFile(join(libRoot, keysRel), 'keys-bytes');
    const manifestPath = join(h.tmp, 'asset-manifest.json');
    await writeFile(
      manifestPath,
      JSON.stringify({
        Keys: {
          status: 'resolved',
          matchKind: 'canonical',
          relativePath: keysRel,
          entryId: 'KKK',
        },
        Pad: {
          status: 'resolved',
          matchKind: 'canonical',
          relativePath: padRel,
          entryId: 'PPP',
        },
      }),
    );
    const decision = decideTonalSource({
      family: 'Pad',
      fixtureRel: 'tone.ogg',
      sampleLibraryRoot: libRoot,
      manifestPath,
      fixtureSamplesDir: h.fixturesDir,
    });
    expect(decision.kind).toBe('real-tonal-sample');
    expect(decision.family).toBe('Pad');
    expect(decision.relativePath).toBe(padRel);
    expect(decision.catalogId).toBe('PPP');
  });

  it('falls back to fixture when manifest has no Pad entry', async () => {
    const manifestPath = join(h.tmp, 'asset-manifest.json');
    await writeFile(manifestPath, JSON.stringify({ Bass: { status: 'resolved' } }));
    const decision = decideTonalSource({
      family: 'Pad',
      fixtureRel: 'tone.ogg',
      sampleLibraryRoot: '/x',
      manifestPath,
      fixtureSamplesDir: h.fixturesDir,
    });
    expect(decision.kind).toBe('fixture-tonal-sample');
    expect(decision.fallbackReason).toMatch(/no Pad entry/u);
  });
});
