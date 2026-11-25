import { describe, expect, it } from 'vitest';

import { isTakeFresh, type Song } from '@casperaki/song-schema';

import { applySungVocals, applySungVocalsOver, applyWrittenLyrics, laneWordsOn, orchestrate, sungSections, type SungMelody, type SungTake } from '../src/index.js';

const PARAMS = { genre: 'brightPop', key: 'C', bpm: 110, seed: 'a' } as const;
const BARS = (song: Song, section: string, track: string) => song.arrangement[section]!.overrides[track]!.bars!;
const notesOf = (song: Song, section: string, track: string) =>
  BARS(song, section, track).flatMap((b, bi) =>
    Object.entries(b.notes ?? {}).flatMap(([beat, evs]) =>
      (evs ?? []).map((e) => ({ start: bi * 4 + Number.parseFloat(beat), ev: e as { note: number; duration: number; fullWord?: string } })),
    ),
  );

const base = orchestrate(PARAMS);
const chorus = sungSections(base).find((s) => s.name.startsWith('chorus'))!.name;
const melody: SungMelody = {
  [chorus]: [
    { start: 0, duration: 1, midi: 60, word: 'Hel-', phonemes: ['hh', 'eh1'] },
    { start: 1, duration: 1, midi: 62, word: 'Un-lo', phonemes: ['l', 'ow1'] },
    { start: 2.5, duration: 1.5, midi: 64, word: 'night', phonemes: ['n', 'ay1', 't'] },
    { start: 5, duration: 2, midi: 67, word: 'sky', phonemes: ['s', 'k', 'ay1'] },
  ],
};
const take = (segment: string, track: string, n: string): SungTake => ({
  segment, track, kind: 'yue2-vocal', sha256: n.repeat(64), durationSeconds: 8, modelId: 'm-a-p/YuE2-3B', modelVersion: 'v1', seed: 1,
});

describe('sungMelody param', () => {
  const song = orchestrate({ ...PARAMS, params: { sungMelody: melody } });

  it('puts exactly those notes and words on the lead', () => {
    const got = notesOf(song, chorus, 'Vocal').map((n) => [n.start, n.ev.note, n.ev.duration, n.ev.fullWord]);
    expect(got).toEqual(melody[chorus]!.map((n) => [n.start, n.midi, n.duration, n.word]));
  });

  it('backing vocals start with lead notes', () => {
    const starts = new Set(notesOf(song, chorus, 'Vocal').map((n) => n.start));
    for (const t of ['Backing vocals 1', 'Backing vocals 2']) {
      const b = notesOf(song, chorus, t);
      expect(b.length).toBeGreaterThan(0);
      for (const n of b) expect(starts.has(n.start)).toBe(true);
    }
  });

  it('keeps the chords', () => {
    expect(song.songStructure.map((s) => s.bars.map((b) => b.chords))).toEqual(base.songStructure.map((s) => s.bars.map((b) => b.chords)));
  });

  it('throws naming an unknown section', () => {
    expect(() => orchestrate({ ...PARAMS, params: { sungMelody: { nope9: melody[chorus] } } })).toThrow(/nope9/);
  });
});

describe('applySungVocals', () => {
  it('stamps fresh fingerprints, replaces earlier takes, and a later lyrics edit makes them stale', () => {
    const first = applySungVocals(base, { melody, takes: [take(chorus, 'Vocal', 'a')] });
    expect(first.aiArtifacts).toHaveLength(1);
    expect(isTakeFresh(first, first.aiArtifacts[0]!)).toBe(true);
    const second = applySungVocals(first, { melody, takes: [take(chorus, 'Vocal', 'b')] });
    expect(second.aiArtifacts).toHaveLength(1);
    expect(second.aiArtifacts[0]!.output.sha256).toBe('b'.repeat(64));
    expect(isTakeFresh(second, second.aiArtifacts[0]!)).toBe(true);
    expect(second.aiArtifacts[0]!.output.uri).toBe(`vocal-take:${'b'.repeat(64)}.ogg`);
    const sec = sungSections(base).find((s) => s.name === chorus)!;
    const lines = sec.lines.map((l) => [...Array.from({ length: l.length - 1 }, () => 'la'), 'day'].join(' '));
    const changed = applyWrittenLyrics(second, { [chorus]: lines });
    expect(isTakeFresh(changed, changed.aiArtifacts[0]!)).toBe(false);
  });
});

describe('applySungVocalsOver (a result merged into unsaved edits)', () => {
  it('keeps the saved takes: a section edited meanwhile comes out stale, the others fresh', () => {
    const sections = sungSections(base).map((s) => s.name);
    const other = sections.find((n) => n !== chorus)!;
    const takes = [take(chorus, 'Vocal', 'a'), take(other, 'Vocal', 'b')];
    const saved = applySungVocals(base, { melody, takes });
    // The unsaved edit: another chord in the chorus's first bar.
    const edited = {
      ...base,
      songStructure: base.songStructure.map((s) =>
        s.name === chorus ? { ...s, bars: s.bars.map((b, i) => (i === 0 ? { ...b, chords: ['Dm' as never] } : b)) } : s,
      ),
    } as Song;
    const merged = applySungVocalsOver(edited, { melody, takes }, saved);
    expect(merged.aiArtifacts).toHaveLength(2);
    const fresh = (seg: string) => isTakeFresh(merged, merged.aiArtifacts.find((a) => a.attachedTo.scope === 'segment' && a.attachedTo.segment === seg)!);
    expect(fresh(chorus)).toBe(false);
    expect(fresh(other)).toBe(true);
  });
});

describe('applySungVocals with partial (Transcribe melody: one section, no takes)', () => {
  it('replaces the melody and takes of the transcribed section only; the others keep theirs', () => {
    const sections = sungSections(base).map((s) => s.name);
    const verse = sections.find((n) => n.startsWith('verse'))!;
    const verseSung = notesOf(base, verse, 'Vocal').map((n) => ({
      start: n.start, duration: n.ev.duration, midi: n.ev.note, word: n.ev.fullWord!, phonemes: ['l', 'aa1'],
    }));
    const sung = applySungVocals(base, { melody: { ...melody, [verse]: verseSung }, takes: [take(chorus, 'Vocal', 'a'), take(verse, 'Vocal', 'b')] });
    const transcribed = verseSung.map((n, i) => ({ ...n, midi: n.midi + (i % 2 ? 2 : 0) }));
    const out = applySungVocals(sung, { melody: { [verse]: transcribed }, takes: [] }, { partial: true });
    // the transcribed section's lane is the transcription, the chorus keeps its sung melody
    expect(notesOf(out, verse, 'Vocal').map((n) => [n.start, n.ev.note, n.ev.duration, n.ev.fullWord])).toEqual(
      transcribed.map((n) => [n.start, n.midi, n.duration, n.word]),
    );
    expect(notesOf(out, chorus, 'Vocal')).toEqual(notesOf(sung, chorus, 'Vocal'));
    // the chorus's take stays (and stays fresh); the verse's take is gone
    expect(out.aiArtifacts.map((a) => a.output.sha256)).toEqual(['a'.repeat(64)]);
    expect(isTakeFresh(out, out.aiArtifacts[0]!)).toBe(true);
    // without partial every earlier take is replaced (Sing)
    expect(applySungVocals(sung, { melody: { [verse]: transcribed }, takes: [] }).aiArtifacts).toEqual([]);
  });

  it('applySungVocalsOver passes partial on', () => {
    const verse = sungSections(base).map((s) => s.name).find((n) => n.startsWith('verse'))!;
    const sung = applySungVocals(base, { melody, takes: [take(chorus, 'Vocal', 'a')] });
    const verseNotes = notesOf(base, verse, 'Vocal').map((n) => ({ start: n.start, duration: n.ev.duration, midi: n.ev.note, word: n.ev.fullWord!, phonemes: ['l', 'aa1'] }));
    const result = { melody: { [verse]: verseNotes }, takes: [] };
    const saved = applySungVocals(sung, result, { partial: true });
    const merged = applySungVocalsOver(sung, result, saved, { partial: true });
    expect(merged.aiArtifacts.map((a) => a.output.sha256)).toEqual(['a'.repeat(64)]);
  });
});

describe('laneWordsOn (pitch-only notes take the lane\'s words, as the generator attaches phrase-bank words)', () => {
  const verse = sungSections(base).map((s) => s.name).find((n) => n.startsWith('verse'))!;
  const bars = BARS(base, verse, 'Vocal');
  const lane = notesOf(base, verse, 'Vocal');
  const ev = (n: (typeof lane)[number]) => n.ev as unknown as { fullWord: string; vocaloidPhonemes: string[] };

  it('one word per note in order when the counts match', () => {
    const notes = lane.map((n) => ({ start: n.start, duration: n.ev.duration, midi: n.ev.note + 1 }));
    const out = laneWordsOn(verse, bars, notes);
    expect(out.map((n) => [n.start, n.duration, n.midi, n.word, n.phonemes])).toEqual(
      lane.map((n) => [n.start, n.ev.duration, n.ev.note + 1, ev(n).fullWord, ev(n).vocaloidPhonemes]),
    );
  });

  it('more notes in a 4-bar line cycle that line\'s words; fewer take its first ones', () => {
    const firstLine = lane.filter((n) => n.start < 16);
    const words = firstLine.map((n) => ev(n).fullWord);
    // the first line sung as twice as many 16ths-long notes from beat 0, the second line as a single note
    const many = Array.from({ length: words.length + 2 }, (_, i) => ({ start: i * 0.5, duration: 0.25, midi: 60 }));
    const secondStart = lane.find((n) => n.start >= 16)!.start;
    const out = laneWordsOn(verse, bars, [...many, { start: secondStart, duration: 1, midi: 62 }]);
    expect(out.slice(0, many.length).map((n) => n.word)).toEqual([...words, words[0], words[1]]);
    expect(out.at(-1)!.word).toBe(ev(lane.find((n) => n.start >= 16)!).fullWord);
  });

  it('a note in a 4-bar line where the lane has no words is an error naming the bars', () => {
    const empty = { ...bars[0]!, notes: {} };
    const silentFirstLine = bars.map((b, i) => (i < 4 ? empty : b));
    expect(() => laneWordsOn(verse, silentFirstLine, [{ start: 0, duration: 1, midi: 60 }])).toThrow(`${verse} bars 1-4`);
  });

  it('a note outside the section is an error', () => {
    expect(() => laneWordsOn(verse, bars, [{ start: bars.length * 4, duration: 1, midi: 60 }])).toThrow(/outside the section/);
  });
});
