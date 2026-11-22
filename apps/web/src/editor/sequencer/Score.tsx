import { useEffect, useRef } from 'react';
import abcjs, { type NoteTimingEvent } from 'abcjs';

import { notesToAbc, type ScoreNote } from './notation';

const SVG_NS = 'http://www.w3.org/2000/svg';
const ON = 'cs-note-on';

/**
 * Read-only score of a passage (engine-resolved notes) on a grand staff,
 * engraved by abcjs from the ABC that notation.ts writes, four bars a line.
 * While the pattern plays, a cursor marks the current position and the
 * notes sounding there are highlighted (abcjs's own note timings, matched
 * to the pattern player's position).
 */
export function Score({
  notes,
  beats,
  songKey,
  bpm,
  beat,
  marks,
}: {
  notes: readonly ScoreNote[];
  beats: number;
  songKey: string;
  bpm: number;
  /** The player's position, in beats from the passage start (undefined when stopped). */
  beat: number | undefined;
  /** Labels above bars (section names), for whole-track scores. */
  marks?: ReadonlyMap<number, string>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const timings = useRef<NoteTimingEvent[]>([]);
  const cursor = useRef<SVGLineElement | null>(null);
  const lit = useRef<Element[]>([]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const abc = notesToAbc(notes, { beats, key: songKey, bpm, ...(marks ? { marks } : {}) });
    const [tune] = abcjs.renderAbc(el, abc, {
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
    if (!tune) throw new Error('abcjs engraved no tune');
    // Note timings at the song's tempo (a quarter note is one beat).
    timings.current = new abcjs.TimingCallbacks(tune, { qpm: bpm }).noteTimings.filter((e) => e.type === 'event');
    const svg = el.querySelector('svg');
    if (!svg) throw new Error('abcjs drew no SVG');
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('stroke', '#e0322b');
    line.setAttribute('stroke-width', '2');
    line.style.display = 'none';
    svg.appendChild(line);
    cursor.current = line;
    lit.current = [];
  }, [notes, beats, songKey, bpm, marks]);

  // Follow the player: cursor at the last note event at or before the position.
  useEffect(() => {
    const line = cursor.current;
    if (!line) return;
    for (const e of lit.current) e.classList.remove(ON);
    lit.current = [];
    if (beat === undefined) {
      line.style.display = 'none';
      return;
    }
    const ms = (beat * 60_000) / bpm;
    const evs = timings.current;
    let lo = 0;
    let hi = evs.length - 1;
    let at = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (evs[mid]!.milliseconds <= ms) {
        at = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    const ev = at >= 0 ? evs[at] : undefined;
    if (!ev || ev.left === undefined || ev.top === undefined || ev.height === undefined) {
      line.style.display = 'none';
      return;
    }
    line.setAttribute('x1', String(ev.left - 3));
    line.setAttribute('x2', String(ev.left - 3));
    line.setAttribute('y1', String(ev.top));
    line.setAttribute('y2', String(ev.top + ev.height));
    line.style.display = '';
    for (const group of ev.elements ?? []) for (const e of group) {
      e.classList.add(ON);
      lit.current.push(e);
    }
  }, [beat, bpm]);

  return (
    <div className="p-4">
      <div ref={ref} className="score-sheet rounded-[6px] bg-[#fbfbfa] shadow-[0_2px_10px_rgba(0,0,0,0.4)]" aria-label="Score" />
      <p className="mt-2 text-[11px] text-white/45">
        The notes the engine plays, rounded to 16ths; parts spanning middle C go on a grand staff.
      </p>
    </div>
  );
}
