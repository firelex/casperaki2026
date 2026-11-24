import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { vocalsApi, type SectionState } from '../api/vocals';
import { singAgain, singRun, trackSetting, withVocals, withVoice } from '../audio/singVocals';
import { useVocalsStatus } from '../audio/useVocalsStatus';
import { useVocalsProgress, vocalsProgress } from '../audio/vocalsProgress';
import { useSession } from '../state/session';

const STATE_LABEL: Record<Exclude<SectionState, 'none'>, string> = {
  sung: 'Sung',
  unsung: 'Not sung yet',
};

/**
 * The sing switch on a vocal track's header (a microphone; docs/superpowers/specs/2026-11-24-sung-vocals-design.md):
 * on, the track is heard (sung sections light up; grey ones are sung while the song plays); off, it is silent and
 * grey. Its panel: the switch, the voice, each section's take with "Sing again", the progress and "Stop singing".
 */
export function VocalsControl({ track }: { track: string }) {
  const { viewSong, activeSong, applyEdit } = useSession();
  // A new song's words are still being written: singing now would sing words that are about to change.
  const waitingForLyrics = activeSong?.project.lyrics?.state === 'writing';
  const progress = useVocalsProgress();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const vocals = viewSong ? trackSetting(viewSong, track) : undefined;
  const on = vocals?.enabled === true;

  // An error or progress opens the panel so it is seen.
  useEffect(() => {
    if (progress.error) setOpen(true);
  }, [progress.error]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      const t = e.target as Node;
      if (box.current && !box.current.contains(t) && !(panel.current && panel.current.contains(t))) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  const voices = useQuery({ queryKey: ['vocals', 'voices'], queryFn: ({ signal }) => vocalsApi.voices(signal), staleTime: Infinity });
  const status = useVocalsStatus(viewSong);
  if (!viewSong) return null;

  const replace = (song: typeof viewSong) => applyEdit({ kind: 'replaceSong', song });
  const sections = (status.data?.tracks[track] ?? []).filter((s) => s.state !== 'none');
  const small = 'h-6 rounded-full border border-white/25 px-2.5 text-[11px] text-white/85 hover:border-white/60 disabled:opacity-40';
  const rect = box.current?.getBoundingClientRect();
  const singing = Boolean(progress.text);

  return (
    <div ref={box} className="relative shrink-0" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
      <button
        type="button"
        onClick={() => {
          // Click: the track on or off. Its first time on, it takes the lead's voice (or the first voice);
          // right-click chooses another.
          if (waitingForLyrics && !on) return;
          const voice = vocals?.voice ?? viewSong.vocals?.voice ?? voices.data?.[0]?.id;
          if (!voice) return setOpen(true);
          vocalsProgress.set({});
          replace(withVocals(viewSong, track, !on, voice));
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation(); // not the track's own menu
          setOpen((o) => !o);
        }}
        aria-expanded={open}
        aria-label={`Sing ${track}`}
        title={singing ? progress.text : waitingForLyrics && !on ? `${track} can be sung once the lyrics are written` : on ? `${track} is sung — click to switch off, right-click for the voice and takes` : `${track} is not sung — click to sing it, right-click for the voice`}
        className={`flex h-5 w-5 items-center justify-center rounded-[4px] hover:bg-white/10 ${on ? 'text-emerald-300' : waitingForLyrics ? 'cursor-not-allowed text-white/20' : 'text-white/35 hover:text-white/70'} ${singing ? 'animate-pulse' : ''}`}
      >
        <MicIcon />
      </button>
      {open && rect
        ? createPortal(
        <div
          ref={panel}
          style={{ position: 'fixed', left: rect.left, top: rect.bottom + 4 }}
          className="z-[1000] w-[320px] rounded-[8px] border border-black/70 bg-[#232428] p-3 text-[12px] text-white shadow-xl"
          role="dialog"
          aria-label={`Sing ${track}`}
        >
          <p className="mb-1.5 font-semibold">{track}</p>
          <label className="flex items-center justify-between gap-2">
            <span>Sing this track</span>
            <input
              type="checkbox"
              checked={on}
              onChange={(e) => {
                const voice = vocals?.voice ?? voices.data?.[0]?.id;
                if (e.target.checked && !voice) return;
                vocalsProgress.set({});
                replace(withVocals(viewSong, track, e.target.checked, voice));
              }}
              disabled={!on && !vocals?.voice && !voices.data?.length}
              aria-label="Sing this track"
            />
          </label>
          <p className="mt-1 text-[11px] text-white/50">On: the track is heard. Sections already sung light up and play; the grey ones are sung while the song plays, starting where you are, and join it as soon as they are ready. Off: the track is silent and grey (its takes are kept).</p>
          {voices.isError ? <p className="mt-2 text-err">The voices could not be loaded: {voices.error.message}</p> : null}
          {on || voices.data ? (
            <label className="mt-2 flex items-center justify-between gap-2">
              <span className="text-white/70">Voice</span>
              <select
                value={vocals?.voice ?? ''}
                onChange={(e) => replace(vocals ? withVoice(viewSong, track, e.target.value) : withVocals(viewSong, track, false, e.target.value))}
                className="h-7 max-w-[200px] rounded-[6px] border border-black/60 bg-[#151619] px-1 text-[12px] text-white"
                aria-label="Voice"
              >
                {!vocals?.voice ? <option value="">Choose a voice</option> : null}
                {(voices.data ?? (vocals?.voice ? [{ id: vocals.voice, label: vocals.voice, median: 0 }] : [])).map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {vocals ? (
            <div className="mt-3 border-t border-white/10 pt-2">
              <div className="mb-1 flex items-center justify-between">
                <span className="text-white/70">Sections</span>
                <button type="button" className={small} disabled={sections.length === 0} onClick={() => replace(singAgain(viewSong, track, sections.map((s) => s.segment)))}>
                  Sing all again
                </button>
              </div>
              {status.isLoading ? <p className="text-white/50">Checking…</p> : null}
              {status.isError ? <p className="text-err">{status.error.message}</p> : null}
              <ul className="max-h-[220px] overflow-y-auto">
                {sections.map((s) => (
                  <li key={s.segment} className="flex items-center justify-between gap-2 py-0.5">
                    <span className="min-w-0 truncate">
                      {s.segment} <span className={s.state === 'sung' ? 'text-emerald-300/80' : 'text-[#f5b942]'}>· {STATE_LABEL[s.state as Exclude<SectionState, 'none'>]}</span>
                    </span>
                    <button type="button" className={small} onClick={() => replace(singAgain(viewSong, track, s.segment))} title="A fresh take of this section (sung on the next Play)">
                      Sing again
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {progress.text ? <p className="mt-2 text-white/70">{progress.text}</p> : null}
          {progress.error ? (
            <div className="mt-2 rounded-[6px] border border-err/60 bg-err/10 p-2" role="alert">
              <p className="text-red-100">The vocals could not be sung: {progress.error}</p>
              <button
                type="button"
                className={`${small} mt-1.5`}
                onClick={() => {
                  vocalsProgress.set({});
                  replace(withVocals(viewSong, track, false));
                }}
              >
                Switch this track off
              </button>
            </div>
          ) : null}
          {singing ? (
            <button type="button" className={`${small} mt-1.5`} onClick={() => { singRun.cancel(); vocalsProgress.set({}); }}>
              Stop singing
            </button>
          ) : null}
        </div>,
          document.body,
        )
      : null}
    </div>
  );
}

function MicIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <rect x="5.5" y="1.5" width="5" height="8" rx="2.5" />
      <path d="M3 7.5a5 5 0 0 0 10 0M8 12.5v2" strokeLinecap="round" />
    </svg>
  );
}
