import { describe, expect, it } from 'vitest';

import { notesToAbc, parseKey } from '../src/editor/sequencer/notation';

const n = (pitch: number, start: number, length: number) => ({ pitch, start, length });
const body = (abc: string, voice: 1 | 2) => abc.split('\n').find((l) => l.startsWith(`[V:${voice}]`))!.slice(6);

describe('notesToAbc', () => {
  it('writes a held chord as one whole-bar chord, on one staff when the part sits on one side', () => {
    const abc = notesToAbc([n(60, 0, 4), n(64, 0, 4), n(67, 0, 4)], { beats: 4, key: 'C' });
    expect(body(abc, 1)).toBe('[CEG]16 |]');
    expect(abc).toContain('V:1 clef=treble');
    expect(abc).not.toContain('[V:2]');
    const low = notesToAbc([n(48, 0, 4), n(52, 0, 4)], { beats: 4, key: 'C' });
    expect(low).toContain('V:1 clef=bass');
    expect(body(low, 1)).toBe('[C,E,]16 |]');
  });

  it('splits at middle C onto the grand staff and uses octave marks', () => {
    const abc = notesToAbc([n(48, 0, 4), n(55, 0, 4), n(72, 0, 4)], { beats: 4, key: 'C' });
    expect(body(abc, 1)).toBe('c16 |]');
    expect(body(abc, 2)).toBe('[C,G,]16 |]');
  });

  it('fills gaps with rests and ties notes across the barline', () => {
    const abc = notesToAbc([n(62, 1, 1), n(64, 3, 2)], { beats: 8, key: 'C' });
    expect(body(abc, 1)).toBe('z4 D4 z4 E4- | E4 z12 |]');
  });

  it('quantises slightly early or late onsets to 16ths', () => {
    const abc = notesToAbc([n(60, 0.02, 0.98), n(62, 0.99, 1)], { beats: 4, key: 'C' });
    expect(body(abc, 1)).toBe('C4 D4 z8 |]');
  });

  it('spells for the key and only marks accidentals that differ', () => {
    // Eb major: Eb and Bb come from the signature; E natural needs =, and stays natural in the bar.
    const abc = notesToAbc([n(63, 0, 1), n(64, 1, 1), n(64, 2, 1), n(70, 3, 1)], { beats: 4, key: 'Eb' });
    expect(abc).toContain('K:Eb');
    expect(body(abc, 1)).toBe('E4 =E4 E4 B4 |]');
  });

  it('resets accidentals at the barline', () => {
    const abc = notesToAbc([n(66, 0, 4), n(66, 4, 4)], { beats: 8, key: 'C' });
    expect(body(abc, 1)).toBe('^F16 | ^F16 |]');
  });

  it('reads minor and long-form keys', () => {
    expect(parseKey('Am')).toEqual({ abc: 'Am', fifths: 0 });
    expect(parseKey('F#m').fifths).toBe(3);
    expect(parseKey('Bb major')).toEqual({ abc: 'Bb', fifths: -2 });
    expect(parseKey('C minor')).toEqual({ abc: 'Cm', fifths: -3 });
    expect(() => parseKey('H')).toThrow();
  });
});

describe('notesToAbc labels and title', () => {
  it('puts section labels above the first note or rest of their bar', () => {
    const abc = notesToAbc([n(60, 4, 4)], { beats: 8, key: 'C', marks: new Map([[0, 'intro'], [1, 'verse1']]), title: 'Song: Keys' });
    expect(abc).toContain('T:Song: Keys');
    expect(body(abc, 1)).toBe('"^intro"z16 | "^verse1"C16 |]');
  });
});

describe('notesToAbc multi-bar rests', () => {
  it('merges empty bars into multi-bar rests, broken at labelled bars', () => {
    const abc = notesToAbc([n(60, 20, 4)], { beats: 24, key: 'C', marks: new Map([[0, 'intro'], [3, 'verse']]) });
    expect(body(abc, 1)).toBe('"^intro"Z3 | "^verse"Z2 | C16 |]');
  });
});

describe('notesToAbc labels after a rest', () => {
  it('labels a bar that starts with the end of a longer rest', () => {
    const abc = notesToAbc([n(60, 4.5, 3.5)], { beats: 8, key: 'C', marks: new Map([[0, 'a'], [1, 'b']]) });
    expect(body(abc, 1).startsWith('"^a"z16 | "^b"z2 ')).toBe(true);
  });
});
