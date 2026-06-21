import { describe, expect, it } from 'vitest';

import { pickTickStep } from '../src/layout/WaveformLane';

describe('pickTickStep', () => {
  it('keeps short clips at a 1-second granularity', () => {
    expect(pickTickStep(8)).toBe(1);
  });

  it('jumps to 5s ticks once 1s would make >10 ticks', () => {
    expect(pickTickStep(11)).toBe(5);
  });

  it('uses 30s ticks for a ~3-minute clip', () => {
    expect(pickTickStep(180)).toBe(30);
  });

  it('uses 30s ticks for the engine-spike 210-second render', () => {
    expect(pickTickStep(210)).toBe(30);
  });

  it('falls back to 10-minute ticks for hour-long clips', () => {
    expect(pickTickStep(7200)).toBe(600);
  });
});
