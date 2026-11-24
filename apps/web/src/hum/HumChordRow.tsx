import { useState } from 'react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@teamsuzie/ui';

/** Width of the key column on the left of the piano roll, so the chord cells line up with its bars. */
export const KEY_COL_W = 44;

type Options = { state: 'loading' } | { state: 'ready'; options: { chord: string; fit: number }[] } | { state: 'failed'; message: string };

/**
 * The 16 half-bar chords above the hum piano roll (one cell per chord given). A chord repeated from the half bar before
 * is shown faintly. Click a cell for every chord the fitter knows, best fit to the notes there first. With `readOnly`
 * the chords are only shown (no menu).
 */
export function HumChordRow(
  props:
    | {
        readOnly?: false;
        chords: readonly string[];
        onPick(slot: number, chord: string): void;
        loadOptions(slot: number): Promise<{ chord: string; fit: number }[]>;
        /** While a request runs. */
        disabled: boolean;
      }
    | { readOnly: true; chords: readonly string[] },
) {
  if (props.readOnly) return <ReadOnlyChordRow chords={props.chords} />;
  return <EditableChordRow {...props} />;
}

const cellClass = (chords: readonly string[], s: number) =>
  `h-8 truncate border-l px-1 text-left text-[13px] ${s % 2 === 0 ? 'border-white/25' : 'border-white/[0.07]'} ${
    s > 0 && chords[s - 1] === chords[s] ? 'text-white/30' : 'font-semibold text-white'
  }`;
const slotName = (s: number) => `bar ${Math.floor(s / 2) + 1}, ${s % 2 === 0 ? 'first' : 'second'} half`;

function ReadOnlyChordRow({ chords }: { chords: readonly string[] }) {
  return (
    <div className="flex" aria-label="Chords, two per bar">
      <div className="shrink-0" style={{ width: KEY_COL_W }} />
      <div className="grid flex-1" style={{ gridTemplateColumns: `repeat(${chords.length}, minmax(0, 1fr))` }}>
        {chords.map((c, s) => (
          <span key={s} className={`${cellClass(chords, s)} leading-8`} title={`Chord in ${slotName(s)}: ${c}`}>
            {c}
          </span>
        ))}
      </div>
    </div>
  );
}

function EditableChordRow({
  chords,
  onPick,
  loadOptions,
  disabled,
}: {
  chords: readonly string[];
  onPick(slot: number, chord: string): void;
  loadOptions(slot: number): Promise<{ chord: string; fit: number }[]>;
  disabled: boolean;
}) {
  const [open, setOpen] = useState<number | undefined>(undefined);
  const [options, setOptions] = useState<Options>({ state: 'loading' });

  const openSlot = (slot: number) => {
    setOpen(slot);
    setOptions({ state: 'loading' });
    loadOptions(slot).then(
      (o) => setOptions({ state: 'ready', options: o }),
      (err: unknown) => setOptions({ state: 'failed', message: err instanceof Error ? err.message : String(err) }),
    );
  };

  return (
    <div className="flex" aria-label="Chords, two per bar">
      <div className="shrink-0" style={{ width: KEY_COL_W }} />
      <div className="grid flex-1" style={{ gridTemplateColumns: `repeat(${chords.length}, minmax(0, 1fr))` }}>
        {chords.map((c, s) => (
          <DropdownMenu key={s} open={open === s} onOpenChange={(o) => (o ? openSlot(s) : setOpen(undefined))}>
            <DropdownMenuTrigger asChild disabled={disabled}>
              <button
                type="button"
                disabled={disabled}
                className={`${cellClass(chords, s)} hover:bg-white/10 disabled:opacity-60 ${open === s ? 'bg-white/15' : ''}`}
                title={`Bar ${Math.floor(s / 2) + 1}, ${s % 2 === 0 ? 'first' : 'second'} half: ${c}. Click to change.`}
                aria-label={`Chord in bar ${Math.floor(s / 2) + 1}, ${s % 2 === 0 ? 'first' : 'second'} half: ${c}`}
              >
                {c}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="z-[70] max-h-[320px] min-w-[180px] overflow-y-auto rounded-[10px] border border-line bg-panel p-1 text-white shadow-2xl">
              <DropdownMenuLabel className="px-3 py-2 text-[12px] font-normal text-white/50">Best fit to the notes first</DropdownMenuLabel>
              {options.state === 'loading' ? <p className="px-3 py-2 text-[13px] text-white/60">Loading…</p> : null}
              {options.state === 'failed' ? (
                <p className="px-3 py-2 text-[13px] text-red-200" role="alert">
                  {options.message}
                </p>
              ) : null}
              {options.state === 'ready'
                ? options.options.map((o) => (
                    <DropdownMenuItem
                      key={o.chord}
                      onSelect={() => onPick(s, o.chord)}
                      className={`flex cursor-pointer justify-between gap-4 rounded-[6px] px-3 py-1.5 text-[13px] outline-none data-[highlighted]:bg-white/10 ${o.chord === c ? 'text-accent' : ''}`}
                    >
                      <span>{o.chord}</span>
                      <span className="font-mono text-[11px] text-white/40">{o.fit.toFixed(1)}</span>
                    </DropdownMenuItem>
                  ))
                : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ))}
      </div>
    </div>
  );
}
