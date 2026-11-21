import { useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';

import { playbackApi } from '../api/playback';
import { renderInFlight, renderLabel, songsApi, songsQueryKeys, type RenderInfo } from '../api/songs';
import { livePlayer } from '../audio/livePlayer';
import { useLivePosition, useLiveState } from '../audio/useLivePlayer';
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

  // What Play plays: the saved song, or the working copy when it has edits.
  const liveKey = useMemo(
    () => (viewSong && editorDirty ? `edit:${fnv1a(JSON.stringify(viewSong))}` : songId),
    [viewSong, editorDirty, songId],
  );
  const live = useLiveState();
  const isThisSong = live.key !== undefined && live.key === liveKey;
  const playing = isThisSong && live.status === 'playing';
  const loading = isThisSong && live.status === 'loading';
  const currentSeconds = useLivePosition(playing) * (isThisSong ? 1 : 0);

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

  const handlePlayPause = useCallback(() => {
    if (!liveKey || !viewSong) return;
    if (playing) {
      void livePlayer.pause();
      return;
    }
    const song = viewSong;
    const savedId = songId;
    void livePlayer.play(liveKey, (signal) =>
      editorDirty || !savedId ? playbackApi.forSong(song, signal) : playbackApi.forSaved(savedId, signal),
    );
  }, [liveKey, viewSong, playing, editorDirty, songId]);

  const currentBar = totalBars > 0 ? Math.max(1, Math.floor(position * totalBars) + 1) : 1;
  const currentBeat =
    totalBars > 0 ? Math.max(1, Math.floor((position * totalBars * 4) % 4) + 1) : 1;

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
              onClick={handlePlayPause}
              disabled={!liveKey || loading}
              className="h-10 w-10 rounded-full flex items-center justify-center text-white text-[15px] hover:bg-white/10 transition-colors disabled:opacity-30 disabled:hover:bg-transparent"
              aria-label={playing ? 'Pause' : 'Play'}
              title={playing ? 'Pause' : 'Play'}
            >
              {loading ? '…' : playing ? '❚❚' : '▶'}
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
                readOnly
                className="absolute inset-0 opacity-0 z-10 cursor-default"
                aria-label="Playhead position"
                disabled
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

          <div className="flex items-baseline gap-4">
            <div className="flex flex-col items-center px-2">
              <strong className="text-[20px] text-white font-semibold leading-tight tabular-nums">
                {currentBar}
              </strong>
              <span className="text-[10px] uppercase tracking-[0.18em] text-dim">Bar</span>
            </div>
            <div className="flex flex-col items-center px-2">
              <strong className="text-[20px] text-white font-semibold leading-tight tabular-nums">
                {currentBeat}
              </strong>
              <span className="text-[10px] uppercase tracking-[0.18em] text-dim">Beat</span>
            </div>
          </div>
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
        onSeek={() => undefined}
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

/** 32-bit FNV-1a of a string, as hex: a cheap key for the working copy. */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}
