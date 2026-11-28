// The singing plan (src/sing/plan.ts): every section with Vocal notes (and written lyrics) is sung by SoulX straight
// from the lane's notes, words and phonemes; the backing lines are the backing lanes' notes in those sections, each
// moved by whole octaves into the singable range near the lead (backingShift).
//
// Fixture: song a31c5ba0 (edm, C, 128 bpm) trimmed to its vocal tracks (test/fixtures/sing-a31c5ba0.json). Its words
// are the phrase bank's, so the tests record written lyrics for every sung section.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { sungSections } from '@casperaki/arrangement';
import type { Song } from '@casperaki/song-schema';

import { backingShift, laneNotes, planSinging, SingError } from '../src/sing/plan.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW = readFileSync(join(HERE, 'fixtures', 'sing-a31c5ba0.json'), 'utf8');

type Ev = { type?: string; note: number; duration: number; fullWord?: string; vocaloidPhonemes?: string[] };
type Bars = { notes: Record<string, Ev[]> }[];

const fresh = (): Song => JSON.parse(RAW) as Song;
const laneOf = (song: Song, name: string, track = 'Vocal'): Bars => song.arrangement[name]!.overrides![track]!.bars as unknown as Bars;
const eachNote = (song: Song, name: string, fn: (ev: Ev) => void) => {
  for (const bar of laneOf(song, name)) for (const evs of Object.values(bar.notes)) for (const ev of evs) if (ev.type === 'vocalNote') fn(ev);
};

/** Written lyrics recorded for every sung section (the lane's own words). */
function withLyrics(song: Song): Song {
  const lyrics = Object.fromEntries(sungSections(song).map((s) => [s.name, [...s.words]]));
  const g = song.generator as unknown as { params: Record<string, unknown> };
  g.params = { ...g.params, params: { lyrics } };
  return song;
}

/** Gives a section a backing lane: the lead's notes moved by `by` semitones (no words, as the generator writes them). */
function withBacking(song: Song, name: string, track: string, by: number): Song {
  const bars = laneOf(song, name).map((bar) => ({
    notes: Object.fromEntries(
      Object.entries(bar.notes).map(([k, evs]) => [k, evs.filter((e) => e.type === 'vocalNote').map((e) => ({ type: 'vocalNote', note: e.note + by, duration: e.duration }))]),
    ),
  }));
  (song.arrangement[name]!.overrides as Record<string, unknown>)[track] = { bars };
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

describe('planSinging on song a31c5ba0', () => {
  it('sings every section with Vocal notes, in song order, from the lane\'s own notes, words and phonemes', () => {
    const song = withLyrics(fresh());
    const plan = planSinging(song);
    // Every section with Vocal notes is sung, or reuses an earlier section that sings the same notes and words.
    const all = ['verse1', 'verse2', 'chorus1', 'chorus2', 'verse3', 'verse4', 'chorus3', 'chorus4', 'bridge1', 'chorus5', 'chorus6'];
    expect(sungSections(song).map((s) => s.name)).toEqual(all);
    expect([...plan.sections.map((s) => s.segment), ...plan.reuses.map((r) => r.segment)].sort()).toEqual([...all].sort());
    expect(plan.sections.map((s) => s.segment)).toEqual(all.filter((n) => !plan.reuses.some((r) => r.segment === n)));
    expect(plan.reuses.length).toBeGreaterThan(0); // this song repeats its choruses word for word
    for (const r of plan.reuses) {
      expect(all.indexOf(r.from)).toBeLessThan(all.indexOf(r.segment));
      expect(laneNotes(song, r.segment, 'Vocal')).toEqual(laneNotes(song, r.from, 'Vocal'));
    }
    expect(plan.sections.every((s) => s.sectionBars === 8)).toBe(true);
    const verse1 = plan.sections[0]!;
    expect(verse1.notes).toHaveLength(44);
    const first = laneOf(song, 'verse1')[0]!.notes['0.0']!.find((e) => e.type === 'vocalNote')!;
    expect(verse1.notes[0]).toEqual({ start: 0, duration: first.duration, midi: first.note, word: first.fullWord, phonemes: first.vocaloidPhonemes });
    // the lane's pitch exactly: no octave shift
    const lane: number[] = [];
    eachNote(song, 'verse1', (ev) => lane.push(ev.note));
    expect(verse1.notes.map((n) => n.midi).sort()).toEqual(lane.sort());
    for (let i = 1; i < verse1.notes.length; i++) expect(verse1.notes[i]!.start).toBeGreaterThan(verse1.notes[i - 1]!.start);
    expect(plan.backings).toEqual([]);
  });

  it('gives each sung section the beats from its end to the next sung note (owner, 2026-11-27: "space" was cut off at the bridge\'s end)', () => {
    const plan = planSinging(withLyrics(fresh()));
    const rest = Object.fromEntries(plan.sections.map((s) => [s.segment, s.restAfter]));
    // verse1's take is played for verse1 to 4: verse1 is followed by verse2 singing on its first beat.
    expect(rest['verse1']).toBe(0);
    expect(rest['bridge1']).toBe(5); // break3 (a bar) without singing, then chorus5 a beat in
    // chorus1's take is played for every chorus: the least room after any of them (chorus2 alone would have 4).
    expect(plan.reuses.some((r) => r.from === 'chorus1' && r.segment === 'chorus2')).toBe(true);
    expect(rest['chorus1']).toBe(1);
  });

  it('nothing sung after the last section: no limit (null)', () => {
    const song = withLyrics(fresh());
    const plan = planSinging(song);
    const last = sungSections(song).at(-1)!.name;
    const owner = plan.reuses.find((r) => r.segment === last)?.from ?? last;
    const others = [...plan.reuses.filter((r) => r.from === owner).map((r) => r.segment), owner].filter((n) => n !== last);
    // The last section's own room is unlimited; its take's room is the least of its copies' (others are followed by singing).
    expect(plan.sections.find((s) => s.segment === owner)!.restAfter).toBe(others.length === 0 ? null : 1);
  });

  it('a song without a chorus is sung too', () => {
    const song = withLyrics(fresh());
    for (const name of ['chorus1', 'chorus2', 'chorus3', 'chorus4', 'chorus5', 'chorus6']) dropSection(song, name);
    const plan = planSinging(song);
    expect([...plan.sections.map((s) => s.segment), ...plan.reuses.map((r) => r.segment)].sort()).toEqual(['bridge1', 'verse1', 'verse2', 'verse3', 'verse4']);
  });

  it('backing lines come from the backing lanes of the sung sections, each moved into F3-A5 near the lead', () => {
    // chorus1's lead sits around G4; a line 16 below it reaches under F3 and goes up an octave, one 3 above stays
    const song = withBacking(withBacking(withLyrics(fresh()), 'chorus1', 'Backing vocals 1', -16), 'chorus1', 'Backing vocals 2', 3);
    const plan = planSinging(song);
    expect(plan.backings.map((b) => [b.track, b.segment, b.shift])).toEqual([
      ['Backing vocals 1', 'chorus1', 12],
      ['Backing vocals 2', 'chorus1', 0],
    ]);
    const lead = plan.sections.find((s) => s.segment === 'chorus1')!.notes;
    const b1 = plan.backings[0]!;
    expect(b1.notes.map((n) => ({ start: n.start, duration: n.duration }))).toEqual(lead.map((n) => ({ start: n.start, duration: n.duration })));
    expect(b1.notes.map((n) => n.midi)).toEqual(lead.map((n) => n.midi - 16 + 12));
    for (const b of plan.backings) for (const n of b.notes) expect(n.midi).toBeGreaterThanOrEqual(53);
  });

  it('a backing line no octave fits: an error naming it and its range', () => {
    const song = withBacking(withLyrics(fresh()), 'chorus1', 'Backing vocals 1', 0);
    const bars = laneOf(song, 'chorus1', 'Backing vocals 1');
    const evs = Object.values(bars[0]!.notes).flat();
    evs[0]!.note = 40;
    evs[1]!.note = 80;
    expect(() => planSinging(song)).toThrow(new SingError('Backing vocals 1 in chorus1 spans E2-G#5, which no octave shift puts within the singable range F3-A5'));
  });

  it('without written lyrics for every sung section: "Write lyrics first"', () => {
    expect(() => planSinging(fresh())).toThrow(new SingError('Write lyrics first'));
    const song = withLyrics(fresh());
    const params = (song.generator as unknown as { params: { params: { lyrics: Record<string, string[]> } } }).params.params;
    delete params.lyrics['verse3'];
    expect(() => planSinging(song)).toThrow(new SingError('Write lyrics first'));
    params.lyrics['verse3'] = [];
    expect(() => planSinging(song)).toThrow(new SingError('Write lyrics first'));
  });

  it('the chosen sections only: their lyrics needed, the rest left alone; an unknown or unsung one an error', () => {
    const song = withLyrics(fresh());
    const params = (song.generator as unknown as { params: { params: { lyrics: Record<string, string[]> } } }).params.params;
    delete params.lyrics['verse3'];
    const plan = planSinging(song, ['verse1', 'chorus1']);
    expect(plan.sections.map((s) => s.segment)).toEqual(['verse1', 'chorus1']);
    expect(plan.reuses).toEqual([]);
    // the rest after verse1 runs to the next section with a melody (verse2), sung now or not
    expect(plan.sections[0]!.restAfter).toBe(planSinging(withLyrics(fresh())).sections[0]!.restAfter);
    expect(() => planSinging(song, ['verse3'])).toThrow(new SingError('Write lyrics first'));
    expect(() => planSinging(song, ['intro1', 'nowhere'])).toThrow(new SingError('intro1, nowhere have no melody to sing'));
    expect(() => planSinging(song, [])).toThrow(new SingError('Choose a section to sing'));
  });

  it('a lead note without phonemes: an error naming where', () => {
    const song = withLyrics(fresh());
    let first = true;
    eachNote(song, 'verse2', (ev) => {
      if (first) ev.vocaloidPhonemes = [];
      first = false;
    });
    expect(() => planSinging(song)).toThrow(/^Vocal in verse2 bar 1 beat 0.0: a note without phonemes: write lyrics first$/u);
  });

  it('a section resized in the editor: an error naming it, before "Write lyrics first"', () => {
    expect(() => planSinging(resize(fresh(), 'verse3', 12))).toThrow(
      new SingError('The section verse3 has 12 bars, but 8 as the song was generated (resized in the editor), so it cannot be sung'),
    );
  });

  it('a section renamed (or added) in the editor: an error naming it, before "Write lyrics first"', () => {
    const song = fresh();
    const seg = song.songStructure.find((s) => s.name === 'verse3')!;
    (seg as { name: string }).name = 'verse9';
    (song.arrangement as Record<string, unknown>)['verse9'] = song.arrangement['verse3'];
    delete (song.arrangement as Record<string, unknown>)['verse3'];
    expect(() => planSinging(song)).toThrow(
      new SingError('The section verse9 was added or renamed in the editor, so it cannot be sung: only sections as the song was generated can be'),
    );
  });

  it('a hidden melody: "Write a melody first"', () => {
    const song = withLyrics(fresh());
    const g = song.generator as unknown as { params: { params: Record<string, unknown> } };
    g.params.params['vocalMelody'] = false;
    for (const s of song.songStructure) if (song.arrangement[s.name]!.overrides['Vocal']) delete (song.arrangement[s.name]!.overrides as Record<string, unknown>)['Vocal'];
    expect(() => planSinging(song)).toThrow(new SingError('Write a melody first'));
  });
});

describe('backingShift: a backing line\'s own octave', () => {
  it('moves a line below F3 up an octave, toward the lead', () => {
    expect(backingShift([43, 50, 55, 60], [60, 67, 72, 76], 'Backing vocals 1 in chorus1')).toBe(12);
  });
  it('keeps a line that fits and sits nearest the lead where it is', () => {
    expect(backingShift([60, 62, 64], [64, 67, 69], 'Backing vocals 2 in chorus1')).toBe(0);
  });
  it('takes the lower shift on a tie', () => {
    expect(backingShift([60], [66], 'Backing vocals 1 in chorus1')).toBe(0);
  });
  it('fails naming the track, the section and the line\'s range when no shift fits', () => {
    expect(() => backingShift([40, 75], [60], 'Backing vocals 2 in bridge1')).toThrow(
      'Backing vocals 2 in bridge1 spans E2-D#5, which no octave shift puts within the singable range F3-A5',
    );
  });
});
