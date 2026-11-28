import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@teamsuzie/ui';

import { singersApi, singersQueryKey } from '../../api/singers';
import { rapSectionLabel } from './RapDialog';

const CONTENT = 'w-[min(480px,calc(100vw-2rem))] max-w-none gap-0 rounded-[12px] border border-line bg-panel p-0 text-white sm:max-w-none';

/** Sing: choose the singer (each with its voice reference to listen to; `preselected` is the song's last singer) and
 *  the sections to sing (every section with a melody at first; docs/superpowers/specs/2026-11-28-rap-like-singing-design.md). */
export function SingerDialog({
  preselected,
  sections,
  onStart,
  onClose,
}: {
  preselected: string | undefined;
  /** The sections with a melody, in song order. */
  sections: readonly string[];
  onStart(singerId: string, sections: string[]): void;
  onClose(): void;
}) {
  const singers = useQuery({ queryKey: singersQueryKey, queryFn: ({ signal }) => singersApi.list(signal), staleTime: 60_000 });
  const [chosen, setChosen] = useState<string | undefined>(preselected);
  const [ticked, setTicked] = useState<string[]>(() => [...sections]);
  const list = singers.data?.singers ?? [];
  const selected = chosen !== undefined && list.some((s) => s.id === chosen) ? chosen : list[0]?.id;
  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent className={CONTENT}>
        <div className="border-b border-line/60 px-5 py-4 pr-12">
          <DialogTitle className="text-[17px] font-semibold text-white">Sing</DialogTitle>
          <DialogDescription className="mt-1 text-[13px] text-white/55">Who sings the vocals?</DialogDescription>
        </div>
        <div className="flex flex-col gap-3 px-5 py-5 text-[14px]">
          {singers.isPending ? <p className="text-white/55">Loading the singers…</p> : null}
          {singers.isError ? (
            <p className="text-err" role="alert">
              The singers could not be loaded: {singers.error instanceof Error ? singers.error.message : String(singers.error)}
            </p>
          ) : null}
          {singers.isSuccess && list.length === 0 ? <p className="text-white/70">You have no singers: add one on the Singers page.</p> : null}
          {list.map((s) => (
            <label key={s.id} className={`flex flex-col gap-2 rounded-[10px] border p-3 ${selected === s.id ? 'border-white/50 bg-white/5' : 'border-line'}`}>
              <span className="flex items-center gap-3">
                <input type="radio" name="singer" checked={selected === s.id} onChange={() => setChosen(s.id)} />
                <span className="font-semibold">{s.name}</span>
              </span>
              <span className="text-[13px] text-white/60">{s.description}</span>
              <audio controls preload="none" src={s.previewUrl} className="h-8 w-full" aria-label={`${s.name}: voice reference`} />
            </label>
          ))}
          <fieldset className="mt-2 flex flex-col gap-2">
            <span className="text-[13px] text-white/60">Sections to sing (the others keep what they have)</span>
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              {sections.map((n) => (
                <label key={n} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={ticked.includes(n)}
                    onChange={(e) => setTicked(sections.filter((x) => (x === n ? e.target.checked : ticked.includes(x))))}
                  />
                  <span>{rapSectionLabel(n)}</span>
                </label>
              ))}
            </div>
          </fieldset>
        </div>
        <div className="flex justify-end gap-2 border-t border-line/60 px-5 py-4">
          <button type="button" onClick={onClose} className="h-10 rounded-full px-4 text-[14px] text-white/70 hover:text-white">
            Cancel
          </button>
          <button
            type="button"
            disabled={!selected || ticked.length === 0}
            onClick={() => selected && onStart(selected, ticked)}
            className="h-10 rounded-full bg-accent px-5 text-[14px] font-semibold text-white hover:bg-[#e00000] disabled:opacity-40"
          >
            Sing
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
