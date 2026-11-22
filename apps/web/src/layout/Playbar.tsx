import { useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';

import { renderInFlight, renderLabel, songsApi, songsQueryKeys, type RenderInfo } from '../api/songs';
import { livePlayer } from '../audio/livePlayer';
import { useLiveTransport } from '../audio/useLiveTransport';
import { fmtClock } from './playbarRenderStatus';
import { WaveformLane } from './WaveformLane';
import { useSession } from '../state/session';
import { useRenderStatus } from '../state/useSongActions';
import { summarizeStructure } from '../types/song';

const WAVEFORM_BINS = 512;

/**
 * Editor Playbar.
 *
 * Play renders the song live in the browser (WASM engine, see
 * audio/livePlayer.ts) — the version on screen, unsaved edits included. The
 * server render is only for downloads: once one exists for the saved song,
 * its waveform shows in the lane and the strip offers WAV / MP3.
 */
export function Playbar() {
  const { activeSong, viewSong, editorDirty } = useSession();
  const songId = activeSong?.id;

  const renderQuery = useRenderStatus(songId);
  const render = renderQuery.data;
  const done = render?.state === 'done';
  const peaksQuery = useQuery({
    queryKey: songsQueryKeys.peaks(songId ?? '', WAVEFORM_BINS),
    queryFn: ({ signal }) => songsApi.renderPeaks(songId as string, WAVEFORM_BINS, signal),
    enabled: Boolean(songId) && done,
    staleTime: Infinity,
  });

  const {
    liveKey, live, isThisSong, playing, loading, currentSeconds, fetchPayload, playPause: handlePlayPause, seek: seekToSeconds, stop, toggleLoop,
  } = useLiveTransport();

  const summary = useMemo(
    () => (viewSong ? summarizeStructure(viewSong) : []),
    [viewSong],
  );
  const totalBars = summary.reduce((sum, s) => sum + s.bars, 0);
  const bpm = viewSong?.bpm ?? 120;
  const songSeconds = (totalBars * 4 * 60) / bpm;

  const totalSeconds = isThisSong && live.durationSec > 0 ? live.durationSec : songSeconds;
  const safeTotalSeconds = totalSeconds > 0 ? totalSeconds : 0;
  const position = safeTotalSeconds > 0 ? Math.min(1, currentSeconds / safeTotalSeconds) : 0;
  // The render's waveform only matches the saved song.
  const peaks = done && !editorDirty ? peaksQuery.data : undefined;

  // Get the version on screen ready in the background, so Play starts at
  // once: right away for the saved song, a moment after editing stops.
  useEffect(() => {
    if (!liveKey || !viewSong) return;
    const t = setTimeout(() => livePlayer.prepare(liveKey, fetchPayload), editorDirty ? 1200 : 0);
    return () => clearTimeout(t);
  }, [liveKey, viewSong, editorDirty, fetchPayload]);

  // Space bar plays / pauses, unless typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.code !== 'Space' && e.code !== 'KeyL' && e.code !== 'Enter') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(t.tagName))) return;
      e.preventDefault();
      if (e.code === 'Space') handlePlayPause();
      else if (e.code === 'KeyL') {
        if (live.loopRange) toggleLoop();
      } else stop(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handlePlayPause, toggleLoop, stop, live.loopRange]);

  const loaded = Boolean(liveKey) && isThisSong && live.status !== 'loading' && live.status !== 'idle';
  const tbtn =
    'h-10 w-10 rounded-[8px] flex items-center justify-center text-white hover:bg-white/10 transition-colors disabled:opacity-30 disabled:hover:bg-transparent';

  return (
    <footer className="flex flex-col w-full border-t border-line/60 bg-[#0d0d17]">
      <div className="flex items-center justify-between w-full h-[88px] px-[60px]">
        <button
          type="button"
          className="flex items-center gap-3 text-white text-[15px] font-semibold uppercase tracking-wide hover:text-white/80 transition-colors disabled:opacity-40"
          disabled
          title="Volume Mixer — modal not in this slice"
        >
          <span>Volume Mixer</span>
          <span className="text-[14px]">▴</span>
        </button>

        <div className="flex items-center gap-6 flex-1 justify-center max-w-[64%]">
          <div
            className="flex-1 max-w-[42vw] h-[60px] flex items-center gap-4 px-3 rounded-lg"
            style={{
              background: 'rgba(38, 43, 51, 0.6)',
              boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06)',
            }}
          >
            <button
              type="button"
              onClick={() => stop(false)}
              onDoubleClick={() => stop(true)}
              disabled={!loaded}
              className={tbtn}
              aria-label="Stop"
              title="Stop and go back to where play started (double-click: back to the beginning)"
            >
              <span className="block h-3 w-3 rounded-[2px] bg-current" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={handlePlayPause}
              disabled={!liveKey || loading}
              className={`${tbtn} text-[15px]`}
              aria-label={playing ? 'Pause' : 'Play'}
              title={playing ? 'Pause (space)' : 'Play (space)'}
            >
              {loading ? '…' : playing ? '❚❚' : '▶'}
            </button>
            <button
              type="button"
              onClick={toggleLoop}
              disabled={!live.loopRange}
              aria-pressed={live.looping}
              className={`${tbtn} ${live.looping ? 'bg-sky-400/20 text-sky-300 hover:bg-sky-400/30' : ''}`}
              aria-label={live.looping ? 'Turn loop off' : 'Loop the selected range'}
              title={live.loopRange ? (live.looping ? 'Loop on (L)' : 'Loop the selected range (L)') : 'Drag across the bar above the tracks to choose a range to loop'}
            >
              <LoopIcon />
            </button>

            <span className="font-mono text-[14px] text-white tabular-nums w-[44px] text-right">
              {fmtClock(currentSeconds)}
            </span>

            <div className="flex-1 relative h-6 flex items-center cursor-pointer">
              <input
                type="range"
                min={0}
                max={1000}
                value={Math.round(position * 1000)}
                onChange={(e) => seekToSeconds((Number(e.target.value) / 1000) * safeTotalSeconds)}
                className="absolute inset-0 opacity-0 cursor-pointer z-10"
                aria-label="Playhead position"
              />
              <div className="absolute left-0 right-0 h-1.5 rounded-full bg-black/40" />
              <div
                className="absolute left-0 h-1.5 rounded-full bg-gradient-to-r from-white/75 to-white/30"
                style={{ width: `${position * 100}%` }}
              />
              <div
                className="absolute h-[18px] w-[18px] rounded-full bg-white shadow-[0_0_4px_rgba(0,0,0,0.4)] -translate-x-1/2"
                style={{ left: `${position * 100}%` }}
              />
            </div>

            <span className="font-mono text-[14px] text-white tabular-nums w-[44px]">
              {fmtClock(safeTotalSeconds)}
            </span>
          </div>

          <Counter seconds={currentSeconds} bpm={bpm} />
        </div>

        <div className="flex flex-col items-end gap-0.5">
          <span className="font-mono text-[22px] text-white font-semibold leading-tight tabular-nums">
            {bpm}
          </span>
          <span className="text-[10px] uppercase tracking-[0.22em] text-dim font-semibold">
            BPM
          </span>
        </div>
      </div>

      <WaveformLane
        peaks={peaks}
        loading={peaksQuery.isPending && done && !editorDirty}
        durationSec={safeTotalSeconds}
        positionSec={currentSeconds}
        segments={summary}
        bpm={bpm}
        onSeek={seekToSeconds}
        artifactExists={Boolean(peaks)}
      />

      <LiveStatusStrip
        status={isThisSong ? live.status : 'idle'}
        step={live.step}
        error={isThisSong ? live.error : undefined}
        dirty={editorDirty}
        render={render}
      />
    </footer>
  );
}

const TICKS_PER_BEAT = 960;

/** DAW-style counter: bars | beats | ticks, with minutes:seconds underneath. */
function Counter({ seconds, bpm }: { seconds: number; bpm: number }) {
  const beatsIn = Math.max(0, (seconds * bpm) / 60);
  const bar = Math.floor(beatsIn / 4) + 1;
  const beat = Math.floor(beatsIn % 4) + 1;
  const ticks = Math.floor((beatsIn % 1) * TICKS_PER_BEAT);
  const m = Math.floor(seconds / 60);
  const sec = seconds - m * 60;
  return (
    <div
      className="flex min-w-[150px] flex-col items-end rounded-[8px] border border-line/60 bg-black/50 px-3 py-1.5 font-mono tabular-nums"
      aria-label={`Bar ${bar}, beat ${beat}`}
    >
      <span className="text-[20px] leading-tight text-emerald-300">
        {String(bar).padStart(3, '\u2007')}|{beat}|{String(ticks).padStart(3, '0')}
      </span>
      <span className="text-[12px] leading-tight text-white/50">
        {m}:{sec.toFixed(3).padStart(6, '0')}
      </span>
    </div>
  );
}

function LoopIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17 2l4 4-4 4" />
      <path d="M3 11V9a3 3 0 0 1 3-3h15" />
      <path d="M7 22l-4-4 4-4" />
      <path d="M21 13v2a3 3 0 0 1-3 3H3" />
    </svg>
  );
}

interface LiveStatusStripProps {
  readonly status: string;
  readonly step: string;
  readonly error: string | undefined;
  readonly dirty: boolean;
  readonly render: RenderInfo | undefined;
}

/** Left: what the live player is doing. Right: the server render, which
 *  exists only for downloads. */
function LiveStatusStrip({ status, step, error, dirty, render }: LiveStatusStripProps) {
  const label =
    status === 'loading'
      ? step
      : status === 'error'
        ? `Playback failed: ${error ?? 'unknown error'}`
        : status === 'playing'
          ? `Playing live in your browser${dirty ? ' (your unsaved edits)' : ''}`
          : status === 'paused'
            ? 'Paused'
            : status === 'ended'
              ? 'Finished'
              : `Press play to hear ${dirty ? 'your edits' : 'this song'}. It plays straight away in your browser.`;
  const dotColor =
    status === 'error'
      ? 'bg-accent'
      : status === 'playing'
        ? 'bg-emerald-400'
        : status === 'loading'
          ? 'bg-white/40 animate-pulse'
          : 'bg-white/30';

  return (
    <div className="flex items-center justify-between gap-6 px-[60px] py-2 text-[12px] text-dim border-t border-line/40 bg-[#0b0c14]">
      <div className="flex items-center gap-3 min-w-0">
        <span className={`h-2 w-2 rounded-full shrink-0 ${dotColor}`} aria-hidden />
        <span className="truncate" title={error}>{label}</span>
      </div>
      <div className="flex items-center gap-5 text-[12px] text-dim shrink-0">
        {render?.state === 'done' ? (
          <>
            <span className="text-dim/80">{dirty ? 'Downloads (saved version):' : 'Downloads:'}</span>
            <a className="text-white/85 hover:text-white underline-offset-2 hover:underline" href={`${render.mp3Url}?download=1`}>
              MP3
            </a>
            <a className="text-white/85 hover:text-white underline-offset-2 hover:underline" href={`${render.wavUrl}?download=1`}>
              WAV
            </a>
          </>
        ) : renderInFlight(render) ? (
          <span>Preparing downloads: {renderLabel(render)}</span>
        ) : render?.state === 'failed' ? (
          <span className="text-err" title={render.error}>Export failed</span>
        ) : (
          <span className="text-dim/70">For WAV / MP3, use Export</span>
        )}
      </div>
    </div>
  );
}

