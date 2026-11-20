import { describe, expect, it } from 'vitest';

import type { RenderInfo } from '../src/api/songs';
import {
  describeRenderStatus,
  fmtBytesLabel,
  fmtClock,
  fmtDbLabel,
  fmtFormatLabel,
  fmtSecondsLabel,
} from '../src/layout/playbarRenderStatus';

const DONE: RenderInfo = {
  state: 'done',
  mp3Url: '/api/songs/abc/render.mp3',
  wavUrl: '/api/songs/abc/render.wav',
};

describe('describeRenderStatus', () => {
  it('reports "checking" while the first request is in flight', () => {
    const status = describeRenderStatus({ render: undefined, loading: true, audioReady: false });
    expect(status.tone).toBe('pending');
    expect(status.label).toMatch(/checking/u);
  });

  it('tells the user to press Render when the song was never rendered', () => {
    const status = describeRenderStatus({ render: { state: 'none' }, loading: false, audioReady: false });
    expect(status.tone).toBe('missing');
    expect(status.label).toMatch(/press Render/u);
  });

  it('reports queue position and running step', () => {
    expect(
      describeRenderStatus({ render: { state: 'queued', queuePosition: 2 }, loading: false, audioReady: false }).label,
    ).toMatch(/2 ahead/u);
    const running = describeRenderStatus({ render: { state: 'running', step: 'render' }, loading: false, audioReady: false });
    expect(running.tone).toBe('pending');
    expect(running.label).toMatch(/mixing/u);
  });

  it('shows the first line of a render failure', () => {
    const status = describeRenderStatus({
      render: { state: 'failed', error: 'casperaki_render failed: exit 3\nmore' },
      loading: false,
      audioReady: false,
    });
    expect(status.tone).toBe('error');
    expect(status.label).toBe('Render failed — casperaki_render failed: exit 3');
  });

  it('reports "loading audio" once done but audio hasn\'t decoded yet', () => {
    const status = describeRenderStatus({ render: DONE, loading: false, audioReady: false });
    expect(status.tone).toBe('pending');
    expect(status.label).toMatch(/loading audio/u);
  });

  it('reports "ready" once the audio element has metadata', () => {
    const status = describeRenderStatus({ render: DONE, loading: false, audioReady: true });
    expect(status.tone).toBe('ready');
    expect(status.label).toMatch(/ready/u);
  });

  it('warns that the render is of the saved version while there are unsaved edits', () => {
    const status = describeRenderStatus({ render: DONE, loading: false, audioReady: true, dirty: true });
    expect(status.tone).toBe('missing');
    expect(status.label).toMatch(/unsaved edits/u);
  });

  it('surfaces audio element errors over everything else', () => {
    const status = describeRenderStatus({
      render: DONE,
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
