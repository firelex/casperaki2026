import type { PointerEvent as ReactPointerEvent } from 'react';

import { snapUnit } from './layout';

export interface BarRange {
  /** In bars from the song start (fractions are beats). */
  readonly start: number;
  readonly end: number;
}

/** Movement (px) before a press counts as a drag rather than a click. */
const DRAG_THRESHOLD = 4;

/** Snap a bar position to the zoom's grid (a beat or a bar), unless `exact`. */
export function snapBar(bar: number, pxPerBar: number, totalBars: number, exact: boolean): number {
  const clamped = Math.max(0, Math.min(totalBars, bar));
  if (exact) return clamped;
  const u = snapUnit(pxPerBar);
  return Math.max(0, Math.min(totalBars, Math.round(clamped / u) * u));
}

/**
 * Press on a timeline surface (ruler or track lane): dragging sideways
 * selects a range of bars, as in a DAW; a press that doesn't move is a
 * click. Positions are measured against `el`, whose left edge is bar 0.
 * Alt turns snapping off.
 */
export function beginRangeDrag(
  e: ReactPointerEvent<HTMLElement>,
  opts: {
    el: HTMLElement;
    pxPerBar: number;
    totalBars: number;
    onRange(range: BarRange): void;
    onClick(bar: number, ev: PointerEvent): void;
  },
): void {
  if (e.button !== 0) return;
  const { el, pxPerBar, totalBars } = opts;
  const x0 = e.clientX;
  const barAt = (clientX: number) => (clientX - el.getBoundingClientRect().left) / pxPerBar;
  const anchorRaw = barAt(x0);
  let dragging = false;
  const prevCursor = document.body.style.cursor;

  const move = (ev: PointerEvent) => {
    if (!dragging && Math.abs(ev.clientX - x0) < DRAG_THRESHOLD) return;
    if (!dragging) {
      dragging = true;
      document.body.style.cursor = 'col-resize';
    }
    ev.preventDefault();
    const a = snapBar(anchorRaw, pxPerBar, totalBars, ev.altKey);
    const b = snapBar(barAt(ev.clientX), pxPerBar, totalBars, ev.altKey);
    if (a !== b) opts.onRange({ start: Math.min(a, b), end: Math.max(a, b) });
  };
  const up = (ev: PointerEvent) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    document.body.style.cursor = prevCursor;
    if (!dragging) opts.onClick(Math.max(0, Math.min(totalBars, barAt(ev.clientX))), ev);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}
