import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { melodyListQuery } from '../../src/api/melodies';
import { scoreChordsOf } from '../../src/hum/halfBars';
import { chordMidis } from '../../src/hum/playPhrase';

const BANKS = fileURLToPath(new URL('../../../../packages/arrangement/data/vocals/precedents/', import.meta.url));

describe('melody library helpers', () => {
  it('the player can voice every chord in every precedent bank (hooks included)', () => {
    const symbols = new Set<string>();
    for (const f of readdirSync(BANKS).filter((n) => /^mlDataRaw-.*\.json$/u.test(n))) {
      const bank = JSON.parse(readFileSync(BANKS + f, 'utf8')) as { chords: Record<string, { chord: string }> }[];
      for (const e of bank) for (const c of Object.values(e.chords)) symbols.add(c.chord);
    }
    expect(symbols.size).toBeGreaterThan(10);
    for (const s of symbols) expect(chordMidis(s).length, s).toBeGreaterThan(1);
    expect(chordMidis('Fsus')).toEqual(chordMidis('Fsus4'));
    expect(() => chordMidis('H7')).toThrow(/Cannot play the chord "H7"/u);
  });

  it('writes half-bar chords where they change, as 16th positions', () => {
    expect([...scoreChordsOf(['C', 'C', 'G', 'Am', 'Am'])]).toEqual([[0, 'C'], [16, 'G'], [24, 'Am']]);
    expect(scoreChordsOf([]).size).toBe(0);
  });

  it('leaves empty filters out of the list query', () => {
    expect(melodyListQuery({ kind: 'hooks', bank: '', type: '', feel: '', tempo: undefined, q: '' }, 0)).toBe('kind=hooks&offset=0&limit=100');
    expect(melodyListQuery({ kind: 'remix', bank: 'stefan', type: 'Verse', feel: '', tempo: 120, q: 'love' }, 100, 50)).toBe(
      'kind=remix&offset=100&limit=50&bank=stefan&type=Verse&tempo=120&q=love',
    );
  });
});

describe('every precedent bank entry engraves as a score', () => {
  it('notesToAbc takes each entry at sung pitch over its bars, with its half-bar chords', async () => {
    const { notesToAbc } = await import('../../src/editor/sequencer/notation');
    let n = 0;
    for (const f of readdirSync(BANKS).filter((x) => /^mlDataRaw-.*\.json$/u.test(x))) {
      const bank = JSON.parse(readFileSync(BANKS + f, 'utf8')) as {
        id: string | number;
        properties: { end: number };
        melody: Record<string, { midi: number; duration: number }[]>;
        chords: Record<string, { chord: string }>;
      }[];
      for (const e of bank) {
        const beats = e.properties.end * 4;
        const notes = Object.entries(e.melody).flatMap(([b, ns]) => ns.map((x) => ({ pitch: x.midi + 12, start: Number(b), length: x.duration })));
        const at = new Map(Object.entries(e.chords).map(([b, c]) => [Number(b), c.chord]));
        const chords = scoreChordsOf(Array.from({ length: e.properties.end * 2 }, (_, s) => at.get(s * 2)!));
        expect(() => notesToAbc(notes, { beats, key: 'C', bpm: 120, chords }), `${f} ${e.id}`).not.toThrow();
        n++;
      }
    }
    expect(n).toBeGreaterThan(1500);
  });
});
