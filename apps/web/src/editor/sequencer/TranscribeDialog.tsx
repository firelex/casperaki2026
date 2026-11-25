import { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@teamsuzie/ui';

const CONTENT = 'w-[min(480px,calc(100vw-2rem))] max-w-none gap-0 rounded-[12px] border border-line bg-panel p-0 text-white sm:max-w-none';

/** The dialog's fields: which section the recording is of, the file, and whether music plays behind the voice. */
export function TranscribeForm({
  sections,
  section,
  onSection,
  file,
  onFile,
  hasBacking,
  onBacking,
}: {
  sections: readonly string[];
  section: string;
  onSection(name: string): void;
  file: File | undefined;
  onFile(file: File | undefined): void;
  hasBacking: boolean;
  onBacking(on: boolean): void;
}) {
  return (
    <div className="flex flex-col gap-5 px-5 py-5 text-[14px]">
      <label className="flex flex-col gap-2">
        <span className="text-[13px] text-white/60">Section</span>
        <select value={section} onChange={(e) => onSection(e.target.value)} className="h-10 rounded-[8px] border border-line bg-transparent px-3 text-white">
          {sections.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-2">
        <span className="text-[13px] text-white/60">Recording (sung or hummed along from the section&apos;s first beat, at the song&apos;s tempo)</span>
        <input type="file" accept="audio/*" onChange={(e) => onFile(e.target.files?.[0])} className="text-[13px] text-white/80" />
        {file ? <span className="text-[12px] text-white/45">{file.name}</span> : null}
      </label>
      <label className="flex items-center gap-3">
        <input type="checkbox" checked={hasBacking} onChange={(e) => onBacking(e.target.checked)} />
        <span>Music plays behind the voice</span>
      </label>
    </div>
  );
}

/** Transcribe melody: choose the section and the recording; the brain writes it into the section's Vocal lane in the
 *  background (the Tasks menu shows it; it goes in when playback stops). */
export function TranscribeDialog({
  sections,
  initialSection,
  onStart,
  onClose,
}: {
  sections: readonly string[];
  initialSection: string | undefined;
  onStart(section: string, file: File, hasBacking: boolean): void;
  onClose(): void;
}) {
  if (sections.length === 0) throw new Error('TranscribeDialog: the song has no section with Vocal notes');
  const [section, setSection] = useState(initialSection !== undefined && sections.includes(initialSection) ? initialSection : sections[0]!);
  const [file, setFile] = useState<File | undefined>(undefined);
  const [hasBacking, setHasBacking] = useState(false);
  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent className={CONTENT}>
        <div className="border-b border-line/60 px-5 py-4 pr-12">
          <DialogTitle className="text-[17px] font-semibold text-white">Transcribe melody</DialogTitle>
          <DialogDescription className="mt-1 text-[13px] text-white/55">
            Your recording of one section becomes its melody on the Vocal track. With written lyrics, every word gets its own note.
          </DialogDescription>
        </div>
        <TranscribeForm sections={sections} section={section} onSection={setSection} file={file} onFile={setFile} hasBacking={hasBacking} onBacking={setHasBacking} />
        <div className="flex justify-end gap-2 border-t border-line/60 px-5 py-4">
          <button type="button" onClick={onClose} className="h-10 rounded-full px-4 text-[14px] text-white/70 hover:text-white">
            Cancel
          </button>
          <button
            type="button"
            disabled={!file}
            onClick={() => file && onStart(section, file, hasBacking)}
            className="h-10 rounded-full bg-accent px-5 text-[14px] font-semibold text-white hover:bg-[#e00000] disabled:opacity-40"
          >
            Transcribe
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
