// Internal — shared lookup tables for chord/note modules so they don't
// import from each other cyclically.

export const LETTER_TO_PITCH_CLASS_ALIAS: Record<string, number> = {
  C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11,
};
