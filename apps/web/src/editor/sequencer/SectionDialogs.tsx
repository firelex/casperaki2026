import { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@teamsuzie/ui';

const CONTENT = 'w-[min(480px,calc(100vw-2rem))] max-w-none gap-0 rounded-[12px] border border-line bg-panel p-0 text-white sm:max-w-none';

/** Section types the generator writes, with their default length. */
export const SECTION_TYPES: readonly { type: string; label: string; bars: number }[] = [
  { type: 'intro', label: 'Intro', bars: 4 },
  { type: 'verse', label: 'Verse', bars: 8 },
  { type: 'preChorus', label: 'Pre-chorus', bars: 4 },
  { type: 'chorus', label: 'Chorus', bars: 8 },
  { type: 'bridge', label: 'Bridge', bars: 8 },
  { type: 'break', label: 'Break', bars: 2 },
  { type: 'outro', label: 'Outro', bars: 8 },
];

/** Add a section: pick its type and length; the generator writes it. */
export function AddSectionDialog({ where, onAdd, onClose }: { where: string; onAdd(type: string, bars: number): void; onClose(): void }) {
  const [type, setType] = useState('verse');
  const [bars, setBars] = useState(8);
  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent className={CONTENT}>
        <div className="border-b border-line/60 px-5 py-4 pr-12">
          <DialogTitle className="text-[17px] font-semibold text-white">Add a section</DialogTitle>
          <DialogDescription className="mt-1 text-[13px] text-white/55">
            {where}. Casperaki writes its chords and every track&rsquo;s part in the song&rsquo;s style.
          </DialogDescription>
        </div>
        <div className="flex flex-col gap-5 px-5 py-5">
          <fieldset>
            <legend className="mb-2 text-[13px] text-white/60">Type</legend>
            <div className="flex flex-wrap gap-2">
              {SECTION_TYPES.map((t) => (
                <button
                  key={t.type}
                  type="button"
                  aria-pressed={type === t.type}
                  onClick={() => {
                    setType(t.type);
                    setBars(t.bars);
                  }}
                  className={`h-9 rounded-full border px-4 text-[14px] ${type === t.type ? 'border-white bg-white text-black' : 'border-line text-white/80 hover:border-white/50'}`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </fieldset>
          <label className="flex items-center gap-3 text-[14px]">
            <span className="text-[13px] text-white/60">Length</span>
            <button type="button" onClick={() => setBars((b) => Math.max(1, b - 1))} className="h-8 w-8 rounded-[6px] border border-line hover:border-white/50" aria-label="One bar less">
              −
            </button>
            <span className="w-16 text-center font-mono">{bars} bar{bars === 1 ? '' : 's'}</span>
            <button type="button" onClick={() => setBars((b) => Math.min(64, b + 1))} className="h-8 w-8 rounded-[6px] border border-line hover:border-white/50" aria-label="One bar more">
              +
            </button>
          </label>
        </div>
        <div className="flex justify-end gap-2 border-t border-line/60 px-5 py-4">
          <button type="button" onClick={onClose} className="h-10 rounded-full px-4 text-[14px] text-white/70 hover:text-white">
            Cancel
          </button>
          <button type="button" onClick={() => onAdd(type, bars)} className="h-10 rounded-full bg-accent px-5 text-[14px] font-semibold text-white hover:bg-[#e00000]">
            Add section
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Rename a section (names must stay unique). */
export function RenameSectionDialog({ name, taken, onRename, onClose }: { name: string; taken: readonly string[]; onRename(newName: string): void; onClose(): void }) {
  const [value, setValue] = useState(name);
  const trimmed = value.trim();
  const clash = trimmed !== name && taken.includes(trimmed);
  const ok = trimmed.length > 0 && !clash && trimmed !== name;
  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent className={CONTENT}>
        <div className="border-b border-line/60 px-5 py-4 pr-12">
          <DialogTitle className="text-[17px] font-semibold text-white">Rename {name}</DialogTitle>
          <DialogDescription className="mt-1 text-[13px] text-white/55">Section names must be unique.</DialogDescription>
        </div>
        <form
          className="flex flex-col gap-2 px-5 py-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (ok) onRename(trimmed);
          }}
        >
          <input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            maxLength={40}
            aria-label="Section name"
            className="h-10 rounded-[8px] border border-line bg-bg px-3 text-[14px] text-white outline-none focus:border-white/50"
          />
          {clash ? <span className="text-[12px] text-err">There is already a section called {trimmed}.</span> : null}
          <div className="mt-3 flex justify-end gap-2">
            <button type="button" onClick={onClose} className="h-10 rounded-full px-4 text-[14px] text-white/70 hover:text-white">
              Cancel
            </button>
            <button type="submit" disabled={!ok} className="h-10 rounded-full bg-accent px-5 text-[14px] font-semibold text-white hover:bg-[#e00000] disabled:opacity-40">
              Rename
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
