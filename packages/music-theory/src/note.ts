// Note: MIDI <-> string conversion and pitch-class arithmetic.
//
// Strings use the engine's accepted shape: letter + optional accidental
// (`#` or `b`) + octave (e.g. "C4", "c4", "F#3", "Db-1"). MIDI 0 = C-1,
// MIDI 60 = C4 (middle C). The legacy engine accepts both lowercase and
// uppercase letters; we normalise to uppercase on parse and emit
// uppercase on toString to keep canonical output stable.

const LETTER_TO_PITCH_CLASS: Record<string, number> = {
  C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11,
};

const PITCH_CLASS_TO_NAME: readonly string[] = [
  'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B',
];

const NOTE_REGEX = /^([A-Ga-g])([#b]?)(-?\d+)$/u;

export interface ParsedNote {
  pitchClass: number; // 0..11
  octave: number;
  midi: number;
}

export function parseNoteString(s: string): ParsedNote {
  const m = NOTE_REGEX.exec(s);
  if (!m) throw new Error(`parseNoteString: invalid note "${s}"`);
  const letter = m[1]!.toUpperCase();
  const accidental = m[2]!;
  const octave = Number.parseInt(m[3]!, 10);
  let pc = LETTER_TO_PITCH_CLASS[letter]!;
  if (accidental === '#') pc = (pc + 1) % 12;
  else if (accidental === 'b') pc = (pc + 11) % 12;
  const midi = (octave + 1) * 12 + pc;
  if (midi < 0 || midi > 127)
    throw new Error(`parseNoteString: midi out of range for "${s}" → ${midi}`);
  return { pitchClass: pc, octave, midi };
}

export function midiToNoteString(midi: number): string {
  if (!Number.isInteger(midi) || midi < 0 || midi > 127)
    throw new Error(`midiToNoteString: midi ${midi} out of range`);
  const pc = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1;
  return `${PITCH_CLASS_TO_NAME[pc]!}${octave}`;
}

export function transposeMidi(midi: number, semitones: number): number {
  const out = midi + semitones;
  if (out < 0 || out > 127)
    throw new Error(`transposeMidi: result ${out} out of range`);
  return out;
}

export function pitchClassDistance(from: number, to: number): number {
  return (((to - from) % 12) + 12) % 12;
}
