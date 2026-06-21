import { describe, expect, it } from 'vitest';

import type { RenderMetadata } from '../src/api/renders';
import {
  describeRenderStatus,
  fmtBytesLabel,
  fmtClock,
  fmtDbLabel,
  fmtFormatLabel,
  fmtSecondsLabel,
} from '../src/layout/playbarRenderStatus';

const READY_META: RenderMetadata = {
  exists: true,
  durationSec: 210,
  peakDb: -3.42,
  rmsDb: -19.58,
  sampleRate: 44100,
  bitDepth: 24,
  channels: 2,
  sizeBytes: 55_566_816,
  updatedAt: '2026-06-06T22:33:00.000Z',
  url: '/api/renders/latest.wav',
};

describe('describeRenderStatus', () => {
  it('reports "checking" while the first request is in flight', () => {
    const status = describeRenderStatus({
      render: undefined,
      loading: true,
      audioReady: false,
    });
    expect(status.tone).toBe('pending');
    expect(status.label).toMatch(/checking/u);
  });

  it('reports "missing" when the brain says exists:false', () => {
    const status = describeRenderStatus({
      render: { exists: false },
      loading: false,
      audioReady: false,
    });
    expect(status.tone).toBe('missing');
    expect(status.label).toMatch(/none found/u);
    expect(status.label).toMatch(/engine-spike/u);
  });

  it('reports "loading bytes" once metadata is back but audio hasn\'t decoded yet', () => {
    const status = describeRenderStatus({
      render: READY_META,
      loading: false,
      audioReady: false,
    });
    expect(status.tone).toBe('pending');
    expect(status.label).toMatch(/loading bytes/u);
  });

  it('reports "ready" once the audio element has metadata', () => {
    const status = describeRenderStatus({
      render: READY_META,
      loading: false,
      audioReady: true,
    });
    expect(status.tone).toBe('ready');
    expect(status.label).toMatch(/ready/u);
  });

  it('surfaces audio element errors over everything else', () => {
    const status = describeRenderStatus({
      render: READY_META,
      loading: false,
      audioReady: true,
      audioError: 'decode failed',
    });
    expect(status.tone).toBe('error');
    expect(status.label).toMatch(/decode failed/u);
  });
});

describe('Playbar number formatters', () => {
  it('fmtClock pads minutes and seconds and gracefully handles NaN / negative', () => {
    expect(fmtClock(0)).toBe('00:00');
    expect(fmtClock(63.4)).toBe('01:03');
    expect(fmtClock(210)).toBe('03:30');
    expect(fmtClock(Number.NaN)).toBe('00:00');
    expect(fmtClock(-1)).toBe('00:00');
  });

  it('fmtSecondsLabel renders with 2 decimals and a unit', () => {
    expect(fmtSecondsLabel(undefined)).toBe('—');
    expect(fmtSecondsLabel(210)).toBe('210.00s');
  });

  it('fmtDbLabel renders 2 decimals with dB unit and handles undefined', () => {
    expect(fmtDbLabel(undefined)).toBe('—');
    expect(fmtDbLabel(-3.42)).toBe('-3.42 dB');
    expect(fmtDbLabel(Number.NEGATIVE_INFINITY)).toBe('—');
  });

  it('fmtFormatLabel collapses to em-dash when any field is missing', () => {
    expect(fmtFormatLabel(44100, 24, 2)).toBe('44.1k · 24-bit · stereo');
    expect(fmtFormatLabel(48000, 16, 1)).toBe('48.0k · 16-bit · mono');
    expect(fmtFormatLabel(44100, 24, undefined)).toBe('—');
  });

  it('fmtBytesLabel picks B / kB / MB', () => {
    expect(fmtBytesLabel(undefined)).toBe('—');
    expect(fmtBytesLabel(500)).toBe('500 B');
    expect(fmtBytesLabel(2048)).toBe('2.0 kB');
    expect(fmtBytesLabel(55_566_816)).toBe('53.0 MB');
  });
});
