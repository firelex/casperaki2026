import type { BassHit } from '../api/patterns';
import { RollGrid } from './RollGrid';

const INTERVAL_NAMES: Record<number, string> = {
  [-12]: 'Root −8va', [-7]: '4th below', [-5]: '5th below', 0: 'Root', 2: '2nd', 3: 'm3', 4: '3rd', 5: '4th', 7: '5th',
  9: '6th', 10: 'm7', 11: '7th', 12: 'Octave', 14: '9th', 17: '11th', 19: '5th +8va', 24: '2 octaves',
};

/**
 * A chord-relative bass pattern as a small piano roll: one row per interval
 * from the chord root (highest at the top), 16th-note columns, bar lines.
 */
export function BassGrid({ pattern }: { pattern: readonly BassHit[] }) {
  const end = Math.max(...pattern.map(([pos, len]) => pos + len));
  const beats = Math.max(8, Math.ceil(end / 4) * 4);
  const intervals = [...new Set(pattern.map(([, , semi]) => semi))].sort((a, b) => b - a);
  const name = (semi: number) => INTERVAL_NAMES[semi] ?? `${semi > 0 ? '+' : ''}${semi} st`;
  return (
    <RollGrid
      beats={beats}
      rows={intervals.map((semi) => ({
        key: semi,
        label: name(semi),
        notes: pattern
          .filter(([, , st]) => st === semi)
          .map(([pos, len]) => ({ pos, len, title: `${name(semi)} at beat ${pos + 1}, ${len} beats` })),
      }))}
    />
  );
}
