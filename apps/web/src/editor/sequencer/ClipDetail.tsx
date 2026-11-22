import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@teamsuzie/ui';

import { BEATS_PER_BAR, DRUM_KIT, drumName, midiName, type SeqClip, type SeqNote, type SeqSection, type SeqTrack } from '../sequencerModel';
import { resolveColor } from './layout';
import { beginRangeDrag, type BarRange } from './rangeDrag';
import { SelectionOverlay } from './Selection';

const DRUM_ROW_H = 26;
const KEY_ROW_H = 12;
const LABEL_W = 104;
const MIN_PX_PER_BEAT = 6;
const MAX_PX_PER_BEAT = 480;
/** Grid choices: notes per bar, as on a DAW's grid menu. */
const GRIDS = [4, 8, 16, 32] as const;
type Grid = (typeof GRIDS)[number];
/** Drum hits are stored on a 32nd-note grid: 8 steps per beat, 32 per bar. */
const STEPS_PER_BEAT_32 = 8;

export type DrumScope = 'this' | 'all';

/**
 * A closer look at one track in one section (double-click a clip). Drums get
 * an editable step grid of the bar the engine repeats through the section;
 * click a cell to add or remove a hit, in this section or in every section
 * of the same kind. Everything with pitches gets a piano roll (view only).
 * Zoom and grid resolution are adjustable for both.
 */
export function ClipDetail({
  track,
  clip,
  section,
  sameKind,
  previewBeat,
  onClose,
  onNewPattern,
  onChangeSound,
  onSetDrumHit,
  previewPlaying,
  onPlay,
  onPause,
  editable,
  soundChangeable,
  busy,
  editError,
  engineNotes,
  soundName,
}: {
  track: SeqTrack;
  clip: SeqClip;
  section: SeqSection;
  /** Names of every section of the same kind (this one included), in song order. */
  sameKind: readonly string[];
  /** The preview's playhead in beats from the section start, while it is loaded. */
  previewBeat: number | undefined;
  onClose(): void;
  onNewPattern(): void;
  onChangeSound(): void;
  /** Add or remove a drum hit (step in 32nds of the bar) in the sections named. */
  onSetDrumHit(segments: string[], pitch: number, step: number, on: boolean): void;
  /** Whether this window's Play is looping. */
  previewPlaying: boolean;
  /** Loop beats `fromBeat`–`toBeat` of the pattern shown (played on its own). */
  onPlay(fromBeat: number, toBeat: number): void;
  onPause(): void;
  editable: boolean;
  soundChangeable: boolean;
  busy: boolean;
  /** The last edit's error, if it was refused. */
  editError: string | undefined;
  /** Pitched tracks: the notes the engine plays for this pattern (beats from its start), or why they could not be read. */
  engineNotes: { notes: SeqNote[] } | { error: string } | undefined;
  /** Public name of the track's sound. */
  soundName: string | undefined;
}) {
  const startBeat = clip.startBar * BEATS_PER_BAR;
  const notes = useMemo(() => clip.notes.map((n) => ({ ...n, start: n.start - startBeat })), [clip, startBeat]);
  const offSixteenth = notes.some((n) => Math.abs(n.start * 4 - Math.round(n.start * 4)) > 1e-6);
  const [grid, setGrid] = useState<Grid>(offSixteenth ? 32 : 16);
  const [pxPerBeat, setPxPerBeat] = useState(track.isDrums ? 255 : 88);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Which sections a drum edit changes; asked on the first edit when there is a choice.
  const [scope, setScope] = useState<DrumScope | undefined>(sameKind.length > 1 ? undefined : 'this');
  const [pending, setPending] = useState<{ pitch: number; step: number; on: boolean } | undefined>(undefined);
  /** Selection in beats from the start of what's shown (the bar for drums, the section otherwise). */
  const [sel, setSel] = useState<BarRange | undefined>(undefined);

  const beats = clip.bars * BEATS_PER_BAR;
  const color = resolveColor(track.color);
  const kindLabel = plural(section.kind);
  // What Play loops: the selection, else the whole pattern shown (drums: the bar).
  const patternBeats = track.isDrums ? BEATS_PER_BAR : beats;
  /** Zoom so the whole pattern fits the window's width. */
  const fitTo = (el: HTMLElement) => {
    // Leave room for a vertical scrollbar, which may appear once the notes are in.
    const room = el.clientWidth - LABEL_W - 28;
    setPxPerBeat(Math.min(MAX_PX_PER_BEAT, Math.max(MIN_PX_PER_BEAT, room / patternBeats)));
  };
  const fit = () => {
    if (!scrollRef.current) throw new Error('The pattern view is not mounted.');
    fitTo(scrollRef.current);
  };
  // Open with the whole pattern in view: fit once, when the view mounts
  // (the dialog mounts its content after this component renders).
  const fitted = useRef(false);
  const attachScroll = (el: HTMLDivElement | null) => {
    scrollRef.current = el;
    if (el && !fitted.current) {
      fitted.current = true;
      fitTo(el);
    }
  };
  const playPattern = () => onPlay(sel ? sel.start : 0, sel ? sel.end : patternBeats);

  // Space plays and pauses the preview while this window is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (previewPlaying) onPause();
      else playPattern();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });
  const selectionProps = { sel, onSel: setSel, looping: previewPlaying };

  const apply = (edit: { pitch: number; step: number; on: boolean }, s: DrumScope) =>
    onSetDrumHit(s === 'all' ? [...sameKind] : [section.name], edit.pitch, edit.step, edit.on);
  const onCell = (pitch: number, step: number, on: boolean) => {
    if (scope === undefined) setPending({ pitch, step, on });
    else apply({ pitch, step, on }, scope);
  };

  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent className="max-h-[88vh] w-[min(1180px,calc(100vw-2rem))] max-w-none gap-0 overflow-hidden rounded-[12px] border border-line bg-panel p-0 text-white sm:max-w-none">
        <div className="flex flex-wrap items-center gap-3 border-b border-line/60 px-5 py-4 pr-12">
          <span className="h-3 w-3 rounded-full" style={{ background: track.color }} aria-hidden="true" />
          <div className="min-w-0">
            <DialogTitle className="text-[17px] font-semibold text-white">
              {track.name} · {section.name}
            </DialogTitle>
            <DialogDescription className="text-[12px] text-white/50">
              Bars {section.startBar + 1}–{section.startBar + section.bars}
              {track.isDrums
                ? ' · the bar below repeats through the section'
                : engineNotes && 'notes' in engineNotes
                  ? ` · ${engineNotes.notes.length} notes as played`
                  : ''}
            </DialogDescription>
          </div>
          <div className="ml-auto flex flex-wrap gap-2">
            {editable ? (
              <>
                <ActionButton onClick={onNewPattern} disabled={busy}>New pattern</ActionButton>
                {soundName ? (
                  <span className="flex h-8 items-center rounded-[6px] border border-line bg-black/30 px-3 text-[13px] text-white/85" title="This track's sound">
                    <span className="mr-1.5 text-white/45">Sound</span>
                    {soundName}
                  </span>
                ) : null}
                {soundChangeable ? <ActionButton onClick={onChangeSound} disabled={busy}>Change sound…</ActionButton> : null}
              </>
            ) : null}
          </div>
        </div>

        {/* Grid, zoom and (drums) which sections edits apply to. */}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-line/60 px-5 py-2.5 text-[13px]">
          <button
            type="button"
            onClick={previewPlaying ? onPause : playPattern}
            className={`inline-flex h-8 items-center gap-2 rounded-full px-3.5 text-[13px] font-semibold ${previewPlaying ? 'bg-sky-400/25 text-sky-200' : 'bg-white text-black hover:bg-white/85'}`}
            title={`Loop ${sel ? 'the selection' : 'this pattern'}, on its own (Space)`}
          >
            <span aria-hidden="true">{previewPlaying ? '❚❚' : '▶'}</span>
            {previewPlaying ? 'Pause' : `Play ${sel ? 'selection' : 'pattern'}`}
          </button>
          <Segmented<Grid>
            label="Grid"
            value={grid}
            options={GRIDS.map((g) => ({ value: g, label: `1/${g}` }))}
            onChange={setGrid}
          />
          <span className="flex items-center gap-1">
            <span className="mr-1 text-white/55">Zoom</span>
            <SmallButton label="Zoom out" onClick={() => setPxPerBeat((z) => Math.max(MIN_PX_PER_BEAT, Math.round(z / 1.4)))}>−</SmallButton>
            <SmallButton label="Zoom in" onClick={() => setPxPerBeat((z) => Math.min(MAX_PX_PER_BEAT, Math.round(z * 1.4)))}>+</SmallButton>
            <button type="button" onClick={fit} title="Fit the whole pattern" className="ml-1 h-7 rounded-[6px] border border-line px-2 text-[12px] text-white/85 hover:border-white/50">
              Fit
            </button>
          </span>
          {track.isDrums && sameKind.length > 1 ? (
            <Segmented<DrumScope>
              label="Edits change"
              value={scope}
              options={[
                { value: 'this' as const, label: `This ${section.kind} only` },
                { value: 'all' as const, label: `All ${kindLabel} (${sameKind.length})` },
              ]}
              onChange={setScope}
            />
          ) : null}
        </div>

        <div ref={attachScroll} className="max-h-[calc(88vh-190px)] overflow-auto bg-[#1a1b1e]">
          {track.isDrums ? (
            <DrumBar
              notes={notes}
              barCount={clip.bars}
              grid={grid}
              pxPerBeat={pxPerBeat}
              color={color}
              head={previewBeat !== undefined ? previewBeat % BEATS_PER_BAR : undefined}
              onCell={onCell}
              {...selectionProps}
            />
          ) : engineNotes === undefined ? (
            <p className="px-5 py-10 text-[14px] text-white/55">Reading the notes the engine plays…</p>
          ) : 'error' in engineNotes ? (
            <p className="px-5 py-10 text-[14px] text-err">{engineNotes.error}</p>
          ) : engineNotes.notes.length > 0 ? (
            <PianoRoll
              notes={engineNotes.notes}
              beats={beats}
              grid={grid}
              pxPerBeat={pxPerBeat}
              color={color}
              head={previewBeat}
              {...selectionProps}
            />
          ) : (
            <p className="px-5 py-10 text-[14px] text-white/55">
              This part is played as patterns (strums or phrases) without single notes to show.
            </p>
          )}
        </div>
        {editError ? <p className="border-t border-line/60 px-5 py-2 text-[13px] text-err" role="alert">{editError}</p> : null}
        <p className="border-t border-line/60 px-5 py-3 text-[12px] text-white/45">
          {track.isDrums
            ? 'Click a cell to add or remove a hit. Undo with Ctrl+Z. Fills at the ends of sections come on top of this bar. Space plays and pauses.'
            : 'The notes the playback engine plays (chords as it voices them). Parts with pitches are written by the generator: ask for a new pattern or another sound to change them. Space plays and pauses.'}
        </p>

        {pending ? (
          <ScopeQuestion
            section={section}
            kindLabel={kindLabel}
            count={sameKind.length}
            onCancel={() => setPending(undefined)}
            onChoose={(s) => {
              setScope(s);
              apply(pending, s);
              setPending(undefined);
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** "verse" → "verses", "chorus" → "choruses". */
function plural(kind: string): string {
  return /(s|sh|ch|x)$/u.test(kind) ? `${kind}es` : `${kind}s`;
}

/** Asked on the first drum edit in a window when other sections share the kind. */
function ScopeQuestion({
  section,
  kindLabel,
  count,
  onChoose,
  onCancel,
}: {
  section: SeqSection;
  kindLabel: string;
  count: number;
  onChoose(scope: DrumScope): void;
  onCancel(): void;
}) {
  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : onCancel())}>
      <DialogContent className="w-[min(460px,calc(100vw-2rem))] max-w-none gap-0 rounded-[12px] border border-line bg-panel p-0 text-white sm:max-w-none">
        <div className="px-5 pb-2 pt-5 pr-12">
          <DialogTitle className="text-[17px] font-semibold text-white">Change only {section.name}, or all {kindLabel}?</DialogTitle>
          <DialogDescription className="mt-2 text-[14px] leading-relaxed text-white/60">
            The song has {count} {kindLabel}. Your drum changes can apply to {section.name} alone or to every one of them.
            You can switch this later in the editor.
          </DialogDescription>
        </div>
        <div className="flex justify-end gap-2 px-5 pb-5 pt-4">
          <button type="button" onClick={() => onChoose('this')} className="h-10 rounded-full border border-white/30 px-4 text-[14px] font-semibold text-white hover:border-white/60">
            Only {section.name}
          </button>
          <button type="button" onClick={() => onChoose('all')} className="h-10 rounded-full bg-accent px-4 text-[14px] font-semibold text-white hover:bg-[#e00000]">
            All {kindLabel}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T | undefined;
  options: readonly { value: T; label: string }[];
  onChange(v: T): void;
}) {
  return (
    <span className="flex items-center gap-2" role="group" aria-label={label}>
      <span className="text-white/55">{label}</span>
      <span className="flex rounded-[7px] border border-line p-0.5">
        {options.map((o) => (
          <button
            key={String(o.value)}
            type="button"
            aria-pressed={value === o.value}
            onClick={() => onChange(o.value)}
            className={`h-7 rounded-[5px] px-2.5 text-[12px] ${value === o.value ? 'bg-white text-black' : 'text-white/70 hover:text-white'}`}
          >
            {o.label}
          </button>
        ))}
      </span>
    </span>
  );
}

function SmallButton({ label, onClick, children }: { label: string; onClick(): void; children: string }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label} className="h-7 w-7 rounded-[6px] border border-line text-[14px] text-white/85 hover:border-white/50">
      {children}
    </button>
  );
}

function ActionButton({ onClick, disabled, children }: { onClick(): void; disabled?: boolean; children: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="h-8 rounded-full border border-white/25 px-3.5 text-[13px] font-semibold text-white hover:border-white/60 disabled:opacity-40"
    >
      {children}
    </button>
  );
}

/** Column shading and lines for `beats` beats at `grid` notes per bar. */
function GridColumns({ beats, grid, pxPerBeat, height }: { beats: number; grid: Grid; pxPerBeat: number; height: number }) {
  const cellsPerBeat = grid / BEATS_PER_BAR;
  const cellW = pxPerBeat / cellsPerBeat;
  const cells = Math.round(beats * cellsPerBeat);
  return (
    <>
      {Array.from({ length: beats }, (_, b) =>
        Math.floor(b / BEATS_PER_BAR) % 2 ? (
          <span key={`s${b}`} className="absolute top-0 bg-white/[0.02]" style={{ left: b * pxPerBeat, width: pxPerBeat, height }} />
        ) : null,
      )}
      {Array.from({ length: cells }, (_, c) => {
        const onBar = (c / cellsPerBeat) % BEATS_PER_BAR === 0;
        const onBeat = c % cellsPerBeat === 0;
        return (
          <span
            key={c}
            className={`absolute top-0 w-px ${onBar ? 'bg-white/35' : onBeat ? 'bg-white/15' : 'bg-white/[0.06]'}`}
            style={{ left: c * cellW, height }}
          />
        );
      })}
    </>
  );
}

interface SelectionProps {
  sel: BarRange | undefined;
  onSel(range: BarRange | undefined): void;
  looping: boolean;
}

/** Snap to the grid's cells (in beats), unless `exact`. */
function gridSnap(grid: Grid, total: number) {
  const unit = BEATS_PER_BAR / grid;
  return (v: number, exact: boolean) => {
    const c = Math.max(0, Math.min(total, v));
    return exact ? c : Math.max(0, Math.min(total, Math.round(c / unit) * unit));
  };
}

/** The selectable area: beat ruler on top (drag it to select), body below, selection over both. */
function Selectable({
  beats,
  pxPerBeat,
  grid,
  sel,
  onSel,
  looping,
  children,
}: SelectionProps & { beats: number; pxPerBeat: number; grid: Grid; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const snap = gridSnap(grid, beats);
  return (
    <div ref={ref} className="relative min-w-max select-none">
      <div className="sticky top-0 z-10 flex bg-[#2c2d32]" style={{ height: 20 }}>
        <div className="sticky left-0 z-10 shrink-0 bg-[#2c2d32] pl-3 text-[10px] leading-[20px] text-white/35" style={{ width: LABEL_W }}>
          Drag to select
        </div>
        <div
          className="relative cursor-crosshair"
          style={{ width: beats * pxPerBeat }}
          onPointerDown={(e) =>
            beginRangeDrag(e, {
              el: e.currentTarget,
              pxPerBar: pxPerBeat,
              totalBars: beats,
              snap,
              onRange: onSel,
              onClick: () => onSel(undefined),
            })
          }
          title="Drag to select (click to clear)"
        >
          <BeatMarks beats={beats} pxPerBeat={pxPerBeat} />
        </div>
      </div>
      {children}
      {sel ? (
        <SelectionOverlay
          range={sel}
          pxPerUnit={pxPerBeat}
          total={beats}
          offsetPx={LABEL_W}
          looping={looping}
          originX={() => ref.current!.getBoundingClientRect().left + LABEL_W}
          snap={snap}
          onChange={onSel}
          zIndex={6}
        />
      ) : null}
    </div>
  );
}

function BeatMarks({ beats, pxPerBeat }: { beats: number; pxPerBeat: number }) {
  return (
      <>
        {Array.from({ length: beats }, (_, b) => (
          <span
            key={b}
            className={`absolute top-0 h-full border-l pl-1 font-mono text-[10px] leading-[20px] ${b % BEATS_PER_BAR === 0 ? 'border-white/40 text-white/80' : 'border-white/10 text-white/40'}`}
            style={{ left: b * pxPerBeat }}
          >
            {b % BEATS_PER_BAR === 0 ? Math.floor(b / BEATS_PER_BAR) + 1 : `.${(b % BEATS_PER_BAR) + 1}`}
          </span>
        ))}
      </>
  );
}

function Playhead({ head, pxPerBeat }: { head: number | undefined; pxPerBeat: number }) {
  if (head === undefined) return null;
  return <span className="pointer-events-none absolute top-0 bottom-0 z-[5] w-[2px] bg-accent" style={{ left: head * pxPerBeat }} />;
}

/**
 * The bar the engine repeats: per kit piece, the hits of the first bar of
 * the section that has that piece (as the engine adapter lowers it), on
 * the 32nd grid. Returns piece pitch → set of 32nd steps.
 */
export function drumBarPattern(notes: readonly SeqNote[], barCount: number): Map<number, Set<number>> {
  const byPitch = new Map<number, Map<number, Set<number>>>();
  for (const n of notes) {
    if (n.pitch === null) continue;
    const bar = Math.floor(n.start / BEATS_PER_BAR + 1e-9);
    if (bar < 0 || bar >= barCount) continue;
    const step = Math.round((n.start - bar * BEATS_PER_BAR) * STEPS_PER_BEAT_32);
    if (step < 0 || step >= 32) continue;
    const bars = byPitch.get(n.pitch) ?? new Map<number, Set<number>>();
    const set = bars.get(bar) ?? new Set<number>();
    set.add(step);
    bars.set(bar, set);
    byPitch.set(n.pitch, bars);
  }
  const out = new Map<number, Set<number>>();
  for (const [pitch, bars] of byPitch) out.set(pitch, bars.get(Math.min(...bars.keys()))!);
  return out;
}

function DrumBar({
  notes,
  barCount,
  grid,
  pxPerBeat,
  color,
  head,
  onCell,
  ...selection
}: SelectionProps & {
  notes: SeqNote[];
  barCount: number;
  grid: Grid;
  pxPerBeat: number;
  color: string;
  head: number | undefined;
  onCell(pitch: number, step: number, on: boolean): void;
}) {
  const pattern = useMemo(() => drumBarPattern(notes, barCount), [notes, barCount]);
  // The whole kit, used pieces or not, plus any note outside it.
  const pitches = [...DRUM_KIT.map((d) => d.pitch), ...[...pattern.keys()].filter((p) => !DRUM_KIT.some((d) => d.pitch === p))];
  const height = pitches.length * DRUM_ROW_H;
  const stepsPerCell = 32 / grid;
  const cellW = (pxPerBeat * BEATS_PER_BAR) / grid;
  const stepW = pxPerBeat / STEPS_PER_BEAT_32;
  const gridW = pxPerBeat * BEATS_PER_BAR;

  return (
    <Selectable beats={BEATS_PER_BAR} pxPerBeat={pxPerBeat} grid={grid} {...selection}>
      <div className="flex">
        <div className="sticky left-0 z-10 shrink-0 bg-[#2a2b30]" style={{ width: LABEL_W }}>
          {pitches.map((p) => (
            <div
              key={p}
              className={`truncate border-b border-white/5 px-3 text-[12px] ${pattern.has(p) ? 'text-white/85' : 'text-white/30'}`}
              style={{ height: DRUM_ROW_H, lineHeight: `${DRUM_ROW_H}px` }}
            >
              {drumName(p)}
            </div>
          ))}
        </div>
        <div className="relative" style={{ width: gridW, height }}>
          <GridColumns beats={BEATS_PER_BAR} grid={grid} pxPerBeat={pxPerBeat} height={height} />
          {pitches.map((p, row) => {
            const steps = pattern.get(p) ?? new Set<number>();
            return (
              <div key={p} className="absolute left-0 right-0 border-b border-white/5" style={{ top: row * DRUM_ROW_H, height: DRUM_ROW_H }}>
                {/* Clickable cells at the grid resolution. */}
                {Array.from({ length: grid }, (_, c) => {
                  const step = c * stepsPerCell;
                  const on = steps.has(step);
                  return (
                    <button
                      key={c}
                      type="button"
                      onClick={() => onCell(p, step, !on)}
                      aria-label={`${drumName(p)}, ${fmtStep(step)}: ${on ? 'remove hit' : 'add hit'}`}
                      className="absolute top-0 h-full hover:bg-white/[0.08]"
                      style={{ left: c * cellW, width: cellW }}
                    />
                  );
                })}
                {/* Hits, at their exact 32nd (also those between grid cells). */}
                {[...steps].map((step) => {
                  const aligned = step % stepsPerCell === 0;
                  return (
                    <span
                      key={step}
                      className="pointer-events-none absolute top-[4px] rounded-[3px]"
                      style={{
                        left: step * stepW + 2,
                        width: Math.max(4, (aligned ? cellW : stepW) - 4),
                        height: DRUM_ROW_H - 8,
                        background: color,
                        opacity: aligned ? 1 : 0.55,
                      }}
                      title={`${drumName(p)} at ${fmtStep(step)}`}
                    />
                  );
                })}
              </div>
            );
          })}
          <Playhead head={head} pxPerBeat={pxPerBeat} />
        </div>
      </div>
    </Selectable>
  );
}

/** A 32nd step as beat.sub ("beat 2, 3rd 16th"). */
function fmtStep(step: number): string {
  const beat = Math.floor(step / 8) + 1;
  const rest = step % 8;
  return rest === 0 ? `beat ${beat}` : `beat ${beat} + ${rest}/32`;
}

function PianoRoll({
  notes,
  beats,
  grid,
  pxPerBeat,
  color,
  head,
  ...selection
}: SelectionProps & {
  notes: SeqNote[];
  beats: number;
  grid: Grid;
  pxPerBeat: number;
  color: string;
  head: number | undefined;
}) {
  const ps = notes.map((n) => n.pitch!);
  // At least an octave and a half of keys, centred on the part.
  const spread = Math.max(...ps) - Math.min(...ps);
  const extra = Math.max(2, Math.ceil((18 - spread) / 2));
  const high = Math.max(...ps) + extra;
  const low = Math.min(...ps) - extra;
  const rows = high - low + 1;
  const height = rows * KEY_ROW_H;
  const gridW = beats * pxPerBeat;
  const isBlack = (p: number) => [1, 3, 6, 8, 10].includes(((p % 12) + 12) % 12);
  return (
    <Selectable beats={beats} pxPerBeat={pxPerBeat} grid={grid} {...selection}>
      <div className="flex">
        <div className="sticky left-0 z-10 shrink-0 bg-[#2a2b30]" style={{ width: LABEL_W }}>
          {Array.from({ length: rows }, (_, i) => high - i).map((p) => (
            <div
              key={p}
              className={`flex items-center justify-end border-b border-black/40 pr-2 font-mono text-[9px] ${isBlack(p) ? 'bg-black/60 text-white/30' : 'bg-white/[0.07] text-white/55'}`}
              style={{ height: KEY_ROW_H }}
            >
              {isBlack(p) ? '' : midiName(p)}
            </div>
          ))}
        </div>
        {/* Notes that ring past the section's end are cut at its edge. */}
        <div className="relative overflow-hidden" style={{ width: gridW, height }}>
          {Array.from({ length: rows }, (_, i) => high - i).map((p, i) => (
            <span key={p} className={`absolute left-0 right-0 ${isBlack(p) ? 'bg-black/25' : ''} ${p % 12 === 0 ? 'border-b border-white/15' : ''}`} style={{ top: i * KEY_ROW_H, height: KEY_ROW_H }} />
          ))}
          <GridColumns beats={beats} grid={grid} pxPerBeat={pxPerBeat} height={height} />
          {notes.map((n, i) => (
            <span
              key={i}
              className="absolute overflow-hidden whitespace-nowrap rounded-[2px] border border-black/50 border-l-[3px] border-l-white px-0.5 text-[8px] leading-[10px] text-black/80"
              style={{
                left: n.start * pxPerBeat,
                // A gap before the next note, so every onset is visible.
                width: Math.max(4, n.length * pxPerBeat - 2),
                top: (high - n.pitch!) * KEY_ROW_H + 0.5,
                height: KEY_ROW_H - 1,
                background: color,
                opacity: n.velocity !== undefined ? 0.45 + 0.55 * (n.velocity / 127) : n.kind === 'chord' ? 0.75 : 1,
              }}
              title={`${midiName(n.pitch!)}${n.label ? ` (${n.label})` : ''}, ${+n.length.toFixed(3)} beat${n.length === 1 ? '' : 's'}${n.velocity !== undefined ? `, velocity ${n.velocity}` : ''}`}
            >
              {n.label && n.kind !== 'chord' ? n.label : ''}
            </span>
          ))}
          <Playhead head={head} pxPerBeat={pxPerBeat} />
        </div>
      </div>
    </Selectable>
  );
}
