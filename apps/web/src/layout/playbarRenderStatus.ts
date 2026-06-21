/**
 * Pure helpers for the Playbar's render-status strip.
 *
 * Extracted from `Playbar.tsx` so they can be unit-tested without a
 * DOM/testing-library stack. The Playbar component delegates label
 * choice and number formatting to these so the visible string for each
 * state ("missing", "ready", error, etc.) has a contract.
 */

import type { RenderMetadata } from '../api/renders';

export type RenderStatusTone = 'pending' | 'missing' | 'ready' | 'error';

export interface RenderStatusInput {
  readonly render: RenderMetadata | undefined;
  readonly loading: boolean;
  readonly audioReady: boolean;
  readonly audioError?: string | undefined;
}

export interface RenderStatus {
  readonly tone: RenderStatusTone;
  readonly label: string;
}

export function describeRenderStatus(input: RenderStatusInput): RenderStatus {
  const { render, loading, audioReady, audioError } = input;
  if (audioError) return { tone: 'error', label: `Local render — audio error: ${audioError}` };
  if (loading && !render) return { tone: 'pending', label: 'Local render — checking…' };
  if (!render || !render.exists)
    return {
      tone: 'missing',
      label: 'Local render — none found (run engine-spike to produce out.wav)',
    };
  return audioReady
    ? { tone: 'ready', label: 'Local render — ready' }
    : { tone: 'pending', label: 'Local render — loading bytes…' };
}

export function fmtClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function fmtSecondsLabel(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return '—';
  return `${seconds.toFixed(2)}s`;
}

export function fmtDbLabel(db: number | undefined): string {
  if (db === undefined || !Number.isFinite(db)) return '—';
  return `${db.toFixed(2)} dB`;
}

export function fmtFormatLabel(
  sampleRate: number | undefined,
  bitDepth: number | undefined,
  channels: number | undefined,
): string {
  if (!sampleRate || !bitDepth || !channels) return '—';
  const ch = channels === 1 ? 'mono' : channels === 2 ? 'stereo' : `${channels}ch`;
  return `${(sampleRate / 1000).toFixed(1)}k · ${bitDepth}-bit · ${ch}`;
}

export function fmtBytesLabel(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return '—';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${bytes} B`;
}
