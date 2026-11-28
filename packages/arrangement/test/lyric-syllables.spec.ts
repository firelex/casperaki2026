// Lyrics edited on the notes (owner 2026-11-28: "make lyrics editable ... the piano roll editor for vocal tracks (would
// have to update the backing vocals as well)", Tab to the next note; "all choruses - important to preserve the link").
import { describe, expect, it } from 'vitest';
import type { Song } from '@casperaki/song-schema';

import { applyLyricsFirst, editLyricSyllables, orchestrate, sungSections } from '../src/index.js';

const PARAMS = { genre: 'brightPop', key: 'C', bpm: 110, seed: 'a' } as const;
const LYRICS = {
  verse: ['Saw your phone light up again', 'A name I do not know', 'You said it was nothing', 'But I could see it show'],
  preChorus: ['Now I am walking fast', 'Hoping this will last', 'Do not wait for me', 'I am already past'],
  chorus: ['You gotta feel it', 'Take me home tonight', 'Maybe I was wrong about you', 'Hold me till the light'],
  bridge: ['Turn the corner lose the map', 'I do not want it back', 'Maybe it is nothing', 'But I like it like that'],
};
const written = applyLyricsFirst(orchestrate(PARAMS), LYRICS);
const names = sungSections(written).map((s) => s.name);
const choruses = names.filter((n) => n.startsWith('chorus'));
const verses = names.filter((n) => n.startsWith('verse'));

/** A track's notes in a section, in order: [beat from the section start, the syllable]. */
const notes = (song: Song, section: string, track = 'Vocal') =>
  (song.arrangement[section]!.overrides[track]?.bars ?? []).flatMap((b, bi) =>
    Object.entries(b.notes ?? {})
      .flatMap(([beat, evs]) => (evs ?? []).filter((e) => e.type === 'vocalNote').map((e) => [bi * 4 + Number.parseFloat(beat), (e as { fullWord?: string }).fullWord ?? ''] as const))
      .sort((x, y) => x[0] - y[0]),
  );
const syllables = (song: Song, section: string) => notes(song, section).map(([, w]) => w);
const onsets = (song: Song, section: string) => notes(song, section).map(([t]) => t);

describe('editLyricSyllables', () => {
  it('a word of the same length: the notes stay, every chorus and its backing vocals sing it', () => {
    expect(choruses.length).toBeGreaterThan(1);
    const [c1] = choruses as [string];
    const syl = syllables(written, c1);
    expect(syl[0]).toBe('You');
    const out = editLyricSyllables(written, c1, ['We', ...syl.slice(1)]);
    for (const c of choruses) {
      expect(onsets(out, c), c).toEqual(onsets(written, c));
      expect(syllables(out, c)[0], c).toBe('We');
    }
    const backing = choruses.find((c) => notes(out, c, 'Backing vocals 1').length > 0);
    expect(backing).toBeDefined();
    // the backing line sings the lead's words: one "You" (line 1's) is "We" now ("...wrong about you" stays)
    const count = (song: Song, w: string) => notes(song, backing!, 'Backing vocals 1').filter(([, x]) => x === w).length;
    expect(count(out, 'We')).toBe(count(written, 'We') + 1);
    expect(count(out, 'You')).toBe(count(written, 'You') - 1);
  });

  it('a longer word on a note: the line is recut to the new words, in every chorus', () => {
    const [c1] = choruses as [string];
    const syl = syllables(written, c1);
    const out = editLyricSyllables(written, c1, ['Somebody', ...syl.slice(1)]);
    for (const c of choruses) {
      expect(syllables(out, c).slice(0, 3), c).toEqual(['Some-', 'bo-', 'dy']);
      expect(onsets(out, c).length, c).toBe(onsets(written, c).length + 2);
    }
  });

  it('a verse has words of its own: only it changes', () => {
    expect(verses.length).toBeGreaterThan(1);
    const [v1, v2] = verses as [string, string];
    const syl = syllables(written, v1);
    const out = editLyricSyllables(written, v1, ['Seen', ...syl.slice(1)]);
    expect(syllables(out, v1)[0]).toBe('Seen');
    expect(syllables(out, v2)).toEqual(syllables(written, v2));
  });

  it('refuses a wrong count, an empty note or a word not in the dictionary', () => {
    const [c1] = choruses as [string];
    const syl = syllables(written, c1);
    expect(() => editLyricSyllables(written, c1, syl.slice(1))).toThrow(/notes/u);
    expect(() => editLyricSyllables(written, c1, ['  ', ...syl.slice(1)])).toThrow(/no syllable/u);
    expect(() => editLyricSyllables(written, c1, ['Zqxv', ...syl.slice(1)])).toThrow(/zqxv/iu);
  });
});
