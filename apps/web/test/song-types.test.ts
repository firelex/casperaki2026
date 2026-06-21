import { describe, it, expect } from 'vitest';

import {
  buildSegmentDetail,
  CANONICAL_GENRES,
  distinctChordCount,
  extractLyricLines,
  generatorView,
  summarizeChordProgression,
  summarizeSegmentPatterns,
  summarizeStructure,
} from '../src/types/song';
import { makeFixtureSong } from './fixture';

describe('song view helpers', () => {
  const fixture = makeFixtureSong();

  it('exposes the canonical genre vocabulary (no `pop` alias)', () => {
    expect(CANONICAL_GENRES).toContain('brightPop');
    expect(CANONICAL_GENRES).not.toContain('pop');
  });

  it('summarises structure with active instruments per segment', () => {
    const summary = summarizeStructure(fixture.song);
    expect(summary).toHaveLength(2);
    expect(summary[0]?.name).toBe('intro');
    expect(summary[0]?.activeInstruments).toEqual(
      expect.arrayContaining(['Drums', 'Bass', 'Keys']),
    );
    expect(summary[0]?.activeInstruments).not.toContain('Pad');
    expect(summary[0]?.bars).toBe(4);
  });

  it('counts distinct chord symbols across the song', () => {
    expect(distinctChordCount(fixture.song.songStructure)).toBe(4);
  });

  it('summarises per-instrument patterns including drum ASCII', () => {
    const patterns = summarizeSegmentPatterns(fixture.song, 'intro');
    const drums = patterns.find((p) => p.instrument === 'Drums');
    expect(drums?.drumPattern?.bassDrum1).toBe('x...x...x...x...');

    const bass = patterns.find((p) => p.instrument === 'Bass');
    expect(bass?.totalEvents).toBe(2);
    expect(bass?.bars[0]?.beats).toEqual(['0.0', '2.0']);
  });

  it('extracts lyric lines from the lead vocal override', () => {
    const lead = extractLyricLines(fixture.song, 'Vocal');
    expect(lead).toHaveLength(1);
    expect(lead[0]?.segment).toBe('verse1');
    expect(lead[0]?.lines[0]?.words).toEqual(['hello']);
    expect(lead[0]?.lines[1]?.endOfPhrase).toBe(true);
  });

  it('summarises the chord progression with unique chord set + change count', () => {
    const verse = fixture.song.songStructure[1]!;
    const view = summarizeChordProgression(verse);
    expect(view.bars).toHaveLength(8);
    expect(view.bars[0]).toEqual(['C', 'F', 'G', 'C']);
    expect(view.unique).toEqual(['C', 'F', 'G']);
    expect(view.totalChanges).toBe(8 * 4);
  });

  it('builds a segment detail aggregating instruments, patterns, vocals, fills, fx', () => {
    const detail = buildSegmentDetail(fixture.song, 'verse1');
    expect(detail).toBeDefined();
    expect(detail?.name).toBe('verse1');
    expect(detail?.kind).toBe('verse');
    expect(detail?.bars).toBe(8);
    expect(detail?.activeInstruments).toEqual(
      expect.arrayContaining(['Drums', 'Bass', 'Keys', 'Pad', 'Vocal', 'Backing vocals 1']),
    );
    expect(detail?.activeInstruments).not.toContain('Backing vocals 2');

    expect(detail?.chordProgression.unique).toEqual(['C', 'F', 'G']);
    expect(detail?.leadVocalLines.map((l) => l.words.join(' '))).toEqual(['hello', 'world']);

    const backing = detail?.backingVocals ?? [];
    expect(backing.map((b) => b.name)).toEqual(['Backing vocals 1', 'Backing vocals 2']);
    const bv1 = backing.find((b) => b.name === 'Backing vocals 1');
    expect(bv1?.active).toBe(true);
    expect(bv1?.hasOverride).toBe(true);
    expect(bv1?.lyricLineCount).toBe(1);
    const bv2 = backing.find((b) => b.name === 'Backing vocals 2');
    expect(bv2?.active).toBe(false);
    expect(bv2?.hasOverride).toBe(false);

    expect(detail?.fills).toEqual([
      { instrument: 'Drums', patternNames: ['patternFourthBar', 'patternEndOfSegment'] },
    ]);
    expect(detail?.transitions).toEqual(['Riser']);
    expect(detail?.mutes).toEqual(['Pad']);

    expect(detail?.signalProcessors).toEqual([
      {
        instrument: 'Drums',
        type: 'lowPassFilter1000SweepUp',
        parameters: ['lowPassFilter'],
      },
    ]);
  });

  it('returns undefined for missing segments and a minimal detail when arrangement is empty', () => {
    expect(buildSegmentDetail(fixture.song, 'nope')).toBeUndefined();
    expect(buildSegmentDetail(fixture.song, undefined)).toBeUndefined();

    const introDetail = buildSegmentDetail(fixture.song, 'intro');
    expect(introDetail?.active).toBe(true);
    expect(introDetail?.leadVocalLines).toEqual([]);
    expect(introDetail?.backingVocals).toEqual([]);
    expect(introDetail?.fills).toEqual([]);
    expect(introDetail?.transitions).toEqual([]);
    expect(introDetail?.signalProcessors).toEqual([]);
  });

  it('builds a generator provenance view', () => {
    const view = generatorView(fixture.song);
    expect(view?.name).toBe('orchestrate');
    expect(view?.seed).toBe('demo-1');
    expect(view?.genre).toBe('brightPop');
  });
});
