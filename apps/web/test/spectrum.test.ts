import { describe, expect, it } from 'vitest';

import { BANDS, bandFreq, bandPowersDb } from '../src/editor/devices/spectrum';

describe('device spectrum', () => {
  it('puts a 1 kHz sine in the band around 1 kHz', () => {
    const sr = 44100;
    const x = new Float32Array(4096).map((_, i) => Math.sin((2 * Math.PI * 1000 * i) / sr));
    const p = bandPowersDb(x, sr);
    let best = 0;
    for (let i = 1; i < BANDS; i++) if (p[i]! > p[best]!) best = i;
    expect(bandFreq(best)).toBeGreaterThan(850);
    expect(bandFreq(best)).toBeLessThan(1180);
    expect(p[best]! - p[5]!).toBeGreaterThan(40); // far above a low band
  });
});
