import { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@teamsuzie/ui';
import { RAP_DEFAULT_STYLE, rapLineCount } from '@casperaki/song-schema/ace-layer';

// Rap like singing (docs/superpowers/specs/2026-11-28-rap-like-singing-design.md): Write rap lyrics… (the language
// model writes the chosen sections' words into the song), then Rap… (ACE raps the chosen sections with their words,
// which can be edited here first; the result lands on the "Rap" track).

const CONTENT = 'w-[min(520px,calc(100vw-2rem))] max-w-none gap-0 rounded-[12px] border border-line bg-panel p-0 text-white sm:max-w-none';

/** "verse2" → "Verse 2", "preChorus1" → "Pre-chorus 1". */
export function rapSectionLabel(name: string): string {
  const m = /^([A-Za-z]+?)(\d*)$/u.exec(name);
  if (!m) return name;
  const kind = m[1]!.replace(/([a-z])([A-Z])/gu, '$1-$2').toLowerCase();
  return `${kind[0]!.toUpperCase()}${kind.slice(1)}${m[2] ? ` ${m[2]}` : ''}`;
}

/** The sections Write rap lyrics ticks at first: the verses when the song has sung vocals, otherwise every section. */
export function defaultRapSections(sections: readonly { name: string }[], hasSung: boolean): string[] {
  return sections.filter((s) => !hasSung || /^verse/u.test(s.name)).map((s) => s.name);
}

/** The ticked sections that have no words yet (Rap cannot start while there are any). */
export function sectionsWithoutWords(ticked: readonly string[], words: Readonly<Record<string, string>>): string[] {
  return ticked.filter((n) => !words[n]?.trim());
}

/** The words sent for the ticked sections: each section's lines, trimmed, empty lines dropped. */
export function rapWordsToSend(ticked: readonly string[], words: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    ticked.map((n) => [
      n,
      (words[n] ?? '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .join('\n'),
    ]),
  );
}

type Section = { readonly name: string; readonly bars: number };

function Shell({ title, description, children, start, onClose }: { title: string; description: string; children: React.ReactNode; start: { label: string; disabled: boolean; hint?: string; onClick(): void }; onClose(): void }) {
  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent className={CONTENT}>
        <div className="border-b border-line/60 px-5 py-4 pr-12">
          <DialogTitle className="text-[17px] font-semibold text-white">{title}</DialogTitle>
          <DialogDescription className="mt-1 text-[13px] text-white/55">{description}</DialogDescription>
        </div>
        <div className="flex max-h-[60vh] flex-col gap-5 overflow-y-auto px-5 py-5 text-[14px]">{children}</div>
        <div className="flex items-center justify-end gap-2 border-t border-line/60 px-5 py-4">
          {start.hint ? <span className="mr-auto text-[12px] text-white/45">{start.hint}</span> : null}
          <button type="button" onClick={onClose} className="h-10 rounded-full px-4 text-[14px] text-white/70 hover:text-white">
            Cancel
          </button>
          <button
            type="button"
            disabled={start.disabled}
            onClick={start.onClick}
            className="h-10 rounded-full bg-accent px-5 text-[14px] font-semibold text-white hover:bg-[#e00000] disabled:opacity-40"
          >
            {start.label}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function StyleInput({ style, onChange }: { style: string; onChange(s: string): void }) {
  return (
    <label className="flex flex-col gap-2">
      <span className="text-[13px] text-white/60">Style</span>
      <input
        value={style}
        maxLength={200}
        onChange={(e) => onChange(e.target.value)}
        placeholder="e.g. female rap vocals, fast and playful"
        className="h-10 rounded-[8px] border border-line bg-transparent px-3 text-white placeholder:text-white/30"
      />
    </label>
  );
}

const toggled = (sections: readonly Section[], ticked: readonly string[], name: string, on: boolean) =>
  sections.map((s) => s.name).filter((n) => (n === name ? on : ticked.includes(n)));

/** Write rap lyrics…: the style and the sections to write words for (the verses at first when the song is sung). */
export function WriteRapLyricsDialog({
  sections,
  hasSung,
  onStart,
  onClose,
}: {
  sections: readonly Section[];
  hasSung: boolean;
  onStart(style: string, chosen: string[]): void;
  onClose(): void;
}) {
  const [style, setStyle] = useState(RAP_DEFAULT_STYLE);
  const [ticked, setTicked] = useState<string[]>(() => defaultRapSections(sections, hasSung));
  return (
    <Shell
      title="Write rap lyrics"
      description="The words of a rap for the sections you choose, one short line per bar. You can change them in Rap… before rapping."
      start={{ label: 'Write', disabled: ticked.length === 0 || !style.trim(), onClick: () => onStart(style.trim(), ticked) }}
      onClose={onClose}
    >
      <StyleInput style={style} onChange={setStyle} />
      <fieldset className="flex flex-col gap-2">
        <span className="text-[13px] text-white/60">Sections</span>
        {sections.map((s) => (
          <label key={s.name} className="flex items-center gap-3">
            <input type="checkbox" checked={ticked.includes(s.name)} onChange={(e) => setTicked(toggled(sections, ticked, s.name, e.target.checked))} />
            <span>
              {rapSectionLabel(s.name)} <span className="text-white/40">({rapLineCount(s.bars)} lines)</span>
            </span>
          </label>
        ))}
      </fieldset>
    </Shell>
  );
}

/** Rap…: the style, the sections (those with rap words at first) and each ticked section's words, editable. */
export function RapDialog({
  sections,
  rapLyrics,
  onStart,
  onClose,
}: {
  sections: readonly Section[];
  /** The song's rap words (section → lines). */
  rapLyrics: Readonly<Record<string, readonly string[]>>;
  /** style: the rapper's voice and flow; chosen: section names in song order; words: each chosen section's lines. */
  onStart(style: string, chosen: string[], words: Record<string, string>): void;
  onClose(): void;
}) {
  const [style, setStyle] = useState(RAP_DEFAULT_STYLE);
  const [ticked, setTicked] = useState<string[]>(() => sections.filter((s) => rapLyrics[s.name]?.length).map((s) => s.name));
  const [words, setWords] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(rapLyrics).map(([n, l]) => [n, l.join('\n')])));
  const missing = sectionsWithoutWords(ticked, words);
  return (
    <Shell
      title="Rap"
      description="AI raps the sections you choose with their words, a few takes each; the clearest is kept, on the track Rap. The singing in those sections is muted (right-click a clip to unmute it)."
      start={{
        label: 'Rap',
        disabled: ticked.length === 0 || missing.length > 0 || !style.trim(),
        hint: missing.length > 0 ? `${missing.map(rapSectionLabel).join(', ')}: no words (write rap lyrics first)` : '',
        onClick: () => onStart(style.trim(), ticked, rapWordsToSend(ticked, words)),
      }}
      onClose={onClose}
    >
      <StyleInput style={style} onChange={setStyle} />
      <fieldset className="flex flex-col gap-3">
        <span className="text-[13px] text-white/60">Sections</span>
        {sections.map((s) => {
          const on = ticked.includes(s.name);
          return (
            <div key={s.name} className="flex flex-col gap-2">
              <label className="flex items-center gap-3">
                <input type="checkbox" checked={on} onChange={(e) => setTicked(toggled(sections, ticked, s.name, e.target.checked))} />
                <span>
                  {rapSectionLabel(s.name)} <span className="text-white/40">({s.bars} bars)</span>
                </span>
              </label>
              {on ? (
                <textarea
                  value={words[s.name] ?? ''}
                  rows={Math.min(rapLineCount(s.bars), 6)}
                  maxLength={1000}
                  onChange={(e) => setWords({ ...words, [s.name]: e.target.value })}
                  placeholder="No words yet: write rap lyrics first, or type them here (one short line per bar)"
                  className="ml-7 rounded-[8px] border border-line bg-transparent px-3 py-2 font-mono text-[13px] text-white placeholder:text-white/30"
                />
              ) : null}
            </div>
          );
        })}
      </fieldset>
    </Shell>
  );
}

/** A Rap track clip opened: the section's rap words, to read and change (saved into the song). */
export function RapWordsDialog({
  section,
  lines,
  onSave,
  onClose,
}: {
  section: string;
  lines: readonly string[];
  onSave(lines: string[]): void;
  onClose(): void;
}) {
  const [text, setText] = useState(lines.join('\n'));
  const kept = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return (
    <Shell
      title={`Rap words: ${rapSectionLabel(section)}`}
      description="The words Rap… raps in this section. Change them here, then Rap… again to hear them."
      start={{ label: 'Save', disabled: kept.length === 0, onClick: () => onSave(kept) }}
      onClose={onClose}
    >
      <textarea
        value={text}
        rows={Math.min(Math.max(lines.length, 4), 12)}
        maxLength={1000}
        onChange={(e) => setText(e.target.value)}
        aria-label={`Rap words of ${rapSectionLabel(section)}`}
        className="rounded-[8px] border border-line bg-transparent px-3 py-2 font-mono text-[13px] text-white"
      />
    </Shell>
  );
}
