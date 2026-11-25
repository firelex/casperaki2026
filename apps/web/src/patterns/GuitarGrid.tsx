import type { GuitarPickPattern, GuitarStrumPattern, StrumStroke } from '../api/patterns';
import { RollGrid } from './RollGrid';

const STRING_LABELS = ['String 1 (bass)', 'String 2', 'String 3', 'String 4', 'String 5', 'String 6'];
const STROKE_LABELS: Record<StrumStroke, string> = {
  down: 'Strum down',
  up: 'Strum up',
  longDown: 'Ringing strum down',
  longUp: 'Ringing strum up',
};

/**
 * A guitar pattern: one row per string of the chord shape (top string at the
 * top), each pick or strum shown on the strings it plays; effects on a row above.
 */
export function GuitarGrid({ pattern }: { pattern: GuitarPickPattern | GuitarStrumPattern }) {
  const beats = pattern.bars * 4;
  const hits = 'hits' in pattern ? pattern.hits : (pattern.picks ?? []);
  const used = [...new Set(hits.flatMap(([, strings]) => strings))].sort((a, b) => b - a);
  const strums = 'strums' in pattern ? pattern.strums : [];
  const strokes = (Object.keys(STROKE_LABELS) as StrumStroke[]).filter((k) => strums.some(([, s]) => s === k));
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
        ...strokes.map((k) => ({
          key: `strum-${k}`,
          label: STROKE_LABELS[k],
          notes: strums.filter(([, s]) => s === k).map(([pos, , len]) => ({ pos, len, title: `${STROKE_LABELS[k]} at beat ${pos + 1}, ${len} beats` })),
        })),
        ...used.map((s) => ({
        key: s,
        label: STRING_LABELS[s]!,
        notes: hits
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
