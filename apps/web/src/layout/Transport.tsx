import { useEffect } from 'react';

import { livePlayer } from '../audio/livePlayer';
import { useLiveTransport } from '../audio/useLiveTransport';
import { useSession } from '../state/session';

const TICKS_PER_BEAT = 960;

/**
 * The editor's transport, in the control bar (as in Logic or Pro Tools):
 * Stop / Play / Loop, the bars|beats|ticks counter with minutes:seconds,
 * and tempo and key. Plays the song live in the browser (the version on
 * screen, unsaved edits included).
 *
 * Keys: Space play/pause · Enter back to the start · L loop on/off.
 */
export function Transport() {
  const { viewSong, editorDirty } = useSession();
  const { liveKey, live, isThisSong, playing, loading, currentSeconds, fetchPayload, playPause, stop, toggleLoop } = useLiveTransport();
  const bpm = viewSong?.bpm ?? 120;
  const loaded = Boolean(liveKey) && isThisSong && live.status !== 'loading' && live.status !== 'idle';

  // Get the version on screen ready in the background, so Play starts at
  // once: right away for the saved song, a moment after editing stops.
  useEffect(() => {
    if (!liveKey || !viewSong) return;
    const t = setTimeout(() => livePlayer.prepare(liveKey, fetchPayload), editorDirty ? 1200 : 0);
    return () => clearTimeout(t);
  }, [liveKey, viewSong, editorDirty, fetchPayload]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.code !== 'Space' && e.code !== 'KeyL' && e.code !== 'Enter') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(t.tagName))) return;
      e.preventDefault();
      if (e.code === 'Space') playPause();
      else if (e.code === 'KeyL') {
        if (live.loopRange) toggleLoop();
      } else stop(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [playPause, toggleLoop, stop, live.loopRange]);

  const btn =
    'flex h-8 w-9 items-center justify-center rounded-[5px] border border-black/60 bg-gradient-to-b from-[#3b3d43] to-[#2b2c31] text-[#d9dade] shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] hover:from-[#45474e] disabled:opacity-35';

  return (
    <div className="flex items-center gap-3">
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => stop(false)}
          onDoubleClick={() => stop(true)}
          disabled={!loaded}
          className={btn}
          aria-label="Stop"
          title="Stop: back to where play started (double-click or Enter: to the beginning)"
        >
          <span className="block h-2.5 w-2.5 rounded-[1px] bg-current" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={playPause}
          disabled={!liveKey || loading}
          className={`${btn} ${playing ? 'text-emerald-300' : ''}`}
          aria-label={playing ? 'Pause' : 'Play'}
          title={playing ? 'Pause (Space)' : 'Play (Space)'}
        >
          {loading ? '…' : playing ? <PauseIcon /> : <PlayIcon />}
        </button>
        <button
          type="button"
          onClick={toggleLoop}
          disabled={!live.loopRange}
          aria-pressed={live.looping}
          className={`${btn} ${live.looping ? 'from-[#2d6f99] to-[#1f5277] text-white' : ''}`}
          aria-label={live.looping ? 'Turn loop off' : 'Loop the selected range'}
          title={live.loopRange ? (live.looping ? 'Loop on (L)' : 'Loop the selected range (L)') : 'Drag across the timeline to choose a range to loop'}
        >
          <LoopIcon />
        </button>
      </div>
      <Lcd seconds={currentSeconds} bpm={bpm} songKey={viewSong?.key} status={isThisSong ? live.status : 'idle'} />
    </div>
  );
}

/** The LCD: bars|beats|ticks and minutes:seconds, tempo and key. */
function Lcd({ seconds, bpm, songKey, status }: { seconds: number; bpm: number; songKey: string | undefined; status: string }) {
  const beatsIn = Math.max(0, (seconds * bpm) / 60);
  const bar = Math.floor(beatsIn / 4) + 1;
  const beat = Math.floor(beatsIn % 4) + 1;
  const ticks = Math.floor((beatsIn % 1) * TICKS_PER_BEAT);
  const m = Math.floor(seconds / 60);
  const sec = seconds - m * 60;
  return (
    <div
      className="flex h-11 items-stretch overflow-hidden rounded-[6px] border border-black/70 bg-[#0c1410] font-mono tabular-nums shadow-[inset_0_2px_6px_rgba(0,0,0,0.6)]"
      aria-label={`Bar ${bar}, beat ${beat}`}
    >
      <div className="flex min-w-[150px] flex-col justify-center px-3">
        <span className="text-[19px] leading-none text-[#7dffb0]">
          {String(bar).padStart(3, ' ')}<span className="text-[#7dffb0]/50"> | </span>{beat}<span className="text-[#7dffb0]/50"> | </span>{String(ticks).padStart(3, '0')}
        </span>
        <span className="mt-1 text-[10px] leading-none text-[#7dffb0]/60">
          {m}:{sec.toFixed(3).padStart(6, '0')} · {status === 'playing' ? 'PLAY' : status === 'loading' ? 'LOAD' : 'STOP'}
        </span>
      </div>
      <div className="flex flex-col justify-center border-l border-[#7dffb0]/15 px-3 text-right">
        <span className="text-[15px] leading-none text-[#7dffb0]">{bpm}</span>
        <span className="mt-1 text-[9px] leading-none text-[#7dffb0]/55">BPM</span>
      </div>
      <div className="flex flex-col justify-center border-l border-[#7dffb0]/15 px-3 text-right">
        <span className="text-[15px] leading-none text-[#7dffb0]">{songKey ?? '—'}</span>
        <span className="mt-1 text-[9px] leading-none text-[#7dffb0]/55">KEY</span>
      </div>
    </div>
  );
}

function PlayIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M2 1l9 5-9 5z" fill="currentColor" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M2 1h3v10H2zM7 1h3v10H7z" fill="currentColor" />
    </svg>
  );
}

function LoopIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17 2l4 4-4 4" />
      <path d="M3 11V9a3 3 0 0 1 3-3h15" />
      <path d="M7 22l-4-4 4-4" />
      <path d="M21 13v2a3 3 0 0 1-3 3H3" />
    </svg>
  );
}
