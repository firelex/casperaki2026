import { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@teamsuzie/ui';
import { ACE_ADLIB_DEFAULT_STYLE, ACE_ADLIB_DEFAULT_WORDS, type AceAdlibVoice } from '@casperaki/song-schema/ace-layer';

const CONTENT = 'w-[min(480px,calc(100vw-2rem))] max-w-none gap-0 rounded-[12px] border border-line bg-panel p-0 text-white sm:max-w-none';

/**
 * Add ad-libs: ACE-Step sings the given words (under every chorus) in the given style over the song as it is; only the
 * final chorus(es) keep them, on an audio-only track "ACE Ad-libs" (mute or remove it like any track). In the
 * background: the Tasks menu shows it, and it goes in when playback stops.
 */
export function AdlibsDialog({
  sections,
  onStart,
  onClose,
}: {
  /** The final chorus(es) the ad-libs go into. */
  sections: readonly string[];
  onStart(lyrics: string, style: string, voice: AceAdlibVoice): void;
  onClose(): void;
}) {
  if (sections.length === 0) throw new Error('AdlibsDialog: the song ends in no chorus');
  const [lyrics, setLyrics] = useState(ACE_ADLIB_DEFAULT_WORDS);
  const [style, setStyle] = useState(ACE_ADLIB_DEFAULT_STYLE);
  const [voice, setVoice] = useState<AceAdlibVoice>('backing_vocals');
  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent className={CONTENT}>
        <div className="border-b border-line/60 px-5 py-4 pr-12">
          <DialogTitle className="text-[17px] font-semibold text-white">Add ad-libs</DialogTitle>
          <DialogDescription className="mt-1 text-[13px] text-white/55">
            ACE-Step sings ad-libs over the song as it is. They go into {sections.join(' and ')}, on their own track.
          </DialogDescription>
        </div>
        <div className="flex flex-col gap-5 px-5 py-5 text-[14px]">
          <label className="flex flex-col gap-2">
            <span className="text-[13px] text-white/60">Words (one ad-lib per line)</span>
            <textarea
              value={lyrics}
              rows={5}
              maxLength={1000}
              onChange={(e) => setLyrics(e.target.value)}
              className="rounded-[8px] border border-line bg-transparent px-3 py-2 font-mono text-[13px] text-white"
            />
          </label>
          <label className="flex flex-col gap-2">
            <span className="text-[13px] text-white/60">Style</span>
            <input
              value={style}
              maxLength={200}
              onChange={(e) => setStyle(e.target.value)}
              className="h-10 rounded-[8px] border border-line bg-transparent px-3 text-white"
            />
          </label>
          <fieldset className="flex flex-col gap-2">
            <span className="text-[13px] text-white/60">Voice</span>
            <label className="flex items-center gap-3">
              <input type="radio" checked={voice === 'backing_vocals'} onChange={() => setVoice('backing_vocals')} />
              <span>Backing singer</span>
            </label>
            <label className="flex items-center gap-3">
              <input type="radio" checked={voice === 'vocals'} onChange={() => setVoice('vocals')} />
              <span>Lead-style singer</span>
            </label>
          </fieldset>
        </div>
        <div className="flex justify-end gap-2 border-t border-line/60 px-5 py-4">
          <button type="button" onClick={onClose} className="h-10 rounded-full px-4 text-[14px] text-white/70 hover:text-white">
            Cancel
          </button>
          <button
            type="button"
            disabled={!lyrics.trim()}
            onClick={() => onStart(lyrics.trim(), style, voice)}
            className="h-10 rounded-full bg-accent px-5 text-[14px] font-semibold text-white hover:bg-[#e00000] disabled:opacity-40"
          >
            Add ad-libs
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
