import type { ChordTonePattern } from '../api/patterns';
import { RollGrid } from './RollGrid';

const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const noteName = (semitonesFromMiddleC: number) => {
  const midi = 60 + semitonesFromMiddleC;
  return `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
};

/** The pitch a written note plays over C major (semitones from middle C):
 *  the nearest of C, E, G, a tie going down (the engine's rule). */
const overC = (semitones: number) => {
  for (let d = 0; d <= 6; d++) {
    if ([0, 4, 7].includes((((semitones - d) % 12) + 12) % 12)) return semitones - d;
    if ([0, 4, 7].includes((((semitones + d) % 12) + 12) % 12)) return semitones + d;
  }
  throw new Error(`overC: no C major tone near ${semitones}`);
};

/**
 * A chord-tone pattern as it sounds over a C major chord: one row per pitch
 * (highest at the top). Over other chords each note moves to the nearest
 * chord tone, so the shape stays and the notes follow the harmony.
 */
export function ChordToneGrid({ pattern }: { pattern: ChordTonePattern }) {
  const beats = pattern.bars * 4;
  const pitches = [...new Set(pattern.notes.map(([, p]) => overC(p)))].sort((a, b) => b - a);
  return (
    <RollGrid
      beats={beats}
      rows={pitches.map((p) => ({
        key: p,
        label: noteName(p),
        notes: pattern.notes
          .filter(([, q]) => overC(q) === p)
          .map(([pos, , len]) => ({ pos, len, title: `${noteName(p)} at beat ${pos + 1}, ${len} beats` })),
      }))}
    />
  );
}
