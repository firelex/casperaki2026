import { describe, expect, it } from 'vitest';

import { CLASH_RULES, resolveArrangementClashes } from '../src/arrangement-polish/clashes.js';
import type { PatternResult } from '../src/patterns/types.js';

type Ev = Record<string, unknown>;
/** One bar from onsets (beats within the bar): each a note lasting until the next onset (or the bar end). */
function bar(onsets: number[], make: (beat: number, dur: number) => Ev = (b, d) => ({ type: 'note', note: 60, duration: d })) {
  const notes: Record<string, Ev[]> = {};
  onsets.forEach((b, i) => {
    notes[b.toFixed(2).replace(/0$/u, '')] = [make(b, (onsets[i + 1] ?? 4) - b)];
  });
  return { notes };
}
const lane = (onsets: number[], bars = 4, make?: (beat: number, dur: number) => Ev) => ({ bars: Array.from({ length: bars }, () => bar(onsets, make)) });
const song = (lanes: Record<string, ReturnType<typeof lane>>): PatternResult => ({ segments: [{ segmentName: 'chorus1', lanes }] }) as unknown as PatternResult;
const onsetsOf = (r: PatternResult, name: string, barIndex = 0) => Object.keys(r.segments[0]!.lanes[name]!.bars[barIndex]!.notes).map(Number).sort((a, b) => a - b);
const durationAt = (r: PatternResult, name: string, beat: number) =>
  (Object.entries(r.segments[0]!.lanes[name]!.bars[0]!.notes).find(([k]) => Number(k) === beat)![1][0] as { duration: number }).duration;

const SIXTEENTHS = Array.from({ length: 16 }, (_, i) => i / 4);
const EIGHTHS = Array.from({ length: 8 }, (_, i) => i / 2);

describe('resolveArrangementClashes', () => {
  it('competition: two busy parts in different registers — the lower-priority one calms down (bass keeps its run, strings go to the beat)', () => {
    const r = resolveArrangementClashes(song({ Bass: lane(SIXTEENTHS), PopStrings: lane(SIXTEENTHS) }));
    expect(onsetsOf(r, 'Bass')).toEqual(SIXTEENTHS);
    expect(onsetsOf(r, 'PopStrings')).toEqual([0, 1, 2, 3]);
    // Calmed notes are held to the next kept note.
    expect(durationAt(r, 'PopStrings', 1)).toBe(1);
  });

  it('clash: two dense parts in the same register mostly together — the lower-priority one is moulded around the other', () => {
    // Keys and strings, both dense (6-7 a bar), mostly on the same 16ths.
    const keys = [0, 0.5, 1, 2, 2.5, 3];
    const strings = [0, 0.5, 0.75, 1, 1.75, 2, 2.75];
    const r = resolveArrangementClashes(song({ Keys: lane(keys), PopStrings: lane(strings) }));
    expect(onsetsOf(r, 'Keys')).toEqual(keys);
    // Strings keep the downbeat and the notes in the keys' gaps; the coinciding ones are held over instead.
    expect(onsetsOf(r, 'PopStrings')).toEqual([0, 0.75, 1.75, 2.75]);
    expect(durationAt(r, 'PopStrings', 0)).toBe(0.75);
    // Every bar the same way (a repeating part stays repeating).
    for (let b = 1; b < 4; b++) expect(onsetsOf(r, 'PopStrings', b)).toEqual([0, 0.75, 1.75, 2.75]);
  });

  it('a clash that would leave the part with less than half its notes calms it instead', () => {
    const same = [0, 0.5, 1, 1.5, 2, 2.5, 3];
    const r = resolveArrangementClashes(song({ Keys: lane(same), PopStrings: lane(same) }));
    expect(onsetsOf(r, 'PopStrings')).toEqual([0, 1, 2, 3]);
  });

  it('leaves interplay alone: dense parts in one register whose notes fall in each other\'s gaps', () => {
    const on = [0, 1, 2, 3, 0.25, 1.25, 2.25].sort((a, b) => a - b);
    const off = [0.5, 1.5, 2.5, 3.5, 0.75, 1.75, 2.75].sort((a, b) => a - b);
    const r = resolveArrangementClashes(song({ Keys: lane(on), PopStrings: lane(off) }));
    expect(onsetsOf(r, 'Keys')).toEqual(on);
    expect(onsetsOf(r, 'PopStrings')).toEqual(off);
  });

  it('leaves doubling alone: two parts of the same family (Guitar + Guitar 2, Synths + Synths 2)', () => {
    const r = resolveArrangementClashes(song({ Synths: lane(EIGHTHS), 'Synths 2': lane(EIGHTHS) }));
    expect(onsetsOf(r, 'Synths 2')).toEqual(EIGHTHS);
  });

  it('leaves drums, vocals and sustained parts alone', () => {
    const pad = lane([0], 4, (_b, d) => ({ type: 'chord', chord: 'C', duration: d }));
    const r = resolveArrangementClashes(song({ Drums: lane(SIXTEENTHS), Bass: lane(SIXTEENTHS), Pad: pad, Vocal: lane(SIXTEENTHS) }));
    expect(onsetsOf(r, 'Drums')).toEqual(SIXTEENTHS);
    expect(onsetsOf(r, 'Vocal')).toEqual(SIXTEENTHS);
    expect(onsetsOf(r, 'Pad')).toEqual([0]);
  });

  it('a part whose notes are guitar patterns cannot be moulded: the other part yields', () => {
    const vg = (_b: number, d: number) => ({ type: 'virtualGuitarist', chord: 'C', duration: d });
    const r = resolveArrangementClashes(song({ Guitar: lane(SIXTEENTHS, 4, vg), Keys: lane(SIXTEENTHS) }));
    expect(onsetsOf(r, 'Guitar')).toEqual(SIXTEENTHS);
    expect(onsetsOf(r, 'Keys')).toEqual([0, 1, 2, 3]);
  });

  it('the thresholds live in one place', () => {
    expect(CLASH_RULES).toMatchObject({ busyPerBar: 8, densePerBar: 6, unison: 0.6, maxMouldRemoval: 0.5 });
  });
});
