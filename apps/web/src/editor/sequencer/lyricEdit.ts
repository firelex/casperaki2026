import { useEffect, useMemo, useState } from 'react';

// Lyrics edited on the notes in the piano roll (owner 2026-11-28: Tab goes to the next note). The notes of the lead in
// time order, each with its syllable; the edit sends every note's syllable in that order (editLyrics).

/** The notes' indices in time order (the order the words are sung in). */
export function lyricOrder(notes: readonly { readonly start: number }[]): number[] {
  return notes.map((_, i) => i).sort((a, b) => notes[a]!.start - notes[b]!.start || a - b);
}

/** The note Tab (dir 1) or Shift+Tab (dir -1) moves to from `at`: the next or previous in time, staying at the ends. */
export function stepLyric(order: readonly number[], at: number, dir: 1 | -1): number {
  const k = order.indexOf(at);
  if (k < 0) throw new Error(`stepLyric: note ${at} is not in the order`);
  return order[Math.min(order.length - 1, Math.max(0, k + dir))]!;
}

/** Every note's syllable in time order, the draft's where the user typed one. */
export function syllablesInOrder(notes: readonly { readonly label?: string }[], order: readonly number[], draft: Readonly<Record<number, string>>): string[] {
  return order.map((i) => {
    const s = draft[i] ?? notes[i]!.label;
    if (s === undefined) throw new Error(`note ${i + 1} has no syllable`);
    return s;
  });
}

/** The note with a syllable whose start is nearest `beat` (a click in the score), or undefined when none has one. */
export function noteAtBeat(notes: readonly { readonly start: number; readonly label?: string | undefined }[], beat: number): number | undefined {
  let best: number | undefined;
  notes.forEach((n, i) => {
    if (n.label === undefined) return;
    if (best === undefined || Math.abs(n.start - beat) < Math.abs(notes[best]!.start - beat)) best = i;
  });
  return best;
}

/** The words being edited in a clip window (shared by its piano roll and score): the note whose word is open, what was
 *  typed per note; Tab and Shift+Tab move, save sends every syllable, closeOne drops the open note's typing. */
export interface LyricEdit {
  readonly order: readonly number[];
  readonly editing: number | undefined;
  readonly draft: Readonly<Record<number, string>>;
  open(i: number): void;
  type(i: number, text: string): void;
  step(dir: 1 | -1): void;
  save(): void;
  closeOne(): void;
}

export function useLyricEdit(notes: readonly { readonly start: number; readonly label?: string | undefined }[], onCommit: ((syllables: string[]) => void) | undefined): LyricEdit | undefined {
  const order = useMemo(() => lyricOrder(notes), [notes]);
  const [editing, setEditing] = useState<number | undefined>(undefined);
  const [draft, setDraft] = useState<Record<number, string>>({});
  useEffect(() => {
    setEditing(undefined);
    setDraft({});
  }, [notes]);
  if (!onCommit) return undefined;
  return {
    order,
    editing,
    draft,
    open: (i) => setEditing(i),
    type: (i, text) => setDraft((d) => ({ ...d, [i]: text })),
    step: (dir) => setEditing((at) => (at === undefined ? at : stepLyric(order, at, dir))),
    save: () => {
      setEditing(undefined);
      if (Object.entries(draft).some(([i, w]) => w !== notes[Number(i)]?.label)) onCommit(syllablesInOrder(notes, order, draft));
    },
    closeOne: () => {
      setDraft((d) => {
        if (editing === undefined) return d;
        const { [editing]: _dropped, ...rest } = d;
        return rest;
      });
      setEditing(undefined);
    },
  };
}
