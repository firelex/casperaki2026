import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { MouseEvent as ReactMouseEvent } from 'react';

import { catalogApi, catalogQueryKeys } from '../api/catalog';
import { livePlayer, type LaneMeters } from '../audio/livePlayer';
import { useLiveTransport } from '../audio/useLiveTransport';
import { indexInstrumentDefinitions } from '../types/song';
import { useSession } from '../state/session';
import { BEATS_PER_BAR, buildSequencerModel, type SeqTrack, type SequencerModel } from './sequencerModel';

const HEADER_W = 212;
const ROW_H = 52;
const RULER_H = 54;
const CHORD_H = 28;
const MIN_PX_PER_BAR = 6;
const MAX_PX_PER_BAR = 120;

/**
 * Sequencer (Timeline tab): the whole song on one time axis. Sections run
 * along the top, each instrument is a row with a clip per section it plays
 * in, and the notes are drawn inside the clips. The red playhead follows
 * the live player; click the ruler to jump, click a clip or section to
 * select it for the inspector. Zoom with the − / + buttons or Fit.
 */
export function TimelineView() {
  const { viewSong, activeSegment, setActiveSegment } = useSession();
  const model = useMemo(() => (viewSong ? buildSequencerModel(viewSong) : undefined), [viewSong]);
  const defs = useMemo(() => indexInstrumentDefinitions(viewSong), [viewSong]);
  const { currentSeconds, playing, isThisSong, seek, liveKey, fetchPayload, editorDirty, live } = useLiveTransport();
  const [meters, setMeters] = useState<LaneMeters | undefined>(undefined);

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

  if (!viewSong || !model) {
    return <div className="flex h-full items-center justify-center text-[15px] text-muted">No song loaded.</div>;
  }

  const width = model.totalBars * px;
  const sectionAt = (bar: number) => model.sections.find((s) => bar >= s.startBar && bar < s.startBar + s.bars);
  const active = model.sections.find((s) => s.name === activeSegment);

  const zoom = (factor: number) => setPxPerBar(Math.min(MAX_PX_PER_BAR, Math.max(MIN_PX_PER_BAR, px * factor)));
  const barFromEvent = (e: ReactMouseEvent<HTMLElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return Math.max(0, Math.min(model.totalBars, (e.clientX - rect.left) / px));
  };

  return (
    <div className="flex h-full flex-col text-white">
      <div className="flex shrink-0 items-center gap-2 border-b border-line/50 px-4 py-2 text-[13px]">
        {meters && !meters.done ? (
          <span className="mr-3 text-white/45" role="status">
            Measuring track levels {Math.round((meters.doneBins / Math.max(1, meters.binCount)) * 100)}%
          </span>
        ) : null}
        <span className="mr-2 text-white/55">
          {model.tracks.length} tracks · {model.totalBars} bars · {Math.round(model.totalBars * secondsPerBar / 60)}:
          {String(Math.round(model.totalBars * secondsPerBar) % 60).padStart(2, '0')}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <ToolButton onClick={() => zoom(1 / 1.5)} label="Zoom out">−</ToolButton>
          <ToolButton onClick={() => zoom(1.5)} label="Zoom in">+</ToolButton>
          <ToolButton onClick={fit} label="Fit the song to the window">Fit</ToolButton>
          <label className="ml-3 flex cursor-pointer items-center gap-2 text-white/70">
            <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} className="accent-[#ff0000]" />
            Follow playhead
          </label>
        </div>
      </div>

      <div ref={scrollerRef} className="relative min-h-0 flex-1 overflow-auto">
        <div className="relative" style={{ width: HEADER_W + width, minHeight: '100%' }}>
          {/* Ruler: sections and bar numbers. Click to jump there. */}
          <div className="sticky top-0 z-20 flex bg-[#0d0d17]" style={{ height: RULER_H }}>
            <div className="sticky left-0 z-30 shrink-0 border-b border-r border-line/50 bg-[#0d0d17]" style={{ width: HEADER_W }} />
            <div
              className="relative shrink-0 cursor-pointer border-b border-line/50"
              style={{ width }}
              onClick={(e) => {
                const bar = barFromEvent(e);
                const sec = sectionAt(bar);
                if (sec) setActiveSegment(sec.name);
                seek(bar * secondsPerBar);
              }}
              title="Click to play from here"
            >
              {model.sections.map((s) => (
                <div
                  key={s.name}
                  className="absolute top-0 flex h-[30px] items-center overflow-hidden border-l border-black/40 px-2"
                  style={{
                    left: s.startBar * px,
                    width: s.bars * px,
                    background: `color-mix(in srgb, ${s.color} ${s.name === activeSegment ? 55 : 30}%, transparent)`,
                  }}
                >
                  {s.bars * px > 44 ? <span className="truncate text-[12px] font-semibold text-white">{s.name}</span> : null}
                </div>
              ))}
              <BarNumbers totalBars={model.totalBars} px={px} />
            </div>
          </div>

          {/* Selected section, across every row. */}
          {active ? (
            <div
              className="pointer-events-none absolute z-0 border-x border-white/25 bg-white/[0.04]"
              style={{ left: HEADER_W + active.startBar * px, width: active.bars * px, top: RULER_H, bottom: 0 }}
            />
          ) : null}

          {model.tracks.map((t) => (
            <div key={t.name} className="relative flex" style={{ height: ROW_H }}>
              <div
                className="sticky left-0 z-10 flex shrink-0 items-center gap-2.5 border-b border-r border-line/40 bg-[#10111b] px-4"
                style={{ width: HEADER_W }}
              >
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: t.color }} aria-hidden="true" />
                <TrackName
                  name={t.name}
                  catalogId={catalogIdOf(defs.get(t.name)?.id)}
                  notPlayed={Boolean(meters?.done && !meters.names.includes(t.name))}
                />
                <MuteSolo lane={t.name} muted={live.muted.includes(t.name)} solo={live.solo.includes(t.name)} anySolo={live.solo.length > 0} />
              </div>
              <div
                className="relative shrink-0 cursor-pointer border-b border-line/25"
                style={{ width }}
                onClick={(e) => {
                  const sec = sectionAt(barFromEvent(e));
                  if (sec) setActiveSegment(sec.name);
                }}
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
                />
              </div>
            </div>
          ))}

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

          {/* Playhead. */}
          {isThisSong ? (
            <div
              className="pointer-events-none absolute top-0 bottom-0 z-20 w-[2px] bg-accent shadow-[0_0_8px_rgba(255,0,0,0.6)]"
              style={{ left: playheadX }}
              aria-hidden="true"
            />
          ) : null}
        </div>
      </div>
    </div>
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
      <span className="truncate text-[13px] text-white/90" title={name}>{name}</span>
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

function BarNumbers({ totalBars, px }: { totalBars: number; px: number }) {
  const every = px >= 28 ? 1 : px >= 14 ? 2 : px >= 8 ? 4 : 8;
  const marks: number[] = [];
  for (let b = 0; b < totalBars; b += every) marks.push(b);
  return (
    <>
      {marks.map((b) => (
        <span
          key={b}
          className="absolute bottom-0 h-[22px] border-l border-white/15 pl-1 font-mono text-[10px] leading-[22px] text-white/45"
          style={{ left: b * px }}
        >
          {b + 1}
        </span>
      ))}
    </>
  );
}

function dedupe(chords: readonly string[]): string[] {
  return chords.filter((c, i) => i === 0 || c !== chords[i - 1]);
}

/** Resolve a `var(--x)` colour for canvas drawing. */
function resolveColor(css: string): string {
  const m = /^var\((--[\w-]+)\)$/u.exec(css);
  if (!m) return css;
  const v = getComputedStyle(document.documentElement).getPropertyValue(m[1]!).trim();
  if (!v) throw new Error(`CSS colour ${m[1]} is not defined`);
  return v;
}

/** One track's clips and notes, drawn on a canvas sized to the row. */
function TrackCanvas({
  track,
  model,
  px,
  secondsPerBar,
  peaks,
  binSec,
  meterMax,
  dimmed,
}: {
  track: SeqTrack;
  model: SequencerModel;
  px: number;
  secondsPerBar: number;
  /** This track's peak level per meter bin, when measured. */
  peaks: Float32Array | undefined;
  binSec: number;
  /** Loudest bin across all tracks, so heights compare between tracks. */
  meterMax: number;
  /** Muted, or not soloed while others are. */
  dimmed: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const width = Math.max(1, Math.round(model.totalBars * px));

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = ROW_H * dpr;
    const g = canvas.getContext('2d');
    if (!g) throw new Error('2D canvas is not available');
    g.scale(dpr, dpr);
    g.clearRect(0, 0, width, ROW_H);
    const color = resolveColor(track.color);
    const pad = 5;
    const innerH = ROW_H - pad * 2;
    if (dimmed) g.globalAlpha = 0.35;
    const baseAlpha = dimmed ? 0.35 : 1;

    // Waveform: peak per pixel column, mirrored around the row's middle.
    if (peaks && peaks.length > 0 && meterMax > 0 && binSec > 0) {
      const binsPerPx = secondsPerBar / px / binSec;
      const mid = ROW_H / 2;
      g.fillStyle = color;
      g.globalAlpha = 0.28 * baseAlpha;
      g.beginPath();
      g.moveTo(0, mid);
      const cols = Math.min(width, Math.ceil(peaks.length / binsPerPx));
      const tops: number[] = [];
      for (let x = 0; x < cols; x++) {
        let m = 0;
        const from = Math.floor(x * binsPerPx);
        const to = Math.min(peaks.length, Math.max(from + 1, Math.floor((x + 1) * binsPerPx)));
        for (let i = from; i < to; i++) if (peaks[i]! > m) m = peaks[i]!;
        const h = Math.sqrt(m / meterMax) * (ROW_H / 2 - 2);
        tops.push(h);
        g.lineTo(x, mid - h);
      }
      for (let x = cols - 1; x >= 0; x--) g.lineTo(x, mid + tops[x]!);
      g.closePath();
      g.fill();
    }

    // Drum kits: one thin lane per drum present; pitched parts: by pitch.
    const drumLanes = track.isDrums
      ? [...new Set(track.clips.flatMap((c) => c.notes.map((n) => n.pitch).filter((p): p is number => p !== null)))].sort((a, b) => b - a)
      : [];
    const yFor = (pitch: number | null): number => {
      if (pitch === null) return pad + innerH * 0.35;
      if (track.isDrums) {
        const i = drumLanes.indexOf(pitch);
        return pad + 2 + (i / Math.max(1, drumLanes.length)) * (innerH - 4);
      }
      const r = track.pitchRange;
      if (!r || r.high === r.low) return pad + innerH * 0.45;
      return pad + 2 + (1 - (pitch - r.low) / (r.high - r.low)) * (innerH - 6);
    };
    const noteH = track.isDrums ? Math.max(1.5, (innerH - 4) / Math.max(1, drumLanes.length) - 1) : 3;

    for (const clip of track.clips) {
      const x = clip.startBar * px;
      const w = clip.bars * px;
      g.globalAlpha = 0.16 * baseAlpha;
      g.fillStyle = color;
      g.fillRect(x + 1, pad - 2, Math.max(1, w - 2), innerH + 4);
      g.globalAlpha = 0.9 * baseAlpha;
      g.fillRect(x + 1, pad - 2, 2, innerH + 4);
      g.globalAlpha = (peaks ? 0.7 : 0.85) * baseAlpha;
      for (const n of clip.notes) {
        const nx = (n.start / BEATS_PER_BAR) * px;
        const nw = Math.max(1.2, (n.length / BEATS_PER_BAR) * px - 0.5);
        const y = yFor(n.pitch);
        g.fillRect(nx, y, nw, n.pitch === null ? innerH * 0.3 : noteH);
      }
    }
    g.globalAlpha = 1;
  }, [track, model, px, width, peaks, binSec, meterMax, secondsPerBar, dimmed]);

  return <canvas ref={ref} style={{ width, height: ROW_H }} className="block" aria-label={`${track.name}: ${track.clips.length} sections`} />;
}
