import { sectionColor } from './sectionColor';
import { useMemo, useRef, useState } from 'react';
import type { DragEvent } from 'react';

import { useSession } from '../state/session';
import { summarizeStructure, type SegmentSummary } from '../types/song';
import type { EditCommand } from '../state/song-edit';

/**
 * Structure tab.
 *
 * Mirrors `rory-fe/src/views/Structure.vue`: horizontal row of
 * proportionally-sized colored section boxes. Each section is colored
 * by its `type` field (intro / verse / chorus / break / bridge / outro
 * — see rory's `.type-verse`, `.type-chorus`, `.type-break`).
 *
 * docs/54g — the section cards are now first-class editor surfaces:
 *
 *   - HTML5 drag/drop reorder via the explicit drag handle (⠿). A
 *     pre-drop indicator highlights the gap the segment will land in.
 *   - The card body carries an always-visible bar-count strip with
 *     ± controls (no hover required).
 *   - Move ◀/▶, Duplicate, Delete buttons live directly under the card
 *     instead of inside a hidden hover tooltip.
 *   - A persistent dirty banner is shown at the top of the view when
 *     the working song diverges from the brain-returned original.
 */
export function StructureView() {
  const { viewSong, activeSegment, setActiveSegment, applyEdit, editorDirty, editor } =
    useSession();
  const segments = useMemo(
    () => (viewSong ? summarizeStructure(viewSong) : []),
    [viewSong],
  );
  const totalBars = segments.reduce((sum, s) => sum + s.bars, 0);

  const [draggingName, setDraggingName] = useState<string | undefined>(undefined);
  const [dropIndex, setDropIndex] = useState<number | undefined>(undefined);
  const draggingNameRef = useRef<string | undefined>(undefined);

  if (!viewSong) {
    return (
      <div className="h-full flex items-center justify-center text-muted text-[15px]">
        No song loaded.
      </div>
    );
  }

  const run = (command: EditCommand) => applyEdit(command);
  const validationError =
    editor?.validation.ok === false ? editor.validation.error : undefined;
  const lastError = editor?.lastError;
  const inlineError = validationError ?? lastError;

  const handleDragStart = (name: string) => (e: DragEvent<HTMLElement>) => {
    setDraggingName(name);
    draggingNameRef.current = name;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      try {
        e.dataTransfer.setData('text/plain', name);
      } catch {
        // Firefox requires setData to start a drag; failure is non-fatal.
      }
    }
  };
  const handleDragEnd = () => {
    setDraggingName(undefined);
    draggingNameRef.current = undefined;
    setDropIndex(undefined);
  };
  const handleSlotEnter = (index: number) => () => {
    if (!draggingNameRef.current) return;
    setDropIndex(index);
  };
  const handleSlotOver = (e: DragEvent<HTMLElement>) => {
    if (!draggingNameRef.current) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  };
  const handleDrop = (slotIndex: number) => (e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    const name = draggingNameRef.current;
    setDraggingName(undefined);
    draggingNameRef.current = undefined;
    setDropIndex(undefined);
    if (!name) return;
    const fromIdx = segments.findIndex((s) => s.name === name);
    if (fromIdx < 0) return;
    // The dragged segment was conceptually lifted out of the row before
    // landing at `slotIndex`. If the lift was before the slot, the
    // resulting target is one index lower.
    const target = slotIndex > fromIdx ? slotIndex - 1 : slotIndex;
    if (target === fromIdx) return;
    run({ kind: 'moveSegment', segmentName: name, targetIndex: target });
  };

  return (
    <div className="flex flex-col h-full text-white">
      <div className="px-[8vw] pt-[4vh] text-center">
        <h2 className="text-[26px] font-semibold leading-tight">
          Edit song structure
        </h2>
        <p className="text-muted text-[13px] mt-2">
          {segments.length} segments · {totalBars} bars · {fmtDuration(totalBars, viewSong.bpm)} ·{' '}
          drag handles to reorder · keyboard ⌃Z / ⌃Y to undo/redo
        </p>
      </div>

      {(editorDirty || inlineError) && (
        <div className="mx-[6vw] mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-accent/40 bg-accent/10 px-4 py-2 text-[12px] text-white/85">
          <div className="flex items-center gap-3">
            <span className="h-2 w-2 rounded-full bg-accent animate-pulse" aria-hidden />
            <span>
              {editorDirty ? (
                <>
                  <span className="text-accent font-semibold uppercase tracking-wider text-[11px] mr-2">
                    Edited
                  </span>
                  Working copy differs from the brain-generated original.
                </>
              ) : null}
              {inlineError ? (
                <span className="text-err font-mono ml-2">{inlineError}</span>
              ) : null}
            </span>
          </div>
          {editorDirty ? (
            <button
              type="button"
              onClick={() => run({ kind: 'revertToOriginal' })}
              className="h-7 px-3 rounded-md text-[10.5px] uppercase tracking-wider font-semibold text-white/80 border border-line hover:border-accent hover:text-white"
              title="Discard edits and restore the brain-generated song"
            >
              Revert
            </button>
          ) : null}
        </div>
      )}

      <div className="flex-1 min-h-0 flex items-center px-[4vw]">
        <div
          className="flex items-stretch w-full gap-2 px-2"
          onDragLeave={(e) => {
            // Only clear if the pointer left the container, not just
            // moved between children.
            if (e.currentTarget === e.target) setDropIndex(undefined);
          }}
        >
          {/* Pre-first slot: drop here to make the segment first. */}
          <DropSlot
            active={dropIndex === 0 && draggingName !== undefined}
            onEnter={handleSlotEnter(0)}
            onOver={handleSlotOver}
            onDrop={handleDrop(0)}
          />
          {segments.map((seg, idx) => (
            <Fragment key={seg.name}>
              <SectionGroup
                seg={seg}
                widthPct={(seg.bars / Math.max(1, totalBars)) * 100}
                active={seg.name === activeSegment}
                isDragging={draggingName === seg.name}
                onSelect={() => setActiveSegment(seg.name)}
                isFirst={idx === 0}
                isLast={idx === segments.length - 1}
                canDelete={segments.length > 1}
                onDragStart={handleDragStart(seg.name)}
                onDragEnd={handleDragEnd}
                onMoveLeft={
                  idx > 0
                    ? () =>
                        run({
                          kind: 'reorderSegment',
                          segmentName: seg.name,
                          direction: 'left',
                        })
                    : undefined
                }
                onMoveRight={
                  idx < segments.length - 1
                    ? () =>
                        run({
                          kind: 'reorderSegment',
                          segmentName: seg.name,
                          direction: 'right',
                        })
                    : undefined
                }
                onDuplicate={() =>
                  run({ kind: 'duplicateSegment', segmentName: seg.name })
                }
                onDelete={() =>
                  run({ kind: 'deleteSegment', segmentName: seg.name })
                }
                onChangeBars={(delta) =>
                  run({
                    kind: 'changeBarCount',
                    segmentName: seg.name,
                    delta,
                  })
                }
              />
              <DropSlot
                active={dropIndex === idx + 1 && draggingName !== undefined}
                onEnter={handleSlotEnter(idx + 1)}
                onOver={handleSlotOver}
                onDrop={handleDrop(idx + 1)}
              />
            </Fragment>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-center gap-10 pb-8">
        <BottomBtn label="Generate a new structure" glyph="⟳" disabled />
        <BottomBtn label="Optimise song length" glyph="↔" disabled />
      </div>
    </div>
  );
}

// Local fragment helper so the map callback can return paired drop-slot
// + section without an extra wrapper div breaking flex sizing.
function Fragment({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

function DropSlot({
  active,
  onEnter,
  onOver,
  onDrop,
}: {
  active: boolean;
  onEnter(): void;
  onOver(e: DragEvent<HTMLElement>): void;
  onDrop(e: DragEvent<HTMLElement>): void;
}) {
  return (
    <div
      onDragEnter={onEnter}
      onDragOver={onOver}
      onDrop={onDrop}
      className={`shrink-0 self-stretch transition-all rounded-full ${
        active ? 'w-3 bg-accent shadow-[0_0_14px_rgba(255,77,77,0.6)]' : 'w-1.5 bg-transparent'
      }`}
      aria-hidden="true"
    />
  );
}

function SectionGroup({
  seg,
  widthPct,
  active,
  isDragging,
  onSelect,
  isFirst,
  isLast,
  canDelete,
  onDragStart,
  onDragEnd,
  onMoveLeft,
  onMoveRight,
  onDuplicate,
  onDelete,
  onChangeBars,
}: {
  seg: SegmentSummary;
  widthPct: number;
  active: boolean;
  isDragging: boolean;
  onSelect(): void;
  isFirst: boolean;
  isLast: boolean;
  canDelete: boolean;
  onDragStart(e: DragEvent<HTMLElement>): void;
  onDragEnd(): void;
  onMoveLeft?: (() => void) | undefined;
  onMoveRight?: (() => void) | undefined;
  onDuplicate(): void;
  onDelete(): void;
  onChangeBars(delta: number): void;
}) {
  const bg = sectionColor(seg.kind ?? seg.name);
  // Mute (don't void) buttons that hold useless info while dragging so the
  // visual swap feels like the segment is "lifted" out of the row.
  return (
    <div
      className={`relative flex flex-col items-stretch min-w-[88px] transition-opacity ${
        isDragging ? 'opacity-30' : 'opacity-100'
      }`}
      style={{ width: `${widthPct}%` }}
    >
      <div className="flex items-center justify-between mb-1.5 px-1">
        <button
          type="button"
          draggable
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onClick={(e) => e.stopPropagation()}
          className="h-5 px-1 text-white/55 hover:text-white text-[14px] cursor-grab active:cursor-grabbing select-none"
          title="Drag to reorder segment"
          aria-label={`Drag handle for segment ${seg.name}`}
        >
          ⠿
        </button>
        <span className="text-white text-[12px] font-semibold truncate flex-1 text-center">
          {seg.name}
        </span>
        <span className="text-[10px] font-mono text-white/55 w-[26px] text-right">
          {seg.bars}b
        </span>
      </div>

      <button
        type="button"
        onClick={onSelect}
        className={`h-[56px] rounded-[10px] flex items-center justify-center text-white text-[11px] font-semibold uppercase tracking-wider transition-transform ${
          active ? 'scale-[1.04] ring-2 ring-white/60' : 'hover:brightness-110'
        }`}
        style={{
          background: bg,
          boxShadow: 'inset 0 2px 0 rgba(255,255,255,0.22)',
        }}
      >
        {seg.kind ?? ''}
      </button>

      <div className="mt-1.5 flex items-center justify-between gap-1 px-0.5">
        <CardBtn
          label="−"
          disabled={seg.bars <= 1}
          title={seg.bars <= 1 ? 'Already at minimum' : 'Remove one bar'}
          onClick={() => onChangeBars(-1)}
        />
        <span
          className="font-mono text-[10.5px] text-white/85 flex-1 text-center"
          title="Bar count for this segment"
        >
          {seg.bars} bar{seg.bars === 1 ? '' : 's'}
        </span>
        <CardBtn label="+" title="Add one bar" onClick={() => onChangeBars(1)} />
      </div>

      <div className="mt-1 grid grid-cols-4 gap-1 px-0.5">
        <CardBtn
          label="◀"
          title="Move segment left"
          disabled={!onMoveLeft || isFirst}
          onClick={onMoveLeft}
        />
        <CardBtn
          label="▶"
          title="Move segment right"
          disabled={!onMoveRight || isLast}
          onClick={onMoveRight}
        />
        <CardBtn label="⎘" title="Duplicate segment" onClick={onDuplicate} />
        <CardBtn
          label="✕"
          title={canDelete ? 'Delete segment' : 'Cannot delete the last segment'}
          danger
          disabled={!canDelete}
          onClick={onDelete}
        />
      </div>
    </div>
  );
}

function CardBtn({
  label,
  onClick,
  disabled,
  title,
  danger,
}: {
  label: string;
  onClick?: (() => void) | undefined;
  disabled?: boolean;
  title?: string;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.();
      }}
      title={title}
      className={`h-6 rounded text-[10.5px] font-semibold leading-none transition-colors ${
        disabled
          ? 'text-white/25 border border-line/50 cursor-not-allowed'
          : danger
            ? 'text-white border border-accent/60 bg-accent/10 hover:bg-accent/25'
            : 'text-white/85 border border-line hover:border-accent hover:text-white'
      }`}
    >
      {label}
    </button>
  );
}


function fmtDuration(bars: number, bpm: number): string {
  const seconds = (bars * 4 * 60) / bpm;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

function BottomBtn({
  label,
  glyph,
  disabled,
}: {
  label: string;
  glyph: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      className={`h-12 flex items-center gap-3 px-6 rounded-full text-white text-[14px] font-semibold uppercase tracking-wide transition-colors ${
        disabled
          ? 'text-white/30 cursor-not-allowed border border-line/40'
          : 'bg-white/5 hover:bg-white/10'
      }`}
    >
      <span className="text-[20px]">{glyph}</span>
      <span>{label}</span>
    </button>
  );
}
