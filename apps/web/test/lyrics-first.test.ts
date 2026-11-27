import { describe, expect, it } from 'vitest';
import type { Song } from '@casperaki/song-schema';

import { lyricsFirstType } from '../src/editor/singing';
import { mergeOp } from '../src/state/tasks';

const songWith = (params: Record<string, unknown>) => ({ generator: { params: { params } } }) as unknown as Song;

describe('lyrics first in the editor', () => {
  it('New rhythm is offered for a section whose type has a rhythm bent to its words', () => {
    const song = songWith({ lyricRhythms: { chorus: {} } });
    expect(lyricsFirstType(song, 'chorus2')).toBe(true);
    expect(lyricsFirstType(song, 'verse1')).toBe(false);
    expect(lyricsFirstType(songWith({}), 'chorus1')).toBe(false);
  });

  it('New rhythm is offered for a verse with words of its own (its rhythm stored by section)', () => {
    const song = songWith({ lyricRhythms: { verse1: {}, verse2: {} } });
    expect(lyricsFirstType(song, 'verse2')).toBe(true);
    expect(lyricsFirstType(song, 'chorus1')).toBe(false);
  });

  it('a finished Write lyrics task puts lyrics written first in with their own edit', () => {
    const saved = songWith({});
    expect(mergeOp('writeLyrics', { lyricsFirst: { chorus: ['a b c d'] } }, saved)).toEqual({ kind: 'applyLyricsFirst', lyrics: { chorus: ['a b c d'] } });
    expect(mergeOp('writeLyrics', { chorus1: ['a b c d'] }, saved)).toEqual({ kind: 'applyLyrics', lyrics: { chorus1: ['a b c d'] } });
  });
});
