import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { rendersApi, rendersQueryKeys, type RenderMetadata } from '../api/renders';
import {
  describeRenderStatus,
  fmtBytesLabel,
  fmtClock,
  fmtDbLabel,
  fmtFormatLabel,
  fmtSecondsLabel,
} from './playbarRenderStatus';
import { WaveformLane } from './WaveformLane';
import { useSession } from '../state/session';
import { summarizeStructure } from '../types/song';

const WAVEFORM_BINS = 512;

/**
 * Editor Playbar — mirrors rory-fe `components/editor/Playbar.vue`.
 *
 * The transport binds to the latest local render artifact when it
 * exists (see docs/54c-ui-render-artifact.md). This is a dev/local
 * bridge: a single configurable WAV exposed by the brain. The browser
 * does not trigger native rendering and there is no per-song mapping;
 * if the artifact is absent the transport collapses to a chrome-only
 * disabled state and a "no local render" status hint.
 */
export function Playbar() {
  const { activeSong, viewSong, renderStale } = useSession();
  const queryClient = useQueryClient();

  const renderQuery = useQuery({
    queryKey: rendersQueryKeys.latest(),
    queryFn: ({ signal }) => rendersApi.latest(signal),
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
  const render = renderQuery.data;
  const peaksQuery = useQuery({
    queryKey: rendersQueryKeys.peaks(WAVEFORM_BINS),
    queryFn: ({ signal }) => rendersApi.peaks(WAVEFORM_BINS, signal),
    enabled: Boolean(render?.exists),
    staleTime: 60_000,
  });
  const refreshRender = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: rendersQueryKeys.latest() });
    void queryClient.invalidateQueries({ queryKey: rendersQueryKeys.peaks(WAVEFORM_BINS) });
  }, [queryClient]);

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
  // `activeSong` is referenced only to keep the artifact tied to the
  // brain-returned identity — once the working copy diverges, the
  // render is marked stale below.
  void activeSong;
  const songSeconds = (totalBars * 4 * 60) / bpm;

  const renderSeconds = render?.exists ? render.durationSec : undefined;
  const totalSeconds = audioDuration ?? renderSeconds ?? songSeconds;
  const safeTotalSeconds = totalSeconds > 0 ? totalSeconds : 0;
  const position = safeTotalSeconds > 0 ? Math.min(1, currentSeconds / safeTotalSeconds) : 0;
  const audioSrc = render?.exists ? rendersApi.latestWavUrl() : undefined;

  // Hard-reset transport state when the artifact appears / disappears or
  // its bytes change (updatedAt drift). Without this the stale audio
  // element would silently keep its old src.
  useEffect(() => {
    setAudioReady(false);
    setAudioError(undefined);
    setPlaying(false);
    setCurrentSeconds(0);
    setAudioDuration(undefined);
  }, [audioSrc, render?.updatedAt]);

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
          <button
            type="button"
            onClick={refreshRender}
            className="h-10 w-10 rounded-full flex items-center justify-center text-[18px] text-white/80 hover:text-white hover:bg-white/10 transition-colors disabled:opacity-30"
            title="Refresh local render metadata"
            aria-label="Refresh local render metadata"
          >
            ⟳
          </button>

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
              title={audioSrc ? (playing ? 'Pause' : 'Play') : 'No local render available'}
            >
              {playing ? '⏸' : '▶'}
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
        loading={peaksQuery.isPending && Boolean(render?.exists)}
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
        stale={renderStale}
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
  readonly render: RenderMetadata | undefined;
  readonly loading: boolean;
  readonly audioReady: boolean;
  readonly audioError: string | undefined;
  readonly stale?: boolean;
}

function RenderStatusStrip({ render, loading, audioReady, audioError, stale }: RenderStatusStripProps) {
  const { tone, label } = describeRenderStatus({ render, loading, audioReady, audioError });

  const effectiveTone = stale && render?.exists ? 'missing' : tone;
  const effectiveLabel = stale && render?.exists ? `${label} · stale (edited)` : label;

  const dotColor =
    effectiveTone === 'ready'
      ? 'bg-emerald-400'
      : effectiveTone === 'error'
        ? 'bg-accent'
        : effectiveTone === 'missing'
          ? 'bg-yellow-400/80'
          : 'bg-white/40';

  return (
    <div className="flex items-center justify-between gap-6 px-[60px] py-2 text-[11px] uppercase tracking-[0.16em] text-dim border-t border-line/40 bg-[#0b0c14]">
      <div className="flex items-center gap-3">
        <span className={`h-2 w-2 rounded-full ${dotColor}`} aria-hidden />
        <span>{effectiveLabel}</span>
      </div>
      <div className="flex items-center gap-5 font-mono normal-case tracking-normal text-[11px] text-dim">
        {render?.exists ? (
          <>
            <RenderStat label="dur" value={fmtSecondsLabel(render.durationSec)} />
            <RenderStat
              label="fmt"
              value={fmtFormatLabel(render.sampleRate, render.bitDepth, render.channels)}
            />
            <RenderStat label="rms" value={fmtDbLabel(render.rmsDb)} />
            <RenderStat label="peak" value={fmtDbLabel(render.peakDb)} />
            <RenderStat label="size" value={fmtBytesLabel(render.sizeBytes)} />
            <RenderStat label="updated" value={fmtUpdated(render.updatedAt)} />
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

function fmtUpdated(updatedAt: string | undefined): string {
  if (!updatedAt) return '—';
  const d = new Date(updatedAt);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toISOString().slice(11, 19) + 'Z';
}
