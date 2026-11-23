// Chord vocabulary for chord-fit: a chord is a root relative to the key's tonic (0..11 semitones) plus a quality.
// Pure module (no I/O) so the brain can import it.

export type Quality =
  | 'maj' | 'min' | 'dim' | 'aug' | 'sus4' | 'sus2' | 'pow5'
  | 'dom7' | 'maj7' | 'min7' | 'm7b5' | 'dim7' | 'add6'
  | 'dom9' | 'maj9' | 'min9' | 'dom11';

export const QUALITY_INTERVALS: Readonly<Record<Quality, readonly number[]>> = {
  maj: [0, 4, 7], min: [0, 3, 7], dim: [0, 3, 6], aug: [0, 4, 8], sus4: [0, 5, 7], sus2: [0, 2, 7], pow5: [0, 7],
  dom7: [0, 4, 7, 10], maj7: [0, 4, 7, 11], min7: [0, 3, 7, 10], m7b5: [0, 3, 6, 10], dim7: [0, 3, 6, 9],
  add6: [0, 4, 7, 9], dom9: [0, 4, 7, 10, 14], maj9: [0, 4, 7, 11, 14], min9: [0, 3, 7, 10, 14],
  dom11: [0, 4, 7, 10, 14, 17],
};

// Chord-symbol suffixes that occur in the precedents and the chord bank. Anything else throws.
const SUFFIX_TO_QUALITY: Readonly<Record<string, Quality>> = {
  '': 'maj', m: 'min', min: 'min', dim: 'dim', aug: 'aug', sus: 'sus4', sus4: 'sus4', sus2: 'sus2', '5': 'pow5',
  '7': 'dom7', maj7: 'maj7', m7: 'min7', m7b5: 'm7b5', dim7: 'dim7', '6': 'add6',
  '9': 'dom9', maj9: 'maj9', m9: 'min9', '11': 'dom11',
};
const QUALITY_TO_SUFFIX: Readonly<Record<Quality, string>> = {
  maj: '', min: 'm', dim: 'dim', aug: 'aug', sus4: 'sus4', sus2: 'sus2', pow5: '5', dom7: '7', maj7: 'maj7',
  min7: 'm7', m7b5: 'm7b5', dim7: 'dim7', add6: '6', dom9: '9', maj9: 'maj9', min9: 'm9', dom11: '11',
};

const LETTER_PC: Readonly<Record<string, number>> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
export const PC_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'] as const;

export interface Chord {
  /** Root in semitones above the key's tonic, 0..11. */
  readonly deg: number;
  readonly q: Quality;
}

export const chordId = (c: Chord): string => `${c.deg}:${c.q}`;
export function chordFromId(id: string): Chord {
  const [d, q] = id.split(':');
  if (d === undefined || q === undefined || !(q in QUALITY_INTERVALS)) throw new Error(`bad chord id "${id}"`);
  return { deg: Number(d), q: q as Quality };
}

export function parsePc(name: string): number {
  const m = /^([A-G])([#b]?)$/u.exec(name);
  if (!m) throw new Error(`bad pitch-class name "${name}"`);
  const base = LETTER_PC[m[1]!]!;
  return (base + (m[2] === '#' ? 1 : m[2] === 'b' ? 11 : 0)) % 12;
}

/** Parse an absolute chord symbol ("Am7", "A#", "Csus") relative to a key tonic pitch class. */
export function parseChordSymbol(symbol: string, tonicPc: number): Chord {
  const m = /^([A-G])([#b]?)(.*)$/u.exec(symbol);
  if (!m) throw new Error(`unparseable chord symbol "${symbol}"`);
  const q = SUFFIX_TO_QUALITY[m[3]!];
  if (q === undefined) throw new Error(`unknown chord suffix "${m[3]}" in "${symbol}"`);
  const root = parsePc(`${m[1]}${m[2]}`);
  return { deg: (root - tonicPc + 12) % 12, q };
}

/** Pitch classes (absolute, 0..11) of a chord in the key with tonic `tonicPc`. */
export function chordPcs(c: Chord, tonicPc = 0): Set<number> {
  return new Set(QUALITY_INTERVALS[c.q].map((i) => (tonicPc + c.deg + i) % 12));
}

export function chordSymbol(c: Chord, tonicPc: number): string {
  return `${PC_NAMES[(tonicPc + c.deg) % 12]}${QUALITY_TO_SUFFIX[c.q]}`;
}

const DEG_NUMERAL: Readonly<Record<number, string>> = {
  0: 'I', 1: 'bII', 2: 'II', 3: 'bIII', 4: 'III', 5: 'IV', 6: '#IV', 7: 'V', 8: 'bVI', 9: 'VI', 10: 'bVII', 11: 'VII',
};
/** Roman numeral in the major key: lower case for minor-third chords. */
export function chordRoman(c: Chord): string {
  const n = DEG_NUMERAL[c.deg]!;
  const minorish = c.q === 'min' || c.q === 'min7' || c.q === 'min9' || c.q === 'dim' || c.q === 'm7b5' || c.q === 'dim7';
  const base = minorish ? n.toLowerCase() : n;
  const tail: Record<Quality, string> = {
    maj: '', min: '', dim: '°', aug: '+', sus4: 'sus4', sus2: 'sus2', pow5: '5', dom7: '7', maj7: 'maj7', min7: '7',
    m7b5: 'ø7', dim7: '°7', add6: '6', dom9: '9', maj9: 'maj9', min9: '9', dom11: '11',
  };
  return base + tail[c.q];
}

/** Diatonic triads and sevenths of the major key. */
export const DIATONIC: readonly Chord[] = [
  { deg: 0, q: 'maj' }, { deg: 2, q: 'min' }, { deg: 4, q: 'min' }, { deg: 5, q: 'maj' },
  { deg: 7, q: 'maj' }, { deg: 9, q: 'min' }, { deg: 11, q: 'dim' },
  { deg: 0, q: 'maj7' }, { deg: 2, q: 'min7' }, { deg: 4, q: 'min7' }, { deg: 5, q: 'maj7' },
  { deg: 7, q: 'dom7' }, { deg: 9, q: 'min7' }, { deg: 11, q: 'm7b5' },
];

export const sharedNotes = (a: Chord, b: Chord): number => {
  const pb = chordPcs(b);
  let n = 0;
  for (const p of chordPcs(a)) if (pb.has(p)) n++;
  return n;
};
