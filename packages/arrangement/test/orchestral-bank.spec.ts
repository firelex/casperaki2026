// to-do #3 — popStrings pattern-bank port tests.
//
// Pins the faithful port of the legacy String pattern generator
// (casperaki2-engine-js/.../stringPatterns/LibraryStringPatternGeneratorClass.js):
//   - the real stringPatterns.json bank (231 patterns: ballad 60, edm 60,
//     organicVibes 111), replacing the orphan 10-pattern StefanEDMStabs copy;
//   - per-genre dispatch (ballad->ballad, edm/schlager->edm,
//     organicVibes/urban->organicVibes);
//   - bpm-band filtering (`e.bpm === 'any' || bpmLow <= bpm <= bpmHigh`);
//   - octave-centering (`-12 * round(avgPosition / numNotes / 12)`), strings
//     only — brass emits note positions verbatim.

import { describe, expect, it, beforeEach } from 'vitest';

import { createRng } from '@casperaki/music-theory';

import {
  describeOrchestralBank,
  expandOrchestralPattern,
  orchestralHasGenreStyle,
  selectOrchestralPattern,
  _resetOrchestralBankCache,
} from '../src/patterns/orchestral-bank.js';

beforeEach(() => _resetOrchestralBankCache());

describe('popStrings bank manifest', () => {
  it('exposes the three genre-bucket styles with the real pattern counts', () => {
    const desc = describeOrchestralBank('popStrings');
    expect(desc.styles.slice().sort()).toEqual(['ballad', 'edm', 'organicVibes']);
    expect(desc.patternCount).toMatchObject({ ballad: 60, edm: 60, organicVibes: 111 });
  });

  it('maps every dispatched genre to its legacy bucket', () => {
    const desc = describeOrchestralBank('popStrings');
    expect(desc.genreStyles).toMatchObject({
      ballad: ['ballad'],
      edm: ['edm'],
      schlager: ['edm'], // legacy: edm + schlager share the edm bucket
      organicVibes: ['organicVibes'],
      urban: ['organicVibes'], // legacy: urban dispatches to organicVibes
    });
  });

  it('reports genre-style support consistent with the manifest', () => {
    for (const g of ['ballad', 'edm', 'schlager', 'organicVibes', 'urban']) {
      expect(orchestralHasGenreStyle('popStrings', g)).toBe(true);
    }
    // latin/rock have no string bucket in the legacy dispatch.
    expect(orchestralHasGenreStyle('popStrings', 'latin')).toBe(false);
    expect(orchestralHasGenreStyle('popStrings', 'rock')).toBe(false);
  });
});

describe('popStrings per-genre dispatch', () => {
  it('selects only patterns from the genre bucket', () => {
    // ballad bucket patterns are named ".../ballad/..."; edm ".../edm/...".
    for (let s = 0; s < 40; s++) {
      const ballad = selectOrchestralPattern(createRng('b' + s), 'popStrings', 'ballad', 120);
      expect(ballad.pattern.name).toContain('/ballad/');
      const edm = selectOrchestralPattern(createRng('e' + s), 'popStrings', 'edm', 120);
      expect(edm.pattern.name).toContain('/edm/');
      // schlager shares the edm bucket
      const schlager = selectOrchestralPattern(createRng('s' + s), 'popStrings', 'schlager', 120);
      expect(schlager.pattern.name).toContain('/edm/');
    }
  });

  it('is deterministic for a fixed rng seed', () => {
    const a = selectOrchestralPattern(createRng('det'), 'popStrings', 'organicVibes', 120);
    const b = selectOrchestralPattern(createRng('det'), 'popStrings', 'organicVibes', 120);
    expect(a.pattern.name).toBe(b.pattern.name);
  });
});

describe('popStrings bpm-band filtering', () => {
  // edm bucket has bands 75-90, 110-130, 130-150 plus `any` patterns. A pick at
  // bpm=120 must never return a pattern whose band excludes 120.
  it('never returns an out-of-band pattern', () => {
    for (const bpm of [80, 120, 140]) {
      for (let s = 0; s < 120; s++) {
        const sel = selectOrchestralPattern(createRng('k' + bpm + s), 'popStrings', 'edm', bpm);
        const { bpmLow, bpmHigh } = sel.pattern;
        if (bpmLow !== undefined && bpmHigh !== undefined) {
          expect(bpm).toBeGreaterThanOrEqual(bpmLow);
          expect(bpm).toBeLessThanOrEqual(bpmHigh);
        }
      }
    }
  });

  it('a bpm in only one band yields a narrower pool than an out-of-all-bands bpm', () => {
    const namesAt = (bpm: number): Set<string> => {
      const set = new Set<string>();
      for (let s = 0; s < 400; s++) {
        set.add(selectOrchestralPattern(createRng('p' + s), 'popStrings', 'edm', bpm).pattern.name);
      }
      return set;
    };
    // bpm=200 is outside every band, so only `any` patterns survive (10 of 60);
    // bpm=120 also admits the 110-130 band, so its pool is strictly larger.
    expect(namesAt(120).size).toBeGreaterThan(namesAt(200).size);
  });
});

describe('strings octave-centering vs brass verbatim', () => {
  it('centers strings patterns near middle C (|avg| < 12)', () => {
    for (let s = 0; s < 60; s++) {
      const sel = selectOrchestralPattern(createRng('c' + s), 'popStrings', 'organicVibes', 120);
      const ex = expandOrchestralPattern(sel.pattern, true);
      if (ex.events.length === 0) continue;
      const avg = ex.events.reduce((a, e) => a + e.distanceFromMiddleC, 0) / ex.events.length;
      expect(Math.abs(avg)).toBeLessThan(12);
    }
  });

  it('centerOctave=false emits note positions verbatim', () => {
    const sel = selectOrchestralPattern(createRng('v'), 'popStrings', 'edm', 120);
    const raw = expandOrchestralPattern(sel.pattern, false);
    // With centering off, distanceFromMiddleC must equal the source positions.
    const sourcePositions = new Set<number>();
    for (const notes of Object.values(sel.pattern.notes)) {
      for (const n of notes) sourcePositions.add(n.position);
    }
    for (const e of raw.events) expect(sourcePositions.has(e.distanceFromMiddleC)).toBe(true);
  });
});
