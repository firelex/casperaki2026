import { useEffect, useRef } from 'react';

import { BEATS_PER_BAR, type SeqTrack, type SequencerModel } from '../sequencerModel';
import { gridStep, resolveColor } from './layout';

const CLIP_HEADER_H = 13;

/**
 * One track's row, drawn on a canvas: the bar/beat grid, a clip per section
 * the track plays in (name strip on top, as in a DAW), its notes, and the
 * track's measured waveform behind them.
 */
export function TrackCanvas({
  track,
  model,
  px,
  secondsPerBar,
  peaks,
  binSec,
  meterMax,
  dimmed,
  selectedSection,
  rowH,
}: {
  track: SeqTrack;
  model: SequencerModel;
  px: number;
  secondsPerBar: number;
  /** This track's peak level per meter bin, when measured. */
  peaks: Float32Array | undefined;
  binSec: number;
  /** Loudest bin across all tracks, so heights compare between tracks. */
  meterMax: number;
  /** Muted, or not soloed while others are. */
  dimmed: boolean;
  /** Section index whose clip is selected (outlined). */
  selectedSection: number | undefined;
  /** Row height (px): the sequencer fits every track into the window. */
  rowH: number;
}) {
  const ROW_H = rowH;
  const ref = useRef<HTMLCanvasElement>(null);
  const width = Math.max(1, Math.round(model.totalBars * px));

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = ROW_H * dpr;
    const g = canvas.getContext('2d');
    if (!g) throw new Error('2D canvas is not available');
    g.scale(dpr, dpr);
    g.clearRect(0, 0, width, ROW_H);

    // Grid: beat lines when there is room, bar lines, stronger every 4 bars.
    const { beats, bars } = gridStep(px);
    if (beats) {
      g.fillStyle = 'rgba(255,255,255,0.035)';
      for (let b = 0; b < model.totalBars * BEATS_PER_BAR; b++) {
        if (b % BEATS_PER_BAR) g.fillRect(Math.round((b / BEATS_PER_BAR) * px), 0, 1, ROW_H);
      }
    }
    for (let bar = 0; bar <= model.totalBars; bar += bars) {
      g.fillStyle = bar % 4 === 0 ? 'rgba(255,255,255,0.11)' : 'rgba(255,255,255,0.06)';
      g.fillRect(Math.round(bar * px), 0, 1, ROW_H);
    }

    const color = resolveColor(track.color);
    const alpha = dimmed ? 0.35 : 1;
    const top = 3;
    const clipH = ROW_H - top * 2;
    // Low rows drop the name strip so the notes keep their room.
    const headerH = ROW_H >= 40 ? CLIP_HEADER_H : 0;
    const bodyTop = top + headerH;
    const bodyH = clipH - headerH;
    const pad = 3;
    const innerTop = bodyTop + pad;
    const innerH = bodyH - pad * 2;

    // Clips: body, name strip, outline.
    for (const clip of track.clips) {
      const x = clip.startBar * px + 1;
      const w = Math.max(2, clip.bars * px - 2);
      g.globalAlpha = 0.2 * alpha;
      g.fillStyle = color;
      roundRect(g, x, top, w, clipH, 3);
      g.fill();
      if (headerH) {
        g.globalAlpha = 0.55 * alpha;
        roundRectTop(g, x, top, w, headerH, 3);
        g.fill();
      }
      g.globalAlpha = (clip.section === selectedSection ? 1 : 0.5) * alpha;
      g.strokeStyle = clip.section === selectedSection ? '#ffffff' : color;
      g.lineWidth = clip.section === selectedSection ? 1.5 : 1;
      roundRect(g, x + 0.5, top + 0.5, w - 1, clipH - 1, 3);
      g.stroke();
      if (headerH && w > 36) {
        g.globalAlpha = alpha;
        g.fillStyle = 'rgba(255,255,255,0.92)';
        g.font = '600 10px Archivo, system-ui, sans-serif';
        g.textBaseline = 'middle';
        g.save();
        g.beginPath();
        g.rect(x + 4, top, w - 8, CLIP_HEADER_H);
        g.clip();
        g.fillText(model.sections[clip.section]!.name, x + 5, top + CLIP_HEADER_H / 2 + 0.5);
        g.restore();
      }
    }

    // Waveform: peak per pixel column, mirrored around the clip body's middle.
    if (peaks && peaks.length > 0 && meterMax > 0 && binSec > 0) {
      const binsPerPx = secondsPerBar / px / binSec;
      const mid = bodyTop + bodyH / 2;
      const half = bodyH / 2 - 1;
      g.fillStyle = color;
      g.globalAlpha = 0.32 * alpha;
      g.beginPath();
      g.moveTo(0, mid);
      const cols = Math.min(width, Math.ceil(peaks.length / binsPerPx));
      const heights: number[] = [];
      for (let x = 0; x < cols; x++) {
        let m = 0;
        const from = Math.floor(x * binsPerPx);
        const to = Math.min(peaks.length, Math.max(from + 1, Math.floor((x + 1) * binsPerPx)));
        for (let i = from; i < to; i++) if (peaks[i]! > m) m = peaks[i]!;
        const h = Math.sqrt(m / meterMax) * half;
        heights.push(h);
        g.lineTo(x, mid - h);
      }
      for (let x = cols - 1; x >= 0; x--) g.lineTo(x, mid + heights[x]!);
      g.closePath();
      g.fill();
    }

    // Notes: drum kits get one thin lane per drum present; pitched parts go by pitch.
    const drumLanes = track.isDrums
      ? [...new Set(track.clips.flatMap((c) => c.notes.map((n) => n.pitch).filter((p): p is number => p !== null)))].sort((a, b) => b - a)
      : [];
    const yFor = (pitch: number | null): number => {
      if (pitch === null) return innerTop + innerH * 0.35;
      if (track.isDrums) return innerTop + (drumLanes.indexOf(pitch) / Math.max(1, drumLanes.length)) * innerH;
      const r = track.pitchRange;
      if (!r || r.high === r.low) return innerTop + innerH * 0.45;
      return innerTop + (1 - (pitch - r.low) / (r.high - r.low)) * (innerH - 2);
    };
    const noteH = track.isDrums ? Math.max(1.5, innerH / Math.max(1, drumLanes.length) - 0.5) : 2;
    g.fillStyle = '#ffffff';
    for (const clip of track.clips) {
      g.globalAlpha = (peaks ? 0.6 : 0.8) * alpha;
      for (const n of clip.notes) {
        const nx = (n.start / BEATS_PER_BAR) * px;
        const nw = Math.max(1.2, (n.length / BEATS_PER_BAR) * px - 0.5);
        g.fillRect(nx, yFor(n.pitch), nw, n.pitch === null ? innerH * 0.3 : noteH);
      }
    }
    g.globalAlpha = 1;
  }, [track, model, px, width, peaks, binSec, meterMax, secondsPerBar, dimmed, selectedSection, ROW_H]);

  return <canvas ref={ref} style={{ width, height: ROW_H }} className="block" aria-label={`${track.name}: ${track.clips.length} sections`} />;
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.roundRect(x, y, w, h, Math.min(r, w / 2));
}

function roundRectTop(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  const rr = Math.min(r, w / 2);
  g.roundRect(x, y, w, h, [rr, rr, 0, 0]);
}
