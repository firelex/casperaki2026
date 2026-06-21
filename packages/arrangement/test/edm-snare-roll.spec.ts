// Unit tests for the EDM snare-roll grid generator (port of casperaki2
// EDMSnareDrumRollGeneratorClass). See edm-snare-roll.ts.

import { describe, expect, it } from 'vitest';

import { createRng } from '@casperaki/music-theory';

import { buildEdmSnareRollPattern } from '../src/arrangement-polish/edm-snare-roll.js';

const strip = (grid: string) => grid.replace(/[^0x]/gu, '');

describe('buildEdmSnareRollPattern', () => {
  it('grid length (in 32nd steps) is exactly lengthInBars * 32 for every capped length', () => {
    for (const cappedBars of [1, 2, 3, 4]) {
      // Sweep seeds so we hit every roll-length / mute / aux branch.
      for (let s = 0; s < 40; s++) {
        const roll = buildEdmSnareRollPattern(createRng(`cap${cappedBars}-${s}`), cappedBars);
        expect(roll.lengthInBars).toBe(cappedBars);
        for (const grid of Object.values(roll.pattern)) {
          expect(strip(grid).length, `cap=${cappedBars} seed=${s}`).toBe(cappedBars * 32);
        }
      }
    }
  });

  it('a 1-bar segment always produces a single-bar roll', () => {
    const roll = buildEdmSnareRollPattern(createRng('one-bar'), 1);
    expect(roll.lengthInBars).toBe(1);
    expect(strip(roll.pattern.snareDrum1!).length).toBe(32);
  });

  it('always emits snareDrum1 and rolls at least one hit', () => {
    for (let s = 0; s < 20; s++) {
      const roll = buildEdmSnareRollPattern(createRng(`hit-${s}`), 4);
      expect(roll.pattern.snareDrum1).toBeDefined();
      expect(roll.pattern.snareDrum1).toMatch(/x/u);
    }
  });

  it('sometimes emits the auxiliary snareDrum2 channel (legacy 2/3 chance)', () => {
    let withAux = 0;
    const N = 60;
    for (let s = 0; s < N; s++) {
      if (buildEdmSnareRollPattern(createRng(`aux-${s}`), 4).pattern.snareDrum2) withAux++;
    }
    // Roughly 2/3 — assert it's neither never nor always.
    expect(withAux).toBeGreaterThan(0);
    expect(withAux).toBeLessThan(N);
  });

  it('is deterministic for a given rng seed', () => {
    const a = buildEdmSnareRollPattern(createRng('det'), 4);
    const b = buildEdmSnareRollPattern(createRng('det'), 4);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('muteLastQuarterNote (when drawn) silences the final 8 steps without changing length', () => {
    // Find a seed whose snareDrum1 ends in silence (last quarter muted) and one
    // that does not — both must keep the full grid length.
    let sawMuted = false;
    for (let s = 0; s < 40; s++) {
      const grid = strip(buildEdmSnareRollPattern(createRng(`mute-${s}`), 1).pattern.snareDrum1!);
      expect(grid.length).toBe(32);
      if (grid.endsWith('00000000')) sawMuted = true;
    }
    expect(sawMuted).toBe(true);
  });
});
