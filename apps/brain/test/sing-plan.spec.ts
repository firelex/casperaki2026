// The singing plan (src/sing/plan.ts): who sings which section (YuE2 units, SoulX copies, reused takes, extension units
// for a longer later section), where the ad-libs go, the song's octave shift and YuE2's style text; plus the copy rule
// (followSung) and the ad-lib gap bars the brain hands the service.
//
// Fixture: song a31c5ba0 (edm, C, 128 bpm) trimmed to its vocal tracks (test/fixtures/sing-a31c5ba0.json). Its words
// are the phrase bank's, so the tests record written lyrics for every sung section and give verses 2-4 their own words.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { sungSections } from '@casperaki/arrangement';
import type { Song } from '@casperaki/song-schema';

import { adlibGapBars, followSung, planSinging, SingError, styleFor, type SungNote } from '../src/sing/plan.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW = readFileSync(join(HERE, 'fixtures', 'sing-a31c5ba0.json'), 'utf8');

type Ev = { type?: string; note: number; duration: number; fullWord?: string; vocaloidPhonemes?: string[] };
type Bars = { notes: Record<string, Ev[]> }[];

const fresh = (): Song => JSON.parse(RAW) as Song;
const vocalBars = (song: Song, name: string): Bars => song.arrangement[name]!.overrides!['Vocal']!.bars as unknown as Bars;
const eachNote = (song: Song, name: string, fn: (ev: Ev) => void) => {
  for (const bar of vocalBars(song, name)) for (const evs of Object.values(bar.notes)) for (const ev of evs) if (ev.type === 'vocalNote') fn(ev);
};
const chordsOf = (song: Song, name: string, from = 0, to?: number) =>
  song.songStructure.find((s) => s.name === name)!.bars.slice(from, to).flatMap((b) => b.chords);

/** Written lyrics recorded for every sung section; verses after the first get their own words (first syllable). */
function withLyrics(song: Song): Song {
  for (const s of song.songStructure) {
    const m = /^verse(\d+)$/u.exec(s.name);
    if (m && m[1] !== '1') {
      let first = true;
      eachNote(song, s.name, (ev) => {
        if (first) ev.fullWord = `Other${m[1]}-`;
        first = false;
      });
    }
  }
  const lyrics = Object.fromEntries(sungSections(song).map((s) => [s.name, [...s.words]]));
  const g = song.generator as unknown as { params: Record<string, unknown> };
  g.params = { ...g.params, params: { lyrics } };
  return song;
}

/** Changes the bar count of a section (repeating its bars cyclically when longer). */
function resize(song: Song, name: string, bars: number): Song {
  const seg = song.songStructure.find((s) => s.name === name)!;
  const lane = song.arrangement[name]!.overrides!['Vocal']! as unknown as { bars: Bars };
  const n = seg.bars.length;
  (seg as { bars: unknown[] }).bars = Array.from({ length: bars }, (_, i) => structuredClone(seg.bars[i % n]!));
  lane.bars = Array.from({ length: bars }, (_, i) => structuredClone(lane.bars[i % n]!));
  return song;
}

function dropSection(song: Song, name: string): Song {
  (song as { songStructure: unknown[] }).songStructure = song.songStructure.filter((s) => s.name !== name);
  delete (song.arrangement as Record<string, unknown>)[name];
  return song;
}

function transpose(song: Song, by: number): Song {
  for (const s of song.songStructure) if (song.arrangement[s.name]?.overrides?.['Vocal']) eachNote(song, s.name, (ev) => (ev.note += by));
  return song;
}

describe('planSinging on song a31c5ba0', () => {
  const plan = planSinging(withLyrics(fresh()));

  it('sings the first section of each type with YuE2, copies the later verses, reuses the choruses', () => {
    expect(plan.units.map((u) => u.id)).toEqual(['verse1', 'chorus1', 'bridge1']);
    expect(plan.copies).toEqual([
      { segment: 'verse2', from: 'verse1', bars: 8 },
      { segment: 'verse3', from: 'verse1', bars: 8 },
      { segment: 'verse4', from: 'verse1', bars: 8 },
    ]);
    expect(plan.reuses).toEqual(['chorus2', 'chorus3', 'chorus4', 'chorus5', 'chorus6'].map((segment) => ({ segment, from: 'chorus1' })));
    expect(plan.extensions).toEqual([]);
  });

  it('puts the ad-libs in the choruses from the middle of the song on (4-6 of 6)', () => {
    expect(plan.adlibChoruses).toEqual(['chorus4', 'chorus5', 'chorus6']);
  });

  it('sings the song an octave above its Vocal lane, in a female EDM voice', () => {
    expect(plan.octave).toBe(12);
    expect(plan.style).toBe('EDM, dance pop, energetic, female lead vocal');
  });

  it('builds each unit from the lane: one note per syllable position, words and phonemes by lyric line', () => {
    const song = withLyrics(fresh());
    const verse1 = plan.units[0]!;
    expect(verse1.lead_in_chords).toEqual(chordsOf(song, 'intro', 2, 4));
    expect(verse1.chords).toEqual(chordsOf(song, 'verse1'));
    expect(verse1.tail_chords).toEqual(chordsOf(song, 'verse2', 0, 2));
    expect(verse1.notes).toHaveLength(44);
    expect(verse1.notes[0]).toEqual({ start: 0, duration: 0.5, midi: 55 });
    expect(verse1.words.flat()).toHaveLength(44);
    expect(verse1.words.map((l) => l.length)).toEqual(verse1.phonemes.map((l) => l.length));
    expect(verse1.words[0]!.slice(0, 2)).toEqual(['Bo-', 'Dy']);
    expect(verse1.phonemes[0]![0]).toEqual(['b', 'aa1']);
    expect(verse1.lyrics).toHaveLength(verse1.words.length);
    // continued syllables join (the phrase bank capitalises each one); a word cut by the line's end keeps its first part
    expect(verse1.lyrics[0]).toBe('BoDy MoVing To The Sound Bo');
    for (let i = 1; i < verse1.notes.length; i++) expect(verse1.notes[i]!.start).toBeGreaterThan(verse1.notes[i - 1]!.start);
  });

  it('takes the tail chords across short sections (bridge1: 1-bar break3, then chorus5)', () => {
    const song = withLyrics(fresh());
    const bridge = plan.units.find((u) => u.id === 'bridge1')!;
    expect(bridge.tail_chords).toEqual([...chordsOf(song, 'break3'), ...chordsOf(song, 'chorus5', 0, 1)]);
    expect(bridge.lead_in_chords).toEqual(chordsOf(song, 'break2'));
  });
});

describe('planSinging on other song shapes', () => {
  it('a 12-bar verse3 against verse1\'s 8: a copy of 8 bars and a YuE2 unit for bars 9-12 (lead-in bars 7-8)', () => {
    const song = withLyrics(resize(fresh(), 'verse3', 12));
    const plan = planSinging(song);
    expect(plan.copies.find((c) => c.segment === 'verse3')).toEqual({ segment: 'verse3', from: 'verse1', bars: 8 });
    expect(plan.extensions).toEqual([{ segment: 'verse3', unit: 'verse3_ext', fromBar: 8 }]);
    const ext = plan.units.find((u) => u.id === 'verse3_ext')!;
    expect(ext.lead_in_chords).toEqual(chordsOf(song, 'verse3', 6, 8));
    expect(ext.chords).toEqual(chordsOf(song, 'verse3', 8, 12));
    expect(ext.tail_chords).toEqual(chordsOf(song, 'verse4', 0, 2));
    // bars 9-12 repeat bars 1-4: the same notes, from beat 0 of the unit
    expect(ext.notes).toEqual(plan.units[0]!.notes.filter((n) => n.start < 16));
    expect(ext.words.flat()).toHaveLength(ext.notes.length);
  });

  it('a 4-bar verse3: the copy is cut to 4 bars', () => {
    const plan = planSinging(withLyrics(resize(fresh(), 'verse3', 4)));
    expect(plan.copies.find((c) => c.segment === 'verse3')).toEqual({ segment: 'verse3', from: 'verse1', bars: 4 });
    expect(plan.extensions).toEqual([]);
  });

  it('five choruses: ad-libs in choruses 3-5', () => {
    const plan = planSinging(withLyrics(dropSection(fresh(), 'chorus6')));
    expect(plan.adlibChoruses).toEqual(['chorus3', 'chorus4', 'chorus5']);
    // chorus5 is now the song's last section: nothing changes for the units
    expect(plan.units.map((u) => u.id)).toEqual(['verse1', 'chorus1', 'bridge1']);
  });

  it('a later chorus with other words is copied, not reused', () => {
    const song = withLyrics(fresh());
    let first = true;
    eachNote(song, 'chorus3', (ev) => {
      if (first) ev.fullWord = 'Other-';
      first = false;
    });
    const plan = planSinging(song);
    expect(plan.copies.map((c) => c.segment)).toEqual(['verse2', 'verse3', 'verse4', 'chorus3']);
    expect(plan.reuses.map((r) => r.segment)).toEqual(['chorus2', 'chorus4', 'chorus5', 'chorus6']);
  });

  it('the song\'s last sung section, when a unit, repeats its own last 2 bars as the tail', () => {
    const song = withLyrics(fresh());
    for (const name of ['chorus5', 'chorus6', 'break3']) dropSection(song, name);
    const bridge = planSinging(song).units.find((u) => u.id === 'bridge1')!;
    expect(bridge.tail_chords).toEqual(chordsOf(song, 'bridge1', 6, 8));
  });

  it('without written lyrics for every sung section: "Write lyrics first"', () => {
    expect(() => planSinging(fresh())).toThrow(new SingError('Write lyrics first'));
    const song = withLyrics(fresh());
    const params = (song.generator as unknown as { params: { params: { lyrics: Record<string, string[]> } } }).params.params;
    delete params.lyrics['verse3'];
    expect(() => planSinging(song)).toThrow(new SingError('Write lyrics first'));
  });

  it('a hidden melody: "Write a melody first"', () => {
    const song = withLyrics(fresh());
    const g = song.generator as unknown as { params: { params: Record<string, unknown> } };
    g.params.params['vocalMelody'] = false;
    for (const s of song.songStructure) if (song.arrangement[s.name]!.overrides['Vocal']) delete (song.arrangement[s.name]!.overrides as Record<string, unknown>)['Vocal'];
    expect(() => planSinging(song)).toThrow(new SingError('Write a melody first'));
  });
});

describe('the octave shift', () => {
  it('a lane already in singing range: no shift', () => {
    expect(planSinging(withLyrics(transpose(fresh(), 12))).octave).toBe(0);
  });

  it('a low lane: +12 is the only shift that fits', () => {
    expect(planSinging(withLyrics(transpose(fresh(), -12))).octave).toBe(12);
  });

  it('a tie goes to the higher shift', () => {
    const song = withLyrics(fresh());
    for (const s of song.songStructure) if (song.arrangement[s.name]?.overrides?.['Vocal']) eachNote(song, s.name, (ev) => (ev.note = 65));
    // median 65: shift 0 sings F4 (6 below B4), shift +12 sings F5 (6 above): the higher wins
    expect(planSinging(song).octave).toBe(12);
  });

  it('a melody no shift fits: an error naming its range', () => {
    const song = withLyrics(fresh());
    let k = 0;
    eachNote(song, 'verse1', (ev) => {
      if (k === 0) ev.note = 40;
      if (k === 1) ev.note = 80;
      k++;
    });
    expect(() => planSinging(song)).toThrow(SingError);
    expect(() => planSinging(song)).toThrow(/E2.*G#5/u);
  });
});

describe('styleFor', () => {
  it('one short phrase per genre, ending in the female lead', () => {
    for (const g of ['ballad', 'brightPop', 'edm', 'latin', 'organicVibes', 'rock', 'schlager', 'urban']) {
      expect(styleFor(g)).toMatch(/, female lead vocal$/u);
    }
    expect(styleFor('edm')).toBe('EDM, dance pop, energetic, female lead vocal');
  });

  it('an unknown genre is an error', () => {
    expect(() => styleFor('polka')).toThrow(SingError);
  });
});

describe('followSung (the copy rule)', () => {
  const note = (start: number, duration: number, word: string, midi = 60) => ({ start, duration, midi, word, phonemes: [word.toLowerCase()] });
  const source = [note(0, 1, 'A'), note(1, 1, 'B'), note(2, 2, 'C')];
  const sung: SungNote[] = [
    { start: 0.25, duration: 0.75, midi: 64, word: 'A', phonemes: ['a'] },
    { start: 1, duration: 0.5, midi: 65, word: 'B', phonemes: ['b'] },
    { start: 2, duration: 1.5, midi: 67, word: 'C', phonemes: ['c'] },
  ];

  it('each target note takes the sung note of the source position at or before it, with its own words', () => {
    const target = [note(0, 1, 'X'), note(1, 1, 'Y'), note(2, 2, 'Z')];
    expect(followSung(target, source, sung, 'verse2')).toEqual([
      { start: 0.25, duration: 0.75, midi: 64, word: 'X', phonemes: ['x'] },
      { start: 1, duration: 0.5, midi: 65, word: 'Y', phonemes: ['y'] },
      { start: 2, duration: 1.5, midi: 67, word: 'Z', phonemes: ['z'] },
    ]);
  });

  it('a note the lyrics split off takes its parent\'s pitch, offset by the same beats, and the parent ends there', () => {
    const target = [note(0, 1, 'X'), note(1, 1, 'Y'), note(2, 1, 'Z1'), note(3, 1, 'Z2')];
    expect(followSung(target, source, sung, 'verse2').slice(2)).toEqual([
      { start: 2, duration: 1, midi: 67, word: 'Z1', phonemes: ['z1'] },
      { start: 3, duration: 0.5, midi: 67, word: 'Z2', phonemes: ['z2'] },
    ]);
  });

  it('a target note before the source\'s first note is an error naming the section', () => {
    const late = [note(1, 1, 'B'), note(2, 2, 'C')];
    expect(() => followSung([note(0, 1, 'X')], late, sung.slice(1), 'verse2')).toThrow(/verse2: a note at beat 0/u);
  });

  it('a sung melody of another length than the source is an error', () => {
    expect(() => followSung(source, source, sung.slice(1), 'verse2')).toThrow(/verse2/u);
  });
});

describe('adlibGapBars', () => {
  it('bars where the lead rests or holds for two beats or more', () => {
    const n = (start: number, duration: number): SungNote => ({ start, duration, midi: 60, word: 'a', phonemes: ['aa1'] });
    // bar 0 busy; bar 1 holds from beat 4 to 8; bar 2 busy; bar 3 empty
    const melody = [n(0, 1), n(1, 1), n(2, 1), n(3, 1), n(4, 4), n(8, 1), n(9, 1), n(10, 1), n(11, 1)];
    expect(adlibGapBars(melody, 4)).toEqual([1, 3]);
  });
});
