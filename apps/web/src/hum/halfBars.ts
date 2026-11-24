/**
 * Half-bar chords (one per 2 beats) as the score's chord symbols: 16th-note position → symbol, written where the
 * chord changes (and at the start).
 */
export function scoreChordsOf(chords: readonly string[]): Map<number, string> {
  const m = new Map<number, string>();
  chords.forEach((c, s) => {
    if (s === 0 || c !== chords[s - 1]) m.set(s * 8, c);
  });
  return m;
}
