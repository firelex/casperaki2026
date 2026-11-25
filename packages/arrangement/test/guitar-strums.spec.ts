// Guitar strums (pattern lab kind `guitarStrums`) and guitar in more genres
// (docs/superpowers/specs/2026-11-25-guitar-strums-design.md).

import { describe, expect, it } from 'vitest';

import { familySoundPool, orchestrate } from '../src/index.js';
import { GuitarStrumPatternSchema } from '../src/patterns/chord-tones.js';
import { virtualGuitaristBankHasPatterns } from '../src/patterns/virtual-guitarist-bank.js';

const STRUMS = {
  family: 'guitar',
  kind: 'guitarStrums',
  patterns: [
    {
      bars: 1,
      strums: [
        [0, 'down', 0.5],
        [1.5, 'up', 0.25],
        [2, 'longDown', 2],
      ],
      picks: [[1, [0], 0.5, 80]],
      fx: [[3.75, 'fx2']],
    },
  ],
};

const guitarDefs = (song: ReturnType<typeof orchestrate>) =>
  song.instrumentDefinitions.filter((d) => /^Guitar( \d+)?$/u.test(d.name));

describe('guitarStrums patterns', () => {
  it('play the recorded chord strums, picks and fx over the song chords', () => {
    const song = orchestrate({ genre: 'urban', key: 'C', bpm: 90, seed: 'strums-preview', params: { lanePreview: STRUMS } });
    expect(guitarDefs(song)).toHaveLength(1);
    const text = JSON.stringify(song.arrangement);
    for (const event of ['chordShortStrumDown', 'chordShortStrumUp', 'chordLongStrumDown', 'fx2']) expect(text).toContain(`"event":"${event}"`);
    expect(text).toMatch(/"type":"strum"/u);
  });

  it('reject a beat past the pattern bars', () => {
    const bad = GuitarStrumPatternSchema.safeParse({ bars: 1, strums: [[4, 'down', 0.5]] });
    expect(bad.success).toBe(false);
  });
});

describe('guitar in more genres', () => {
  const ids = (genre: string) => familySoundPool('guitar', genre).map((e) => e.id);

  it('urban takes the ballad guitars; schlager, latin and EDM the brightPop guitars', () => {
    expect(ids('urban')).toEqual(ids('ballad'));
    for (const genre of ['schlager', 'latin', 'edm']) expect(ids(genre)).toEqual(ids('brightPop'));
  });

  it('urban songs (approved guitar styles) get a guitar about one time in three', () => {
    let withGuitar = 0;
    for (let seed = 1; seed <= 60; seed++) {
      if (guitarDefs(orchestrate({ genre: 'urban', key: 'C', bpm: 90, seed })).length > 0) withGuitar++;
    }
    expect(withGuitar).toBeGreaterThan(10);
    expect(withGuitar).toBeLessThan(32);
  });

  it('EDM gets no guitar while it has no approved guitar style', () => {
    for (let seed = 1; seed <= 20; seed++) expect(guitarDefs(orchestrate({ genre: 'edm', key: 'C', bpm: 124, seed }))).toHaveLength(0);
  });

  it('the legacy bank has patterns for rock and none for urban', () => {
    expect(virtualGuitaristBankHasPatterns('rock', 120)).toBe(true);
    expect(virtualGuitaristBankHasPatterns('urban', 90)).toBe(false);
  });
});
