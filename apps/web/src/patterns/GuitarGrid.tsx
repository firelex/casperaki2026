import type { GuitarPickPattern } from '../api/patterns';
import { RollGrid } from './RollGrid';

const STRING_LABELS = ['String 1 (bass)', 'String 2', 'String 3', 'String 4', 'String 5', 'String 6'];

/**
 * A guitar pattern: one row per string of the chord shape (top string at the
 * top), each pick or strum shown on the strings it plays; effects on a row above.
 */
export function GuitarGrid({ pattern }: { pattern: GuitarPickPattern }) {
  const beats = pattern.bars * 4;
  const used = [...new Set(pattern.hits.flatMap(([, strings]) => strings))].sort((a, b) => b - a);
  return (
    <RollGrid
      beats={beats}
      rows={[
        ...(pattern.fx?.length
          ? [
              {
                key: 'fx',
                label: 'Guitar effects',
                notes: pattern.fx.map(([pos, name]) => ({ pos, len: 0.5, title: `Effect ${name} at beat ${pos + 1}` })),
              },
            ]
          : []),
        ...used.map((s) => ({
        key: s,
        label: STRING_LABELS[s]!,
        notes: pattern.hits
          .filter(([, strings]) => strings.includes(s))
          .map(([pos, strings, len, vel]) => ({
            pos,
            len,
            title: `${strings.length > 1 ? (strings[0]! < strings[strings.length - 1]! ? 'Down strum' : 'Up strum') : 'Pick'} at beat ${pos + 1}, ${len} beats, velocity ${vel}`,
          })),
        })),
      ]}
    />
  );
}
