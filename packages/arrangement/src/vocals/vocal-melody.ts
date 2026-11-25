// Whether the song's vocal tracks show their melody: generator param `vocalMelody`. `false` = the vocal tracks (lead
// and backings) are empty: they exist, no section has them on, they have no notes. Absent = shown (every song made
// before 2026-11-25). The generator chooses the melody either way, because a sung section takes its chords from it
// (docs/superpowers/specs/2026-11-25-vocal-tasks-design.md).

export const VOCAL_MELODY_PARAM = 'vocalMelody';

/** Whether generator params show the vocal melody (an error when the param is anything but `false` or absent). */
export function vocalMelodyShownIn(params: Readonly<Record<string, unknown>> | undefined): boolean {
  const raw = params?.[VOCAL_MELODY_PARAM];
  if (raw === undefined) return true;
  if (raw === false) return false;
  throw new Error(`generator param "${VOCAL_MELODY_PARAM}" must be false or absent, not ${JSON.stringify(raw)}`);
}
