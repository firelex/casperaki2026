import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@teamsuzie/ui';

import { catalogApi, catalogQueryKeys } from '../api/catalog';
import { livePlayer, type LaneMeters } from '../audio/livePlayer';
import { useLiveTransport } from '../audio/useLiveTransport';
import { indexInstrumentDefinitions } from '../types/song';
import { useSession } from '../state/session';
import { BEATS_PER_BAR, buildSequencerModel, type SeqSection, type SeqTrack } from './sequencerModel';
import { ClipDetail } from './sequencer/ClipDetail';
import { BARS_H, CHORD_H, HEADER_W, LOOP_H, MARKERS_H, MAX_PX_PER_BAR, MIN_PX_PER_BAR, ROW_H, RULER_H, TIME_H } from './sequencer/layout';
import { beginEdgeDrag, beginRangeDrag } from './sequencer/rangeDrag';
import { fmtBar, Ruler, type BarRange } from './sequencer/Ruler';
import { TrackCanvas } from './sequencer/TrackCanvas';
import { AddTrackDialog, ChangeSoundDialog } from './sequencer/TrackDialogs';
import { useTrackEdits } from './sequencer/useTrackEdits';

type Dialog =
  | { kind: 'detail'; track: string; section: number }
  | { kind: 'sound'; track: string }
  | { kind: 'add'; sections: string[] };

const MENU = 'z-50 min-w-[220px] rounded-[10px] border border-line bg-panel p-1 text-white shadow-2xl';
const ITEM = 'cursor-pointer rounded-[6px] px-3 py-2 text-[14px] outline-none data-[highlighted]:bg-white/10 data-[disabled]:opacity-40';

/**
 * Sequencer (Timeline tab): the whole song on one time axis, laid out like a
 * DAW. The ruler shows sections, bars|beats and minutes:seconds; drag across
 * its bottom strip to choose a loop range. Each track is a row with a clip
 * per section it plays in. Double-click a clip to look inside it (drum grid
 * or piano roll); right-click a track for its menu (open, loop, change the
 * sound, new pattern, remove, add a track).
 */
export function TimelineView() {
  const { viewSong, activeSegment, setActiveSegment } = useSession();
  const model = useMemo(() => (viewSong ? buildSequencerModel(viewSong) : undefined), [viewSong]);
  const defs = useMemo(() => indexInstrumentDefinitions(viewSong), [viewSong]);
  const { currentSeconds, playing, isThisSong, seek, liveKey, fetchPayload, editorDirty, live, playPause } = useLiveTransport();
  const edits = useTrackEdits(liveKey);
  const [meters, setMeters] = useState<LaneMeters | undefined>(undefined);
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const [selectedTrack, setSelectedTrack] = useState<string | undefined>(undefined);
  /** Where the last right-click landed: which track, which section. */
  const [menuAt, setMenuAt] = useState<{ track: string; section: number | undefined; inSelection: boolean } | undefined>(undefined);

  // Per-track waveforms: measured in a background worker for the version on
  // screen (a moment after editing stops), filling in as it runs.
  useEffect(() => {
    setMeters(undefined);
    if (!liveKey) return;
    let cancel: (() => void) | undefined;
    const t = setTimeout(() => {
      cancel = livePlayer.meters(liveKey, fetchPayload, setMeters);
    }, editorDirty ? 1500 : 300);
    return () => {
      clearTimeout(t);
      cancel?.();
    };
  }, [liveKey, fetchPayload, editorDirty]);
  const meterMax = useMemo(() => {
    let m = 0;
    for (const arr of meters?.peaks ?? []) for (const v of arr) if (v > m) m = v;
    return m;
  }, [meters]);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [pxPerBar, setPxPerBar] = useState<number | undefined>(undefined);
  const [follow, setFollow] = useState(true);

  const bpm = viewSong?.bpm ?? 120;
  const secondsPerBar = (BEATS_PER_BAR * 60) / bpm;

  const fit = useCallback(() => {
    const el = scrollerRef.current;
    if (!el || !model || model.totalBars === 0) return;
    const fitted = (el.clientWidth - HEADER_W - 24) / model.totalBars;
    setPxPerBar(Math.min(MAX_PX_PER_BAR, Math.max(MIN_PX_PER_BAR, fitted)));
  }, [model]);

  // Start fitted to the window.
  useLayoutEffect(() => {
    if (pxPerBar === undefined) fit();
  }, [fit, pxPerBar]);

  const px = pxPerBar ?? 24;
  const playheadBar = isThisSong ? currentSeconds / secondsPerBar : 0;
  const playheadX = HEADER_W + playheadBar * px;

  // Keep the playhead in view while playing.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || !follow || !playing) return;
    const left = el.scrollLeft + HEADER_W;
    const right = el.scrollLeft + el.clientWidth - 80;
    if (playheadX < left || playheadX > right) el.scrollLeft = Math.max(0, playheadX - HEADER_W - 120);
  }, [playheadX, follow, playing]);

  const range: BarRange | undefined = live.loopRange
    ? { start: live.loopRange.start / secondsPerBar, end: live.loopRange.end / secondsPerBar }
    : undefined;
  const setRange = useCallback(
    (r: BarRange | undefined) => livePlayer.setLoopRange(r ? { start: r.start * secondsPerBar, end: r.end * secondsPerBar } : undefined),
    [secondsPerBar],
  );

  const selectionMenu: SelectionActions = {
    label: range ? `Selection ${fmtBar(range.start)} – ${fmtBar(range.end)}` : '',
    looping: live.looping,
    onLoop: () => {
      if (!range) return;
      livePlayer.setLooping(true);
      if (!playing) {
        if (liveKey && livePlayer.isLoaded(liveKey)) playPause();
        else seek(range.start * secondsPerBar);
      }
    },
    onPlay: () => {
      if (!range) return;
      seek(range.start * secondsPerBar);
      if (!playing && liveKey && livePlayer.isLoaded(liveKey)) playPause();
    },
    onClear: () => setRange(undefined),
  };

  const loopSection = useCallback(
    (sec: SeqSection) => {
      setRange({ start: sec.startBar, end: sec.startBar + sec.bars });
      livePlayer.setLooping(true);
      setActiveSegment(sec.name);
      if (!playing) {
        if (liveKey && livePlayer.isLoaded(liveKey)) {
          livePlayer.seek(sec.startBar * secondsPerBar);
          playPause();
        } else seek(sec.startBar * secondsPerBar);
      }
    },
    [setRange, setActiveSegment, playing, liveKey, secondsPerBar, playPause, seek],
  );

  if (!viewSong || !model) {
    return <div className="flex h-full items-center justify-center text-[15px] text-muted">No song loaded.</div>;
  }

  const width = model.totalBars * px;
  const sectionIndexAt = (bar: number) => model.sections.findIndex((s) => bar >= s.startBar && bar < s.startBar + s.bars);
  const barFromEvent = (e: ReactMouseEvent<HTMLElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return Math.max(0, Math.min(model.totalBars, (e.clientX - rect.left) / px));
  };
  const zoom = (factor: number) => setPxPerBar(Math.min(MAX_PX_PER_BAR, Math.max(MIN_PX_PER_BAR, px * factor)));
  const editable = (track: string) => edits.options.data?.tracks[track]?.editable === true;
  /** Whether other sounds can be offered (drum kits are fixed per genre). */
  const canChangeSound = (track: string) => {
    const info = edits.options.data?.tracks[track];
    if (!info?.editable || !info.family) return false;
    return (edits.options.data?.families.find((f) => f.family === info.family)?.sounds.length ?? 0) > 0;
  };
  const openDetail = (track: SeqTrack, section: number) => {
    if (track.clips.some((c) => c.section === section)) setDialog({ kind: 'detail', track: track.name, section });
  };

  const detail = dialog?.kind === 'detail' ? dialog : undefined;
  const detailTrack = detail ? model.tracks.find((t) => t.name === detail.track) : undefined;
  const detailClip = detail && detailTrack ? detailTrack.clips.find((c) => c.section === detail.section) : undefined;

  const newPattern = (track: string) => void edits.run({ kind: 'newPattern', track }, `New pattern for ${track}`);

  return (
    <div className="flex h-full flex-col text-white">
      <div className="flex shrink-0 items-center gap-2 border-b border-line/50 px-4 py-2 text-[13px]">
        <span className="mr-2 text-white/55">
          {model.tracks.length} tracks · {model.totalBars} bars · {Math.floor((model.totalBars * secondsPerBar) / 60)}:
          {String(Math.round(model.totalBars * secondsPerBar) % 60).padStart(2, '0')}
        </span>
        {range ? (
          <span className="mr-2 font-mono text-[12px] text-sky-300/90" title="Loop range (bars|beats)">
            Range {fmtBar(range.start)} – {fmtBar(range.end)}
          </span>
        ) : null}
        {edits.busy ? (
          <span className="flex items-center gap-2 text-white/70" role="status">
            <span className="h-2 w-2 animate-pulse rounded-full bg-white/60" aria-hidden="true" />
            {edits.busy}…
          </span>
        ) : edits.error ? (
          <span className="flex items-center gap-2 text-err" role="alert">
            {edits.error}
            <button type="button" onClick={edits.clearError} className="text-white/60 hover:text-white" aria-label="Dismiss">
              ✕
            </button>
          </span>
        ) : meters && !meters.done ? (
          <span className="text-white/45" role="status">
            Measuring track levels {Math.round((meters.doneBins / Math.max(1, meters.binCount)) * 100)}%
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => setDialog({ kind: 'add', sections: model.sections.map((s) => s.name) })}
            disabled={!edits.options.data || Boolean(edits.busy)}
            className="mr-3 h-8 rounded-full border border-white/30 px-3.5 text-[13px] font-semibold text-white hover:border-white/60 disabled:opacity-40"
          >
            + Add track
          </button>
          <ToolButton onClick={() => zoom(1 / 1.5)} label="Zoom out">−</ToolButton>
          <ToolButton onClick={() => zoom(1.5)} label="Zoom in">+</ToolButton>
          <ToolButton onClick={fit} label="Fit the song to the window">Fit</ToolButton>
          <label className="ml-3 flex cursor-pointer items-center gap-2 text-white/70">
            <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} className="accent-[#ff0000]" />
            Follow playhead
          </label>
        </div>
      </div>

      <div ref={scrollerRef} className="relative min-h-0 flex-1 overflow-auto bg-[#0b0c15]">
        <div ref={contentRef} className="relative" style={{ width: HEADER_W + width, minHeight: '100%' }}>
          {/* Ruler. */}
          <div className="sticky top-0 z-30 flex bg-[#0d0d17]" style={{ height: RULER_H }}>
            <div
              className="sticky left-0 z-40 flex shrink-0 flex-col border-b border-r border-line/60 bg-[#0d0d17] px-3 text-[10px] text-white/40"
              style={{ width: HEADER_W }}
            >
              <span style={{ height: MARKERS_H, lineHeight: `${MARKERS_H}px` }}>Sections</span>
              <span style={{ height: BARS_H, lineHeight: `${BARS_H}px` }}>Bars|beats</span>
              <span style={{ height: TIME_H, lineHeight: `${TIME_H}px` }}>Min:sec</span>
              <span className="text-sky-300/70" style={{ height: LOOP_H, lineHeight: `${LOOP_H}px` }}>Loop (drag)</span>
            </div>
            <SelectionMenu selection={range ? selectionMenu : undefined}>
            <div className="border-b border-line/60">
              <Ruler
                model={model}
                px={px}
                secondsPerBar={secondsPerBar}
                activeSegment={activeSegment}
                range={range}
                looping={live.looping}
                onSeekBar={(bar) => seek(bar * secondsPerBar)}
                onSelectSection={setActiveSegment}
                onRangeChange={setRange}
              />
            </div>
            </SelectionMenu>
            {isThisSong && playheadX >= HEADER_W ? (
              <span
                className="pointer-events-none absolute top-[22px] z-[35] h-0 w-0 -translate-x-1/2 border-x-[6px] border-t-[8px] border-x-transparent border-t-accent"
                style={{ left: playheadX + 0.5 }}
                aria-hidden="true"
              />
            ) : null}
          </div>

          {/* Loop range across the tracks. */}
          {range ? (
            <div
              className={`pointer-events-none absolute z-[5] border-x ${live.looping ? 'border-sky-300 bg-sky-400/[0.16]' : 'border-white/70 bg-white/[0.12]'}`}
              style={{ left: HEADER_W + range.start * px, width: (range.end - range.start) * px, top: RULER_H, bottom: 0 }}
            />
          ) : null}

          {/* Selection edges over the tracks: drag to adjust. */}
          {range
            ? ([0, 1] as const).map((i) => (
                <div
                  key={i}
                  className="absolute z-[6] w-[11px] cursor-ew-resize"
                  style={{ left: HEADER_W + (i === 0 ? range.start : range.end) * px - 5, top: RULER_H, bottom: 0 }}
                  title="Drag to move this edge of the selection"
                  onPointerDown={(e) =>
                    beginEdgeDrag(e, {
                      originX: () => contentRef.current!.getBoundingClientRect().left + HEADER_W,
                      pxPerBar: px,
                      totalBars: model.totalBars,
                      fixed: i === 0 ? range.end : range.start,
                      onRange: setRange,
                    })
                  }
                />
              ))
            : null}

          {model.tracks.map((t, i) => (
            <TrackMenu
              key={t.name}
              track={t}
              section={menuAt?.track === t.name ? menuAt.section : undefined}
              selection={menuAt?.track === t.name && menuAt.inSelection ? selectionMenu : undefined}
              sections={model.sections}
              editable={editable(t.name)}
              soundChangeable={canChangeSound(t.name)}
              busy={Boolean(edits.busy) || !edits.options.data}
              onOpen={(s) => openDetail(t, s)}
              onLoop={(s) => loopSection(model.sections[s]!)}
              onChangeSound={() => setDialog({ kind: 'sound', track: t.name })}
              onNewPattern={() => newPattern(t.name)}
              onRemove={() => edits.removeTrack(t.name)}
              onAdd={(s) =>
                setDialog({ kind: 'add', sections: s === undefined ? model.sections.map((x) => x.name) : [model.sections[s]!.name] })
              }
            >
              <div
                className={`relative flex ${i % 2 ? 'bg-white/[0.015]' : ''}`}
                style={{ height: ROW_H }}
                onContextMenu={(e) => {
                  const lane = (e.target as HTMLElement).closest('[data-lane]');
                  const bar = lane ? (e.clientX - lane.getBoundingClientRect().left) / px : undefined;
                  const s = bar === undefined ? -1 : sectionIndexAt(bar);
                  setMenuAt({
                    track: t.name,
                    section: s >= 0 && t.clips.some((c) => c.section === s) ? s : undefined,
                    inSelection: Boolean(range && bar !== undefined && bar >= range.start && bar <= range.end),
                  });
                  setSelectedTrack(t.name);
                }}
              >
                <div
                  className={`sticky left-0 z-10 flex shrink-0 cursor-default items-center gap-2.5 border-b border-r border-line/40 pr-3 ${
                    selectedTrack === t.name ? 'bg-[#1a1c2b]' : 'bg-[#10111b]'
                  }`}
                  style={{ width: HEADER_W }}
                  onClick={() => setSelectedTrack(t.name)}
                >
                  <span className="h-full w-[4px] shrink-0" style={{ background: t.color }} aria-hidden="true" />
                  <span className="w-4 shrink-0 text-right font-mono text-[11px] text-white/35">{i + 1}</span>
                  <TrackName
                    name={t.name}
                    catalogId={catalogIdOf(defs.get(t.name)?.id)}
                    notPlayed={Boolean(meters?.done && !meters.names.includes(t.name))}
                  />
                  <MuteSolo lane={t.name} muted={live.muted.includes(t.name)} solo={live.solo.includes(t.name)} anySolo={live.solo.length > 0} />
                </div>
                <div
                  data-lane
                  className="relative shrink-0 cursor-pointer border-b border-line/25"
                  style={{ width }}
                  onPointerDown={(e) =>
                    beginRangeDrag(e, {
                      el: e.currentTarget,
                      pxPerBar: px,
                      totalBars: model.totalBars,
                      onRange: setRange,
                      onClick: (bar) => {
                        setSelectedTrack(t.name);
                        const s = sectionIndexAt(bar);
                        if (s >= 0) setActiveSegment(model.sections[s]!.name);
                      },
                    })
                  }
                  onDoubleClick={(e) => {
                    const s = sectionIndexAt(barFromEvent(e));
                    if (s >= 0) openDetail(t, s);
                  }}
                  title="Drag to select a range · double-click a clip to open it · right-click for more"
                >
                  <TrackCanvas
                    track={t}
                    model={model}
                    px={px}
                    secondsPerBar={secondsPerBar}
                    peaks={meters?.peaks[meters.names.indexOf(t.name)]}
                    binSec={meters?.binSec ?? 0}
                    meterMax={meterMax}
                    dimmed={live.solo.length > 0 ? !live.solo.includes(t.name) : live.muted.includes(t.name)}
                    selectedSection={selectedTrack === t.name ? model.sections.findIndex((s) => s.name === activeSegment) : undefined}
                  />
                </div>
              </div>
            </TrackMenu>
          ))}

          {/* Add a track. */}
          <div className="relative flex" style={{ height: 40 }}>
            <div className="sticky left-0 z-10 flex shrink-0 items-center border-b border-r border-line/40 bg-[#10111b] px-4" style={{ width: HEADER_W }}>
              <button
                type="button"
                onClick={() => setDialog({ kind: 'add', sections: model.sections.map((s) => s.name) })}
                disabled={!edits.options.data || Boolean(edits.busy)}
                className="text-[13px] text-white/55 hover:text-white disabled:opacity-40"
              >
                + Add track
              </button>
            </div>
            <div className="shrink-0 border-b border-line/25" style={{ width }} />
          </div>

          {/* Chords per bar, when there is room to read them. */}
          <div className="relative flex" style={{ height: CHORD_H }}>
            <div
              className="sticky left-0 z-10 flex shrink-0 items-center border-r border-line/40 bg-[#10111b] px-4 text-[12px] text-white/55"
              style={{ width: HEADER_W }}
            >
              Chords
            </div>
            <div className="relative shrink-0" style={{ width }}>
              {px >= 30
                ? model.sections.flatMap((s) =>
                    s.chordsByBar.slice(0, s.bars).map((chords, i) => (
                      <span
                        key={`${s.name}-${i}`}
                        className="absolute top-1.5 truncate font-mono text-[11px] text-white/60"
                        style={{ left: (s.startBar + i) * px + 3, width: px - 4 }}
                        title={chords.join(' ')}
                      >
                        {dedupe(chords).join(' ')}
                      </span>
                    )),
                  )
                : null}
            </div>
          </div>

          {/* Playhead: a line through the tracks with a marker on the ruler. */}
          {isThisSong ? (
            <div
              className="pointer-events-none absolute top-0 bottom-0 z-20 w-px bg-accent shadow-[0_0_6px_rgba(255,0,0,0.6)]"
              style={{ left: playheadX }}
              aria-hidden="true"
            />
          ) : null}
        </div>
      </div>

      {detail && detailTrack && detailClip ? (
        <ClipDetail
          track={detailTrack}
          clip={detailClip}
          section={model.sections[detail.section]!}
          playheadBeat={isThisSong ? (currentSeconds / secondsPerBar) * BEATS_PER_BAR : undefined}
          onClose={() => setDialog(undefined)}
          onLoopSection={() => loopSection(model.sections[detail.section]!)}
          onNewPattern={() => newPattern(detailTrack.name)}
          onChangeSound={() => setDialog({ kind: 'sound', track: detailTrack.name })}
          editable={editable(detailTrack.name)}
          soundChangeable={canChangeSound(detailTrack.name)}
          busy={Boolean(edits.busy)}
        />
      ) : null}
      {dialog?.kind === 'sound' && edits.options.data ? (
        <ChangeSoundDialog
          track={dialog.track}
          options={edits.options.data}
          onClose={() => setDialog(undefined)}
          onPick={(soundId) => {
            setDialog(undefined);
            void edits.run({ kind: 'changeSound', track: dialog.track, soundId }, `Changing the sound of ${dialog.track}`);
          }}
        />
      ) : null}
      {dialog?.kind === 'add' && edits.options.data ? (
        <AddTrackDialog
          options={edits.options.data}
          hasDrums={model.tracks.some((t) => t.name === 'Drums')}
          sections={model.sections}
          initialSections={dialog.sections}
          onClose={() => setDialog(undefined)}
          onAdd={(family, segments, soundId) => {
            setDialog(undefined);
            void edits.run({ kind: 'addTrack', family, segments, ...(soundId ? { soundId } : {}) }, 'Adding a track');
          }}
        />
      ) : null}
    </div>
  );
}

/** Right-click menu for a track row. `section` is the clip under the pointer, if any. */
function TrackMenu({
  track,
  section,
  selection,
  sections,
  editable,
  soundChangeable,
  busy,
  onOpen,
  onLoop,
  onChangeSound,
  onNewPattern,
  onRemove,
  onAdd,
  children,
}: {
  track: SeqTrack;
  section: number | undefined;
  /** Set when the right-click landed inside the selected range. */
  selection: SelectionActions | undefined;
  sections: readonly SeqSection[];
  editable: boolean;
  soundChangeable: boolean;
  busy: boolean;
  onOpen(section: number): void;
  onLoop(section: number): void;
  onChangeSound(): void;
  onNewPattern(): void;
  onRemove(): void;
  onAdd(section: number | undefined): void;
  children: ReactNode;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className={MENU}>
        <ContextMenuLabel className="px-3 py-2 text-[12px] font-normal text-white/50">
          {track.name}
          {section !== undefined ? ` · ${sections[section]!.name}` : ''}
        </ContextMenuLabel>
        {selection ? (
          <>
            <SelectionItems selection={selection} />
            <ContextMenuSeparator className="my-1 h-px bg-line" />
          </>
        ) : null}
        {section !== undefined ? (
          <>
            <ContextMenuItem className={ITEM} onSelect={() => onOpen(section)}>
              Open <span className="ml-auto pl-6 text-[12px] text-white/40">Double-click</span>
            </ContextMenuItem>
            <ContextMenuItem className={ITEM} onSelect={() => onLoop(section)}>
              Loop {sections[section]!.name}
            </ContextMenuItem>
            <ContextMenuSeparator className="my-1 h-px bg-line" />
          </>
        ) : null}
        <ContextMenuItem className={ITEM} disabled={!soundChangeable || busy} onSelect={onChangeSound}>
          Change sound…
        </ContextMenuItem>
        <ContextMenuItem className={ITEM} disabled={!editable || busy} onSelect={onNewPattern}>
          New pattern
        </ContextMenuItem>
        <ContextMenuSeparator className="my-1 h-px bg-line" />
        <ContextMenuItem className={`${ITEM} text-err`} disabled={busy} onSelect={onRemove}>
          Remove track <span className="ml-auto pl-6 text-[12px] text-white/40">Undo: Ctrl+Z</span>
        </ContextMenuItem>
        <ContextMenuSeparator className="my-1 h-px bg-line" />
        <ContextMenuItem className={ITEM} disabled={busy} onSelect={() => onAdd(section)}>
          Add track…
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

interface SelectionActions {
  readonly label: string;
  readonly looping: boolean;
  onPlay(): void;
  onLoop(): void;
  onClear(): void;
}

function SelectionItems({ selection }: { selection: SelectionActions }) {
  return (
    <>
      <ContextMenuLabel className="px-3 pb-1 pt-2 font-mono text-[11px] font-normal text-sky-300/80">{selection.label}</ContextMenuLabel>
      <ContextMenuItem className={ITEM} onSelect={selection.onPlay}>
        Play from selection start
      </ContextMenuItem>
      {selection.looping ? null : (
        <ContextMenuItem className={ITEM} onSelect={selection.onLoop}>
          Loop selection <span className="ml-auto pl-6 text-[12px] text-white/40">L</span>
        </ContextMenuItem>
      )}
      <ContextMenuItem className={ITEM} onSelect={selection.onClear}>
        Clear selection
      </ContextMenuItem>
    </>
  );
}

/** Right-click menu for the ruler while a range is selected. */
function SelectionMenu({ selection, children }: { selection: SelectionActions | undefined; children: ReactNode }) {
  if (!selection) return <>{children}</>;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className={MENU}>
        <SelectionItems selection={selection} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

const CATALOG_ID = /^[0-9a-f]{16}$/u;
function catalogIdOf(id: unknown): string | undefined {
  return typeof id === 'string' && CATALOG_ID.test(id) ? id : undefined;
}

/** Track name, with the public name of its sound underneath when it is a catalog sound. */
function TrackName({ name, catalogId, notPlayed }: { name: string; catalogId: string | undefined; notPlayed: boolean }) {
  const entry = useQuery({
    queryKey: catalogQueryKeys.entry(catalogId ?? ''),
    queryFn: ({ signal }) => catalogApi.get(catalogId as string, signal),
    enabled: Boolean(catalogId),
    staleTime: 5 * 60_000,
  });
  const sound = entry.data?.entry.publicName;
  return (
    <span className="flex min-w-0 flex-col leading-tight">
      <span className="truncate text-[13px] font-semibold text-white/90" title={name}>{name}</span>
      {notPlayed ? (
        <span className="truncate text-[11px] text-white/35" title="The playback engine has no voice for this track yet">
          Not in playback yet
        </span>
      ) : sound ? (
        <span className="truncate text-[11px] text-white/45" title={sound}>{sound}</span>
      ) : null}
    </span>
  );
}

/** Mute / solo for a track; applies live to the playing song. */
function MuteSolo({ lane, muted, solo, anySolo }: { lane: string; muted: boolean; solo: boolean; anySolo: boolean }) {
  const btn = 'h-6 w-6 rounded-[4px] border text-[11px] font-bold leading-none';
  return (
    <span className="ml-auto flex shrink-0 gap-1">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          livePlayer.setMuted(lane, !muted);
        }}
        aria-pressed={muted}
        aria-label={`${muted ? 'Unmute' : 'Mute'} ${lane}`}
        title={muted ? 'Unmute' : 'Mute'}
        className={`${btn} ${muted ? 'border-yellow-400 bg-yellow-400 text-black' : anySolo && !solo ? 'border-line text-white/30' : 'border-line text-white/60 hover:text-white'}`}
      >
        M
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          livePlayer.setSolo(lane, !solo);
        }}
        aria-pressed={solo}
        aria-label={`${solo ? 'Unsolo' : 'Solo'} ${lane}`}
        title={solo ? 'Unsolo' : 'Solo (hear only soloed tracks)'}
        className={`${btn} ${solo ? 'border-emerald-400 bg-emerald-400 text-black' : 'border-line text-white/60 hover:text-white'}`}
      >
        S
      </button>
    </span>
  );
}

function ToolButton({ onClick, label, children }: { onClick(): void; label: string; children: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="h-8 min-w-8 rounded-[6px] border border-line px-2 text-[14px] text-white/85 hover:border-white/50"
    >
      {children}
    </button>
  );
}

function dedupe(chords: readonly string[]): string[] {
  return chords.filter((c, i) => i === 0 || c !== chords[i - 1]);
}
