// Step 6 — pattern generator tests (docs/58i lane model).

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { beatsPerBar, createRng, parseChord, parseBarBeat } from '@casperaki/music-theory';
import { ChordSymbolSchema, NoteRefSchema, stableStringify } from '@casperaki/song-schema';

import {
  describeDrumBank,
  generateChords,
  generatePatterns,
  generateSongStructure,
  PatternResultSchema,
  selectInstruments,
  type FamilyPattern,
  type GenerateParams,
  type GeneratorContext,
  type PatternResult,
} from '../src/index.js';
import { patternsGoldenPath } from './fixtures.js';

function makeCtx(seed: string | number, key = 'C', genre = 'brightPop'): GeneratorContext {
  const params: GenerateParams = { genre, key, bpm: 120, seed };
  return { rng: createRng(seed), params };
}

function pipeline(seed: string | number, key = 'C', genre = 'brightPop'): {
  result: PatternResult;
  selection: ReturnType<typeof selectInstruments>;
  structure: ReturnType<typeof generateSongStructure>;
} {
  const ctx = makeCtx(seed, key, genre);
  const structure = generateChords(ctx, generateSongStructure(ctx));
  const selection = selectInstruments(ctx, structure);
  const result = generatePatterns(ctx, structure, selection);
  return { result, selection, structure };
}

/** Scan seeds until the roster contains a lane of the given base family name
 *  (the roster is now probabilistic — docs/58i — so a specific lane is not
 *  guaranteed on any single seed). */
function pipelineWithLane(base: string, genre = 'brightPop'): ReturnType<typeof pipeline> {
  for (let i = 0; i < 300; i++) {
    const p = pipeline(`scan-${base}-${i}`, 'C', genre);
    if (p.selection.instruments.some((s) => laneMatchesBase(s.lane, base))) return p;
  }
  throw new Error(`pipelineWithLane: no seed produced a "${base}" lane for genre "${genre}"`);
}

function laneMatchesBase(lane: string, base: string): boolean {
  return lane === base || lane.startsWith(`${base} `);
}

/** All FamilyPatterns in a segment whose lane belongs to `base` (exact or the
 *  ` 2`/` 3` suffixed duplicates). */
function lanesFor(
  segment: PatternResult['segments'][number],
  base: string,
): FamilyPattern[] {
  return Object.entries(segment.lanes)
    .filter(([name]) => laneMatchesBase(name, base))
    .map(([, pat]) => pat);
}

function forEachBar(
  result: PatternResult,
  cb: (bar: FamilyPattern['bars'][number], segmentName: string) => void,
): void {
  for (const segment of result.segments) {
    for (const fam of Object.values(segment.lanes)) {
      for (const bar of fam.bars) cb(bar, segment.segmentName);
    }
  }
}

describe('generatePatterns (brightPop)', () => {
  it('validates against PatternResultSchema', () => {
    const { result } = pipeline('schema-check');
    const parsed = PatternResultSchema.safeParse(result);
    if (!parsed.success) console.error(parsed.error.issues);
    expect(parsed.success).toBe(true);
  });

  it('emits one SegmentPatterns per structure segment', () => {
    const { result } = pipeline('shape-check');
    const ctx = makeCtx('shape-check');
    const structure = generateChords(ctx, generateSongStructure(ctx));
    expect(result.segments.map((s) => s.segmentName)).toEqual(
      structure.map((s) => s.name),
    );
  });

  it('the lane key set per segment equals the selection activeLanes (active lanes present, inactive absent)', () => {
    const { result, selection } = pipeline('absence-check');
    for (let i = 0; i < result.segments.length; i++) {
      const segment = result.segments[i]!;
      const active = [...selection.segments[i]!.activeLanes].sort();
      const emitted = Object.keys(segment.lanes).sort();
      // Every active roster lane generates a pattern; nothing else is present.
      expect(emitted).toEqual(active);
    }
  });

  it('every emitted lane in every segment emits at least one note', () => {
    const { result } = pipeline('non-empty-check');
    for (const segment of result.segments) {
      for (const fam of Object.values(segment.lanes)) {
        expect(fam.bars.length).toBeGreaterThan(0);
        const noteCount = fam.bars
          .flatMap((b) => Object.values(b.notes))
          .reduce((n, evs) => n + evs.length, 0);
        expect(noteCount).toBeGreaterThan(0);
      }
    }
  });

  it('lane bar counts match the structure segment bar counts', () => {
    const { result } = pipeline('bar-count-check');
    const ctx = makeCtx('bar-count-check');
    const structure = generateChords(ctx, generateSongStructure(ctx));
    const expected = new Map(structure.map((s) => [s.name, s.bars.length]));
    for (const segment of result.segments) {
      for (const fam of Object.values(segment.lanes)) {
        expect(fam.bars.length).toBe(expected.get(segment.segmentName));
      }
    }
  });

  it('no BarBeat key is >= beatsPerBar()', () => {
    const { result } = pipeline('beat-range-check');
    const beats = beatsPerBar();
    forEachBar(result, (bar) => {
      for (const key of Object.keys(bar.notes)) {
        const b = parseBarBeat(key);
        expect(b).toBeGreaterThanOrEqual(0);
        expect(b).toBeLessThan(beats);
      }
    });
  });

  it('bass notes are valid NoteRef values (MIDI integers in this slice)', () => {
    const { result } = pipeline('bass-noteref');
    for (const segment of result.segments) {
      for (const bass of lanesFor(segment, 'Bass')) {
        for (const bar of bass.bars) {
          for (const events of Object.values(bar.notes)) {
            for (const ev of events) {
              expect(ev.type).toBe('note');
              if (ev.type === 'note') {
                expect(NoteRefSchema.safeParse(ev.note).success).toBe(true);
              }
            }
          }
        }
      }
    }
  });

  it('bass notes lower to valid MIDI in the bass register (real generator family — to-do #2)', () => {
    // brightPop bass now routes through the real generators (style 'simple' ->
    // SimpleBass, chord-relative; or 'brightPop' -> LibraryBass, chord-
    // independent octave-centred MIDI), NOT the orphan SM bank. The chord-root
    // tie therefore only holds for the chord-relative styles, so here we pin
    // the cross-style invariant — every bass note is an integer MIDI in the
    // bass register. SimpleBass's exact chord-root behaviour is pinned
    // precisely by the ballad test in bass-generators.spec.ts.
    const { result } = pipeline('bass-roots');
    let inspected = 0;
    for (const segment of result.segments) {
      for (const bass of lanesFor(segment, 'Bass')) {
        for (const bar of bass.bars) {
          for (const events of Object.values(bar.notes)) {
            for (const ev of events) {
              expect(ev.type).toBe('note');
              if (ev.type !== 'note') continue;
              expect(typeof ev.note).toBe('number');
              const note = ev.note as number;
              expect(Number.isInteger(note)).toBe(true);
              expect(note).toBeGreaterThanOrEqual(0);
              // Bass stays below middle C (60); octave-centring lands the
              // Library banks around MIDI ~24 and SimpleBass at octave 2.
              expect(note).toBeLessThanOrEqual(60);
              inspected++;
            }
          }
        }
      }
    }
    expect(inspected).toBeGreaterThan(0);
  });

  it('keys chord events carry parseable ChordSymbols (chordsStraight/edmHousePiano path — edm genre)', () => {
    // edm routes Keys through edmHousePiano (chord events). Keys is
    // probabilistic on edm, so we tolerate absence and only pin SHAPE.
    const { result } = pipeline('keys-chord-symbols', 'C', 'edm');
    for (const segment of result.segments) {
      for (const keys of lanesFor(segment, 'Keys')) {
        for (const bar of keys.bars) {
          for (const events of Object.values(bar.notes)) {
            for (const ev of events) {
              expect(ev.type).toBe('chord');
              if (ev.type === 'chord') {
                expect(ChordSymbolSchema.safeParse(ev.chord).success).toBe(true);
                expect(parseChord(ev.chord).quality).not.toBe('unknown');
              }
            }
          }
        }
      }
    }
  });

  it('keys noteRelative events carry parseable ChordSymbols + finite distanceFromMiddleC (library path)', () => {
    const { result } = pipelineWithLane('Keys');
    let inspected = 0;
    for (const segment of result.segments) {
      for (const keys of lanesFor(segment, 'Keys')) {
        for (const bar of keys.bars) {
          for (const events of Object.values(bar.notes)) {
            for (const ev of events) {
              expect(ev.type).toBe('noteRelative');
              if (ev.type === 'noteRelative') {
                expect(ChordSymbolSchema.safeParse(ev.chord).success).toBe(true);
                expect(parseChord(ev.chord).quality).not.toBe('unknown');
                expect(Number.isFinite(ev.distanceFromMiddleC)).toBe(true);
                expect(typeof ev.duration === 'number' && ev.duration > 0).toBe(true);
                inspected++;
              }
            }
          }
        }
      }
    }
    expect(inspected).toBeGreaterThan(0);
  });

  it("keys noteRelative events match the segment bar's chord at floor(beat) (library path)", () => {
    const { result, structure } = pipelineWithLane('Keys');
    const byName = new Map(structure.map((s) => [s.name, s]));
    let inspected = 0;
    for (const segment of result.segments) {
      const struct = byName.get(segment.segmentName)!;
      for (const keys of lanesFor(segment, 'Keys')) {
        keys.bars.forEach((bar, barIdx) => {
          for (const [key, events] of Object.entries(bar.notes)) {
            const beat = parseBarBeat(key);
            const chordIdx = Math.floor(beat);
            const expected =
              struct.bars[barIdx]!.chords[chordIdx] ?? struct.bars[barIdx]!.chords[0]!;
            for (const ev of events) {
              if (ev.type !== 'noteRelative') continue;
              expect(ev.chord).toBe(expected);
              inspected++;
            }
          }
        });
      }
    }
    expect(inspected).toBeGreaterThan(0);
  });

  it('pad events fire on beat 0 of every pad bar with full-bar duration (post-53x bank wiring)', () => {
    const { result } = pipeline('pad-shape');
    let inspected = 0;
    for (const segment of result.segments) {
      for (const pad of lanesFor(segment, 'Pad')) {
        for (const bar of pad.bars) {
          expect(Object.keys(bar.notes)).toEqual(['0.0']);
          const events = bar.notes['0.0']!;
          expect(events.length).toBe(1);
          const ev = events[0]!;
          if (ev.type === 'chord' || ev.type === 'note') {
            expect(ev.duration).toBe(4);
          }
          inspected++;
        }
      }
    }
    expect(inspected).toBeGreaterThan(0);
  });

  it('drum events all carry valid MIDI numbers drawn from the bank lane manifest', () => {
    const { result } = pipeline('drums-grid');
    const validMidi = new Set(Object.values(describeDrumBank().lanes));
    let drumEventCount = 0;
    for (const segment of result.segments) {
      for (const drums of lanesFor(segment, 'Drums')) {
        for (const bar of drums.bars) {
          for (const events of Object.values(bar.notes)) {
            for (const ev of events) {
              expect(ev.type).toBe('note');
              if (ev.type !== 'note') continue;
              expect(typeof ev.note).toBe('number');
              expect(NoteRefSchema.safeParse(ev.note).success).toBe(true);
              expect(validMidi.has(ev.note as number)).toBe(true);
              drumEventCount++;
            }
          }
        }
      }
    }
    expect(drumEventCount).toBeGreaterThan(0);
  });

  it('drum bars are populated when the chosen blueprint covers them (every blueprint hits every loop bar)', () => {
    const { result } = pipeline('drums-density');
    for (const segment of result.segments) {
      for (const drums of lanesFor(segment, 'Drums')) {
        for (let i = 0; i < drums.bars.length; i++) {
          const noteKeys = Object.keys(drums.bars[i]!.notes);
          expect(
            noteKeys.length,
            `segment ${segment.segmentName} bar ${i} has no drum events — legacy blueprints always hit every looped bar`,
          ).toBeGreaterThan(0);
        }
      }
    }
  });

  it('essentials (Drums/Bass/Pad) are active in every segment (legacy non-chorus mandatory set)', () => {
    // docs/58i — `ArrangementsClass.js:611-619` keeps Drums + Bass + a pad on
    // every non-chorus segment, and chorus uses the whole roster. So the three
    // essential lanes render in EVERY segment (a reversal of the old
    // fixed-activity "intro/verse drop" tables).
    const { result } = pipeline('essentials-everywhere');
    for (const segment of result.segments) {
      expect(lanesFor(segment, 'Drums').length, `${segment.segmentName} Drums`).toBeGreaterThan(0);
      expect(lanesFor(segment, 'Bass').length, `${segment.segmentName} Bass`).toBeGreaterThan(0);
      expect(lanesFor(segment, 'Pad').length, `${segment.segmentName} Pad`).toBeGreaterThan(0);
    }
  });

  it('chorus segments render the full base roll (fullest mix sans per-segment add-ons)', () => {
    const { result, selection } = pipeline('chorus-fullness');
    // docs/58i — chorus = base roll; per-segment "add one" lanes are excluded.
    const baseLanes = new Set(
      selection.instruments.filter((s) => !s.perSegment).map((s) => s.lane),
    );
    for (const segment of result.segments) {
      if (!segment.segmentName.startsWith('chorus')) continue;
      expect(new Set(Object.keys(segment.lanes))).toEqual(baseLanes);
    }
  });

  it('is reproducible: same seed twice → byte-identical canonical JSON', () => {
    const a = stableStringify(pipeline('repro').result, 2);
    const b = stableStringify(pipeline('repro').result, 2);
    expect(a).toBe(b);
  });

  it('different seeds → different patterns (post-step-4 structure variation cascades)', () => {
    const a = stableStringify(pipeline('seed-one').result, 2);
    const b = stableStringify(pipeline('seed-two').result, 2);
    expect(a).not.toBe(b);
  });

  it('does not mutate the input structure', () => {
    const ctx = makeCtx('immutability');
    const structure = generateChords(ctx, generateSongStructure(ctx));
    const before = stableStringify(structure, 2);
    const selection = selectInstruments(ctx, structure);
    generatePatterns(ctx, structure, selection);
    expect(stableStringify(structure, 2)).toBe(before);
  });

  it('matches committed golden fixture (brightPop / brightPop-vertical-slice)', async () => {
    const seed = 'brightPop-vertical-slice';
    const generated = `${stableStringify(pipeline(seed).result, 2)}\n`;
    const golden = await readFile(patternsGoldenPath('brightPop', seed), 'utf8');
    expect(generated).toBe(golden);
  });
});

describe('named lane pattern streams (laneForks)', () => {
  const ctx = makeCtx('lane-forks');
  const structure = generateChords(ctx, generateSongStructure(ctx));
  const selection = selectInstruments(ctx, structure);
  // A lead synth with a free style choice (leadSynthsAnalog is forced to one style; guitar banks are small enough
  // for two streams to draw the same pattern).
  const lead = selection.instruments.find((i) => i.family === 'synths' && i.lowLevel !== 'leadSynthsAnalog');
  if (!lead) throw new Error('seed lane-forks no longer has a free-style lead synth: pick another seed');
  const lane = lead.lane;
  const laneIn = (r: PatternResult) => r.segments.map((s) => s.lanes[lane]);
  const others = (r: PatternResult) => r.segments.map((s) => Object.fromEntries(Object.entries(s.lanes).filter(([l]) => l !== lane)));
  const base = generatePatterns(ctx, structure, selection);

  it('no named streams: the same patterns as before', () => {
    expect(generatePatterns(ctx, structure, selection, new Map(), new Map())).toEqual(base);
  });

  it('a named stream changes only that lane', () => {
    const named = generatePatterns(ctx, structure, selection, new Map(), new Map([[lane, `thin/${lane}#2`]]));
    expect(laneIn(named)).not.toEqual(laneIn(base));
    expect(others(named)).toEqual(others(base));
  });

  it('a new pattern (variant) of a named lane forks from its name, so it never repeats another option', () => {
    const forks = (k: number) => new Map([[lane, `thin/${lane}#${k}`]]);
    const chosen = generatePatterns(ctx, structure, selection, new Map(), forks(2));
    const renewed = generatePatterns(ctx, structure, selection, new Map([[lane, 1]]), forks(2));
    const option1 = generatePatterns(ctx, structure, selection, new Map(), forks(1));
    expect(laneIn(renewed)).not.toEqual(laneIn(chosen));
    expect(laneIn(renewed)).not.toEqual(laneIn(option1));
    expect(laneIn(renewed)).not.toEqual(laneIn(base));
  });
});
