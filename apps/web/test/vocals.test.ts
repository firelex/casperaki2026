import { describe, expect, it } from 'vitest';

import type { Song } from '@casperaki/song-schema';

import { singAgain, singBeforePlay, singMissing, singRun, takesToken, unsungSections, withVocals } from '../src/audio/singVocals';

const song = (extra: Partial<Song> = {}): Song =>
  ({
    key: 'C', bpm: 100, arrangement: {}, instrumentDefinitions: [], aiArtifacts: [],
    songStructure: [{ name: 'verse1', bars: [] }, { name: 'chorus1', bars: [] }, { name: 'intro', bars: [] }],
    vocals: { enabled: true, voice: 'en_prompt', takeNumbers: {} },
    ...extra,
  }) as unknown as Song;

describe('singAgain', () => {
  it('bumps the take number of one section, or of several', () => {
    const s = song({ vocals: { enabled: true, voice: 'v', takeNumbers: { verse1: 2 } } });
    expect(singAgain(s, 'verse1').vocals!.takeNumbers).toEqual({ verse1: 3 });
    expect(singAgain(s, 'chorus1').vocals!.takeNumbers).toEqual({ verse1: 2, chorus1: 2 });
    expect(singAgain(s, ['verse1', 'chorus1']).vocals!.takeNumbers).toEqual({ verse1: 3, chorus1: 2 });
  });
});

describe('withVocals', () => {
  it('switches singing on with a voice, keeping take numbers; off keeps the voice', () => {
    expect(withVocals(song({ vocals: undefined }), true, 'en_prompt').vocals).toEqual({ enabled: true, voice: 'en_prompt', takeNumbers: {} });
    const on = song({ vocals: { enabled: true, voice: 'v', takeNumbers: { verse1: 2 } } });
    expect(withVocals(on, false).vocals).toEqual({ enabled: false, voice: 'v', takeNumbers: { verse1: 2 } });
  });
});

describe('singMissing', () => {
  it('sings only the unsung sections, in order, reporting progress', async () => {
    const calls: string[] = [];
    const api = {
      status: async () => ({ sections: [
        { segment: 'intro', state: 'none' as const },
        { segment: 'verse1', state: 'unsung' as const },
        { segment: 'chorus1', state: 'unsung' as const },
        { segment: 'verse2', state: 'sung' as const },
      ] }),
      sing: async (_s: Song, segment: string) => {
        calls.push(segment);
        return { section: { segment, state: 'sung' as const } };
      },
    };
    const progress: string[] = [];
    expect(await singMissing(song(), api, (t) => progress.push(t))).toBe(2);
    expect(calls).toEqual(['verse1', 'chorus1']);
    expect(progress).toEqual(['Singing verse1 (1 of 2)', 'Singing chorus1 (2 of 2)']);
  });
});

describe('singBeforePlay', () => {
  const api = { status: async () => ({ sections: [{ segment: 'verse1', state: 'unsung' as const }] }), sing: async (_s: Song, segment: string) => ({ section: { segment, state: 'sung' as const } }) };
  it('done when sung', async () => {
    expect(await singBeforePlay(song(), api, () => {}, new AbortController().signal)).toBe('done');
  });
  it('a cancelled run neither plays nor reports an error', async () => {
    const ac = new AbortController();
    expect(await singBeforePlay(song(), { ...api, sing: async () => { ac.abort(); throw new Error('aborted'); } }, () => {}, ac.signal)).toBe('cancelled');
  });
});

describe('singRun', () => {
  it('one run at a time: pressing again while one runs cancels it and starts nothing', () => {
    const first = singRun.toggle();
    expect(singRun.active()).toBe(true);
    expect(singRun.toggle()).toBeUndefined();
    expect(first!.signal.aborted).toBe(true);
    expect(singRun.active()).toBe(false);
    const next = singRun.toggle()!;
    singRun.done(next);
    expect(singRun.active()).toBe(false);
  });
});

describe('unsungSections and takesToken', () => {
  const sections = [{ name: 'intro' }, { name: 'verse1' }, { name: 'chorus1' }];
  const st = [{ segment: 'intro', state: 'none' as const }, { segment: 'verse1', state: 'sung' as const }, { segment: 'chorus1', state: 'unsung' as const }];
  it('greys only the unsung sections; nothing while unknown', () => {
    expect([...unsungSections(sections, st)]).toEqual([2]);
    expect(unsungSections(sections, undefined).size).toBe(0);
  });
  it('the token changes when a section gets its take', () => {
    expect(takesToken(st)).not.toBe(takesToken([...st.slice(0, 2), { segment: 'chorus1', state: 'sung' as const }]));
  });
});
