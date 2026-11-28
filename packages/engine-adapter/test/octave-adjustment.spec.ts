import { describe, expect, it } from 'vitest';

import { octaveAdjustmentFor } from '../src/index.js';

describe('per-sound octave adjustment', () => {
  // "BA Brooks 1" starts on F#: its octave was measured on a slice holding F#1, not C, and rounded to 2 octaves, so it
  // played an octave high (owner 2026-11-28: "an octave high"). Like the other basses recorded at that pitch it is 1.
  it('BA Brooks 1 is transposed one octave, like the other basses', () => {
    expect(octaveAdjustmentFor('585de9cc4a5366b1')).toBe(1);
  });
});
