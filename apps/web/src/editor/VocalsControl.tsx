import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { vocalsApi, type SectionState } from '../api/vocals';
import { singAgain, withVocals, withVoice } from '../audio/singVocals';
import { fnv1a } from '../audio/useLiveTransport';
import { useVocalsProgress, vocalsProgress } from '../audio/vocalsProgress';
import { useSession } from '../state/session';

const STATE_LABEL: Record<Exclude<SectionState, 'none'>, string> = {
  current: 'Sung',
  missing: 'Sung on the next play',
  stale: 'Changed: sung again on the next play',
  unused: 'No vocal notes now: its take is dropped on the next play',
};

/**
 * Sung vocals in the control bar (docs/superpowers/specs/2026-11-24-sung-vocals-design.md): the Vocals switch
 * (off by default: nothing is sung), the voice, each section's take and "Sing again". Play sings what is missing
 * first; its progress and any error show here, with "Play without vocals" (switches Vocals off) after an error.
 */
export function VocalsControl() {
  const { viewSong, applyEdit } = useSession();
  const progress = useVocalsProgress();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const vocals = viewSong?.vocals;
  const on = vocals?.enabled === true;

  // An error or progress opens the panel so it is seen.
  useEffect(() => {
    if (progress.error) setOpen(true);
  }, [progress.error]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  const voices = useQuery({ queryKey: ['vocals', 'voices'], queryFn: ({ signal }) => vocalsApi.voices(signal), staleTime: Infinity, enabled: open });
  const songKey = viewSong ? fnv1a(JSON.stringify(viewSong)) : '';
  const status = useQuery({
    queryKey: ['vocals', 'status', songKey],
    queryFn: ({ signal }) => vocalsApi.status(viewSong!, signal),
    enabled: open && on && Boolean(viewSong),
    staleTime: 10_000,
  });
  if (!viewSong) return null;

  const replace = (song: typeof viewSong) => applyEdit({ kind: 'replaceSong', song });
  const sections = (status.data?.sections ?? []).filter((s) => s.state !== 'none');
  const btn =
    'flex h-8 items-center gap-1.5 rounded-[5px] border border-black/60 bg-gradient-to-b from-[#3b3d43] to-[#2b2c31] px-2.5 text-[12px] text-[#d9dade] shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] hover:from-[#45474e]';
  const small = 'h-6 rounded-full border border-white/25 px-2.5 text-[11px] text-white/85 hover:border-white/60 disabled:opacity-40';

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={on ? 'Vocals on' : 'Vocals off'}
        title={on ? 'Sung vocals are on' : 'Sung vocals are off (switch on to hear the lead vocal sung)'}
        className={`${btn} ${on ? 'text-emerald-300' : ''}`}
      >
        <span aria-hidden="true">{on ? '●' : '○'}</span> Vocals
      </button>
      {progress.text ? <span className="absolute left-full top-1/2 ml-2 -translate-y-1/2 whitespace-nowrap text-[11px] text-white/70">{progress.text}</span> : null}
      {open ? (
        <div className="absolute left-0 top-full z-50 mt-1 w-[320px] rounded-[8px] border border-black/70 bg-[#232428] p-3 text-[12px] text-white shadow-xl" role="dialog" aria-label="Sung vocals">
          <label className="flex items-center justify-between gap-2">
            <span>Sing the lead vocal</span>
            <input
              type="checkbox"
              checked={on}
              onChange={(e) => {
                const voice = vocals?.voice ?? voices.data?.[0]?.id;
                if (e.target.checked && !voice) return;
                vocalsProgress.set({});
                replace(withVocals(viewSong, e.target.checked, voice));
              }}
              disabled={!on && !vocals?.voice && !voices.data?.length}
              aria-label="Sing the lead vocal"
            />
          </label>
          <p className="mt-1 text-[11px] text-white/50">Off: nothing is sung and Play starts at once. On: Play first sings the sections that need it (a few seconds each).</p>
          {voices.isError ? <p className="mt-2 text-err">The voices could not be loaded: {voices.error.message}</p> : null}
          {on || voices.data ? (
            <label className="mt-2 flex items-center justify-between gap-2">
              <span className="text-white/70">Voice</span>
              <select
                value={vocals?.voice ?? ''}
                onChange={(e) => replace(vocals ? withVoice(viewSong, e.target.value) : withVocals(viewSong, false, e.target.value))}
                className="h-7 max-w-[200px] rounded-[6px] border border-black/60 bg-[#151619] px-1 text-[12px] text-white"
                aria-label="Voice"
              >
                {!vocals?.voice ? <option value="">Choose a voice</option> : null}
                {(voices.data ?? (vocals?.voice ? [{ id: vocals.voice, label: vocals.voice, octave: 0 }] : [])).map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {on ? (
            <div className="mt-3 border-t border-white/10 pt-2">
              <div className="mb-1 flex items-center justify-between">
                <span className="text-white/70">Sections</span>
                <button type="button" className={small} disabled={sections.length === 0} onClick={() => replace(singAgain(viewSong, sections.map((s) => s.segment)))}>
                  Sing all again
                </button>
              </div>
              {status.isLoading ? <p className="text-white/50">Checking…</p> : null}
              {status.isError ? <p className="text-err">{status.error.message}</p> : null}
              <ul className="max-h-[220px] overflow-y-auto">
                {sections.map((s) => (
                  <li key={s.segment} className="flex items-center justify-between gap-2 py-0.5">
                    <span className="min-w-0 truncate">
                      {s.segment} <span className={s.state === 'current' ? 'text-emerald-300/80' : 'text-[#f5b942]'}>· {STATE_LABEL[s.state as Exclude<SectionState, 'none'>]}</span>
                    </span>
                    <button type="button" className={small} onClick={() => replace(singAgain(viewSong, s.segment))} title="A fresh take of this section on the next play">
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
                  replace(withVocals(viewSong, false));
                }}
              >
                Play without vocals
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
