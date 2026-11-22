import { beginEdgeDrag, type BarRange } from './rangeDrag';

/**
 * A time selection drawn over a timeline: a tinted band (blue while it
 * loops) with a grab handle on each edge to move that edge. Units are the
 * timeline's own (bars in the sequencer, beats in the detail editor); the
 * band sits inside a positioned container whose left edge + `offsetPx` is 0.
 * Selections are made with beginRangeDrag on the timeline's surfaces.
 */
export function SelectionOverlay({
  range,
  pxPerUnit,
  total,
  offsetPx = 0,
  top = 0,
  looping,
  originX,
  snap,
  onChange,
  zIndex = 5,
}: {
  range: BarRange;
  pxPerUnit: number;
  /** Length of the timeline in units. */
  total: number;
  offsetPx?: number;
  top?: number;
  looping: boolean;
  /** Screen x of unit 0 (read when an edge drag moves). */
  originX(): number;
  snap?(value: number, exact: boolean): number;
  onChange(range: BarRange): void;
  zIndex?: number;
}) {
  return (
    <>
      <div
        className={`pointer-events-none absolute border-x ${looping ? 'border-sky-300 bg-sky-400/[0.16]' : 'border-white/70 bg-white/[0.12]'}`}
        style={{ left: offsetPx + range.start * pxPerUnit, width: (range.end - range.start) * pxPerUnit, top, bottom: 0, zIndex }}
        aria-hidden="true"
      />
      {([0, 1] as const).map((i) => (
        <div
          key={i}
          className="absolute w-[11px] cursor-ew-resize"
          style={{ left: offsetPx + (i === 0 ? range.start : range.end) * pxPerUnit - 5, top, bottom: 0, zIndex: zIndex + 1 }}
          title="Drag to move this edge of the selection"
          onPointerDown={(e) =>
            beginEdgeDrag(e, {
              originX,
              pxPerBar: pxPerUnit,
              totalBars: total,
              fixed: i === 0 ? range.end : range.start,
              onRange: onChange,
              ...(snap ? { snap } : {}),
            })
          }
        />
      ))}
    </>
  );
}
