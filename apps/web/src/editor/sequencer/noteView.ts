import { useState } from 'react';

/** Piano roll or score: one remembered choice for every place that offers both (owner, 2026-11-27). */
export type NoteView = 'roll' | 'score';
const STORAGE = 'casperaki.noteView';

function read(fallback: NoteView): NoteView {
  try {
    const v = window.localStorage.getItem(STORAGE);
    return v === 'roll' || v === 'score' ? v : fallback;
  } catch {
    return fallback;
  }
}

/** The piano roll / score choice, remembered in this browser; `initial` until one has been made. */
export function useNoteView(initial: NoteView): [NoteView, (v: NoteView) => void] {
  const [view, setView] = useState<NoteView>(() => read(initial));
  const set = (v: NoteView) => {
    setView(v);
    try {
      window.localStorage.setItem(STORAGE, v);
    } catch {
      // Not remembered in this browser (private window, blocked storage): the choice still applies now.
    }
  };
  return [view, set];
}
