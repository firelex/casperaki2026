import { useMemo, useRef, useState } from 'react';
import type { MouseEvent } from 'react';

import { useSession } from '../state/session';
import {
  summarizeSegmentPatterns,
  summarizeStructure,
  type SegmentSummary,
  type InstrumentPatternSummary,
} from '../types/song';

/**
 * Timeline tab.
 *
 * Mirrors `rory-fe/src/views/Timeline.vue`: horizontally scrollable
 * arrangement, one wide `.section` per song segment, each with stacked
 * pattern rows + chord overlay. Patterns are rendered from the brain's
 * per-instrument overrides; mute/edit/delete buttons are chrome only
 * for now (deletions and mutations land with M2 — docs/54).
 *
 * Drag-scrolling is supported (rory's mousedown→mousemove pattern).
 */
export function TimelineView() {
  const { viewSong, activeSegment, setActiveSegment } = useSession();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const dragState = useRef<{ startX: number; scrollLeft: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const segments = useMemo(
    () => (viewSong ? summarizeStructure(viewSong) : []),
    [viewSong],
  );

  if (!viewSong) {
    return (
      <div className="h-full flex items-center justify-center text-muted text-[15px]">
        No song loaded.
      </div>
    );
  }

  const onMouseDown = (e: MouseEvent<HTMLDivElement>) => {
    if (!scrollerRef.current) return;
    if ((e.target as HTMLElement).closest('button')) return;
    dragState.current = {
      startX: e.clientX,
      scrollLeft: scrollerRef.current.scrollLeft,
    };
    setIsDragging(true);
  };

  const onMouseMove = (e: MouseEvent<HTMLDivElement>) => {
    if (!dragState.current || !scrollerRef.current) return;
    const dx = e.clientX - dragState.current.startX;
    scrollerRef.current.scrollLeft = dragState.current.scrollLeft - dx;
  };

  const stopDrag = () => {
    dragState.current = null;
    setIsDragging(false);
  };

  return (
    <div
      ref={scrollerRef}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={stopDrag}
      onMouseLeave={stopDrag}
      className={`h-full overflow-x-auto overflow-y-hidden pl-12 pr-32 no-scrollbar select-none ${
        isDragging ? 'cursor-grabbing' : 'cursor-grab'
      }`}
    >
      <div className="flex items-stretch h-full">
        {segments.map((seg) => (
          <TimelineSection
            key={seg.name}
            song={viewSong}
            seg={seg}
            active={seg.name === activeSegment}
            onSelect={() => setActiveSegment(seg.name)}
          />
        ))}
      </div>
    </div>
  );
}

function TimelineSection({
  song,
  seg,
  active,
  onSelect,
}: {
  song: import('@casperaki/song-schema').Song;
  seg: SegmentSummary;
  active: boolean;
  onSelect(): void;
}) {
  const patterns = useMemo(() => summarizeSegmentPatterns(song, seg.name), [song, seg.name]);
  const width = Math.max(220, seg.bars * 32);

  return (
    <section
      style={{ width }}
      onClick={onSelect}
      aria-pressed={active}
      className={`shrink-0 flex flex-col pt-6 px-3 pb-10 border-r border-line/40 transition-colors relative ${
        active
          ? 'bg-accent/10 shadow-[inset_0_2px_0_var(--color-accent)]'
          : 'hover:bg-white/[0.02]'
      }`}
    >
      <header className="flex items-center justify-between mb-3 px-1">
        <h3 className="text-white text-[14px] font-semibold uppercase tracking-wide truncate">
          {seg.name}
        </h3>
        <span className="text-[10px] uppercase tracking-[0.18em] text-dim font-semibold">
          {seg.bars} bars
        </span>
      </header>

      <div className="text-[11px] uppercase tracking-wider text-dim font-semibold mb-2 flex items-center justify-between">
        <span>
          Patterns <span className="text-white/80 ml-1">{patterns.length}</span>
        </span>
      </div>

      <div className="flex flex-col gap-1.5">
        {patterns.length === 0 ? (
          <EmptyRow />
        ) : (
          patterns.map((p) => <PatternRow key={p.instrument} pattern={p} />)
        )}
        <button
          type="button"
          disabled
          className="h-9 rounded-[10px] flex items-center justify-center text-white/55 text-[12px] uppercase tracking-wider"
          style={{
            background: 'rgba(38, 43, 51, 0.35)',
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04)',
          }}
        >
          + add pattern
        </button>
      </div>

      <div className="text-[11px] uppercase tracking-wider text-dim font-semibold mt-5 mb-2">
        Chords
      </div>
      <div
        className="grid gap-1"
        style={{ gridTemplateColumns: `repeat(${Math.min(seg.bars, 8)}, minmax(0, 1fr))` }}
      >
        {seg.chordsByBar.slice(0, 8).map((bar, i) => (
          <div
            key={i}
            className="rounded bg-black/30 px-1.5 py-1 text-[10px] font-mono text-white/75 truncate"
            title={bar.join(' · ')}
          >
            {bar[0] ?? '·'}
          </div>
        ))}
      </div>
    </section>
  );
}

function PatternRow({ pattern }: { pattern: InstrumentPatternSummary }) {
  const color = familyColor(pattern.instrument);
  return (
    <div
      className="group relative flex items-center gap-2 px-3 h-[44px] rounded-[12px] overflow-hidden"
      style={{
        background: 'rgba(57, 57, 68, 0.49)',
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04)',
      }}
    >
      <span
        className="h-2.5 w-2.5 rounded-full shrink-0"
        style={{ background: color }}
        aria-hidden="true"
      />
      <span className="text-[13px] text-white truncate flex-1">{pattern.instrument}</span>
      <span className="text-[10px] font-mono text-white/40">{pattern.totalEvents}</span>
      <div
        className="absolute inset-0 flex items-center justify-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity"
        style={{ background: 'rgba(24, 27, 32, 0.92)' }}
      >
        <RowBtn label="Edit" disabled />
        <RowBtn label="Mute" disabled />
        <RowBtn label="Delete" disabled />
      </div>
    </div>
  );
}

function RowBtn({ label, disabled }: { label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      className={`text-[10px] uppercase tracking-wider font-semibold px-2 h-7 rounded transition-colors ${
        disabled
          ? 'text-white/40 cursor-not-allowed'
          : 'text-white hover:bg-white/10'
      }`}
    >
      {label}
    </button>
  );
}

function EmptyRow() {
  return (
    <div className="h-[44px] rounded-[12px] flex items-center justify-center text-[12px] text-dim border border-dashed border-line/60">
      No overrides
    </div>
  );
}

function familyColor(name: string): string {
  const key = name.toLowerCase();
  if (key.startsWith('drum')) return 'var(--color-c0)';
  if (key.startsWith('bass')) return 'var(--color-c1)';
  if (key.startsWith('key')) return 'var(--color-c2)';
  if (key.startsWith('pad')) return 'var(--color-c3)';
  if (key.includes('vocal')) return 'var(--color-c4)';
  return 'var(--color-c5)';
}
