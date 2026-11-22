import { useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

import { BEATS_PER_BAR, type SequencerModel } from '../sequencerModel';
import { BARS_H, clockLabel, gridStep, LOOP_H, MARKERS_H, snapUnit, TIME_H } from './layout';

import { beginEdgeDrag, beginRangeDrag, type BarRange } from './rangeDrag';

export type { BarRange };

type Drag =
  | { mode: 'new'; anchor: number }
  | { mode: 'start' | 'end'; other: number }
  | { mode: 'move'; grab: number; length: number };

/**
 * The time ruler above the tracks, DAW style: section markers, a bars|beats
 * scale and a minutes:seconds scale (click either to jump there), and the
 * loop bar: drag across it to choose a range, drag its edges to change it,
 * drag the middle to move it, double-click a section to take its length.
 */
export function Ruler({
  model,
  px,
  secondsPerBar,
  activeSegment,
  range,
  looping,
  onSeekBar,
  onSelectSection,
  onRangeChange,
}: {
  model: SequencerModel;
  px: number;
  secondsPerBar: number;
  activeSegment: string | undefined;
  range: BarRange | undefined;
  looping: boolean;
  onSeekBar(bar: number): void;
  onSelectSection(name: string): void;
  onRangeChange(range: BarRange | undefined): void;
}) {
  const width = model.totalBars * px;
  const loopRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | undefined>(undefined);
  const { beats, bars: barEvery } = gridStep(px);
  const labelEvery = px >= 34 ? 1 : px >= 16 ? 2 : px >= 9 ? 4 : 8;

  const barAt = (clientX: number, el: HTMLElement) =>
    Math.max(0, Math.min(model.totalBars, (clientX - el.getBoundingClientRect().left) / px));
  const snap = (bar: number, exact: boolean) => {
    if (exact) return bar;
    const u = snapUnit(px);
    return Math.max(0, Math.min(model.totalBars, Math.round(bar / u) * u));
  };

  const onLoopDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const bar = barAt(e.clientX, el);
    const edge = 6 / px;
    if (range && Math.abs(bar - range.start) <= edge) setDrag({ mode: 'start', other: range.end });
    else if (range && Math.abs(bar - range.end) <= edge) setDrag({ mode: 'end', other: range.start });
    else if (range && bar > range.start && bar < range.end) setDrag({ mode: 'move', grab: bar - range.start, length: range.end - range.start });
    else setDrag({ mode: 'new', anchor: snap(bar, e.altKey) });
  };
  const onLoopMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    const bar = snap(barAt(e.clientX, e.currentTarget), e.altKey);
    if (drag.mode === 'move') {
      const start = Math.max(0, Math.min(model.totalBars - drag.length, snap(barAt(e.clientX, e.currentTarget) - drag.grab, e.altKey)));
      onRangeChange({ start, end: start + drag.length });
      return;
    }
    const other = drag.mode === 'new' ? drag.anchor : drag.other;
    if (bar === other) return;
    onRangeChange({ start: Math.min(bar, other), end: Math.max(bar, other) });
  };
  const onLoopUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    // A click without a drag clears the range.
    if (drag.mode === 'new' && snap(barAt(e.clientX, e.currentTarget), e.altKey) === drag.anchor) onRangeChange(undefined);
    setDrag(undefined);
  };

  const barMarks: number[] = [];
  for (let b = 0; b < model.totalBars; b += labelEvery) barMarks.push(b);
  const totalSec = model.totalBars * secondsPerBar;
  const secEvery = niceSeconds(secondsPerBar / px);
  const timeMarks: number[] = [];
  for (let t = 0; t < totalSec; t += secEvery) timeMarks.push(t);

  const rangeLabel = range ? `${fmtBar(range.start)} – ${fmtBar(range.end)}` : '';

  return (
    <div ref={rootRef} className="relative shrink-0 select-none" style={{ width }}>
      {/* Range start / end markers across the ruler. */}
      {range ? (
        <>
          {[range.start, range.end].map((b, i) => (
            <span
              key={i}
              className={`pointer-events-none absolute top-0 bottom-0 z-20 w-px ${looping ? 'bg-sky-300' : 'bg-white/80'}`}
              style={{ left: b * px }}
            >
              <span
                className={`absolute top-[22px] h-0 w-0 border-y-[5px] border-y-transparent ${
                  i === 0 ? `left-0 border-l-[7px] ${looping ? 'border-l-sky-300' : 'border-l-white/80'}` : `right-0 border-r-[7px] ${looping ? 'border-r-sky-300' : 'border-r-white/80'}`
                }`}
              />
              {/* Grab area: drag to move this edge. */}
              <span
                className="pointer-events-auto absolute -left-[5px] top-0 bottom-0 w-[11px] cursor-ew-resize"
                title="Drag to move this edge of the selection"
                onPointerDown={(e) =>
                  beginEdgeDrag(e, {
                    originX: () => rootRef.current!.getBoundingClientRect().left,
                    pxPerBar: px,
                    totalBars: model.totalBars,
                    fixed: i === 0 ? range.end : range.start,
                    onRange: onRangeChange,
                  })
                }
              />
            </span>
          ))}
        </>
      ) : null}
      {/* Section markers. */}
      <div className="relative border-b border-black/50" style={{ height: MARKERS_H }}>
        {model.sections.map((s) => (
          <button
            key={s.name}
            type="button"
            onClick={() => {
              onSelectSection(s.name);
              onSeekBar(s.startBar);
            }}
            className="absolute top-0 flex items-center overflow-hidden border-l-2 px-1.5 text-left"
            style={{
              left: s.startBar * px,
              width: s.bars * px,
              height: MARKERS_H,
              borderColor: s.color,
              background: `color-mix(in srgb, ${s.color} ${s.name === activeSegment ? 50 : 24}%, transparent)`,
            }}
            title={`${s.name}: bars ${s.startBar + 1}–${s.startBar + s.bars} (click to play from here)`}
          >
            {s.bars * px > 40 ? <span className="truncate text-[11px] font-semibold text-white">{s.name}</span> : null}
          </button>
        ))}
      </div>

      {/* Bars|beats. */}
      <div
        className="relative cursor-pointer border-b border-black/50 bg-[#2c2d32]"
        style={{ height: BARS_H }}
        onPointerDown={(e) =>
          beginRangeDrag(e, {
            el: e.currentTarget,
            pxPerBar: px,
            totalBars: model.totalBars,
            onRange: onRangeChange,
            onClick: (bar, ev) => onSeekBar(snap(bar, ev.altKey)),
          })
        }
        title="Click to play from here, drag to select a range"
      >
        {beats
          ? Array.from({ length: model.totalBars * BEATS_PER_BAR }, (_, b) =>
              b % BEATS_PER_BAR ? (
                <span
                  key={b}
                  className="absolute bottom-0 h-[5px] w-px bg-white/25"
                  style={{ left: (b / BEATS_PER_BAR) * px }}
                />
              ) : null,
            )
          : null}
        {Array.from({ length: Math.ceil(model.totalBars / barEvery) }, (_, i) => i * barEvery).map((b) => (
          <span key={`t${b}`} className="absolute bottom-0 h-[9px] w-px bg-white/40" style={{ left: b * px }} />
        ))}
        {barMarks.map((b) => (
          <span
            key={b}
            className="absolute top-0 h-full border-l border-white/45 pl-1 font-mono text-[10px] leading-[14px] text-white/75"
            style={{ left: b * px }}
          >
            {b + 1}
          </span>
        ))}
      </div>

      {/* Minutes:seconds. */}
      <div
        className="relative cursor-pointer border-b border-black/50 bg-[#25262a]"
        style={{ height: TIME_H }}
        onPointerDown={(e) =>
          beginRangeDrag(e, {
            el: e.currentTarget,
            pxPerBar: px,
            totalBars: model.totalBars,
            onRange: onRangeChange,
            onClick: (bar) => onSeekBar(bar),
          })
        }
        title="Click to play from here, drag to select a range"
      >
        {timeMarks.map((t) => (
          <span
            key={t}
            className="absolute top-0 h-full border-l border-white/20 pl-1 font-mono text-[9px] leading-[15px] text-white/45"
            style={{ left: (t / secondsPerBar) * px }}
          >
            {clockLabel(t)}
          </span>
        ))}
      </div>

      {/* Loop / selection bar. */}
      <div
        ref={loopRef}
        className="relative cursor-crosshair bg-[#1f2023]"
        style={{ height: LOOP_H }}
        onPointerDown={onLoopDown}
        onPointerMove={onLoopMove}
        onPointerUp={onLoopUp}
        onDoubleClick={(e) => {
          const bar = barAt(e.clientX, e.currentTarget);
          const s = model.sections.find((x) => bar >= x.startBar && bar < x.startBar + x.bars);
          if (s) onRangeChange({ start: s.startBar, end: s.startBar + s.bars });
        }}
        title="Drag to choose a range to loop (Alt: no snapping). Double-click: the section under the pointer."
        aria-label="Loop range"
      >
        {range ? (
          <div
            className={`absolute top-[2px] bottom-[2px] cursor-grab rounded-[3px] border ${
              looping ? 'border-sky-300 bg-sky-400/55' : 'border-white/50 bg-white/25'
            }`}
            style={{ left: range.start * px, width: Math.max(2, (range.end - range.start) * px) }}
          >
            <span className="absolute left-0 top-0 h-full w-[5px] cursor-ew-resize" />
            <span className="absolute right-0 top-0 h-full w-[5px] cursor-ew-resize" />
            {(range.end - range.start) * px > 90 ? (
              <span className="pointer-events-none absolute inset-0 truncate px-2 text-center font-mono text-[9px] leading-[11px] text-white">
                {rangeLabel}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Bar position as bars|beats ("9|1"), 1-based. */
export function fmtBar(bar: number): string {
  const whole = Math.floor(bar + 1e-6);
  const beat = Math.round((bar - whole) * BEATS_PER_BAR) + 1;
  return `${whole + 1}|${beat}`;
}

/** A readable spacing for time labels at `secPerPx`. */
function niceSeconds(secPerPx: number): number {
  const minPx = 56;
  for (const s of [1, 2, 5, 10, 15, 30, 60, 120]) if (s / secPerPx >= minPx) return s;
  return 300;
}
