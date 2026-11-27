import { describe, expect, it } from 'vitest';
import { createRng } from '@casperaki/music-theory';
import type { Song } from '@casperaki/song-schema';

import { orchestrate } from '../src/index.js';
import { drawRhythm } from '../src/vocals/precedents.js';
import { recutRhythm } from '../src/vocals/recut.js';
import { LYRIC_RHYTHMS_PARAM } from '../src/vocals/lyric-rhythms.js';
import { WRITTEN_LYRICS_PARAM } from '../src/vocals/written-lyrics.js';

const PARAMS = { genre: 'brightPop', key: 'C', bpm: 110, seed: 'a' } as const;
const LINES = ['You gotta feel it', 'Take me home tonight', 'Maybe I was wrong about you', 'Never gonna let you go'];

/** The lead's notes in a section: [start (beats from the section start), duration]. */
const leadNotes = (song: Song, name: string): [number, number][] =>
  (song.arrangement[name]!.overrides.Vocal!.bars ?? []).flatMap((bar, i) =>
    Object.entries(bar.notes ?? {}).flatMap(([beat, evs]) => (evs ?? []).filter((e) => e.type === 'vocalNote').map((e) => [i * 4 + Number(beat), (e as { duration: number }).duration] as [number, number])),
  ).sort((a, b) => a[0] - b[0]);

describe('the generator sings on a stored recut', () => {
  const before = orchestrate(PARAMS);
  const choruses = before.songStructure.filter((s) => s.name.startsWith('chorus'));
  const rhythm = drawRhythm({ desiredPatternLength: 8, segmentType: 'chorus', genre: 'brightPop', tempo: 110, rng: createRng('recut-test') });
  const recut = recutRhythm(rhythm, LINES, { bpm: 110, bars: 8 });
  const lyrics = Object.fromEntries(choruses.map((c) => [c.name, Array.from({ length: c.bars.length / 2 }, (_, i) => LINES[i % 4]!)]));
  const after = orchestrate({ ...PARAMS, params: { [LYRIC_RHYTHMS_PARAM]: { chorus: recut }, [WRITTEN_LYRICS_PARAM]: lyrics } });

  it("the chorus lead sings the recut's notes, tiled over longer choruses", () => {
    for (const c of choruses) {
      const want = Array.from({ length: c.bars.length / 8 }, (_, t) => recut.notes.map((n) => [n.start + t * 32, n.duration])).flat();
      expect(leadNotes(after, c.name), c.name).toEqual(want);
    }
  });

  it("keeps the melody's chords and leaves the other sections alone", () => {
    for (const s of before.songStructure) {
      expect(after.songStructure.find((x) => x.name === s.name)!.bars.map((b) => b.chords), s.name).toEqual(s.bars.map((b) => b.chords));
      if (!s.name.startsWith('chorus') && before.arrangement[s.name]!.overrides.Vocal) expect(leadNotes(after, s.name)).toEqual(leadNotes(before, s.name));
    }
  });

  it('a malformed stored recut is an error naming the param', () => {
    expect(() => orchestrate({ ...PARAMS, params: { [LYRIC_RHYTHMS_PARAM]: { chorus: { pattern: 'x', bars: 8, notes: [] } } } })).toThrow(/lyricRhythms/u);
  });
});
