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
