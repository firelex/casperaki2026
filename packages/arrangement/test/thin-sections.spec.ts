import { describe, expect, it } from 'vitest';

import { createRng } from '@casperaki/music-theory';

import { addThinPartners, fillScore, measureSection, partnerLane, THIN_RULES } from '../src/arrangement-polish/thin-sections.js';
import type { ValidatedCatalogEntry } from '../src/catalog/validated-catalog.js';
import type { GeneratorContext } from '../src/context.js';
import type { PatternResult } from '../src/patterns/types.js';
import type { InstrumentFamily, SelectionResult } from '../src/selection/types.js';
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

// ---- the partner loop, with a stand-in pattern writer ----------------------------------------------------------

const ctx = { rng: createRng('thin-unit'), params: { genre: 'brightPop', key: 'C', bpm: 120, seed: 'thin-unit' } } as GeneratorContext;
const entry = (id: string, family: InstrumentFamily) => ({ id, family, lowLevel: `${family}Test`, mainStyle: 'brightPop', addStyles: [] }) as unknown as ValidatedCatalogEntry;
const inst = (laneName: string, family: InstrumentFamily, id: string) =>
  ({ lane: laneName, family, lowLevel: `${family}Test`, entry: entry(id, family), essential: false, perSegment: false, pickSource: 'genre' }) as SelectionResult['instruments'][number];
const sel = (instruments: SelectionResult['instruments'], active: Record<string, string[]>): SelectionResult => ({
  instruments,
  segments: Object.entries(active).map(([segmentName, activeLanes]) => ({ segmentName, activeLanes, loopActive: false })),
});
/** Writes each active lane from a table: base patterns by lane name; a partner lane plays chords whatever its fork. */
const writer =
  (table: Record<string, FamilyPattern>, calls: string[] = []) =>
  (s: SelectionResult, forks: ReadonlyMap<string, string>): PatternResult => {
    calls.push([...forks.entries()].map(([l, f]) => `${l}=${f}`).join(','));
    return {
      segments: s.segments.map((seg) => ({
        segmentName: seg.segmentName,
        lanes: Object.fromEntries(seg.activeLanes.map((l) => [l, table[l] ?? lane([0], 4, chord('Am'))])),
      })),
    };
  };
const pool = (ids: Record<string, string[]>) => (family: InstrumentFamily) => (ids[family] ?? []).map((id) => entry(id, family));

describe('addThinPartners', () => {
  const thinTable = { Pad: lane([0], 4, padNote(69)), Keys: lane(EIGHTHS, 4, chord('C')) };

  it('a section that is not thin anywhere: nothing added, the patterns as written', () => {
    const s = sel([inst('Keys', 'keys', 'k1')], { verse1: ['Keys'] });
    const write = writer(thinTable);
    const r = addThinPartners({ ctx, selection: s, write, soundPool: pool({ keys: ['k1', 'k2'] }), reservedNames: new Set() });
    expect(r.added).toEqual([]);
    expect(r.patterns).toEqual(write(s, new Map()));
    expect(r.selection).toEqual(s);
  });

  it('a one-note pad gets a Pad 2 with an unused sound, in every section of that type and nowhere else', () => {
    const s = sel([inst('Pad', 'pad', 'p1')], { verse1: ['Pad'], chorus1: ['Pad'], verse2: ['Pad'] });
    const r = addThinPartners({ ctx, selection: s, write: writer(thinTable), soundPool: pool({ pad: ['p1', 'p2'] }), reservedNames: new Set() });
    expect(r.added).toHaveLength(1);
    expect(r.added[0]).toMatchObject({ lane: 'Pad 2', family: 'pad', soundId: 'p2', sectionType: 'verse', kind: 'harmony' });
    expect(r.selection.segments.map((x) => x.activeLanes.includes('Pad 2'))).toEqual([true, false, true]);
    expect(r.laneForks.get('Pad 2')).toMatch(/^thin\/Pad 2#[1-4]$/u);
  });

  it('never takes a name a recorded track edit uses', () => {
    const s = sel([inst('Pad', 'pad', 'p1')], { verse1: ['Pad'] });
    const r = addThinPartners({ ctx, selection: s, write: writer(thinTable), soundPool: pool({ pad: ['p1', 'p2'] }), reservedNames: new Set(['Pad 2']) });
    expect(r.added[0]!.lane).toBe('Pad 3');
  });

  it('no unused sound for the family: nothing added, no error', () => {
    const s = sel([inst('Pad', 'pad', 'p1')], { verse1: ['Pad'] });
    const r = addThinPartners({ ctx, selection: s, write: writer(thinTable), soundPool: pool({ pad: ['p1'] }), reservedNames: new Set() });
    expect(r.added).toEqual([]);
  });

  it('a sound tagged with the song\'s genre is preferred; without one, an untagged sound is a tracked fallback pick', () => {
    const s = sel([inst('Pad', 'pad', 'p1')], { verse1: ['Pad'] });
    const rock = (id: string, family: InstrumentFamily) => ({ ...entry(id, family), mainStyle: 'rock', addStyles: [] }) as ValidatedCatalogEntry;
    const mixed = addThinPartners({ ctx, selection: s, write: writer(thinTable), soundPool: (f) => [entry('p1', f), rock('p2', f), entry('p3', f)], reservedNames: new Set() });
    expect(mixed.added[0]!.soundId).toBe('p3');
    expect(mixed.selection.instruments.at(-1)!.pickSource).toBe('genre');
    const untagged = addThinPartners({ ctx, selection: s, write: writer(thinTable), soundPool: (f) => [entry('p1', f), rock('p2', f)], reservedNames: new Set() });
    expect(untagged.added[0]!.soundId).toBe('p2');
    expect(untagged.selection.instruments.at(-1)!.pickSource).toBe('fallback');
  });

  it('a partner that does not help is not kept', () => {
    const s = sel([inst('Pad', 'pad', 'p1')], { verse1: ['Pad'] });
    // Every pattern option of the partner is the same one note: nothing gained.
    const write = writer({ Pad: lane([0], 4, padNote(69)), 'Pad 2': lane([0], 4, padNote(69)) });
    const r = addThinPartners({ ctx, selection: s, write, soundPool: pool({ pad: ['p1', 'p2'] }), reservedNames: new Set() });
    expect(r.added).toEqual([]);
    expect(r.selection).toEqual(s);
  });

  it('tries THIN_RULES.variants pattern options for a partner', () => {
    const s = sel([inst('Pad', 'pad', 'p1')], { verse1: ['Pad'] });
    const calls: string[] = [];
    addThinPartners({ ctx, selection: s, write: writer(thinTable, calls), soundPool: pool({ pad: ['p1', 'p2'] }), reservedNames: new Set() });
    for (let k = 1; k <= THIN_RULES.variants; k++) expect(calls).toContain(`Pad 2=thin/Pad 2#${k}`);
  });

  it('adds at most THIN_RULES.maxAddedTracks tracks', () => {
    // Three section types, each harmony-thin; every partner helps.
    const s = sel([inst('Pad', 'pad', 'p1')], { verse1: ['Pad'], preChorus1: ['Pad'], bridge1: ['Pad'] });
    const r = addThinPartners({ ctx, selection: s, write: writer(thinTable), soundPool: pool({ pad: ['p1', 'p2', 'p3', 'p4'] }), reservedNames: new Set() });
    expect(r.added).toHaveLength(THIN_RULES.maxAddedTracks);
  });

  it('intros, outros and breaks are sparse on purpose: never paired', () => {
    const s = sel([inst('Pad', 'pad', 'p1')], { intro: ['Pad'], break1: ['Pad'], outro: ['Pad'] });
    const r = addThinPartners({ ctx, selection: s, write: writer(thinTable), soundPool: pool({ pad: ['p1', 'p2'] }), reservedNames: new Set() });
    expect(r.added).toEqual([]);
  });

  it('is deterministic', () => {
    const s = sel([inst('Pad', 'pad', 'p1')], { verse1: ['Pad'] });
    const run = () => addThinPartners({ ctx, selection: s, write: writer(thinTable), soundPool: pool({ pad: ['p1', 'p2', 'p3', 'p4'] }), reservedNames: new Set() });
    expect(run()).toEqual(run());
  });
});
