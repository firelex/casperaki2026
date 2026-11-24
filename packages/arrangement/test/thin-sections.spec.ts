import { describe, expect, it } from 'vitest';

import { fillScore, measureSection, partnerLane, THIN_RULES } from '../src/arrangement-polish/thin-sections.js';
import type { FamilyPattern } from '../src/patterns/types.js';

type Ev = Record<string, unknown>;
type Make = (beat: number, dur: number) => Ev;
const note = (pitch: number): Make => (_b, d) => ({ type: 'note', note: pitch, duration: d });
const padNote = (pitch: number): Make => () => ({ type: 'note', note: pitch, duration: 4 });
const chord = (symbol: string): Make => () => ({ type: 'chord', chord: symbol, duration: 4 });

/** One bar from onsets (beats within the bar): each a note lasting until the next onset (or the bar end). */
function bar(onsets: number[], make: Make = note(60)) {
  const notes: Record<string, Ev[]> = {};
  onsets.forEach((b, i) => {
    notes[b.toFixed(2).replace(/0$/u, '')] = [make(b, (onsets[i + 1] ?? 4) - b)];
  });
  return { notes };
}
const lane = (onsets: number[], bars = 4, make?: Make) =>
  ({ bars: Array.from({ length: bars }, () => bar(onsets, make)) }) as unknown as FamilyPattern;

const SIXTEENTHS = Array.from({ length: 16 }, (_, i) => i / 4);
const EIGHTHS = Array.from({ length: 8 }, (_, i) => i / 2);

describe('measureSection', () => {
  it('a one-note pad under a one-note lead is harmony-thin', () => {
    const m = measureSection({ Pad: lane([0], 4, padNote(69)), Synths: lane(EIGHTHS, 4, note(72)) });
    expect(m.harmony).toBe(true);
    expect(m.medianVoices).toBe(2);
  });

  it('a pad playing chords is not harmony-thin', () => {
    expect(measureSection({ Pad: lane([0], 4, chord('Am')) }).harmony).toBe(false);
  });

  it('a two-bar lead whose second bar has two notes is rhythm-thin; the lead is the rhythm partner, the pad the harmony one', () => {
    const synths = { bars: [bar(EIGHTHS), bar([0, 3.5]), bar(EIGHTHS), bar([0, 3.5])] } as unknown as FamilyPattern;
    const lanes = { Pad: lane([0], 4, padNote(69)), Synths: synths };
    expect(measureSection(lanes)).toMatchObject({ rhythm: true, gapBars: 2 });
    expect(partnerLane(lanes, 'rhythm')).toBe('Synths');
    expect(partnerLane(lanes, 'harmony')).toBe('Pad');
  });

  it('strums without a duration ring to the next strum, so a strummed section is not thin', () => {
    const strum: Make = () => ({ type: 'strum', chord: 'C', durations: [1], offset: [0], strings: [3], velocities: [70] });
    expect(measureSection({ Guitar: lane(EIGHTHS, 4, strum) })).toMatchObject({ harmony: false, rhythm: false });
  });

  it('fret noise is an onset without a pitch', () => {
    const fret: Make = () => ({ type: 'fretNoise', duration: 0.25 });
    const m = measureSection({ Pad: lane([0], 4, chord('C')), Guitar: lane([1, 2, 3], 4, fret) });
    expect(m).toMatchObject({ rhythm: false, medianVoices: 3 });
  });

  it('drums, bass, vocals and the loop are not measured', () => {
    const m = measureSection({ Drums: lane(SIXTEENTHS), Bass: lane(SIXTEENTHS), Vocal: lane(SIXTEENTHS), Loop: lane(SIXTEENTHS) });
    expect(m).toMatchObject({ harmony: true, rhythm: true });
  });
});

describe('partnerLane', () => {
  it('only sustained parts: no rhythm partner', () => {
    expect(partnerLane({ Pad: lane([0], 4, chord('C')) }, 'rhythm')).toBeUndefined();
  });

  it('without a pad, the harmony partner is the part sounding longest', () => {
    const lanes = { Keys: lane([0, 2], 4, note(60)), Synths: lane([0, 3.5], 4, (_b) => ({ type: 'note', note: 72, duration: 0.5 })) };
    expect(partnerLane(lanes, 'harmony')).toBe('Keys');
  });
});

describe('fillScore', () => {
  it('ranks clearing a thin kind above anything else', () => {
    const thin = { harmony: true, rhythm: true, medianVoices: 2, gapBars: 2 };
    expect(fillScore(thin, { ...thin, harmony: false, medianVoices: 4 })).toEqual([1, 0, 2]);
  });
});

it('the thresholds live in one place', () => {
  expect(THIN_RULES).toMatchObject({ minVoices: 3, gapBeats: 2, maxGapBarShare: 0.25, variants: 4, maxAddedTracks: 2 });
});
