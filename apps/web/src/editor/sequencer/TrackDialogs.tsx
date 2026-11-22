import { useMemo, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@teamsuzie/ui';

import type { InstrumentFamily, TrackOptions } from '../../api/tracks';
import type { SeqSection } from '../sequencerModel';

const CONTENT =
  'w-[min(560px,calc(100vw-2rem))] max-w-none gap-0 rounded-[12px] border border-line bg-panel p-0 text-white sm:max-w-none';

/** Pick another sound of the same family for a track. */
export function ChangeSoundDialog({
  track,
  options,
  onPick,
  onClose,
}: {
  track: string;
  options: TrackOptions;
  onPick(soundId: string): void;
  onClose(): void;
}) {
  const [filter, setFilter] = useState('');
  const info = options.tracks[track];
  if (!info) throw new Error(`No options for track "${track}".`);
  const family = options.families.find((f) => f.family === info.family);
  if (!family) throw new Error(`This genre offers no ${info.family} sounds.`);
  const shown = family.sounds.filter((s) => s.name.toLowerCase().includes(filter.trim().toLowerCase()));

  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent className={CONTENT}>
        <div className="border-b border-line/60 px-5 py-4 pr-12">
          <DialogTitle className="text-[17px] font-semibold text-white">Change the sound of {track}</DialogTitle>
          <DialogDescription className="mt-1 text-[13px] text-white/55">
            {family.label} sounds for this genre. The part keeps its notes where the new sound can play them.
          </DialogDescription>
        </div>
        <div className="px-5 pt-4">
          <input
            autoFocus
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={`Search ${family.sounds.length} sounds`}
            aria-label="Search sounds"
            className="h-10 w-full rounded-[8px] border border-line bg-bg px-3 text-[14px] text-white outline-none focus:border-white/50"
          />
        </div>
        <ul className="max-h-[50vh] overflow-auto px-3 py-3">
          {shown.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => onPick(s.id)}
                className={`flex w-full items-center justify-between rounded-[8px] px-3 py-2.5 text-left text-[14px] hover:bg-white/10 ${
                  s.id === info.soundId ? 'text-white' : 'text-white/80'
                }`}
              >
                <span className="truncate">{s.name}</span>
                {s.id === info.soundId ? <span className="text-[12px] text-white/50">Current</span> : null}
              </button>
            </li>
          ))}
          {shown.length === 0 ? <li className="px-3 py-4 text-[14px] text-white/50">No sound matches.</li> : null}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

/** Add a track: pick the family (and optionally the sound) and the sections it plays in. */
export function AddTrackDialog({
  options,
  hasDrums,
  sections,
  initialSections,
  onAdd,
  onClose,
}: {
  options: TrackOptions;
  /** The song has a drum track already (the engine plays one kit). */
  hasDrums: boolean;
  sections: readonly SeqSection[];
  initialSections: readonly string[];
  onAdd(family: InstrumentFamily, segments: string[], soundId: string | undefined): void;
  onClose(): void;
}) {
  const [family, setFamily] = useState<InstrumentFamily | undefined>(undefined);
  const [soundId, setSoundId] = useState<string>('');
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(initialSections));
  const sounds = useMemo(() => options.families.find((f) => f.family === family)?.sounds ?? [], [options, family]);
  const ready = family !== undefined && chosen.size > 0;
  const toggle = (name: string) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent className={CONTENT}>
        <div className="border-b border-line/60 px-5 py-4 pr-12">
          <DialogTitle className="text-[17px] font-semibold text-white">Add a track</DialogTitle>
          <DialogDescription className="mt-1 text-[13px] text-white/55">
            Casperaki writes a part for it that fits the song&rsquo;s chords and groove.
          </DialogDescription>
        </div>

        <div className="flex flex-col gap-5 px-5 py-5">
          <fieldset>
            <legend className="mb-2 text-[13px] text-white/60">Instrument</legend>
            <div className="flex flex-wrap gap-2">
              {options.families.map((f) => (
                <button
                  key={f.family}
                  type="button"
                  disabled={f.family === 'drums' && hasDrums}
                  title={f.family === 'drums' && hasDrums ? 'The song already has drums: right-click them for a new pattern' : undefined}
                  aria-pressed={family === f.family}
                  onClick={() => {
                    setFamily(f.family);
                    setSoundId('');
                  }}
                  className={`h-9 rounded-full border px-4 text-[14px] ${
                    family === f.family ? 'border-white bg-white text-black' : 'border-line text-white/80 hover:border-white/50'
                  } disabled:opacity-35`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </fieldset>

          {family && sounds.length > 0 ? (
            <label className="flex flex-col gap-2">
              <span className="text-[13px] text-white/60">Sound</span>
              <select
                value={soundId}
                onChange={(e) => setSoundId(e.target.value)}
                className="h-10 rounded-[8px] border border-line bg-bg px-3 text-[14px] text-white"
              >
                <option value="">Let Casperaki choose</option>
                {sounds.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <fieldset>
            <legend className="mb-2 flex w-full items-center justify-between text-[13px] text-white/60">
              <span>Plays in</span>
              <span className="flex gap-3">
                <button type="button" className="text-white/70 hover:text-white" onClick={() => setChosen(new Set(sections.map((s) => s.name)))}>
                  All
                </button>
                <button type="button" className="text-white/70 hover:text-white" onClick={() => setChosen(new Set())}>
                  None
                </button>
              </span>
            </legend>
            <div className="flex flex-wrap gap-2">
              {sections.map((s) => (
                <button
                  key={s.name}
                  type="button"
                  aria-pressed={chosen.has(s.name)}
                  onClick={() => toggle(s.name)}
                  className={`h-8 rounded-[6px] border px-3 text-[13px] ${chosen.has(s.name) ? 'text-white' : 'border-line text-white/45'}`}
                  style={chosen.has(s.name) ? { borderColor: s.color, background: `color-mix(in srgb, ${s.color} 35%, transparent)` } : undefined}
                >
                  {s.name}
                </button>
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
            disabled={!ready}
            onClick={() => family && onAdd(family, sections.filter((s) => chosen.has(s.name)).map((s) => s.name), soundId || undefined)}
            className="h-10 rounded-full bg-accent px-5 text-[14px] font-semibold text-white hover:bg-[#e00000] disabled:opacity-40"
          >
            Add track
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
