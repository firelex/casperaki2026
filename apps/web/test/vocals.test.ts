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
        { segment: 'chorus2', state: 'stored' as const },
      ] }),
      sing: async (_s: Song, segment: string) => {
        calls.push(segment);
        return { artifact: art(segment, `new-${segment}`) };
      },
    };
    const progress: string[] = [];
    const out = await singMissing(song({ aiArtifacts: [art('verse1', 'old')] }), api, (t) => progress.push(t));
    expect(calls).toEqual(['verse1', 'chorus1', 'chorus2']);
    expect(progress).toEqual(['Singing verse1 (1 of 3)', 'Singing chorus1 (2 of 3)', 'Singing chorus2 (3 of 3)']);
    expect(out.aiArtifacts.map((a) => a.id)).toEqual(['vocal-verse1-new-verse1', 'vocal-chorus1-new-chorus1', 'vocal-chorus2-new-chorus2']);
  });

  it('drops a take left on a section that no longer has vocal notes', async () => {
    const api = {
      status: async () => ({ sections: [{ segment: 'verse1', state: 'unused' as const }, { segment: 'chorus1', state: 'current' as const }] }),
      sing: async () => { throw new Error('nothing to sing'); },
    };
    const out = await singMissing(song({ aiArtifacts: [art('verse1', 'old'), art('chorus1', 'c')] }), api, () => {});
    expect(out.aiArtifacts.map((a) => a.id)).toEqual(['vocal-chorus1-c']);
  });

  it('returns the same song when nothing needs singing', async () => {
    const s = song();
    const api = { status: async () => ({ sections: [{ segment: 'verse1', state: 'current' as const }] }), sing: async () => { throw new Error('no'); } };
    expect(await singMissing(s, api, () => {})).toBe(s);
  });
});

import { singBeforePlay, singRun, viewSource } from '../src/audio/singVocals';

describe('singBeforePlay', () => {
  const api = (onSing?: () => void) => ({
    status: async () => ({ sections: [{ segment: 'verse1', state: 'missing' as const }] }),
    sing: async (_s: Song, segment: string) => {
      onSing?.();
      return { artifact: art(segment, 'x') };
    },
  });

  it('plays the sung song when the song on screen is still the one sung', async () => {
    const s = song();
    const out = await singBeforePlay(s, api(), () => true, () => {}, new AbortController().signal);
    expect(out.kind).toBe('play');
    expect(out.kind === 'play' && out.song.aiArtifacts.map((a) => a.id)).toEqual(['vocal-verse1-x']);
  });

  it('does not apply the takes when the song changed while singing (another song opened, or edited)', async () => {
    const out = await singBeforePlay(song(), api(), () => false, () => {}, new AbortController().signal);
    expect(out).toEqual({ kind: 'changed' });
  });

  it('a cancelled run neither applies nor reports an error', async () => {
    const ac = new AbortController();
    const out = await singBeforePlay(song(), { ...api(), sing: async () => { ac.abort(); throw new Error('aborted'); } }, () => true, () => {}, ac.signal);
    expect(out).toEqual({ kind: 'cancelled' });
  });
});

describe('singRun', () => {
  it('one run at a time: pressing again while one runs cancels it and starts nothing', () => {
    const first = singRun.toggle();
    expect(first).toBeDefined();
    expect(singRun.active()).toBe(true);
    expect(singRun.toggle()).toBeUndefined();
    expect(first!.signal.aborted).toBe(true);
    expect(singRun.active()).toBe(false);
    const next = singRun.toggle()!;
    singRun.done(next);
    expect(singRun.active()).toBe(false);
  });
});

describe('viewSource', () => {
  const st = (state: 'none' | 'current' | 'stored' | 'stale' | 'missing' | 'unused') => [{ segment: 'verse1', state }, { segment: 'intro', state: 'none' as const }];
  it('the mixer and waveforms load the song as it plays when vocals are off or all sung', () => {
    expect(viewSource(song({ vocals: undefined }), undefined)).toBe('song');
    expect(viewSource(song(), st('current'))).toBe('song');
  });
  it('without the vocal while a section is not sung for the song as it is (Play would sing first)', () => {
    for (const s of ['stored', 'stale', 'missing', 'unused'] as const) expect(viewSource(song(), st(s))).toBe('instrumental');
  });
  it('waits while the vocals status is not known', () => {
    expect(viewSource(song(), undefined)).toBe('wait');
  });
});

import { unsungSections } from '../src/audio/singVocals';

describe('unsungSections', () => {
  const sections = [{ name: 'intro' }, { name: 'verse1' }, { name: 'chorus1' }, { name: 'verse2' }];
  it('the section indexes whose lead vocal has no current take (missing or changed)', () => {
    const st = [
      { segment: 'intro', state: 'none' as const },
      { segment: 'verse1', state: 'current' as const },
      { segment: 'chorus1', state: 'stale' as const },
      { segment: 'verse2', state: 'missing' as const },
      { segment: 'intro', state: 'stored' as const },
    ];
    expect([...unsungSections(sections, st)].sort()).toEqual([2, 3]);
    // Sung and stored, only not recorded on this copy: not grey.
    expect(unsungSections(sections, [{ segment: 'verse1', state: 'stored' as const }]).size).toBe(0);
  });
  it('nothing while the status is not known', () => {
    expect(unsungSections(sections, undefined).size).toBe(0);
  });
});
