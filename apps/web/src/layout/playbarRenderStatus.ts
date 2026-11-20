/**
 * Pure helpers for the Playbar's render-status strip.
 *
 * Extracted from `Playbar.tsx` so they can be unit-tested without a
 * DOM/testing-library stack. The Playbar component delegates label
 * choice and number formatting to these so the visible string for each
 * state ("missing", "ready", error, etc.) has a contract.
 */

import type { RenderInfo } from '../api/songs';

export type RenderStatusTone = 'pending' | 'missing' | 'ready' | 'error';

export interface RenderStatusInput {
  /** The open song's render job, from GET /api/songs/:id/render. */
  readonly render: RenderInfo | undefined;
  readonly loading: boolean;
  readonly audioReady: boolean;
  readonly audioError?: string | undefined;
  /** The editor holds unsaved edits, so the render (if any) is of the saved version. */
  readonly dirty?: boolean;
}

export interface RenderStatus {
  readonly tone: RenderStatusTone;
  readonly label: string;
}

export function describeRenderStatus(input: RenderStatusInput): RenderStatus {
  const { render, loading, audioReady, audioError, dirty } = input;
  const base = describeBase(render, loading, audioReady, audioError);
  if (dirty && render?.state === 'done') {
    return { tone: 'missing', label: `${base.label} · of the saved version (you have unsaved edits)` };
  }
  return base;
}

function describeBase(
  render: RenderInfo | undefined,
  loading: boolean,
  audioReady: boolean,
  audioError: string | undefined,
): RenderStatus {
  if (audioError) return { tone: 'error', label: `Render — audio error: ${audioError}` };
  if (loading && !render) return { tone: 'pending', label: 'Render — checking…' };
  switch (render?.state) {
    case undefined:
    case 'none':
      return { tone: 'missing', label: 'Not rendered yet — press Render to hear this song' };
    case 'queued':
      return {
        tone: 'pending',
        label: render.queuePosition ? `Render queued — ${render.queuePosition} ahead` : 'Render queued',
      };
    case 'running':
      return {
        tone: 'pending',
        label:
          render.step === 'lower'
            ? 'Rendering — preparing instruments…'
            : render.step === 'encode'
              ? 'Rendering — encoding…'
              : 'Rendering — mixing audio…',
      };
    case 'failed':
      return { tone: 'error', label: `Render failed — ${(render.error ?? 'unknown error').split('\n')[0]}` };
    case 'done':
      return audioReady
        ? { tone: 'ready', label: 'Render — ready' }
        : { tone: 'pending', label: 'Render — loading audio…' };
  }
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
