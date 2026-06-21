// docs/54q — tests for the SignalProcessor port.

import { describe, expect, it } from 'vitest';

import {
  SUPPORTED_SP_TAGS,
  computeSignalProcessor,
  isSupportedSignalProcessorTag,
} from '../src/signal-processors.js';

describe('SUPPORTED_SP_TAGS', () => {
  it('lists the 10 legacy lowPassFilter tags + the 2 fade tags (docs/62 A7)', () => {
    expect([...SUPPORTED_SP_TAGS].sort()).toEqual([
      'fadeIn',
      'fadeOut',
      'lowPassFilter',
      'lowPassFilter100',
      'lowPassFilter1000',
      'lowPassFilter1000SweepUp',
      'lowPassFilter100SweepUp',
      'lowPassFilter300',
      'lowPassFilter300SweepUp',
      'lowPassFilter700',
      'lowPassFilter700SweepUp',
      'lowPassFilterSweepUp',
    ]);
  });

  it('isSupportedSignalProcessorTag agrees with the list', () => {
    for (const t of SUPPORTED_SP_TAGS) expect(isSupportedSignalProcessorTag(t)).toBe(true);
    expect(isSupportedSignalProcessorTag('lowPassFilter9999')).toBe(false);
    // fxNoiseRise is a TRANSITION (needs a noise instrument), not a signalProcessor.
    expect(isSupportedSignalProcessorTag('fxNoiseRise')).toBe(false);
    expect(isSupportedSignalProcessorTag('')).toBe(false);
  });
});

describe('computeSignalProcessor — fade branch (docs/62 A7)', () => {
  it('fadeIn → 2-point volume ramp -25dB → 0dB over the segment', () => {
    const r = computeSignalProcessor({ tag: 'fadeIn', segmentLengthInBars: 2, tempo: 120 });
    expect(r).not.toBeNull();
    expect(r!.type).toBe('fadeIn');
    expect(r!.lowPassFilter).toBeUndefined();
    expect(r!.volume).toEqual([
      { pointIn32ndNotes: 0, pointInSeconds: 0, value: -25 },
      { pointIn32ndNotes: 64, pointInSeconds: 4, value: 0 },
    ]);
  });

  it('fadeOut → 2-point volume ramp 0dB → -25dB over the segment', () => {
    const r = computeSignalProcessor({ tag: 'fadeOut', segmentLengthInBars: 8, tempo: 100 });
    expect(r!.type).toBe('fadeOut');
    // 8 bars * 4 beats * (60/100) = 19.2s; 8*32 = 256 32nds.
    expect(r!.volume).toEqual([
      { pointIn32ndNotes: 0, pointInSeconds: 0, value: 0 },
      { pointIn32ndNotes: 256, pointInSeconds: 19.2, value: -25 },
    ]);
  });
});

describe('computeSignalProcessor — SweepUp branch', () => {
  it('lowPassFilter1000SweepUp on a 2-bar segment @120bpm → 1000Hz→30000Hz over 4s', () => {
    const r = computeSignalProcessor({ tag: 'lowPassFilter1000SweepUp', segmentLengthInBars: 2, tempo: 120 });
    expect(r).not.toBeNull();
    expect(r!.type).toBe('lowPassFilter1000SweepUp');
    expect(r!.lowPassFilter).toHaveLength(2);
    expect(r!.lowPassFilter[0]).toEqual({ pointIn32ndNotes: 0,  pointInSeconds: 0, value: 1000 });
    expect(r!.lowPassFilter[1]).toEqual({ pointIn32ndNotes: 64, pointInSeconds: 4, value: 30000 });
  });

  it('lowPassFilterSweepUp (no digits) starts at 100Hz', () => {
    const r = computeSignalProcessor({ tag: 'lowPassFilterSweepUp', segmentLengthInBars: 4, tempo: 120 });
    expect(r!.lowPassFilter[0]!.value).toBe(100);
    expect(r!.lowPassFilter[1]!.value).toBe(30000);
  });

  it('lowPassFilter100SweepUp on 8 bars @100bpm', () => {
    const r = computeSignalProcessor({ tag: 'lowPassFilter100SweepUp', segmentLengthInBars: 8, tempo: 100 });
    // 8 bars * 4 beats * (60/100) sec = 19.2s; 8*32 = 256 32nds.
    expect(r!.lowPassFilter[0]).toEqual({ pointIn32ndNotes: 0, pointInSeconds: 0, value: 100 });
    expect(r!.lowPassFilter[1]).toEqual({ pointIn32ndNotes: 256, pointInSeconds: 19.2, value: 30000 });
  });
});

describe('computeSignalProcessor — static branch (no SweepUp)', () => {
  it('lowPassFilter1000 emits 3 points (hold-then-release to 30000)', () => {
    const r = computeSignalProcessor({ tag: 'lowPassFilter1000', segmentLengthInBars: 2, tempo: 120 });
    expect(r!.type).toBe('lowPassFilter1000');
    expect(r!.lowPassFilter).toHaveLength(3);
    expect(r!.lowPassFilter[0]).toEqual({ pointIn32ndNotes: 0,  pointInSeconds: 0, value: 1000 });
    expect(r!.lowPassFilter[1]).toEqual({ pointIn32ndNotes: 64, pointInSeconds: 4, value: 1000 });
    // Final release point: 1/32 past segment end, value 30000.
    const last = r!.lowPassFilter[2]!;
    expect(last.pointIn32ndNotes).toBe(65);
    expect(last.value).toBe(30000);
    // pointInSeconds == (bars + 1/32) * 4 * 60/tempo == (2 + 1/32) * 2 = 4.0625
    expect(last.pointInSeconds).toBeCloseTo(4.0625, 6);
  });

  it('lowPassFilter (no digits) static → 100Hz hold', () => {
    const r = computeSignalProcessor({ tag: 'lowPassFilter', segmentLengthInBars: 4, tempo: 120 });
    expect(r!.lowPassFilter[0]!.value).toBe(100);
    expect(r!.lowPassFilter[1]!.value).toBe(100);
    expect(r!.lowPassFilter[2]!.value).toBe(30000);
  });
});

describe('computeSignalProcessor — unsupported tags', () => {
  it('returns null for unknown tag', () => {
    expect(computeSignalProcessor({ tag: 'fxNoiseRise', segmentLengthInBars: 4, tempo: 120 })).toBeNull();
    expect(computeSignalProcessor({ tag: 'lowPassFilter9999', segmentLengthInBars: 4, tempo: 120 })).toBeNull();
  });
});
