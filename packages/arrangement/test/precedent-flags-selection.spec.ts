// Selection by the entry flags (src/vocals/precedents.ts, "selection: flags, several banks, hooks") for legacy
// entries: an entry flagged useOriginal is sung whole when it suits the section (type, tempo within 10 bpm, range by
// octave shift under the rule's maxNote); an entry not flagged useRemix never takes part in a merge.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRng } from '@casperaki/music-theory';
import { afterEach, describe, expect, it } from 'vitest';

import {
  selectMergedPrecedent,
  setPrecedentDataForTests,
  setPrecedentEdits,
  wholeOctaveShift,
  type MergedPrecedent,
  type Precedent,
} from '../src/vocals/precedents.js';

const PRECEDENTS = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'vocals', 'precedents');
const schlager = JSON.parse(readFileSync(resolve(PRECEDENTS, 'mlDataRaw-schlager.json'), 'utf8')) as Precedent[];
const MAX_NOTE = 60;
// A schlager chorus that fits the range under MAX_NOTE by an octave shift.
const chorus = schlager.find((e) => e.properties.type === 'Chorus' && e.properties.start === 0 && wholeOctaveShift(e, MAX_NOTE) !== undefined)!;
const TEMPO = Number(chorus.properties.tempo);
const KEY = `schlager/${chorus.id}`;

function useIndex(wholeShare = 0.5): void {
  setPrecedentDataForTests({
    index: {
      $schemaVersion: 1,
      wholeShare,
      banks: { schlager: { file: 'mlDataRaw-schlager.json' } },
      genres: { g: { chorus: { melodic: 'schlager', rhythmic: 'schlager', maxNote: MAX_NOTE }, verse: { melodic: 'schlager', rhythmic: 'schlager', maxNote: MAX_NOTE } } },
    },
    files: { 'mlDataRaw-schlager.json': schlager },
  });
}

afterEach(() => {
  setPrecedentEdits({});
  setPrecedentDataForTests(undefined);
});

function sample(n: number, tempo: number, segmentType = 'chorus'): MergedPrecedent[] {
  return Array.from({ length: n }, (_, i) =>
    selectMergedPrecedent({ desiredPatternLength: 8, segmentType, genre: 'g', tempo, rng: createRng(`seed-${i}`) })!,
  );
}

const isWhole = (m: MergedPrecedent) => m.rhythmicPrecedentId === chorus.id && m.melodicPrecedentId === chorus.id;
const uses = (m: MergedPrecedent) => m.rhythmicPrecedentId === chorus.id || m.melodicPrecedentId === chorus.id;

describe('legacy entries and the flags', () => {
  it('remix-only bank: draws and output exactly as the legacy merge (no extra draws)', () => {
    useIndex();
    const before = sample(10, TEMPO);
    // Flag edits on another type (a Verse entry cannot be sung in a chorus) change nothing for the chorus.
    const verse = schlager.find((e) => e.properties.type === 'Verse')!;
    setPrecedentEdits({ [`schlager/${verse.id}`]: { useOriginal: true, editedAt: 'x' } });
    expect(sample(10, TEMPO)).toEqual(before);
  });

  it('useOriginal only: sung whole, exactly (octave shift under the rule maxNote), and never in a merge', () => {
    useIndex();
    setPrecedentEdits({ [KEY]: { useOriginal: true, useRemix: false, editedAt: 'x' } });
    const picks = sample(200, TEMPO);
    const whole = picks.filter(isWhole);
    expect(whole.length).toBeGreaterThan(0);
    const shift = wholeOctaveShift(chorus, MAX_NOTE)!;
    for (const m of whole) {
      expect(Object.keys(m.melody)).toEqual(Object.keys(chorus.melody));
      for (const [b, n] of Object.entries(m.melody)) {
        expect(n).toEqual([{ midi: chorus.melody[b]![0]!.midi + shift, duration: chorus.melody[b]![0]!.duration }]);
      }
      expect(m.properties.maxNote).toBe(MAX_NOTE);
    }
    for (const m of picks.filter((x) => !isWhole(x))) expect(uses(m)).toBe(false);
  });

  it('whole use needs the section type and a tempo within 10 bpm', () => {
    useIndex();
    setPrecedentEdits({ [KEY]: { useOriginal: true, useRemix: false, editedAt: 'x' } });
    expect(sample(200, TEMPO + 10).some(isWhole)).toBe(true);
    expect(sample(200, TEMPO - 10).some(isWhole)).toBe(true);
    expect(sample(200, TEMPO + 11).some(isWhole)).toBe(false);
    expect(sample(200, TEMPO, 'verse').some(isWhole)).toBe(false);
  });

  it('both flags: whole with probability wholeShare, otherwise the merge (which may use it)', () => {
    useIndex(0);
    setPrecedentEdits({ [KEY]: { useOriginal: true, editedAt: 'x' } });
    expect(sample(200, TEMPO).some(isWhole)).toBe(false);
    useIndex(1);
    setPrecedentEdits({ [KEY]: { useOriginal: true, editedAt: 'x' } });
    expect(sample(200, TEMPO).some(isWhole)).toBe(true);
  });

  it('useRemix off: the entry is left out of merges, as melodic and as rhythmic precedent', () => {
    useIndex();
    setPrecedentEdits({ [KEY]: { useRemix: false, editedAt: 'x' } });
    for (const m of sample(200, TEMPO)) expect(uses(m)).toBe(false);
  });
});
