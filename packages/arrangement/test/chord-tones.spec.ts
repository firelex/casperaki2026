// Pattern lab styles for the pitched families and guitar (chord-tones.ts,
// authored-bank.ts, the patterns/index.ts hook).

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { Song } from '@casperaki/song-schema';

import { orchestrate } from '../src/index.js';
import { authoredStylesFor } from '../src/patterns/authored-bank.js';
import { resolveChordTone, sectionEnergy } from '../src/patterns/chord-tones.js';
import { loadPatternProposals } from '../src/patterns/proposals.js';

/** First seed whose song has a lane of `family` (by instrument name prefix). */
function songWithLane(genre: 'ballad' | 'brightPop' | 'organicVibes', lane: string, params?: Record<string, unknown>): Song {
  for (let i = 0; i < 60; i++) {
    const song = orchestrate({ genre, key: 'C', bpm: 90, seed: `chord-tones-${i}`, ...(params ? { params } : {}) });
    if (song.instrumentDefinitions.some((d) => d.name === lane)) return song;
  }
  throw new Error(`no seed gave a ${lane} lane`);
}

function laneEvents(song: Song, lane: string) {
  return Object.entries(song.arrangement).flatMap(([section, seg]) =>
    (seg.overrides[lane]?.bars ?? []).flatMap((bar) => Object.entries(bar.notes).flatMap(([beat, evs]) => (evs ?? []).map((e) => ({ section, beat, e })))),
  );
}

const tmpProposals = (content: unknown) => {
  const dir = mkdtempSync(join(tmpdir(), 'proposals-'));
  writeFileSync(join(dir, 'a.json'), JSON.stringify(content));
  return dir;
};

describe('chord-tone patterns', () => {
  it('a note moves to the nearest chord tone, a tie going down', () => {
    expect(resolveChordTone(4, 'C')).toBe(64); // E on C stays
    expect(resolveChordTone(4, 'Am')).toBe(64); // E is in Am
    expect(resolveChordTone(7, 'Am')).toBe(69); // G -> A (2 up beats 3 down to E)
    expect(resolveChordTone(7, 'F')).toBe(65); // G: F and A are both 2 away -> F (down)
    expect(resolveChordTone(0, 'G7')).toBe(59); // C -> B, one below (D is two above)
  });

  it('sections ask for quiet or full patterns', () => {
    expect(sectionEnergy('verse1')).toBe('low');
    expect(sectionEnergy('chorus2')).toBe('high');
    expect(sectionEnergy('bridge')).toBeUndefined();
  });

  it('a keys preview plays the proposed notes, choosing by section energy', () => {
    const preview = {
      lanePreview: {
        family: 'keys',
        kind: 'chordTones',
        patterns: [
          { bars: 1, energy: 'low', notes: [[0, 4, 4]] },
          { bars: 1, energy: 'high', notes: [[0, 7, 1], [1, 7, 1], [2, 7, 1], [3, 7, 1]] },
        ],
      },
    };
    const song = songWithLane('ballad', 'Keys', preview);
    const again = orchestrate({ ...song.generator!.params, seed: song.generator!.seed } as never);
    expect(JSON.stringify(again)).toBe(JSON.stringify(song));
    const events = laneEvents(song, 'Keys');
    expect(events.length).toBeGreaterThan(0);
    for (const { section, beat, e } of events) {
      expect(e.type).toBe('noteRelative');
      const d = (e as { distanceFromMiddleC: number }).distanceFromMiddleC;
      if (sectionEnergy(section) === 'low') expect([beat, d]).toEqual(['0.0', 4]);
      if (sectionEnergy(section) === 'high') expect(d).toBe(7);
    }
  });

  it('a guitar preview plays strums over the chord shape', () => {
    const preview = { lanePreview: { family: 'guitar', kind: 'guitarPicks', patterns: [{ bars: 1, hits: [[0, [0, 1, 2], 1, 90], [1, [3], 0.5, 70]] }] } };
    const song = songWithLane('organicVibes', 'Guitar', preview);
    const events = laneEvents(song, 'Guitar');
    expect(events.length).toBeGreaterThan(0);
    const strum = events.find((x) => x.beat === '0.0')!.e as { type: string; strings: number[]; offset: number[] };
    expect(strum.type).toBe('strum');
    expect(strum.strings).toEqual([0, 1, 2]);
    expect(strum.offset).toEqual([0, 0.02, 0.04]);
  });

  it('songs are unchanged while no style is approved', () => {
    expect(authoredStylesFor('keys', 'ballad')).toEqual([]);
  });

  it('the bank and proposals refuse styles that leave a section silent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'authored-'));
    writeFileSync(join(dir, 'p.json'), JSON.stringify([{ bars: 1, energy: 'high', notes: [[0, 0, 1]] }]));
    writeFileSync(
      join(dir, 'index.json'),
      JSON.stringify({ $schemaVersion: 1, styles: { 'authored-x': { family: 'keys', kind: 'chordTones', genres: ['ballad'], file: 'p.json' } } }),
    );
    expect(() => authoredStylesFor('keys', 'ballad', dir)).toThrow(/every pattern is marked "high"/);
    const base = { id: 'x', name: 'n', genres: ['ballad'], rationale: 'r' };
    expect(() => loadPatternProposals(tmpProposals([{ ...base, family: 'pad', kind: 'chordTones', patterns: [{ bars: 1, energy: 'low', notes: [[0, 0, 1]] }] }]))).toThrow(/marked "low"/);
    expect(() => loadPatternProposals(tmpProposals([{ ...base, family: 'guitar', kind: 'chordTones', patterns: [{ bars: 1, notes: [[0, 0, 1]] }] }]))).toThrow();
    expect(() => loadPatternProposals(tmpProposals([{ ...base, family: 'keys', kind: 'chordTones', patterns: [{ bars: 1, notes: [[4, 0, 1]] }] }]))).toThrow(/past the pattern/);
  });
});
