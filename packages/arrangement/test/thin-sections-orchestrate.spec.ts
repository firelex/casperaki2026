import { describe, expect, it } from 'vitest';

import { orchestrate, type GenerateParams } from '../src/index.js';
import { familySoundPool } from '../src/selection/index.js';

// "Sunlit Sidewalk" (song ba189d1762d0d253): verses with a one-note pad and a lead whose every other bar is almost
// empty.
const SUNLIT: GenerateParams = { genre: 'brightPop', key: 'C', bpm: 120, seed: 'seed-19ptbn' };
const isVerse = (name: string) => name.startsWith('verse');
const roster = (song: ReturnType<typeof orchestrate>) => song.instrumentDefinitions.map((d) => d.name);

describe('thin sections in orchestrate', () => {
  const song = orchestrate(SUNLIT);

  it('the thin verses of Sunlit Sidewalk get a partner track (Pad 2 or Synths 2) that plays in every verse', () => {
    const partners = roster(song).filter((n) => n === 'Pad 2' || n === 'Synths 2');
    expect(partners.length).toBeGreaterThan(0);
    for (const sec of song.songStructure.filter((s) => isVerse(s.name))) {
      for (const p of partners) {
        expect(song.arrangement[sec.name]!.instruments[p]).toBe(true);
        expect(song.arrangement[sec.name]!.overrides[p]).toBeDefined();
      }
    }
  });

  it('the choruses get no partner track', () => {
    const partners = roster(song).filter((n) => n === 'Pad 2' || n === 'Synths 2');
    for (const sec of song.songStructure.filter((s) => s.name.startsWith('chorus'))) {
      for (const p of partners) expect(song.arrangement[sec.name]!.instruments[p]).toBe(false);
    }
  });

  it('is deterministic', () => {
    expect(orchestrate(SUNLIT)).toEqual(song);
  });

  it('a track the user added keeps its name; a partner takes the next one', () => {
    const padSound = familySoundPool('pad', 'brightPop')[0]!.id;
    const edited = orchestrate({
      ...SUNLIT,
      params: { trackEdits: [{ kind: 'addTrack', track: 'Pad 2', family: 'pad', soundId: padSound, segments: ['chorus1'] }] },
    });
    expect(edited.arrangement.chorus1!.instruments['Pad 2']).toBe(true);
    expect(edited.arrangement.verse1!.instruments['Pad 2']).toBe(false);
    expect(roster(edited)).toContain('Pad 3');
    expect(edited.arrangement.verse1!.instruments['Pad 3']).toBe(true);
  });
});
