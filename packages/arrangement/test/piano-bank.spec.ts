// docs/55a — Piano pattern bank loader + LibraryPianoPattern expansion tests.

import { describe, expect, it } from 'vitest';
import { createRng } from '@casperaki/music-theory';

import {
  _resetPianoBankCache,
  describePianoBank,
  expandPianoLibraryPattern,
  selectPianoLibraryPattern,
} from '../src/patterns/piano-bank.js';

describe('describePianoBank', () => {
  it('exposes per-library bucket + pattern counts', () => {
    _resetPianoBankCache();
    const info = describePianoBank();
    expect(info.libraries.edmSynthsPluckedLibrary).toEqual({
      bucket: 'edm',
      patternCount: 9,
    });
    expect(info.libraries.edmSynthsStabsLibrary).toEqual({
      bucket: 'edm',
      patternCount: 5,
    });
  });
});

describe('selectPianoLibraryPattern', () => {
  it('returns a non-empty edmSynthsPluckedLibrary pattern', () => {
    const sel = selectPianoLibraryPattern(createRng('pluck-1'), 'edmSynthsPluckedLibrary');
    expect(sel.library).toBe('edmSynthsPluckedLibrary');
    expect(sel.bucket).toBe('edm');
    expect(sel.pattern.name).toMatch(/Pluck Pattern/);
    expect(Object.keys(sel.pattern.rightHandNotes).length).toBeGreaterThan(0);
  });

  it('returns a non-empty edmSynthsStabsLibrary pattern', () => {
    const sel = selectPianoLibraryPattern(createRng('stabs-1'), 'edmSynthsStabsLibrary');
    expect(sel.library).toBe('edmSynthsStabsLibrary');
    expect(sel.bucket).toBe('edm');
    expect(sel.pattern.name).toMatch(/Lead synth pattern|Stab|Lead synth/);
  });

  it('determinism: same seed → same pattern name', () => {
    const a = selectPianoLibraryPattern(createRng('det'), 'edmSynthsPluckedLibrary');
    const b = selectPianoLibraryPattern(createRng('det'), 'edmSynthsPluckedLibrary');
    expect(a.pattern.name).toBe(b.pattern.name);
  });

  it('different seeds produce different picks within the bank pool', () => {
    const names = new Set<string>();
    for (const seed of ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8']) {
      names.add(
        selectPianoLibraryPattern(createRng(seed), 'edmSynthsPluckedLibrary').pattern.name,
      );
    }
    expect(names.size).toBeGreaterThanOrEqual(2);
  });

  it('throws on an unknown library', () => {
    // docs/56c follow-on — `library` + `altLibrary` are now registered
    // alongside the original `edmSynthsPluckedLibrary` /
    // `edmSynthsStabsLibrary`. Use a name guaranteed not to exist.
    expect(() =>
      selectPianoLibraryPattern(createRng('x'), 'unknownBank' as never),
    ).toThrowError(/unknown piano library/);
  });
});

describe('expandPianoLibraryPattern', () => {
  // Synthetic small pattern exercising bpm-adjust, monophonic, stabs,
  // polyphonic octave-centering, and the per-bar split.
  const PATTERN = {
    library: 'edmSynthsPluckedLibrary' as const,
    name: 'TEST',
    bpm: 120,
    leftHandNotes: Object.freeze({
      '0.0': Object.freeze([{ position: -12, duration: 1 }]),
      '4.0': Object.freeze([{ position: -7, duration: 1 }]),
    }) as Readonly<Record<string, readonly { position: number; duration: number }[]>>,
    rightHandNotes: Object.freeze({
      '0.0': Object.freeze([{ position: 24, duration: 0.5 }, { position: 19, duration: 0.5 }]),
      '0.5': Object.freeze([{ position: 21, duration: 0.5 }]),
      '4.0': Object.freeze([{ position: 24, duration: 0.5 }]),
    }) as Readonly<Record<string, readonly { position: number; duration: number }[]>>,
  };

  it('polyphonic mode emits events from both hands with octave-centering', () => {
    const ex = expandPianoLibraryPattern(PATTERN, {
      songBpm: 120,
      genre: 'brightPop',
      monophonic: false,
      stabs: false,
    });
    // 6 events: LH(0.0)=1, RH(0.0)=2, RH(0.5)=1, LH(4.0)=1, RH(4.0)=1 = 6
    expect(ex.events.length).toBe(6);
    // averagePosition = (-12 + -7 + 24 + 19 + 21 + 24) / 6 = 11.5;
    // adjustment = -12 * round(11.5/12) = -12 * 1 = -12.
    const adjustment = -12;
    const findEv = (bar: number, beat: number, originalPos: number) =>
      ex.events.find(
        (e) =>
          e.bar === bar &&
          Math.abs(e.beat - beat) < 0.001 &&
          e.distanceFromMiddleC === originalPos + adjustment,
      );
    expect(findEv(0, 0.0, -12)).toBeDefined(); // LH
    expect(findEv(0, 0.0, 24)).toBeDefined(); // RH
    expect(findEv(0, 0.0, 19)).toBeDefined(); // RH
    expect(findEv(0, 0.5, 21)).toBeDefined(); // RH
    expect(findEv(1, 0.0, -7)).toBeDefined(); // LH wrapped to bar 1
  });

  it('monophonic mode emits only first right-hand note per hit; no adjustment', () => {
    const ex = expandPianoLibraryPattern(PATTERN, {
      songBpm: 120,
      genre: 'brightPop',
      monophonic: true,
      stabs: false,
    });
    // Hits: 0.0 (RH first note = position 24), 0.5 (position 21), 4.0 (position 24).
    expect(ex.events.length).toBe(3);
    const positions = ex.events.map((e) => e.distanceFromMiddleC).sort((a, b) => a - b);
    expect(positions).toEqual([21, 24, 24]);
  });

  it('stabs mode clamps every duration to 0.25', () => {
    const ex = expandPianoLibraryPattern(PATTERN, {
      songBpm: 120,
      genre: 'brightPop',
      monophonic: false,
      stabs: true,
    });
    for (const e of ex.events) expect(e.duration).toBe(0.25);
  });

  it('genre durationAddOn: ballad/rock add +1 beat, urban +0.5', () => {
    const fromGenre = (genre: string) =>
      expandPianoLibraryPattern(PATTERN, {
        songBpm: 120,
        genre,
        monophonic: true,
        stabs: false,
      }).events[0]!.duration;
    expect(fromGenre('brightPop')).toBe(0.5);
    expect(fromGenre('ballad')).toBe(1.5);
    expect(fromGenre('rock')).toBe(1.5);
    expect(fromGenre('urban')).toBe(1.0);
  });

  it('bpm adjustmentFactor: pattern 120 vs song 60 doubles hit positions (factor=2)', () => {
    const ex = expandPianoLibraryPattern(PATTERN, {
      songBpm: 60,
      genre: 'brightPop',
      monophonic: true,
      stabs: false,
    });
    // Hit 4.0 originally → 4.0 * 2 = 8.0 → bar 2, beat 0.
    const ev40 = ex.events.find((e) => e.bar === 2 && e.beat === 0);
    expect(ev40).toBeDefined();
  });

  it('barCount reflects the largest bar index seen in the events', () => {
    const ex = expandPianoLibraryPattern(PATTERN, {
      songBpm: 120,
      genre: 'brightPop',
      monophonic: false,
      stabs: false,
    });
    expect(ex.barCount).toBe(2); // hits at 0.0 and 4.0 → bar 0 + bar 1
  });
});
