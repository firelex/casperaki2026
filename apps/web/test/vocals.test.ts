import { describe, expect, it } from 'vitest';

import type { AIArtifact, Song } from '@casperaki/song-schema';

import { singAgain, singMissing, withTake, withVocals } from '../src/audio/singVocals';

const art = (segment: string, fp: string, kind: AIArtifact['kind'] = 'soulx-vocal'): AIArtifact => ({
  id: `vocal-${segment}-${fp}`, kind, modelId: 'soulx-singer', modelVersion: 'steps-32',
  output: { uri: `vocal-take:${fp}.wav`, sha256: fp.padEnd(64, '0') },
  attachedTo: { scope: 'segment', segment, instrument: 'Vocal' },
} as AIArtifact);

const song = (extra: Partial<Song> = {}): Song =>
  ({
    key: 'C', bpm: 100, arrangement: {}, instrumentDefinitions: [], aiArtifacts: [],
    songStructure: [{ name: 'verse1', bars: [] }, { name: 'chorus1', bars: [] }, { name: 'intro', bars: [] }],
    vocals: { enabled: true, voice: 'en_prompt', takeNumbers: {} },
    ...extra,
  }) as unknown as Song;

describe('withTake', () => {
  it('replaces the section take and keeps other sections and kinds', () => {
    const other = art('verse1', 'm', 'matchering-master');
    const s = song({ aiArtifacts: [art('verse1', 'a'), art('chorus1', 'b'), other] });
    const out = withTake(s, art('verse1', 'c'));
    expect(out.aiArtifacts.map((a) => a.id)).toEqual(['vocal-chorus1-b', 'vocal-verse1-m', 'vocal-verse1-c']);
    expect(s.aiArtifacts).toHaveLength(3); // not mutated
  });
});

describe('singAgain', () => {
  it('bumps the take number of one section, or of every vocal section', () => {
    const s = song({ vocals: { enabled: true, voice: 'v', takeNumbers: { verse1: 2 } } });
    expect(singAgain(s, 'verse1').vocals!.takeNumbers).toEqual({ verse1: 3 });
    expect(singAgain(s, 'chorus1').vocals!.takeNumbers).toEqual({ verse1: 2, chorus1: 2 });
    expect(singAgain(s, ['verse1', 'chorus1']).vocals!.takeNumbers).toEqual({ verse1: 3, chorus1: 2 });
  });
});

describe('withVocals', () => {
  it('switches vocals on with a voice, keeping take numbers; off keeps the voice', () => {
    const off = song({ vocals: undefined });
    expect(withVocals(off, true, 'en_prompt').vocals).toEqual({ enabled: true, voice: 'en_prompt', takeNumbers: {} });
    const on = song({ vocals: { enabled: true, voice: 'v', takeNumbers: { verse1: 2 } } });
    expect(withVocals(on, false).vocals).toEqual({ enabled: false, voice: 'v', takeNumbers: { verse1: 2 } });
  });
});

describe('singMissing', () => {
  it('sings only missing and stale sections, in order, reporting progress, and returns the song with the takes', async () => {
    const calls: string[] = [];
    const api = {
      status: async () => ({ sections: [
        { segment: 'intro', state: 'none' as const },
        { segment: 'verse1', state: 'stale' as const },
        { segment: 'chorus1', state: 'missing' as const },
        { segment: 'verse2', state: 'current' as const },
      ] }),
      sing: async (_s: Song, segment: string) => {
        calls.push(segment);
        return { artifact: art(segment, `new-${segment}`) };
      },
    };
    const progress: string[] = [];
    const out = await singMissing(song({ aiArtifacts: [art('verse1', 'old')] }), api, (t) => progress.push(t));
    expect(calls).toEqual(['verse1', 'chorus1']);
    expect(progress).toEqual(['Singing verse1 (1 of 2)', 'Singing chorus1 (2 of 2)']);
    expect(out.aiArtifacts.map((a) => a.id)).toEqual(['vocal-verse1-new-verse1', 'vocal-chorus1-new-chorus1']);
  });

  it('returns the same song when nothing needs singing', async () => {
    const s = song();
    const api = { status: async () => ({ sections: [{ segment: 'verse1', state: 'current' as const }] }), sing: async () => { throw new Error('no'); } };
    expect(await singMissing(s, api, () => {})).toBe(s);
  });
});
