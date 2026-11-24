import { describe, expect, it } from 'vitest';

import type { Song } from '@casperaki/song-schema';

import { sectionStarts, singAgain, singQueue, singRun, takesToken, unsungSections, withVocals } from '../src/audio/singVocals';

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
    expect(singAgain(s, 'Vocal', 'verse1').vocals!.takeNumbers).toEqual({ verse1: 3 });
    expect(singAgain(s, 'Vocal', 'chorus1').vocals!.takeNumbers).toEqual({ verse1: 2, chorus1: 2 });
    expect(singAgain(s, 'Vocal', ['verse1', 'chorus1']).vocals!.takeNumbers).toEqual({ verse1: 3, chorus1: 2 });
    // A backing track has its own setting.
    const b = withVocals(s, 'Backing vocals 1', true, 'zh_target');
    expect(b.backingVocals).toEqual({ 'Backing vocals 1': { enabled: true, voice: 'zh_target', takeNumbers: {} } });
    expect(singAgain(b, 'Backing vocals 1', 'chorus1').backingVocals!['Backing vocals 1']!.takeNumbers).toEqual({ chorus1: 2 });
    expect(b.vocals).toEqual(s.vocals);
  });
});

describe('withVocals', () => {
  it('switches singing on with a voice, keeping take numbers; off keeps the voice', () => {
    expect(withVocals(song({ vocals: undefined }), 'Vocal', true, 'en_prompt').vocals).toEqual({ enabled: true, voice: 'en_prompt', takeNumbers: {} });
    const on = song({ vocals: { enabled: true, voice: 'v', takeNumbers: { verse1: 2 } } });
    expect(withVocals(on, 'Vocal', false).vocals).toEqual({ enabled: false, voice: 'v', takeNumbers: { verse1: 2 } });
  });
});

describe('singQueue', () => {
  it('sings the singing tracks unsung sections from the play position, the lead first within a section', () => {
    const s = song({
      bpm: 120 as never,
      songStructure: [{ name: 'verse1', bars: [{}, {}] }, { name: 'chorus1', bars: [{}, {}] }] as never,
      backingVocals: { 'Backing vocals 1': { enabled: true, voice: 'v', takeNumbers: {} }, 'Backing vocals 2': { enabled: false, voice: 'v', takeNumbers: {} } },
    });
    const tracks = {
      Vocal: [{ segment: 'verse1', state: 'unsung' as const }, { segment: 'chorus1', state: 'unsung' as const }],
      'Backing vocals 1': [{ segment: 'verse1', state: 'none' as const }, { segment: 'chorus1', state: 'unsung' as const }],
      'Backing vocals 2': [{ segment: 'verse1', state: 'none' as const }, { segment: 'chorus1', state: 'unsung' as const }],
    };
    // Playing from 5 s (chorus1 starts at 4 s): chorus1 first (lead, then backing 1; backing 2 is off), then verse1.
    expect(singQueue(s, tracks, 5)).toEqual([
      { track: 'Vocal', segment: 'chorus1' },
      { track: 'Backing vocals 1', segment: 'chorus1' },
      { track: 'Vocal', segment: 'verse1' },
    ]);
  });
});

describe('singRun', () => {
  it('one run at a time: a new run cancels the running one; cancel stops it', () => {
    const first = singRun.start();
    const second = singRun.start();
    expect(first.signal.aborted).toBe(true);
    expect(singRun.active()).toBe(true);
    singRun.cancel();
    expect(second.signal.aborted).toBe(true);
    expect(singRun.active()).toBe(false);
  });
});

describe('sectionStarts', () => {
  it('each section starts after the bars before it (4/4)', () => {
    const s = song({ bpm: 120, songStructure: [{ name: 'a', bars: [{}, {}] }, { name: 'b', bars: [{}] }, { name: 'c', bars: [] }] } as never);
    expect(sectionStarts(s)).toEqual([{ segment: 'a', start: 0 }, { segment: 'b', start: 4 }, { segment: 'c', start: 6 }]);
  });
});

describe('unsungSections and takesToken', () => {
  const sections = [{ name: 'intro' }, { name: 'verse1' }, { name: 'chorus1' }];
  const st = [{ segment: 'intro', state: 'none' as const }, { segment: 'verse1', state: 'sung' as const }, { segment: 'chorus1', state: 'unsung' as const }];
  it('greys only the unsung sections; nothing while unknown', () => {
    expect([...unsungSections(sections, st)]).toEqual([2]);
    expect(unsungSections(sections, undefined).size).toBe(0);
  });
  it('the token changes when a section of any track gets its take', () => {
    expect(takesToken({ Vocal: st })).not.toBe(takesToken({ Vocal: [...st.slice(0, 2), { segment: 'chorus1', state: 'sung' as const }] }));
    expect(takesToken({ Vocal: st, 'Backing vocals 1': [] })).not.toBe(takesToken({ Vocal: st, 'Backing vocals 1': [{ segment: 'chorus1', state: 'sung' as const }] }));
  });
});

import { singOrder } from '../src/audio/singVocals';

describe('singOrder', () => {
  // Sections start at 0, 10, 20, 30 s.
  const starts = [{ segment: 'intro', start: 0 }, { segment: 'verse1', start: 10 }, { segment: 'chorus1', start: 20 }, { segment: 'verse2', start: 30 }];
  it('sings the section being played first, then on through the song, then the ones already passed', () => {
    expect(singOrder(['verse1', 'chorus1', 'verse2'], starts, 22)).toEqual(['chorus1', 'verse2', 'verse1']);
    expect(singOrder(['verse1', 'verse2'], starts, 22)).toEqual(['verse2', 'verse1']);
    expect(singOrder(['verse1', 'chorus1'], starts, 0)).toEqual(['verse1', 'chorus1']);
  });
});
