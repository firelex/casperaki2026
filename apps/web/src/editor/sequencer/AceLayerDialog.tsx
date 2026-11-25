import { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@teamsuzie/ui';
import { ACE_INSTRUMENT_LABELS, ACE_INSTRUMENTS, type AceInstrument } from '@casperaki/song-schema/ace-layer';

const CONTENT = 'w-[min(480px,calc(100vw-2rem))] max-w-none gap-0 rounded-[12px] border border-line bg-panel p-0 text-white sm:max-w-none';

/** The bars a selection covers, as the dialog names them ("bars 5–12"): bar numbers from 1, end inclusive. */
export function selectionBars(range: { startBar: number; endBar: number }): string {
  const first = Math.floor(range.startBar) + 1;
  const last = Math.ceil(range.endBar);
  return first === last ? `bar ${first}` : `bars ${first}–${last}`;
}

/**
 * Add ACE layer (docs/superpowers/specs/2026-11-25-ace-layer-design.md): choose the instrument, optional style words
 * and what it covers (the whole song, or the selection when there is one). ACE-Step plays the part over the song in the
 * background (the Tasks menu shows it); it goes in when playback stops, on an audio-only track "ACE <Instrument>".
 */
export function AceLayerDialog({
  selection,
  onStart,
  onClose,
}: {
  /** The timeline's selection in bars from the song's start (end exclusive), if any. */
  selection: { startBar: number; endBar: number } | undefined;
  onStart(instrument: AceInstrument, words: string, range: { startBar: number; endBar: number } | undefined): void;
  onClose(): void;
}) {
  const [instrument, setInstrument] = useState<AceInstrument>('guitar');
  const [words, setWords] = useState('');
  const [onSelection, setOnSelection] = useState(selection !== undefined);
  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent className={CONTENT}>
        <div className="border-b border-line/60 px-5 py-4 pr-12">
          <DialogTitle className="text-[17px] font-semibold text-white">Add ACE layer</DialogTitle>
          <DialogDescription className="mt-1 text-[13px] text-white/55">
            ACE-Step listens to the song as it is and plays one more part over it. It arrives on its own track, which you can mute or remove.
          </DialogDescription>
        </div>
        <div className="flex flex-col gap-5 px-5 py-5 text-[14px]">
          <label className="flex flex-col gap-2">
            <span className="text-[13px] text-white/60">Instrument</span>
            <select
              value={instrument}
              onChange={(e) => setInstrument(e.target.value as AceInstrument)}
              className="h-10 rounded-[8px] border border-line bg-transparent px-3 text-white"
            >
              {ACE_INSTRUMENTS.map((i) => (
                <option key={i} value={i}>
                  {ACE_INSTRUMENT_LABELS[i]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-2">
            <span className="text-[13px] text-white/60">Style (optional)</span>
            <input
              value={words}
              maxLength={200}
              onChange={(e) => setWords(e.target.value)}
              placeholder="e.g. funky muted strums, warm, sparse"
              className="h-10 rounded-[8px] border border-line bg-transparent px-3 text-white placeholder:text-white/30"
            />
          </label>
          <fieldset className="flex flex-col gap-2">
            <span className="text-[13px] text-white/60">Covers</span>
            <label className="flex items-center gap-3">
              <input type="radio" checked={!onSelection} onChange={() => setOnSelection(false)} />
              <span>The whole song</span>
            </label>
            {selection ? (
              <label className="flex items-center gap-3">
                <input type="radio" checked={onSelection} onChange={() => setOnSelection(true)} />
                <span>{selectionBars(selection)} (the selection)</span>
              </label>
            ) : null}
          </fieldset>
        </div>
        <div className="flex justify-end gap-2 border-t border-line/60 px-5 py-4">
          <button type="button" onClick={onClose} className="h-10 rounded-full px-4 text-[14px] text-white/70 hover:text-white">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onStart(instrument, words, onSelection ? selection : undefined)}
            className="h-10 rounded-full bg-accent px-5 text-[14px] font-semibold text-white hover:bg-[#e00000]"
          >
            Add layer
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
