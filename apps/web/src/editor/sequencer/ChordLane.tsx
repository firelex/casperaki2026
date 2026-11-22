import { memo, useMemo } from 'react';

import type { SequencerModel } from '../sequencerModel';
import { chordCellAt, chordCells, chordLabel, type ChordCell } from './chordCells';
import { beginRangeDrag, snapBar, type BarRange } from './rangeDrag';

/**
 * The chord lane under the ruler: the chord symbols on the bar timeline,
 * repeated chords shown once across their bars, labels shortened when a cell
 * is too narrow (the full symbol is in the tooltip). The chord under the
 * playhead is lit. Click to play from a chord, drag to select a range, like
 * the bars|beats ruler.
 */
export function ChordLane({
  model,
  px,
  playheadBar,
  onSeekBar,
  onRangeChange,
}: {
  model: SequencerModel;
  px: number;
  /** Playhead position in bars, when the playhead is shown. */
  playheadBar: number | undefined;
  onSeekBar(bar: number): void;
  onRangeChange(range: BarRange): void;
}) {
  const cells = useMemo(() => chordCells(model.sections), [model.sections]);
  const active = playheadBar === undefined ? -1 : chordCellAt(cells, playheadBar);
  const lit = active >= 0 ? cells[active]! : undefined;

  return (
    <div
      className="relative h-full shrink-0 cursor-pointer select-none overflow-hidden bg-[#202125]"
      style={{ width: model.totalBars * px }}
      onPointerDown={(e) =>
        beginRangeDrag(e, {
          el: e.currentTarget,
          pxPerBar: px,
          totalBars: model.totalBars,
          onRange: onRangeChange,
          onClick: (bar, ev) => {
            const i = chordCellAt(cells, bar);
            onSeekBar(i >= 0 ? cells[i]!.start : snapBar(bar, px, model.totalBars, ev.altKey));
          },
        })
      }
      title="Click a chord to play from it, drag to select a range"
      aria-label="Chords"
    >
      <Cells cells={cells} sections={model.sections} px={px} />
      {lit ? (
        <span
          className="pointer-events-none absolute top-0 flex h-full items-center overflow-hidden border-l-2 bg-white/[0.16] px-[3px] font-mono text-[11px] font-semibold text-white"
          style={{
            left: lit.start * px,
            width: (lit.end - lit.start) * px,
            borderColor: model.sections[lit.section]!.color,
            background: `color-mix(in srgb, ${model.sections[lit.section]!.color} 50%, transparent)`,
          }}
          aria-hidden="true"
        >
          <span className="whitespace-nowrap">{chordLabel(lit.chord, (lit.end - lit.start) * px)}</span>
        </span>
      ) : null}
      {playheadBar !== undefined ? (
        <span className="pointer-events-none absolute top-0 h-full w-px bg-accent" style={{ left: playheadBar * px }} aria-hidden="true" />
      ) : null}
    </div>
  );
}

/** The cells themselves, apart from the playhead so playback does not redraw them. */
const Cells = memo(function Cells({
  cells,
  sections,
  px,
}: {
  cells: readonly ChordCell[];
  sections: SequencerModel['sections'];
  px: number;
}) {
  return (
    <>
      {cells.map((c) => {
        const w = (c.end - c.start) * px;
        return (
          <span
            key={c.start}
            className="absolute top-0 flex h-full items-center overflow-hidden border-l border-white/20 px-[3px] font-mono text-[11px] text-white/75"
            style={{
              left: c.start * px,
              width: w,
              background: `color-mix(in srgb, ${sections[c.section]!.color} 10%, transparent)`,
            }}
            title={c.chord}
          >
            <span className="whitespace-nowrap">{chordLabel(c.chord, w)}</span>
          </span>
        );
      })}
    </>
  );
});
