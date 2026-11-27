import { describe, expect, it } from 'vitest';
import type { Song } from '@casperaki/song-schema';

import { applyLyricsFirst, checkLyricLine, checkSectionLyrics, generatorParams, lyricLines, newMelody, newRhythm, orchestrate, sungSections, TrackEditError } from '../src/index.js';
import { LYRIC_RHYTHMS_PARAM } from '../src/vocals/lyric-rhythms.js';
import { SUNG_MELODY_PARAM } from '../src/vocals/sung-melody.js';
import { MELODY as HUM_MELODY, CHORDS as HUM_CHORDS } from './hum-fixture.js';

const PARAMS = { genre: 'brightPop', key: 'C', bpm: 110, seed: 'a' } as const;
const LYRICS = {
  verse: ['Saw your phone light up again', 'A name I do not know', 'You said it was nothing', 'But I could see it show'],
  preChorus: ['Now I am walking fast', 'Hoping this will last', 'Do not wait for me', 'I am already past'],
  chorus: ['You gotta feel it', 'Take me home tonight', 'Maybe I was wrong about you', 'Hold me till the light'],
  bridge: ['Turn the corner lose the map', 'I do not want it back', 'Maybe it is nothing', 'But I like it like that'],
};

const lead = (song: Song, name: string) => JSON.stringify(song.arrangement[name]?.overrides.Vocal?.bars ?? null);
const onsets = (song: Song, name: string) =>
  JSON.stringify((song.arrangement[name]!.overrides.Vocal!.bars ?? []).map((b) => Object.keys(b.notes ?? {}).filter((k) => (b.notes![k] ?? []).some((e) => e.type === 'vocalNote')).sort()));
const pitches = (song: Song, name: string) =>
  JSON.stringify((song.arrangement[name]!.overrides.Vocal!.bars ?? []).map((b) => Object.values(b.notes ?? {}).flat().filter((e) => e.type === 'vocalNote').map((e) => (e as { note: number }).note)));
const chords = (song: Song) => JSON.stringify(song.songStructure.map((s) => [s.name, s.bars.map((b) => b.chords)]));

describe('lyrics first', () => {
  const song = orchestrate(PARAMS);
  const written = applyLyricsFirst(song, LYRICS);

  it('every lead note sings a syllable of the words, and the words pass the line check', () => {
    for (const s of sungSections(written)) {
      expect(s.words.length, s.name).toBeGreaterThan(0);
      const bars = written.arrangement[s.name]!.overrides.Vocal!.bars!;
      const lines = lyricLines(bars);
      const text = (LYRICS as Record<string, string[]>)[s.type]!;
      expect(checkSectionLyrics(lines, Array.from({ length: lines.length }, (_, i) => text[i % text.length]!)), s.name).toEqual([]);
    }
  });

  it("keeps the song's melody choice: the same chords everywhere", () => {
    expect(chords(written)).toBe(chords(song));
  });

  it('records the recut rhythm per type', () => {
    const p = generatorParams(written).params as Record<string, Record<string, unknown>>;
    expect(Object.keys(p[LYRIC_RHYTHMS_PARAM]!).sort()).toEqual(Object.keys(LYRICS).filter((t) => sungSections(song).some((s) => s.type === t)).sort());
  });

  it('New rhythm bends another rhythm to the same words; chords and words stay', () => {
    const again = newRhythm(written, 'chorus');
    expect(onsets(again, 'chorus1')).not.toBe(onsets(written, 'chorus1'));
    expect(sungSections(again).find((s) => s.name === 'chorus1')!.words).toEqual(sungSections(written).find((s) => s.name === 'chorus1')!.words);
    expect(chords(again)).toBe(chords(written));
    expect(lead(again, 'verse1')).toBe(lead(written, 'verse1'));
  });

  it('Change melody on a lyrics-first type keeps its rhythm and words and changes its pitches', () => {
    const made = newMelody(written, 'chorus').song;
    expect(onsets(made, 'chorus1')).toBe(onsets(written, 'chorus1'));
    expect(pitches(made, 'chorus1')).not.toBe(pitches(written, 'chorus1'));
    expect(sungSections(made).find((s) => s.name === 'chorus1')!.words).toEqual(sungSections(written).find((s) => s.name === 'chorus1')!.words);
  });

  it('New rhythm without lyrics-first words is refused', () => {
    expect(() => newRhythm(song, 'chorus')).toThrow(TrackEditError);
    try {
      newRhythm(song, 'chorus');
    } catch (e) {
      expect((e as TrackEditError).status).toBe(409);
      expect((e as TrackEditError).code).toBe('no_lyrics');
    }
  });

  it('a hummed chorus gets the words on its own pitches, its rhythm recut', () => {
    const hummed = orchestrate({ ...PARAMS, key: 'E', params: { userChorus: { melody: HUM_MELODY, chords: HUM_CHORDS } } });
    const out = applyLyricsFirst(hummed, { chorus: LYRICS.chorus });
    const humPitches = new Set(JSON.parse(pitches(hummed, 'chorus1')).flat().map((n: number) => n % 12));
    for (const n of JSON.parse(pitches(out, 'chorus1')).flat()) expect(humPitches.has(n % 12)).toBe(true);
    expect(() => newMelody(out, 'chorus')).toThrow(/hummed/u);
  });

  it("new words drop the type's sung melody", () => {
    const p = generatorParams(written);
    const sungParams = { ...p, params: { ...(p.params ?? {}), [SUNG_MELODY_PARAM]: { chorus1: [{ start: 0, duration: 1, midi: 60, word: 'Hey', phonemes: ['hh', 'ey1'] }] } } };
    const withSung = { ...written, generator: { ...written.generator!, params: sungParams } } as Song;
    const out = applyLyricsFirst(withSung, { chorus: LYRICS.chorus });
    expect((generatorParams(out).params as Record<string, unknown>)[SUNG_MELODY_PARAM]).toBeUndefined();
  });
});

describe('lyrics first on a section longer than its pattern', () => {
  it('a 12-bar chorus sings each line on the rhythm of the line its bars were copied from', () => {
    const lines = ['You gotta feel it', 'Take me home tonight', 'Maybe I was wrong about you', 'Hold me till the light'];
    for (const seed of ['a', 'b', 'c']) {
      const song = orchestrate({ genre: 'brightPop', key: 'C', bpm: 110, seed, params: { structure: [{ name: 'verse1', bars: 8 }, { name: 'chorus1', bars: 12 }] } });
      const out = applyLyricsFirst(song, { verse: LYRICS.verse, chorus: lines });
      const sung = lyricLines(out.arrangement.chorus1!.overrides.Vocal!.bars!);
      expect(sung, seed).toHaveLength(6);
      // Bars 9-12 repeat bars 5-8 (the pattern's lines 3 and 4), so lines 5 and 6 are lines 3 and 4 again.
      const words = (generatorParams(out).params as { lyrics: Record<string, string[]> }).lyrics.chorus1!;
      expect(words, seed).toEqual([...lines, lines[2], lines[3]]);
      words.forEach((w, i) => expect(checkLyricLine(w, sung[i]!), `${seed} line ${i + 1}`).toBeUndefined());
    }
  });
});
