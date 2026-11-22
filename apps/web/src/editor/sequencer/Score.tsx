import { useEffect, useRef } from 'react';
import abcjs from 'abcjs';

import { notesToAbc, type ScoreNote } from './notation';

/**
 * Read-only score of a passage (engine-resolved notes) on a grand staff,
 * engraved by abcjs from the ABC that notation.ts writes. Four bars a line.
 */
export function Score({ notes, beats, songKey, bpm }: { notes: readonly ScoreNote[]; beats: number; songKey: string; bpm: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const abc = notesToAbc(notes, { beats, key: songKey, bpm });
    abcjs.renderAbc(el, abc, {
      responsive: 'resize',
      staffwidth: Math.max(480, el.clientWidth - 48),
      wrap: { minSpacing: 1.6, maxSpacing: 2.6, preferredMeasuresPerLine: 4 },
      // A short last line spans the width like the others.
      format: { stretchlast: 1 },
      paddingtop: 12,
      paddingbottom: 12,
      paddingleft: 12,
      paddingright: 12,
      foregroundColor: '#15161a',
      add_classes: true,
    });
  }, [notes, beats, songKey, bpm]);
  return (
    <div className="p-4">
      <div ref={ref} className="rounded-[6px] bg-[#fbfbfa] shadow-[0_2px_10px_rgba(0,0,0,0.4)]" aria-label="Score" />
      <p className="mt-2 text-[11px] text-white/45">
        The notes the engine plays, rounded to 16ths; parts spanning middle C go on a grand staff.
      </p>
    </div>
  );
}
