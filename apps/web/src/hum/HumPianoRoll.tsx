import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

import type { BeatNote } from '../api/hum';
import { midiName } from '../editor/sequencerModel';
import { KEY_COL_W } from './HumChordRow';
import { GRID, TOTAL_BEATS as DEFAULT_TOTAL_BEATS } from './melodyEdit';

const ROW_H = 14;
const MIN_ROWS = 18;
const LONG_PRESS_MS = 350;
const MOVE_PX = 4;
const isBlack = (p: number) => [1, 3, 6, 8, 10].includes(((p % 12) + 12) % 12);
const snap = (x: number) => Math.round(x / GRID) * GRID;
const NO_BARS: ReadonlySet<number> = new Set();

/** The pitch rows: the melody's range plus 4 semitones each side, at least MIN_ROWS. */
function rangeOf(melody: readonly BeatNote[]): { lo: number; hi: number } {
  const ps = melody.length ? melody.map((n) => n.midi) : [60, 72];
  let lo = Math.min(...ps) - 4;
  let hi = Math.max(...ps) + 4;
  while (hi - lo + 1 < MIN_ROWS) (hi - lo) % 2 ? lo-- : hi++;
  return { lo, hi };
}

interface Drag {
  readonly index: number;
  readonly pointerId: number;
  readonly pointerType: string;
  readonly x0: number;
  readonly y0: number;
  readonly beat0: number;
  readonly midi0: number;
  mode: 'pending' | 'move' | 'resize';
  /** Where the note is shown while dragging. */
  beat: number;
  midi: number;
  duration: number;
  timer: number | undefined;
}

/** What the hum page passes: the roll is editable. */
interface EditableProps {
  readOnly?: false;
  hummedBars: number;
  editedBars: ReadonlySet<number>;
  onAdd(beat: number, midi: number): void;
  onDelete(index: number): void;
  onMove(index: number, beat: number, midi: number): void;
  onResize(index: number, length: number): void;
  /** A pitch to sound briefly (a note dragged to a new pitch). */
  onPitch(midi: number): void;
  /** While a request runs: shown, not editable (its answer replaces the melody). */
  disabled: boolean;
}

/** Shown only (the melody library): no adding, deleting, moving or resizing; every note one colour. */
interface ReadOnlyProps {
  readOnly: true;
}

const READ_ONLY_NOTE = '#5aa9ff';

/**
 * The hum editor's piano roll: 8 bars (or `totalBeats`), one voice. Left click on an empty spot adds a note; right
 * click on a note deletes it; press and drag moves it; a long press (no movement for 350 ms), then drag, changes its
 * length. On a touch screen a tap selects a note and shows a delete button. Hummed bars have a lighter ground; notes
 * are red in hummed bars, amber in bars the user edited, blue where the melody was completed. With `readOnly` it only
 * shows the melody.
 */
export function HumPianoRoll(
  props: {
    melody: readonly BeatNote[];
    /** The player's position in beats, while playing. */
    playBeat: number | undefined;
    /** Length of the roll in beats (default 8 bars). */
    totalBeats?: number;
    /** The roll scrolls sideways inside a box (zoomed): the key column stays in view. */
    scrollable?: boolean;
  } & (EditableProps | ReadOnlyProps),
) {
  const { melody, playBeat, totalBeats: total = DEFAULT_TOTAL_BEATS, scrollable = false } = props;
  const edit = props.readOnly ? undefined : props;
  const hummedBars = edit?.hummedBars ?? 0;
  const editedBars = edit?.editedBars ?? NO_BARS;
  const disabled = edit?.disabled ?? false;
  const [range, setRange] = useState(() => rangeOf(melody));
  const [drag, setDrag] = useState<Drag | undefined>(undefined);
  const [selected, setSelected] = useState<number | undefined>(undefined);
  const gridRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | undefined>(undefined);

  // The rows grow to take in every note (never shrink while editing; a new version remounts this).
  useEffect(() => {
    const r = rangeOf(melody);
    setRange((cur) => (r.lo < cur.lo || r.hi > cur.hi ? { lo: Math.min(cur.lo, r.lo), hi: Math.max(cur.hi, r.hi) } : cur));
    setSelected(undefined);
  }, [melody]);

  const { lo, hi } = range;
  const rows = hi - lo + 1;
  const pitches = Array.from({ length: rows }, (_, i) => hi - i);
  const pct = (beat: number) => `${(beat / total) * 100}%`;

  const at = (e: { clientX: number; clientY: number }) => {
    const r = gridRef.current!.getBoundingClientRect();
    const beat = Math.max(0, Math.min(total - GRID, ((e.clientX - r.left) / r.width) * total));
    const midi = hi - Math.floor((e.clientY - r.top) / ROW_H);
    return { beat, midi: Math.max(lo, Math.min(hi, midi)) };
  };

  const setDragBoth = (d: Drag | undefined) => {
    dragRef.current = d;
    setDrag(d ? { ...d } : undefined);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const noteEl = (e.target as HTMLElement).closest<HTMLElement>('[data-note]');
    const p = at(e);
    if (!noteEl) {
      setSelected(undefined);
      edit!.onAdd(p.beat, p.midi);
      return;
    }
    const index = Number(noteEl.dataset['note']);
    const n = melody[index]!;
    e.currentTarget.setPointerCapture(e.pointerId);
    const d: Drag = {
      index, pointerId: e.pointerId, pointerType: e.pointerType, x0: e.clientX, y0: e.clientY, beat0: p.beat, midi0: p.midi,
      mode: 'pending', beat: n.beat, midi: n.midi, duration: n.duration, timer: undefined,
    };
    d.timer = window.setTimeout(() => {
      const cur = dragRef.current;
      if (cur && cur.mode === 'pending') {
        cur.mode = 'resize';
        setDragBoth(cur);
      }
    }, LONG_PRESS_MS);
    setDragBoth(d);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    if (d.mode === 'pending') {
      if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) <= MOVE_PX) return;
      window.clearTimeout(d.timer);
      d.mode = 'move';
    }
    const n = melody[d.index]!;
    const p = at(e);
    if (d.mode === 'move') {
      const beat = Math.max(0, Math.min(total - n.duration, snap(n.beat + p.beat - d.beat0)));
      const midi = n.midi + (p.midi - d.midi0);
      if (midi !== d.midi) edit!.onPitch(midi);
      d.beat = beat;
      d.midi = midi;
      // (The rows grow after the drop, to take in the moved note; growing them mid-drag shifts the grid under the pointer.)
    } else {
      d.duration = Math.max(GRID, Math.min(total - n.beat, snap(p.beat - n.beat + GRID)));
    }
    setDragBoth(d);
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    window.clearTimeout(d.timer);
    setDragBoth(undefined);
    if (d.mode === 'move') edit!.onMove(d.index, d.beat, d.midi);
    else if (d.mode === 'resize') edit!.onResize(d.index, d.duration);
    else if (d.pointerType !== 'mouse') setSelected(d.index);
  };

  const onContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    // A long touch also fires contextmenu (Android): that is the resize gesture, not a delete.
    if (dragRef.current || (e.nativeEvent as PointerEvent).pointerType === 'touch') return;
    const noteEl = (e.target as HTMLElement).closest<HTMLElement>('[data-note]');
    if (noteEl) edit!.onDelete(Number(noteEl.dataset['note']));
  };

  const colourOf = (beat: number) => {
    const bar = Math.floor(beat / 4);
    if (!edit) return READ_ONLY_NOTE;
    return bar < hummedBars ? '#ff3b3b' : editedBars.has(bar) ? '#f5b942' : '#5aa9ff';
  };

  return (
    <div
      className="flex select-none rounded-[8px] bg-black/30"
      aria-label={edit ? 'Melody: click to add a note, right click to delete, drag to move, long press and drag to change its length' : 'Melody'}
    >
      <div className={`shrink-0 ${scrollable ? 'sticky left-0 z-30 bg-[#1b1c1f]' : ''}`} style={{ width: KEY_COL_W }}>
        {pitches.map((p) => (
          <div
            key={p}
            className={`flex items-center justify-end border-b border-black/40 pr-1 font-mono text-[9px] ${isBlack(p) ? 'bg-black/60 text-white/30' : 'bg-white/[0.07] text-white/55'}`}
            style={{ height: ROW_H }}
          >
            {isBlack(p) ? '' : midiName(p)}
          </div>
        ))}
      </div>
      <div
        ref={gridRef}
        aria-disabled={disabled}
        className={`relative flex-1 touch-none overflow-hidden ${disabled ? 'pointer-events-none opacity-60' : ''} ${!edit ? 'cursor-default' : drag?.mode === 'resize' ? 'cursor-ew-resize' : drag?.mode === 'move' ? 'cursor-grabbing' : 'cursor-crosshair'}`}
        style={{ height: rows * ROW_H }}
        {...(edit ? { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp, onContextMenu } : {})}
      >
        {pitches.map((p, i) => (
          <span key={p} className={`pointer-events-none absolute left-0 right-0 ${isBlack(p) ? 'bg-black/25' : ''} ${p % 12 === 0 ? 'border-b border-white/15' : ''}`} style={{ top: i * ROW_H, height: ROW_H }} />
        ))}
        <span className="pointer-events-none absolute bottom-0 top-0 bg-white/[0.06]" style={{ left: 0, width: pct(hummedBars * 4) }} />
        {[...editedBars].filter((b) => b >= hummedBars).map((b) => (
          <span key={b} className="pointer-events-none absolute top-0 h-[3px] bg-[#f5b942]/70" style={{ left: pct(b * 4), width: pct(4) }} />
        ))}
        {Array.from({ length: total + 1 }, (_, b) => (
          <span key={b} className={`pointer-events-none absolute bottom-0 top-0 w-px ${b % 4 === 0 ? 'bg-white/25' : 'bg-white/[0.07]'}`} style={{ left: pct(b) }} />
        ))}
        {melody.map((n, i) => {
          const shown = drag?.index === i ? { beat: drag.beat, midi: drag.midi, duration: drag.duration } : n;
          return (
            <span
              key={i}
              data-note={i}
              className={`absolute rounded-[2px] border border-black/50 ${drag?.index === i ? 'z-10 ring-2 ring-white/80' : ''} ${selected === i ? 'ring-2 ring-white' : ''} ${
                !edit ? '' : drag?.index === i && drag.mode === 'resize' ? 'cursor-ew-resize' : 'cursor-grab'
              }`}
              style={{
                left: pct(shown.beat),
                width: `calc(${pct(shown.duration)} - 2px)`,
                minWidth: 4,
                top: (hi - shown.midi) * ROW_H + 0.5,
                height: ROW_H - 1,
                background: colourOf(shown.beat),
              }}
              title={`${midiName(n.midi)}, bar ${Math.floor(n.beat / 4) + 1} beat ${+((n.beat % 4) + 1).toFixed(2)}, ${n.duration} beat${n.duration === 1 ? '' : 's'}`}
            />
          );
        })}
        {selected !== undefined && melody[selected] ? (
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => (edit!.onDelete(selected), setSelected(undefined))}
            className="absolute z-20 rounded-full bg-white px-3 py-1 text-[12px] font-semibold text-black shadow"
            style={{ left: pct(melody[selected]!.beat), top: Math.max(0, (hi - melody[selected]!.midi) * ROW_H - 30) }}
          >
            Delete note
          </button>
        ) : null}
        {playBeat !== undefined ? <span className="pointer-events-none absolute bottom-0 top-0 z-20 w-0.5 bg-white" style={{ left: pct(playBeat) }} /> : null}
      </div>
    </div>
  );
}
