// Step 2 deliverable: the skeleton compiles + the shared types resolve.
// Real generator tests land alongside their generators in steps 3-8.

import { describe, expect, it } from 'vitest';
import { DataAssetError, type GenerateParams, type GeneratorContext } from '../src/index.js';
import { createRng } from '@casperaki/music-theory';

describe('@casperaki/arrangement skeleton', () => {
  it('exports GenerateParams as a workable type', () => {
    const params: GenerateParams = {
      genre: 'brightPop',
      key: 'C',
      bpm: 120,
      seed: 'spike',
    };
    expect(params.bpm).toBe(120);
  });

  it('exports GeneratorContext wiring an Rng + params', () => {
    const params: GenerateParams = { genre: 'brightPop', key: 'C', bpm: 120, seed: 42 };
    const ctx: GeneratorContext = { rng: createRng(params.seed), params };
    expect(typeof ctx.rng.next()).toBe('number');
  });

  it('DataAssetError carries its meta', () => {
    const err = new DataAssetError(
      { filename: 'x.json', legacyPath: 'legacy/x', extractedAt: '2026-01-01' },
      'broken',
    );
    expect(err.message).toMatch(/\[x\.json\] broken/u);
    expect(err.meta.legacyPath).toBe('legacy/x');
  });
});
