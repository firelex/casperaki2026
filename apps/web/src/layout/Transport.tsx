import { useEffect, useMemo } from 'react';

import { livePlayer } from '../audio/livePlayer';
import { useLiveTransport } from '../audio/useLiveTransport';
import { buildSequencerModel } from '../editor/sequencerModel';
import { VocalsControl } from '../editor/VocalsControl';
import { useSession } from '../state/session';

const TICKS_PER_BEAT = 960;

/**
 * The editor's transport, in the control bar (as in Logic or Pro Tools):
 * to the beginning, previous section, Stop / Play, next section, to the end,
 * Loop, the bars|beats|ticks counter with minutes:seconds,
 * and tempo and key. Plays the song live in the browser (the version on
 * screen, unsaved edits included).
 *
 * Keys: Space play / stop (back to where play started) · Enter back to the
 * beginning · L loop on/off. The Play/Pause button pauses.
 */
export function Transport() {
  const { viewSong, editorDirty } = useSession();
  const { liveKey, live, isThisSong, playing, loading, currentSeconds, fetchPayload, playPause, seek, stop, toggleLoop } = useLiveTransport();
  const bpm = viewSong?.bpm ?? 120;
  const loaded = Boolean(liveKey) && isThisSong && live.status !== 'loading' && live.status !== 'idle';
  // Where each section starts (seconds), for the previous / next buttons.
  const sectionStarts = useMemo(() => {
    if (!viewSong) return [];
    const secondsPerBar = (4 * 60) / viewSong.bpm;
    return buildSequencerModel(viewSong).sections.map((x) => x.startBar * secondsPerBar);
  }, [viewSong]);
  // Back: to the start of this section, or the one before when just past a start (as in a DAW).
  const prevStart = [...sectionStarts].reverse().find((t) => t < currentSeconds - 0.5) ?? 0;
  const nextStart = sectionStarts.find((t) => t > currentSeconds + 0.05);

  // Get the version on screen ready in the background, so Play starts at
  // once: right away for the saved song, a moment after editing stops.
  useEffect(() => {
    if (!liveKey || !viewSong) return;
    // With sung vocals on, Play sings what is missing first; preparing would ask for takes not sung yet.
    if (viewSong.vocals?.enabled) return;
    const t = setTimeout(() => livePlayer.prepare(liveKey, fetchPayload), editorDirty ? 1200 : 0);
    return () => clearTimeout(t);
  }, [liveKey, viewSong, editorDirty, fetchPayload]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.code !== 'Space' && e.code !== 'KeyL' && e.code !== 'Enter') return;
      const t = e.target as HTMLElement | null;
      // Typing in a field keeps its keys. Otherwise Space always plays/pauses, even
      // with a button focused (preventDefault stops it from also clicking that button);
      // Enter on a focused button still presses the button.
      if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return;
      if (e.code === 'Enter' && t?.tagName === 'BUTTON') return;
      // A window with its own player (the pattern editor) takes Space while open.
      if (e.code === 'Space' && document.querySelector('[data-owns-space]')) return;
      e.preventDefault();
      // Space: play, or stop back to where play started (as Stop; the Play/Pause button pauses).
      if (e.code === 'Space') {
        if (playing) stop(false);
        else playPause();
      }
      else if (e.code === 'KeyL') {
        if (live.loopRange) toggleLoop();
      } else stop(true);
    };
    // Capture phase: runs before any element's own key handling can stop it.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [playPause, playing, toggleLoop, stop, live.loopRange]);

  const btn =
    'flex h-8 w-9 items-center justify-center rounded-[5px] border border-black/60 bg-gradient-to-b from-[#3b3d43] to-[#2b2c31] text-[#d9dade] shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] hover:from-[#45474e] disabled:opacity-35';

  // Two cells of the control bar's three-column grid: the buttons at the left
  // edge, the LCD in the centre column (the Pro controls take the right edge).
  return (
    <>
      <div className="flex items-center gap-1 justify-self-start">
        <button type="button" onClick={() => seek(0)} disabled={!loaded} className={btn} aria-label="To the beginning" title="To the beginning">
          <SkipIcon dir="back" end />
        </button>
        <button type="button" onClick={() => seek(prevStart)} disabled={!loaded} className={btn} aria-label="Previous section" title="Back to the start of this section (again: the section before)">
          <SkipIcon dir="back" />
        </button>
        <button
          type="button"
          onClick={() => stop(false)}
          onDoubleClick={() => stop(true)}
          disabled={!loaded}
          className={btn}
          aria-label="Stop"
          title="Stop: back to where play started (Space; double-click or Enter: to the beginning)"
        >
          <span className="block h-2.5 w-2.5 rounded-[1px] bg-current" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={playPause}
          disabled={!liveKey || loading}
          className={`${btn} ${playing ? 'text-emerald-300' : ''}`}
          aria-label={playing ? 'Pause' : 'Play'}
          title={playing ? 'Pause (stays here)' : 'Play (Space)'}
        >
          {loading ? '…' : playing ? <PauseIcon /> : <PlayIcon />}
        </button>
        <button
          type="button"
          onClick={() => nextStart !== undefined && seek(nextStart)}
          disabled={!loaded || nextStart === undefined}
          className={btn}
          aria-label="Next section"
          title="To the next section"
        >
          <SkipIcon dir="forward" />
        </button>
        <button type="button" onClick={() => seek(live.durationSec)} disabled={!loaded} className={btn} aria-label="To the end" title="To the end">
          <SkipIcon dir="forward" end />
        </button>
        <span className="w-1" aria-hidden="true" />
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
        <span className="w-1" aria-hidden="true" />
        <VocalsControl />
      </div>
      <Lcd seconds={currentSeconds} bpm={bpm} songKey={viewSong?.key} status={isThisSong ? live.status : 'idle'} />
    </>
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

/** Skip icons: two triangles (a section back / forward); with `end`, one triangle and a bar (to the beginning / end). */
function SkipIcon({ dir, end = false }: { dir: 'back' | 'forward'; end?: boolean }) {
  return (
    <svg width="14" height="12" viewBox="0 0 14 12" aria-hidden="true" style={dir === 'back' ? { transform: 'scaleX(-1)' } : undefined}>
      {end ? (
        <>
          <path d="M2 1 L10 6 L2 11 Z" fill="currentColor" />
          <rect x="10.5" y="1" width="2" height="10" fill="currentColor" />
        </>
      ) : (
        <>
          <path d="M0.5 1 L7 6 L0.5 11 Z" fill="currentColor" />
          <path d="M7 1 L13.5 6 L7 11 Z" fill="currentColor" />
        </>
      )}
    </svg>
  );
}
