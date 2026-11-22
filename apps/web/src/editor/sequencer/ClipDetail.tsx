import { useMemo } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@teamsuzie/ui';

import { BEATS_PER_BAR, DRUM_KIT, drumName, midiName, type SeqClip, type SeqNote, type SeqSection, type SeqTrack } from '../sequencerModel';
import { resolveColor } from './layout';

const CELL_W = 22;
const DRUM_ROW_H = 24;
const KEY_ROW_H = 12;
const LABEL_W = 92;

/**
 * A closer look at one track in one section (double-click a clip): a step
 * grid for drum kits, a piano roll for everything with pitches. Read-only:
 * parts come from the generator, so the actions offered are a new pattern
 * or a different sound, plus looping the section to listen.
 */
export function ClipDetail({
  track,
  clip,
  section,
  playheadBeat,
  onClose,
  onLoopSection,
  onNewPattern,
  onChangeSound,
  editable,
  soundChangeable,
  busy,
}: {
  track: SeqTrack;
  clip: SeqClip;
  section: SeqSection;
  /** Playhead in beats from the song start, when this song is loaded. */
  playheadBeat: number | undefined;
  onClose(): void;
  onLoopSection(): void;
  onNewPattern(): void;
  onChangeSound(): void;
  editable: boolean;
  soundChangeable: boolean;
  busy: boolean;
}) {
  const startBeat = clip.startBar * BEATS_PER_BAR;
  const notes = useMemo(() => clip.notes.map((n) => ({ ...n, start: n.start - startBeat })), [clip, startBeat]);
  // 16th steps, or 32nds when the part has hits between 16ths.
  const stepsPerBeat = notes.some((n) => Math.abs(n.start * 4 - Math.round(n.start * 4)) > 1e-6) ? 8 : 4;
  const beats = clip.bars * BEATS_PER_BAR;
  const cellW = stepsPerBeat === 8 ? CELL_W / 2 + 2 : CELL_W;
  const gridW = beats * stepsPerBeat * cellW;
  const head = playheadBeat !== undefined && playheadBeat >= startBeat && playheadBeat < startBeat + beats ? playheadBeat - startBeat : undefined;
  const color = resolveColor(track.color);
  const pitched = notes.filter((n) => n.pitch !== null);

  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent className="max-h-[86vh] w-[min(1100px,calc(100vw-2rem))] max-w-none gap-0 overflow-hidden rounded-[12px] border border-line bg-panel p-0 text-white sm:max-w-none">
        <div className="flex flex-wrap items-center gap-3 border-b border-line/60 px-5 py-4 pr-12">
          <span className="h-3 w-3 rounded-full" style={{ background: track.color }} aria-hidden="true" />
          <div className="min-w-0">
            <DialogTitle className="text-[17px] font-semibold text-white">
              {track.name} · {section.name}
            </DialogTitle>
            <DialogDescription className="text-[12px] text-white/50">
              Bars {section.startBar + 1}–{section.startBar + section.bars} · {notes.length} {track.isDrums ? 'hits' : 'notes'}
            </DialogDescription>
          </div>
          <div className="ml-auto flex flex-wrap gap-2">
            <ActionButton onClick={onLoopSection}>Loop this section</ActionButton>
            {editable ? (
              <>
                <ActionButton onClick={onNewPattern} disabled={busy}>New pattern</ActionButton>
                {soundChangeable ? <ActionButton onClick={onChangeSound} disabled={busy}>Change sound…</ActionButton> : null}
              </>
            ) : null}
          </div>
        </div>

        <div className="max-h-[calc(86vh-140px)] overflow-auto bg-[#0d0e18]">
          {track.isDrums ? (
            <DrumSteps notes={notes} beats={beats} stepsPerBeat={stepsPerBeat} cellW={cellW} gridW={gridW} color={color} head={head} />
          ) : pitched.length > 0 ? (
            <PianoRoll notes={pitched} beats={beats} stepsPerBeat={stepsPerBeat} cellW={cellW} gridW={gridW} color={color} head={head} />
          ) : (
            <p className="px-5 py-10 text-[14px] text-white/55">
              This part is played as patterns (strums or phrases) without single notes to show.
            </p>
          )}
        </div>
        <p className="border-t border-line/60 px-5 py-3 text-[12px] text-white/45">
          Parts are written by Casperaki&rsquo;s generator, so they aren&rsquo;t edited note by note: ask for a new
          pattern or another sound instead. Space plays and pauses.
        </p>
      </DialogContent>
    </Dialog>
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

interface GridProps {
  notes: SeqNote[];
  beats: number;
  stepsPerBeat: number;
  cellW: number;
  gridW: number;
  color: string;
  head: number | undefined;
}

/** Column backgrounds: bars, beats and steps, as in a step sequencer. */
function StepColumns({ beats, stepsPerBeat, cellW, height }: { beats: number; stepsPerBeat: number; cellW: number; height: number }) {
  return (
    <>
      {Array.from({ length: beats }, (_, b) => (
        <span
          key={b}
          className={`absolute top-0 ${Math.floor(b / BEATS_PER_BAR) % 2 ? 'bg-white/[0.025]' : ''} border-l ${b % BEATS_PER_BAR === 0 ? 'border-white/30' : 'border-white/10'}`}
          style={{ left: b * stepsPerBeat * cellW, width: stepsPerBeat * cellW, height }}
        />
      ))}
    </>
  );
}

function BeatHeader({ beats, stepsPerBeat, cellW }: { beats: number; stepsPerBeat: number; cellW: number }) {
  return (
    <div className="sticky top-0 z-10 flex bg-[#151623]" style={{ height: 20 }}>
      <div className="sticky left-0 z-10 shrink-0 bg-[#151623]" style={{ width: LABEL_W }} />
      <div className="relative" style={{ width: beats * stepsPerBeat * cellW }}>
        {Array.from({ length: beats }, (_, b) => (
          <span
            key={b}
            className={`absolute top-0 h-full border-l pl-1 font-mono text-[10px] leading-[20px] ${b % BEATS_PER_BAR === 0 ? 'border-white/40 text-white/80' : 'border-white/10 text-white/35'}`}
            style={{ left: b * stepsPerBeat * cellW }}
          >
            {b % BEATS_PER_BAR === 0 ? Math.floor(b / BEATS_PER_BAR) + 1 : `.${(b % BEATS_PER_BAR) + 1}`}
          </span>
        ))}
      </div>
    </div>
  );
}

function Playhead({ head, stepsPerBeat, cellW }: { head: number | undefined; stepsPerBeat: number; cellW: number }) {
  if (head === undefined) return null;
  return <span className="pointer-events-none absolute top-0 bottom-0 z-[5] w-[2px] bg-accent" style={{ left: head * stepsPerBeat * cellW }} />;
}

function DrumSteps({ notes, beats, stepsPerBeat, cellW, gridW, color, head }: GridProps) {
  // The whole kit, used pieces or not, plus any note outside it.
  const used = new Set(notes.map((n) => n.pitch).filter((p): p is number => p !== null));
  const pitches = [...DRUM_KIT.map((d) => d.pitch), ...[...used].filter((p) => !DRUM_KIT.some((d) => d.pitch === p))];
  const height = pitches.length * DRUM_ROW_H;
  return (
    <div className="relative min-w-max">
      <BeatHeader beats={beats} stepsPerBeat={stepsPerBeat} cellW={cellW} />
      <div className="flex">
        <div className="sticky left-0 z-10 shrink-0 bg-[#10111b]" style={{ width: LABEL_W }}>
          {pitches.map((p) => (
            <div key={p} className={`truncate border-b border-white/5 px-3 text-[12px] ${used.has(p) ? 'text-white/85' : 'text-white/30'}`} style={{ height: DRUM_ROW_H, lineHeight: `${DRUM_ROW_H}px` }}>
              {drumName(p)}
            </div>
          ))}
        </div>
        <div className="relative" style={{ width: gridW, height }}>
          <StepColumns beats={beats} stepsPerBeat={stepsPerBeat} cellW={cellW} height={height} />
          {pitches.map((p, row) => (
            <div key={p} className="absolute left-0 right-0 border-b border-white/5" style={{ top: row * DRUM_ROW_H, height: DRUM_ROW_H }}>
              {notes
                .filter((n) => n.pitch === p)
                .map((n, i) => (
                  <span
                    key={i}
                    className="absolute top-[4px] rounded-[3px]"
                    style={{ left: n.start * stepsPerBeat * cellW + 2, width: cellW - 4, height: DRUM_ROW_H - 8, background: color }}
                    title={`${drumName(p)} at beat ${(n.start + 1).toFixed(2)}`}
                  />
                ))}
            </div>
          ))}
          <Playhead head={head} stepsPerBeat={stepsPerBeat} cellW={cellW} />
        </div>
      </div>
    </div>
  );
}

function PianoRoll({ notes, beats, stepsPerBeat, cellW, gridW, color, head }: GridProps) {
  const ps = notes.map((n) => n.pitch!);
  // At least an octave and a half of keys, centred on the part.
  const spread = Math.max(...ps) - Math.min(...ps);
  const extra = Math.max(2, Math.ceil((18 - spread) / 2));
  const high = Math.max(...ps) + extra;
  const low = Math.min(...ps) - extra;
  const rows = high - low + 1;
  const height = rows * KEY_ROW_H;
  const isBlack = (p: number) => [1, 3, 6, 8, 10].includes(((p % 12) + 12) % 12);
  return (
    <div className="relative min-w-max">
      <BeatHeader beats={beats} stepsPerBeat={stepsPerBeat} cellW={cellW} />
      <div className="flex">
        <div className="sticky left-0 z-10 shrink-0 bg-[#10111b]" style={{ width: LABEL_W }}>
          {Array.from({ length: rows }, (_, i) => high - i).map((p) => (
            <div
              key={p}
              className={`flex items-center justify-end border-b border-black/40 pr-2 font-mono text-[9px] ${isBlack(p) ? 'bg-black/60 text-white/30' : 'bg-white/[0.07] text-white/55'}`}
              style={{ height: KEY_ROW_H }}
            >
              {p % 12 === 0 || !isBlack(p) ? midiName(p) : ''}
            </div>
          ))}
        </div>
        <div className="relative" style={{ width: gridW, height }}>
          {Array.from({ length: rows }, (_, i) => high - i).map((p, i) => (
            <span key={p} className={`absolute left-0 right-0 ${isBlack(p) ? 'bg-black/25' : ''} ${p % 12 === 0 ? 'border-b border-white/15' : ''}`} style={{ top: i * KEY_ROW_H, height: KEY_ROW_H }} />
          ))}
          <StepColumns beats={beats} stepsPerBeat={stepsPerBeat} cellW={cellW} height={height} />
          {notes.map((n, i) => (
            <span
              key={i}
              className="absolute overflow-hidden whitespace-nowrap rounded-[2px] border border-black/40 px-0.5 text-[8px] leading-[10px] text-black/80"
              style={{
                left: n.start * stepsPerBeat * cellW,
                width: Math.max(4, n.length * stepsPerBeat * cellW - 1),
                top: (high - n.pitch!) * KEY_ROW_H + 0.5,
                height: KEY_ROW_H - 1,
                background: color,
                opacity: n.kind === 'chord' ? 0.75 : 1,
              }}
              title={`${midiName(n.pitch!)}${n.label ? ` (${n.label})` : ''}, ${n.length} beat${n.length === 1 ? '' : 's'}`}
            >
              {n.label && n.kind !== 'chord' ? n.label : ''}
            </span>
          ))}
          <Playhead head={head} stepsPerBeat={stepsPerBeat} cellW={cellW} />
        </div>
      </div>
    </div>
  );
}
