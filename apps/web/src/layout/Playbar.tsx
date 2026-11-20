import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { songsApi, songsQueryKeys, type RenderInfo } from '../api/songs';
import { describeRenderStatus, fmtClock, fmtSecondsLabel } from './playbarRenderStatus';
import { WaveformLane } from './WaveformLane';
import { useSession } from '../state/session';
import { useRenderStatus } from '../state/useSongActions';
import { summarizeStructure } from '../types/song';

const WAVEFORM_BINS = 512;

/**
 * Editor Playbar — mirrors rory-fe `components/editor/Playbar.vue`.
 *
 * The transport plays the open song's own server-side render
 * (GET /api/songs/:id/render.mp3) once it exists; the editor header's
 * Render button starts one. Until then the transport is disabled and the
 * status strip says what to do. The waveform comes from the render's
 * peaks.
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

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [audioReady, setAudioReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [audioError, setAudioError] = useState<string | undefined>(undefined);
  const [currentSeconds, setCurrentSeconds] = useState(0);
  // Falls back to brain-derived total before audio metadata loads, and
  // again if the artifact is missing.
  const [audioDuration, setAudioDuration] = useState<number | undefined>(undefined);

  const summary = useMemo(
    () => (viewSong ? summarizeStructure(viewSong) : []),
    [viewSong],
  );
  const totalBars = summary.reduce((sum, s) => sum + s.bars, 0);
  const bpm = viewSong?.bpm ?? 120;
  const songSeconds = (totalBars * 4 * 60) / bpm;

  const totalSeconds = audioDuration ?? peaksQuery.data?.durationSec ?? songSeconds;
  const safeTotalSeconds = totalSeconds > 0 ? totalSeconds : 0;
  const position = safeTotalSeconds > 0 ? Math.min(1, currentSeconds / safeTotalSeconds) : 0;
  const audioSrc = done ? render.mp3Url : undefined;

  // Hard-reset transport state when the song or its render changes.
  // Without this the audio element would keep the previous song's src.
  useEffect(() => {
    setAudioReady(false);
    setAudioError(undefined);
    setPlaying(false);
    setCurrentSeconds(0);
    setAudioDuration(undefined);
  }, [audioSrc]);

  const handlePlayPause = useCallback(() => {
    const el = audioRef.current;
    if (!el || !audioSrc) return;
    if (el.paused) {
      const promise = el.play();
      if (promise && typeof promise.catch === 'function') {
        promise.catch((err: unknown) => {
          setAudioError(err instanceof Error ? err.message : 'playback failed');
        });
      }
    } else {
      el.pause();
    }
  }, [audioSrc]);

  const handleSeek = useCallback(
    (value: number) => {
      const el = audioRef.current;
      const target = (value / 1000) * safeTotalSeconds;
      setCurrentSeconds(target);
      if (el && Number.isFinite(target)) {
        try {
          el.currentTime = target;
        } catch {
          // Pre-metadata seeks are ignored; the timeupdate handler will
          // realign once the audio loads.
        }
      }
    },
    [safeTotalSeconds],
  );

  const seekToSeconds = useCallback(
    (seconds: number) => {
      if (!Number.isFinite(seconds) || seconds < 0) return;
      const clamped = Math.min(safeTotalSeconds, seconds);
      setCurrentSeconds(clamped);
      const el = audioRef.current;
      if (el) {
        try {
          el.currentTime = clamped;
        } catch {
          // Same pre-metadata caveat as handleSeek.
        }
      }
    },
    [safeTotalSeconds],
  );

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
              disabled={!audioSrc}
              className="h-10 w-10 rounded-full flex items-center justify-center text-white text-[15px] hover:bg-white/10 transition-colors disabled:opacity-30 disabled:hover:bg-transparent"
              aria-label={playing ? 'Pause' : 'Play'}
              title={audioSrc ? (playing ? 'Pause' : 'Play') : 'Render the song to play it'}
            >
              {playing ? '❚❚' : '▶'}
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
                onChange={(e) => handleSeek(Number(e.target.value))}
                className="absolute inset-0 opacity-0 cursor-pointer z-10 disabled:cursor-not-allowed"
                aria-label="Playhead position"
                disabled={!audioSrc || safeTotalSeconds <= 0}
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
        peaks={peaksQuery.data}
        loading={peaksQuery.isPending && done}
        durationSec={safeTotalSeconds}
        positionSec={currentSeconds}
        segments={summary}
        bpm={bpm}
        onSeek={seekToSeconds}
        artifactExists={Boolean(audioSrc)}
      />

      <RenderStatusStrip
        render={render}
        loading={renderQuery.isPending}
        audioReady={audioReady}
        audioError={audioError}
        dirty={editorDirty}
        durationSec={audioDuration}
      />

      {audioSrc ? (
        <audio
          ref={audioRef}
          src={audioSrc}
          preload="metadata"
          onLoadedMetadata={(e) => {
            const el = e.currentTarget;
            setAudioReady(true);
            setAudioDuration(Number.isFinite(el.duration) ? el.duration : undefined);
          }}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => {
            setPlaying(false);
            setCurrentSeconds(safeTotalSeconds);
          }}
          onTimeUpdate={(e) => setCurrentSeconds(e.currentTarget.currentTime)}
          onError={() => {
            setAudioError('audio element failed to load');
            setAudioReady(false);
            setPlaying(false);
          }}
          // The native controls are hidden — the transport pill above is
          // authoritative. The element stays in the tree so the ref + the
          // declared event handlers stay wired.
          className="hidden"
        />
      ) : null}
    </footer>
  );
}

interface RenderStatusStripProps {
  readonly render: RenderInfo | undefined;
  readonly loading: boolean;
  readonly audioReady: boolean;
  readonly audioError: string | undefined;
  readonly dirty: boolean;
  readonly durationSec: number | undefined;
}

function RenderStatusStrip({ render, loading, audioReady, audioError, dirty, durationSec }: RenderStatusStripProps) {
  const { tone, label } = describeRenderStatus({ render, loading, audioReady, audioError, dirty });

  const dotColor =
    tone === 'ready'
      ? 'bg-emerald-400'
      : tone === 'error'
        ? 'bg-accent'
        : tone === 'missing'
          ? 'bg-yellow-400/80'
          : 'bg-white/40 animate-pulse';

  return (
    <div className="flex items-center justify-between gap-6 px-[60px] py-2 text-[11px] uppercase tracking-[0.16em] text-dim border-t border-line/40 bg-[#0b0c14]">
      <div className="flex items-center gap-3 min-w-0">
        <span className={`h-2 w-2 rounded-full shrink-0 ${dotColor}`} aria-hidden />
        <span className="truncate" title={render?.error}>{label}</span>
      </div>
      <div className="flex items-center gap-5 font-mono normal-case tracking-normal text-[11px] text-dim shrink-0">
        {render?.state === 'done' ? (
          <>
            <RenderStat label="dur" value={fmtSecondsLabel(durationSec)} />
            <a className="text-white/85 hover:text-white underline-offset-2 hover:underline" href={`${render.mp3Url}?download=1`}>
              Download MP3
            </a>
            <a className="text-white/85 hover:text-white underline-offset-2 hover:underline" href={`${render.wavUrl}?download=1`}>
              Download WAV
            </a>
          </>
        ) : (
          <span className="text-dim/70">{'— · — · —'}</span>
        )}
      </div>
    </div>
  );
}

function RenderStat({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="text-dim/70 uppercase tracking-[0.16em] text-[10px]">{label}</span>
      <span className="tabular-nums text-white/85">{value}</span>
    </span>
  );
}
