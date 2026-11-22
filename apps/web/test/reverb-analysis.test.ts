import { describe, expect, it } from 'vitest';

import { analyseImpulse } from '../src/editor/devices/reverbAnalysis';

/** Deterministic noise with an exponential decay of the given RT60, after a predelay. */
function tail(rt60: number, predelaySec: number, seconds: number, sr: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * sr));
  let seed = 1;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  const start = Math.round(predelaySec * sr);
  for (let i = start; i < out.length; i++) {
    const t = (i - start) / sr;
    out[i] = rnd() * Math.pow(10, (-3 * t) / rt60); // amplitude falls 60 dB in rt60
  }
  return out;
}

describe('reverb impulse analysis', () => {
  it('measures RT60 and predelay of a synthetic tail', () => {
    const sr = 44100;
    const x = tail(1.5, 0.03, 4, sr);
    const a = analyseImpulse(x, x, sr);
    expect(a.rt60Sec).not.toBeNull();
    expect(a.rt60Sec!).toBeGreaterThan(1.35);
    expect(a.rt60Sec!).toBeLessThan(1.65);
    expect(a.predelayMs).toBeGreaterThan(28);
    expect(a.predelayMs).toBeLessThan(40);
    expect(a.bandRt.mid!).toBeGreaterThan(1.2);
    expect(a.bandRt.mid!).toBeLessThan(1.8);
  });

  it('refuses silence', () => {
    const z = new Float32Array(1000);
    expect(() => analyseImpulse(z, z, 44100)).toThrow(/silence/);
  });
});
