import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { vocalsApi, type SectionState } from '../api/vocals';
import { singAgain, singRun, withVocals, withVoice } from '../audio/singVocals';
import { useVocalsStatus } from '../audio/useVocalsStatus';
import { useVocalsProgress, vocalsProgress } from '../audio/vocalsProgress';
import { useSession } from '../state/session';

const STATE_LABEL: Record<Exclude<SectionState, 'none'>, string> = {
  sung: 'Sung',
  unsung: 'Not sung yet',
};

/**
 * Sung vocals, on the Vocal track's header (docs/superpowers/specs/2026-11-24-sung-vocals-design.md): the switch
 * (off by default: nothing is sung), the voice, each section's take and "Sing again". With it on, Play sings the
 * grey sections while the song plays; the progress, "Stop singing" and any error (with "Don't sing on Play") show here.
 */
export function VocalsControl() {
  const { viewSong, applyEdit } = useSession();
  const progress = useVocalsProgress();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const vocals = viewSong?.vocals;
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

  const voices = useQuery({ queryKey: ['vocals', 'voices'], queryFn: ({ signal }) => vocalsApi.voices(signal), staleTime: Infinity, enabled: open });
  const status = useVocalsStatus(viewSong);
  if (!viewSong) return null;

  const replace = (song: typeof viewSong) => applyEdit({ kind: 'replaceSong', song });
  const sections = (status.data?.sections ?? []).filter((s) => s.state !== 'none');
  const small = 'h-6 rounded-full border border-white/25 px-2.5 text-[11px] text-white/85 hover:border-white/60 disabled:opacity-40';
  const rect = box.current?.getBoundingClientRect();
  const singing = Boolean(progress.text);

  return (
    <div ref={box} className="relative shrink-0" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label="Sung vocals"
        title={singing ? progress.text : on ? 'Sung vocals: Play sings the grey sections' : 'Sung vocals (Play does not sing; sung sections play)'}
        className={`flex h-6 items-center gap-1 rounded-[5px] border border-black/60 bg-[#33353b] px-1.5 text-[11px] hover:bg-[#3d3f46] ${on ? 'text-emerald-300' : 'text-white/70'}`}
      >
        <span aria-hidden="true" className={singing ? 'animate-pulse' : ''}>{singing ? '◉' : on ? '●' : '○'}</span> Sing
      </button>
      {open && rect
        ? createPortal(
        <div
          ref={panel}
          style={{ position: 'fixed', left: rect.left, top: rect.bottom + 4 }}
          className="z-[1000] w-[320px] rounded-[8px] border border-black/70 bg-[#232428] p-3 text-[12px] text-white shadow-xl"
          role="dialog"
          aria-label="Sung vocals"
        >
          <label className="flex items-center justify-between gap-2">
            <span>Sing grey sections while playing</span>
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
              aria-label="Sing grey sections while playing"
            />
          </label>
          <p className="mt-1 text-[11px] text-white/50">Sung sections always play. On: when you press Play, the grey sections are sung while the song plays, starting where you are; each one joins the song as soon as it is ready. Off: nothing new is sung.</p>
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
          {vocals ? (
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
                      {s.segment} <span className={s.state === 'sung' ? 'text-emerald-300/80' : 'text-[#f5b942]'}>· {STATE_LABEL[s.state as Exclude<SectionState, 'none'>]}</span>
                    </span>
                    <button type="button" className={small} onClick={() => replace(singAgain(viewSong, s.segment))} title="A fresh take of this section (sung on the next Play)">
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
                Don't sing on Play
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
