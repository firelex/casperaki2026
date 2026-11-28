// The casting writer (docs/superpowers/plans/2026-11-28-casting-3-writer.md): the cast, the song facts, the scene
// plans and one model call per line, against a scripted fake language model.

import { orchestrate } from '@casperaki/arrangement';
import { describe, expect, it } from 'vitest';

import { JUDGES, verdictVotes } from '../src/casting/cast.js';
import { castingFacts } from '../src/casting/facts.js';
import { songTiming } from '../src/video/videoInput.js';

const song = orchestrate({ genre: 'brightPop', key: 'C', bpm: 120, seed: 'casting-1' });

describe('the cast', () => {
  it('is the four judges with their approved voices, in plain-English profiles naming no real person', () => {
    expect(JUDGES.map((j) => j.id)).toEqual(['ice', 'nicky', 'love', 'bob']);
    expect(JUDGES.map((j) => j.voice.seed)).toEqual([7, 7, 7, 21]);
    expect(JUDGES.find((j) => j.id === 'bob')!.voice.description).toMatch(/Irish man/);
    for (const j of JUDGES) {
      expect(j.profile.length).toBeGreaterThan(300);
      expect(j.profile).not.toMatch(/Cowell|Walsh|Minaj|Minogue/);
    }
  });
  it('votes as the outcome says; three to one picks one "no", the same for the same song', () => {
    expect(Object.values(verdictVotes('fourYes', 's1'))).toEqual(['yes', 'yes', 'yes', 'yes']);
    expect(Object.values(verdictVotes('notThisTime', 's1'))).toEqual(['no', 'no', 'no', 'no']);
    const v = verdictVotes('threeOne', 's1');
    expect(Object.values(v).filter((x) => x === 'no')).toHaveLength(1);
    expect(verdictVotes('threeOne', 's1')).toEqual(v);
    const noes = new Set(Array.from({ length: 40 }, (_, i) => Object.entries(verdictVotes('threeOne', `song-${i}`)).find(([, x]) => x === 'no')![0]));
    expect(noes.size).toBeGreaterThan(1);
  });
});

describe('the song facts', () => {
  it('quotes the first chorus and describes the tempo', () => {
    const f = castingFacts(song, { name: 'Kesha', description: 'bright pop voice' }, 'Mia');
    expect(f.title.length).toBeGreaterThan(0);
    expect(f.bpm).toBe(120);
    expect(f.tempoWord).toBe('fast');
    expect(f.quotes.length).toBeGreaterThan(0);
    expect(f.quotes.length).toBeLessThanOrEqual(4);
    const chorus = songTiming(song).sections.find((s) => /chorus/iu.test(s.name))!;
    expect(f.sections).toContain(chorus.name);
    expect(f).toMatchObject({ singerName: 'Kesha', singerDescription: 'bright pop voice', avatarName: 'Mia' });
  });
  it('refuses a song without a title', () => {
    expect(() => castingFacts({ ...song, title: '' }, { name: 'Kesha', description: null }, 'Mia')).toThrow(/no title/);
  });
  it('has no quotes for a song without words', () => {
    const silent = { ...song, arrangement: Object.fromEntries(Object.entries(song.arrangement).map(([k, v]) => [k, { ...v, overrides: {} }])) } as typeof song;
    expect(castingFacts(silent, { name: 'Kesha', description: null }, 'Mia').quotes).toEqual([]);
  });
});
