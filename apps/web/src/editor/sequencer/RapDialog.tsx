import { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@teamsuzie/ui';
import { RAP_DEFAULT_STYLE, rapLineCount } from '@casperaki/song-schema/ace-layer';

const CONTENT = 'w-[min(520px,calc(100vw-2rem))] max-w-none gap-0 rounded-[12px] border border-line bg-panel p-0 text-white sm:max-w-none';

/** "verse2" → "Verse 2", "preChorus1" → "Pre-chorus 1". */
export function rapSectionLabel(name: string): string {
  const m = /^([A-Za-z]+?)(\d*)$/u.exec(name);
  if (!m) return name;
  const kind = m[1]!.replace(/([a-z])([A-Z])/gu, '$1-$2').toLowerCase();
  return `${kind[0]!.toUpperCase()}${kind.slice(1)}${m[2] ? ` ${m[2]}` : ''}`;
}

/** The sections ticked at first: the verses (none: nothing ticked). */
export function defaultRapSections(sections: readonly { name: string }[]): string[] {
  return sections.filter((s) => /^verse/u.test(s.name)).map((s) => s.name);
}

/** The words the user typed for the ticked sections (sections left empty are not sent: their words are written). */
export function rapWordsToSend(ticked: readonly string[], words: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(ticked.flatMap((n) => (words[n]?.trim() ? [[n, words[n]!.trim()]] : [])));
}

/**
 * Add rap vocals (docs/superpowers/specs/2026-11-27-rap-vocals-design.md): ACE-Step raps over the chosen sections of the
 * song as it is, each section on its own, several takes, the clearest kept (separated from any backing). Words per
 * section are optional: empty ones are written for the user. The result lands on an audio-only track "ACE Rap".
 */
export function RapDialog({
  sections,
  onStart,
  onClose,
}: {
  sections: readonly { name: string; bars: number }[];
  /** style: the rap's style words; chosen: section names in song order; words: the sections' own words. */
  onStart(style: string, chosen: string[], words: Record<string, string>): void;
  onClose(): void;
}) {
  const [style, setStyle] = useState(RAP_DEFAULT_STYLE);
  const [ticked, setTicked] = useState<string[]>(() => defaultRapSections(sections));
  const [words, setWords] = useState<Record<string, string>>({});
  const toggle = (name: string, on: boolean) => setTicked(sections.map((s) => s.name).filter((n) => (n === name ? on : ticked.includes(n))));
  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent className={CONTENT}>
        <div className="border-b border-line/60 px-5 py-4 pr-12">
          <DialogTitle className="text-[17px] font-semibold text-white">Add rap vocals</DialogTitle>
          <DialogDescription className="mt-1 text-[13px] text-white/55">
            ACE-Step raps over the sections you choose, each one a few times; the clearest take is kept, separated from the music. It arrives on its own track, which you can mute or remove.
          </DialogDescription>
        </div>
        <div className="flex max-h-[60vh] flex-col gap-5 overflow-y-auto px-5 py-5 text-[14px]">
          <label className="flex flex-col gap-2">
            <span className="text-[13px] text-white/60">Style</span>
            <input
              value={style}
              maxLength={200}
              onChange={(e) => setStyle(e.target.value)}
              placeholder="e.g. female rap vocals, fast and playful"
              className="h-10 rounded-[8px] border border-line bg-transparent px-3 text-white placeholder:text-white/30"
            />
          </label>
          <fieldset className="flex flex-col gap-3">
            <span className="text-[13px] text-white/60">Sections (words are optional: empty ones are written for you)</span>
            {sections.map((s) => {
              const on = ticked.includes(s.name);
              const lines = rapLineCount(s.bars);
              return (
                <div key={s.name} className="flex flex-col gap-2">
                  <label className="flex items-center gap-3">
                    <input type="checkbox" checked={on} onChange={(e) => toggle(s.name, e.target.checked)} />
                    <span>
                      {rapSectionLabel(s.name)} <span className="text-white/40">({s.bars} bars)</span>
                    </span>
                  </label>
                  {on ? (
                    <textarea
                      value={words[s.name] ?? ''}
                      rows={Math.min(lines, 6)}
                      maxLength={1000}
                      onChange={(e) => setWords({ ...words, [s.name]: e.target.value })}
                      placeholder={`Leave empty to have ${lines} line${lines === 1 ? '' : 's'} written (one line per 2 bars)`}
                      className="ml-7 rounded-[8px] border border-line bg-transparent px-3 py-2 font-mono text-[13px] text-white placeholder:text-white/30"
                    />
                  ) : null}
                </div>
              );
            })}
          </fieldset>
        </div>
        <div className="flex justify-end gap-2 border-t border-line/60 px-5 py-4">
          <button type="button" onClick={onClose} className="h-10 rounded-full px-4 text-[14px] text-white/70 hover:text-white">
            Cancel
          </button>
          <button
            type="button"
            disabled={ticked.length === 0}
            onClick={() => onStart(style, ticked, rapWordsToSend(ticked, words))}
            className="h-10 rounded-full bg-accent px-5 text-[14px] font-semibold text-white hover:bg-[#e00000] disabled:opacity-40"
          >
            Add rap
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
