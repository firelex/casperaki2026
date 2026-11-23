import { useRef } from 'react';

/** Pro mode for a device panel: its knob positions (canvas pixels) and what a turn does. */
export interface DeviceProControls {
  /** The standard mix's values (raw 0..1), to mark what changed and for double-click. */
  readonly standard: readonly number[];
  onChange(index: number, value: number): void;
}

/** One knob drawn on the panel's canvas: centre and the parameter it shows (raw 0..1 = its position). */
export interface KnobSpot {
  readonly cx: number;
  readonly cy: number;
  readonly index: number;
  readonly name: string;
}

const R = 24; // grab area radius (the drawn knob is 20)
const DRAG_PX = 200; // a 200 px drag turns a knob over its whole range

/**
 * Pro mode: makes the knobs drawn on a device canvas turnable. Drag up or down
 * (Shift: finer), arrow keys, double-click for the standard value. Sits over the
 * canvas; the panel redraws the knobs from the new values.
 */
export function KnobOverlay({ knobs, values, pro }: { knobs: readonly KnobSpot[]; values: readonly number[]; pro: DeviceProControls }) {
  const drag = useRef<{ index: number; y0: number; v0: number } | undefined>(undefined);
  const set = (index: number, v: number) => pro.onChange(index, Math.max(0, Math.min(1, Math.round(v * 1000) / 1000)));
  return (
    <>
      {knobs.map((k) => {
        const v = values[k.index] ?? 0;
        const changed = Math.abs(v - (pro.standard[k.index] ?? 0)) > 1e-6;
        return (
          <span
            key={k.index}
            role="slider"
            tabIndex={0}
            aria-label={k.name}
            aria-valuemin={0}
            aria-valuemax={1}
            aria-valuenow={v}
            title={`${k.name}: drag up or down (Shift: finer); double-click for the standard value`}
            className={`absolute cursor-ns-resize touch-none rounded-full outline-none ring-[#ffb347] hover:ring-1 focus-visible:ring-2 ${changed ? 'ring-1' : ''}`}
            style={{ left: k.cx - R, top: k.cy - R, width: R * 2, height: R * 2 }}
            onPointerDown={(e) => {
              e.preventDefault(); // no text selection while dragging
              e.currentTarget.focus();
              e.currentTarget.setPointerCapture(e.pointerId);
              drag.current = { index: k.index, y0: e.clientY, v0: v };
            }}
            onPointerMove={(e) => {
              const d = drag.current;
              if (!d || d.index !== k.index) return;
              set(k.index, d.v0 + ((d.y0 - e.clientY) / DRAG_PX) * (e.shiftKey ? 0.1 : 1));
            }}
            onPointerUp={(e) => {
              drag.current = undefined;
              e.currentTarget.releasePointerCapture(e.pointerId);
            }}
            onDoubleClick={() => set(k.index, pro.standard[k.index] ?? 0)}
            onKeyDown={(e) => {
              const step = e.shiftKey ? 0.001 : 0.01;
              if (e.key === 'ArrowUp' || e.key === 'ArrowRight') set(k.index, v + step);
              else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') set(k.index, v - step);
              else return;
              e.preventDefault();
            }}
          />
        );
      })}
    </>
  );
}
