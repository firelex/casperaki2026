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

type Placement = 'beginningOfSegment' | 'midSegment' | 'endOfSegment';

/** The transitions the engine plays, by where they sit in a section. */
const TRANSITIONS: readonly { type: string; label: string; placements: readonly Placement[] }[] = [
  { type: 'cymbalsCrashHit', label: 'Crash', placements: ['beginningOfSegment'] },
  { type: 'fxHighImpact', label: 'High impact', placements: ['beginningOfSegment'] },
  { type: 'fxLowImpact', label: 'Low impact', placements: ['beginningOfSegment'] },
  { type: 'fxDownlifter', label: 'Downlifter', placements: ['beginningOfSegment'] },
  { type: 'fxTransition', label: 'Transition sweep', placements: ['beginningOfSegment'] },
  { type: 'fxReverse', label: 'Reverse', placements: ['beginningOfSegment', 'endOfSegment'] },
  { type: 'fxTonalReverse', label: 'Tonal reverse', placements: ['beginningOfSegment', 'endOfSegment'] },
  { type: 'fxNoiseRise', label: 'Noise rise', placements: ['beginningOfSegment', 'endOfSegment'] },
  { type: 'fxUplifter', label: 'Uplifter', placements: ['endOfSegment'] },
  { type: 'percussionBreaksFills', label: 'Percussion fill', placements: ['midSegment'] },
  { type: 'percussionBreaksBuildups', label: 'Percussion build-up', placements: ['midSegment'] },
  { type: 'edmSnareDrumRoll', label: 'Snare roll', placements: ['endOfSegment'] },
];
const PLACES: readonly { placement: Placement; label: string }[] = [
  { placement: 'beginningOfSegment', label: 'At the start' },
  { placement: 'midSegment', label: 'In the middle' },
  { placement: 'endOfSegment', label: 'At the end' },
];

/** Where each section has each transition: section name → type → placement. */
export type SectionTransitions = Readonly<Record<string, Readonly<Record<string, Placement>>>>;

/**
 * Switch transitions on or off in a section, or in every section of its kind
 * (all choruses). A switch shows on when every section in scope has it there.
 */
export function TransitionsDialog({
  section,
  sameKind,
  kindLabel,
  current,
  busy,
  error,
  onToggle,
  onClose,
}: {
  section: string;
  /** Every section of the same kind (this one included). */
  sameKind: readonly string[];
  /** e.g. "choruses". */
  kindLabel: string;
  current: SectionTransitions;
  busy: string | undefined;
  error: string | undefined;
  onToggle(segments: string[], type: string, placement: Placement, on: boolean): void;
  onClose(): void;
}) {
  const [scope, setScope] = useState<'this' | 'all'>('this');
  const segments = scope === 'this' ? [section] : [...sameKind];
  const count = (type: string, placement: Placement) => segments.filter((s) => current[s]?.[type] === placement).length;
  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent className={CONTENT}>
        <div className="border-b border-line/60 px-5 py-4 pr-12">
          <DialogTitle className="text-[17px] font-semibold text-white">Transitions in {scope === 'this' ? section : `all ${kindLabel}`}</DialogTitle>
          <DialogDescription className="mt-1 text-[13px] text-white/55">Risers, impacts and fills around the section. Undo with Ctrl+Z.</DialogDescription>
          {sameKind.length > 1 ? (
            <div className="mt-3 flex gap-1" role="group" aria-label="Apply to">
              {(
                [
                  ['this', `${section} only`],
                  ['all', `All ${kindLabel} (${sameKind.length})`],
                ] as const
              ).map(([v, label]) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={scope === v}
                  onClick={() => setScope(v)}
                  className={`h-8 rounded-full border px-3 text-[13px] ${scope === v ? 'border-white bg-white text-black' : 'border-line text-white/80 hover:border-white/50'}`}
                >
                  {label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <div className="max-h-[60vh] overflow-y-auto px-5 py-3">
          {PLACES.map((place) => (
            <div key={place.placement} className="mb-3">
              <div className="mb-1 text-[12px] text-white/50">{place.label}</div>
              {TRANSITIONS.filter((t) => t.placements.includes(place.placement)).map((t) => {
                const n = count(t.type, place.placement);
                const on = n === segments.length;
                const partial = n > 0 && !on;
                return (
                  <label key={t.type} className="flex cursor-pointer items-center gap-3 rounded-[6px] px-2 py-1.5 hover:bg-white/5">
                    <input
                      type="checkbox"
                      checked={on}
                      ref={(el) => {
                        if (el) el.indeterminate = partial;
                      }}
                      disabled={Boolean(busy)}
                      onChange={() => onToggle(segments, t.type, place.placement, !on)}
                      className="h-4 w-4 accent-[#ff2b2b]"
                    />
                    <span className="text-[14px] text-white/90">{t.label}</span>
                    {partial ? <span className="ml-auto text-[12px] text-white/45">in {n} of {segments.length}</span> : null}
                  </label>
                );
              })}
            </div>
          ))}
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-line/60 px-5 py-3 text-[12px]">
          <span className={error ? 'text-err' : 'text-white/55'} role={error ? 'alert' : 'status'}>
            {error ?? (busy ? `${busy}…` : '')}
          </span>
          <button type="button" onClick={onClose} className="h-9 rounded-full px-4 text-[14px] text-white/80 hover:text-white">
            Done
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
