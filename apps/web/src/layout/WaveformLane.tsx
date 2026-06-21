import { useMemo } from 'react';

import type { RenderPeaks } from '../api/renders';
import type { SegmentSummary } from '../types/song';

/**
 * Visible audio timeline strip for the latest local render artifact.
 *
 * Shows the per-bin amplitude overview (max-absolute as filled bars,
 * RMS as a center-of-mass overlay), the segment boundaries from the
 * brain song, and a playhead. Clicking anywhere on the strip seeks the
 * transport via the provided `onSeek(seconds)` callback.
 *
 * Deliberately read-only / non-editing — see docs/54g-visible-editor-pass.md
 * for the deferred true DAW-lane work (per-track waveforms, region drag,
 * waveform-aware loop markers, etc.).
 */
export function WaveformLane({
  peaks,
  loading,
  durationSec,
  positionSec,
  segments,
  bpm,
  onSeek,
  artifactExists,
}: {
  peaks: RenderPeaks | undefined;
  loading: boolean;
  durationSec: number;
  positionSec: number;
  segments: readonly SegmentSummary[];
  bpm: number;
  onSeek(seconds: number): void;
  artifactExists: boolean;
}) {
  const totalBars = segments.reduce((sum, s) => sum + s.bars, 0);
  const songSeconds = totalBars > 0 ? (totalBars * 4 * 60) / bpm : durationSec;
  // Prefer the WAV's own duration so the lane's segment markers stay
  // bar-aligned with the audio; fall back to the brain-derived total.
  const usableDuration = peaks?.durationSec ?? durationSec ?? songSeconds;
  const safeDuration = usableDuration > 0 ? usableDuration : 1;

  const segmentMarkers = useMemo(() => {
    if (totalBars === 0) return [] as { name: string; left: number; widthPct: number; kind: string | undefined }[];
    // Map each segment onto the audio timeline by bar share. When the
    // audio is shorter/longer than the brain-derived duration we still
    // distribute proportionally to bars, which keeps marker placement
    // stable across re-renders.
    let cursorBars = 0;
    return segments.map((seg) => {
      const left = cursorBars / totalBars;
      const widthPct = seg.bars / totalBars;
      cursorBars += seg.bars;
      return { name: seg.name, left, widthPct, kind: seg.kind };
    });
  }, [segments, totalBars]);

  const position = Math.min(1, Math.max(0, positionSec / safeDuration));

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!artifactExists || safeDuration <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    onSeek(fraction * safeDuration);
  };

  const peakValues = peaks?.peaks ?? [];
  const rmsValues = peaks?.rms ?? [];
  const lanePlaceholder = !artifactExists
    ? 'no local render'
    : loading
      ? 'analysing waveform…'
      : peakValues.length === 0
        ? 'waveform unavailable (header decode failed) — playback still works'
        : undefined;

  return (
    <div
      className="px-[60px] py-3 border-t border-line/40 bg-[#0a0b13]"
      aria-label="Render waveform timeline"
    >
      <div className="flex items-center justify-between mb-1 text-[10px] uppercase tracking-[0.16em] text-dim font-semibold">
        <span>Waveform</span>
        <span className="font-mono normal-case tracking-normal text-[10.5px]">
          {peakValues.length > 0 ? `${peakValues.length} bins` : '—'} ·{' '}
          {peaks?.sampleRate ? `${(peaks.sampleRate / 1000).toFixed(1)}k` : '—'} ·{' '}
          {fmtClock(safeDuration)} total
        </span>
      </div>

      <div
        className={`relative h-[64px] rounded-md overflow-hidden border border-line/40 ${
          artifactExists && peakValues.length > 0 ? 'cursor-pointer' : 'cursor-default'
        }`}
        style={{ background: 'rgba(20, 22, 32, 0.85)' }}
        onClick={handleClick}
        role="slider"
        aria-valuemin={0}
        aria-valuemax={safeDuration}
        aria-valuenow={Math.round(positionSec)}
      >
        {/* Segment background lanes — colored stripes so the user can
            visually map bars on the audio timeline. */}
        {segmentMarkers.map((m, i) => (
          <div
            key={`${m.name}-${i}`}
            className="absolute top-0 bottom-0 border-r border-line/30"
            style={{
              left: `${m.left * 100}%`,
              width: `${m.widthPct * 100}%`,
              background: stripeColor(i, m.kind),
            }}
            title={`${m.name}${m.kind ? ` · ${m.kind}` : ''}`}
          />
        ))}

        {/* Peaks: tall bars from center, faded RMS overlay inside them. */}
        {peakValues.length > 0 ? (
          <Peaks peaks={peakValues} rms={rmsValues} />
        ) : null}

        {/* Segment name labels */}
        {segmentMarkers.map((m, i) =>
          m.widthPct > 0.04 ? (
            <span
              key={`label-${m.name}-${i}`}
              className="absolute top-1 text-[9.5px] uppercase tracking-[0.18em] font-mono text-white/75 pointer-events-none truncate"
              style={{
                left: `calc(${m.left * 100}% + 4px)`,
                width: `calc(${m.widthPct * 100}% - 8px)`,
              }}
            >
              {m.name}
            </span>
          ) : null,
        )}

        {/* Playhead line */}
        {artifactExists ? (
          <div
            className="absolute top-0 bottom-0 w-px bg-white shadow-[0_0_4px_rgba(255,255,255,0.6)] pointer-events-none"
            style={{ left: `${position * 100}%` }}
          />
        ) : null}

        {lanePlaceholder ? (
          <div className="absolute inset-0 flex items-center justify-center text-[11px] uppercase tracking-[0.16em] text-white/40 font-semibold pointer-events-none">
            {lanePlaceholder}
          </div>
        ) : null}
      </div>

      {/* Tick row: 0:00, 0:30, 1:00, ... */}
      <TickRow durationSec={safeDuration} />
    </div>
  );
}

function Peaks({ peaks, rms }: { peaks: readonly number[]; rms: readonly number[] }) {
  // Render bins as flex columns so they auto-fit the container width.
  // Each bin draws a full-height bar centred vertically, plus a softer
  // RMS bar inside it.
  return (
    <div className="absolute inset-0 flex items-stretch pointer-events-none">
      {peaks.map((p, i) => {
        const r = rms[i] ?? 0;
        const peakH = Math.max(2, p * 100);
        const rmsH = Math.max(1, r * 100);
        return (
          <div key={i} className="flex-1 flex items-center justify-center">
            <div className="relative w-full px-px">
              <div
                className="mx-auto rounded-[1px] bg-white/35"
                style={{ height: `${peakH}%`, width: '100%' }}
              />
              <div
                className="absolute inset-x-0 top-1/2 -translate-y-1/2 mx-auto rounded-[1px] bg-white/75"
                style={{ height: `${rmsH}%`, width: '100%' }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function TickRow({ durationSec }: { durationSec: number }) {
  const ticks = useMemo(() => {
    if (durationSec <= 0) return [] as { atPct: number; label: string }[];
    const step = pickTickStep(durationSec);
    const out: { atPct: number; label: string }[] = [];
    for (let t = 0; t <= durationSec + 1e-6; t += step) {
      out.push({ atPct: t / durationSec, label: fmtClock(t) });
    }
    return out;
  }, [durationSec]);
  if (ticks.length === 0) return null;
  return (
    <div className="relative h-3 mt-1 text-[9px] font-mono text-dim/80">
      {ticks.map((t, i) => (
        <span
          key={i}
          className="absolute top-0 -translate-x-1/2 tabular-nums"
          style={{ left: `${t.atPct * 100}%` }}
        >
          {t.label}
        </span>
      ))}
    </div>
  );
}

export function pickTickStep(durationSec: number): number {
  // Aim for ~6-10 ticks across the lane regardless of total duration.
  const targets = [1, 5, 10, 15, 30, 60, 120, 300, 600];
  for (const t of targets) {
    if (durationSec / t <= 10) return t;
  }
  return targets[targets.length - 1]!;
}

function stripeColor(index: number, kind: string | undefined): string {
  const k = (kind ?? '').toLowerCase();
  if (k.includes('chorus')) return 'rgba(255, 77, 77, 0.10)';
  if (k.includes('verse')) return 'rgba(64, 152, 255, 0.08)';
  if (k.includes('bridge')) return 'rgba(189, 122, 255, 0.10)';
  if (k.includes('pre')) return 'rgba(255, 184, 76, 0.10)';
  if (k.includes('intro')) return 'rgba(64, 213, 173, 0.08)';
  if (k.includes('outro')) return 'rgba(64, 213, 173, 0.05)';
  if (k.includes('break')) return 'rgba(255, 255, 255, 0.05)';
  return index % 2 === 0 ? 'rgba(255,255,255,0.025)' : 'rgba(255,255,255,0.045)';
}

function fmtClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
