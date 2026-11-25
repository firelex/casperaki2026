import { describe, expect, it } from 'vitest';

import { isTakeFresh, type Song } from '@casperaki/song-schema';

import { applySungVocals, applySungVocalsOver, applyWrittenLyrics, orchestrate, sungSections, type SungMelody, type SungTake } from '../src/index.js';

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
