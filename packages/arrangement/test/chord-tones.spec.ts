// Pattern lab styles for the pitched families and guitar (chord-tones.ts,
// authored-bank.ts, the patterns/index.ts hook).

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { Song } from '@casperaki/song-schema';

import { orchestrate } from '../src/index.js';
import { generatorContext } from '../src/context.js';
import { authoredStylesFor, authoredStylesForSong } from '../src/patterns/authored-bank.js';
import { resolveChordTone, sectionEnergy } from '../src/patterns/chord-tones.js';
import { loadPatternProposals, previewParamsFor } from '../src/patterns/proposals.js';

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

  // Owner 2026-11-28: "finger picking can be done on sampled guitars, but strums always on virtual guitarist", as
  // the legacy app's convertNonVirtualGuitaristPatternsIntoVirtualGuitaristPatterns.js did: a hit on several strings
  // is a recorded strum (down when the strings go up from the bass, short when it lasts a 16th, its length the
  // nearest of 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4 beats); one string stays a picked note on the sampled guitar.
  it('a guitar preview plays its strums as Virtual Guitarist strums and its picks on the sampled guitar', () => {
    const hits = [[0, [0, 1, 2], 1, 90], [1, [3], 0.5, 70], [2, [5, 4, 3], 0.3, 80], [3, [1, 2, 3, 4], 0.6, 80]];
    const preview = { lanePreview: { family: 'guitar', kind: 'guitarPicks', patterns: [{ bars: 1, hits }] } };
    const song = songWithLane('organicVibes', 'Guitar', preview);
    const events = laneEvents(song, 'Guitar');
    expect(events.length).toBeGreaterThan(0);
    const at = (beat: string) => events.find((x) => x.beat === beat)!.e as Record<string, unknown>;
    expect(at('0.0')).toMatchObject({ type: 'virtualGuitarist', event: 'chordLongStrumDown', duration: 1 });
    expect(at('1.0')).toMatchObject({ type: 'strum', strings: [3], durations: [0.5], velocities: [70] });
    expect(at('2.0')).toMatchObject({ type: 'virtualGuitarist', event: 'chordShortStrumUp', duration: 0.25 });
    expect(at('3.0')).toMatchObject({ type: 'virtualGuitarist', event: 'chordLongStrumDown', duration: 0.5 });
    for (const { e } of events) if ((e as { type: string }).type === 'strum') expect((e as { strings: number[] }).strings).toHaveLength(1);
  });

  it('a guitar preview plays its Virtual Guitarist effects', () => {
    const preview = { lanePreview: { family: 'guitar', kind: 'guitarPicks', patterns: [{ bars: 1, hits: [[0, [0, 1, 2], 1, 90]], fx: [[3.5, 'fx2']] }] } };
    const song = songWithLane('organicVibes', 'Guitar', preview);
    const fx = laneEvents(song, 'Guitar').filter((x) => (x.e as { type: string; event?: string }).type === 'virtualGuitarist' && (x.e as { event: string }).event.startsWith('fx'));
    expect(fx.length).toBeGreaterThan(0);
    for (const { beat, e } of fx) {
      expect(beat).toBe('3.5');
      expect((e as { event: string }).event).toBe('fx2');
    }
  });

  it('a preview of one pattern plays only that pattern, in every section', () => {
    const p = loadPatternProposals().find((x) => x.kind === 'chordTones' && x.patterns.length > 1 && x.patterns.some((t) => t.energy))!;
    if (p.kind !== 'chordTones') throw new Error('expected a chord-tone proposal');
    const params = previewParamsFor(p, 1) as { lanePreview: { patterns: { energy?: string; notes: unknown }[] } };
    expect(params.lanePreview.patterns).toEqual([{ bars: p.patterns[1]!.bars, notes: p.patterns[1]!.notes }]);
    expect((previewParamsFor(p) as typeof params).lanePreview.patterns).toHaveLength(p.patterns.length);
    expect(() => previewParamsFor(p, p.patterns.length)).toThrow(/no pattern/);
  });

  it('songs are unchanged while no style is approved', () => {
    expect(authoredStylesFor('keys', 'ballad')).toEqual([]);
  });

  // Owner 2026-11-28: our own short, choppy patterns for Casperaki Pop, proposed and approved in the pattern lab.
  it('a style may be for a genre recipe: a Casperaki Pop song takes Bright Pop\'s styles and its own, a Bright Pop song only Bright Pop\'s', () => {
    const dir = mkdtempSync(join(tmpdir(), 'authored-'));
    const strums = [{ bars: 1, strums: [[0.5, 'down', 0.25], [1.75, 'up', 0.25], [2.5, 'down', 0.25], [3.75, 'up', 0.25]] }];
    writeFileSync(join(dir, 'p.json'), JSON.stringify(strums));
    writeFileSync(
      join(dir, 'index.json'),
      JSON.stringify({
        $schemaVersion: 1,
        styles: {
          'authored-cp': { family: 'guitar', kind: 'guitarStrums', genres: ['casperakiPop'], file: 'p.json' },
          'authored-bp': { family: 'guitar', kind: 'guitarStrums', genres: ['brightPop'], file: 'p.json' },
        },
      }),
    );
    const names = (genre: string) => authoredStylesForSong('guitar', generatorContext({ genre, key: 'C', bpm: 110, seed: 'x' } as never), dir).map((x) => x.styleName).sort();
    expect(names('casperakiPop')).toEqual(['authored-bp', 'authored-cp']);
    expect(names('brightPop')).toEqual(['authored-bp']);
    const base = { id: 'cp', name: 'n', genres: ['casperakiPop'], rationale: 'r' };
    expect(loadPatternProposals(tmpProposals([{ ...base, family: 'guitar', kind: 'guitarStrums', patterns: strums }])).map((p) => p.genres)).toEqual([['casperakiPop']]);
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
