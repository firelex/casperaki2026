// Vocal precedent banks: the required flags and source on every entry, the admin's edits overlay, and the entry
// checks and rebuild the melody library uses (src/vocals/precedents.ts, src/vocals/hook-text.ts).

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  checkPrecedentEntry,
  loadBankIndex,
  loadPrecedentBank,
  precedentEntryFromNotes,
  setPrecedentEdits,
  type Precedent,
} from '../src/index.js';
import { setPrecedentDataForTests } from '../src/vocals/precedents.js';

const PRECEDENTS = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'vocals', 'precedents');

afterEach(() => {
  setPrecedentDataForTests(undefined);
  setPrecedentEdits({});
});

describe('flags and source on every bank entry', () => {
  it('are written into every bank: hooks both flags (casperaki), legacy remix only (song / melodySauce)', () => {
    for (const bankId of Object.keys(loadBankIndex().banks)) {
      for (const e of loadPrecedentBank(bankId)) {
        const p = e.properties;
        if (bankId === 'hooks') {
          expect(p).toMatchObject({ useOriginal: true, useRemix: true, source: { kind: 'casperaki' } });
        } else if (bankId === 'stefan') {
          expect(p).toMatchObject({ useOriginal: false, useRemix: true, source: { kind: 'melodySauce' } });
        } else {
          expect(p).toMatchObject({ useOriginal: false, useRemix: true, source: { kind: 'song', title: p.name } });
        }
        expect(p.source.artist).toBeUndefined();
      }
    }
  });

  it('the loader requires them (no defaults)', () => {
    const schlager = JSON.parse(readFileSync(resolve(PRECEDENTS, 'mlDataRaw-schlager.json'), 'utf8')) as Precedent[];
    const without = schlager.map((e) => {
      const { useRemix: _drop, ...properties } = e.properties;
      return { ...e, properties };
    });
    setPrecedentDataForTests({
      index: { $schemaVersion: 1, wholeShare: 0.5, banks: { schlager: { file: 's.json' } }, genres: {} },
      files: { 's.json': without },
    });
    expect(() => loadPrecedentBank('schlager')).toThrow(/useRemix/);
  });
});

describe('edits overlay', () => {
  const original = () => loadPrecedentBank('schlager')[0]!;

  it('selection sees edited entries: melody and chords replaced, stats recomputed, flags and source replaced', () => {
    const base = original();
    const melody = { '0.0': [{ note: 'c4', midi: 48, duration: 2 }], '2.0': [{ note: 'g4', midi: 55, duration: 2 }] };
    const chords = Object.fromEntries(Array.from({ length: base.properties.end * 4 }, (_, b) => [`${b}.0`, { chord: 'F' }]));
    setPrecedentEdits({
      [`schlager/${base.id}`]: {
        melody,
        chords,
        useOriginal: true,
        source: { kind: 'song', title: 'Atemlos durch die Nacht', artist: 'Helene Fischer' },
        editedAt: '2026-11-24T10:00:00Z',
        editedBy: 'admin',
      },
    });
    const edited = loadPrecedentBank('schlager')[0]!;
    expect(edited.id).toBe(base.id);
    expect(edited.melody).toEqual(melody);
    expect(edited.chords).toEqual(chords);
    expect(edited.properties).toMatchObject({
      name: base.properties.name,
      useOriginal: true,
      useRemix: true,
      source: { kind: 'song', title: 'Atemlos durch die Nacht', artist: 'Helene Fischer' },
      lowestNote: 48,
      highestNote: 55,
      medianNote: 55,
      busyness: 2 / 8,
      editedAt: '2026-11-24T10:00:00Z',
      editedBy: 'admin',
    });
    // Other entries and banks untouched; clearing the overlay restores the file.
    expect(loadPrecedentBank('schlager')[1]).toEqual(loadPrecedentBankFresh('schlager')[1]);
    setPrecedentEdits({});
    expect(loadPrecedentBank('schlager')[0]).toEqual(base);
  });

  it('only flags: melody, chords and stats stay', () => {
    const base = original();
    setPrecedentEdits({ [`schlager/${base.id}`]: { useRemix: false, editedAt: 'x' } });
    const edited = loadPrecedentBank('schlager')[0]!;
    expect(edited.melody).toEqual(base.melody);
    expect(edited.properties.useRemix).toBe(false);
    expect(edited.properties.lowestNote).toBe(base.properties.lowestNote);
  });

  it('throws on an unknown bank or id or invalid content, and keeps the previous overlay', () => {
    const base = original();
    setPrecedentEdits({ [`schlager/${base.id}`]: { useOriginal: true, editedAt: 'x' } });
    expect(() => setPrecedentEdits({ 'nope/1': { editedAt: 'x' } })).toThrow(/unknown bank "nope"/);
    expect(() => setPrecedentEdits({ 'schlager/no-such-id': { editedAt: 'x' } })).toThrow(/bank "schlager" has no entry "no-such-id"/);
    expect(() =>
      setPrecedentEdits({ [`schlager/${base.id}`]: { melody: { '0.0': [{ note: 'c4', duration: 1 }] }, editedAt: 'x' } as never }),
    ).toThrow(/invalid edit/);
    expect(() => setPrecedentEdits({ [`schlager/${base.id}`]: { useOriginal: true } as never })).toThrow(/editedAt/);
    expect(loadPrecedentBank('schlager')[0]!.properties.useOriginal).toBe(true);
  });
});

/** The bank as in its file, bypassing the overlay (a fresh copy of the JSON). */
function loadPrecedentBankFresh(bankId: string): Precedent[] {
  const file = loadBankIndex().banks[bankId]!.file;
  return JSON.parse(readFileSync(resolve(PRECEDENTS, file), 'utf8')) as Precedent[];
}

describe('checkPrecedentEntry', () => {
  it('every bank entry as written passes its own checks (hooks: full, legacy: mechanical)', () => {
    for (const bankId of Object.keys(loadBankIndex().banks)) {
      const kind = bankId === 'hooks' ? 'hook' : 'legacy';
      for (const e of loadPrecedentBank(bankId)) expect(checkPrecedentEntry(e, kind), `${bankId}/${e.id}`).toEqual([]);
    }
  });

  it('names mechanical problems: overlap, off-grid, past the end, unreadable chord', () => {
    const base = loadPrecedentBank('schlager')[0]!;
    const bad: Precedent = {
      ...base,
      melody: {
        '0.0': [{ note: 'c4', midi: 48, duration: 3 }],
        '2.0': [{ note: 'd4', midi: 50, duration: 1 }],
        '5.1': [{ note: 'e4', midi: 52, duration: 1 }],
        [`${base.properties.end * 4 - 1}.0`]: [{ note: 'e4', midi: 52, duration: 4 }],
      },
      chords: { ...base.chords, '0.0': { chord: 'Cxyz' } },
    };
    const problems = checkPrecedentEntry(bad, 'legacy').join('\n');
    expect(problems).toMatch(/the note at beat 0 \(3 beats\) overlaps the note at beat 2/);
    expect(problems).toMatch(/beat 5.1 is not on the 16th grid/);
    expect(problems).toMatch(/after the end/);
    expect(problems).toMatch(/chord "Cxyz"/);
  });

  it('hook: also the musical checks, and a chord on every beat', () => {
    const hook = loadPrecedentBank('hooks')[0]!;
    const sour: Precedent = {
      ...hook,
      melody: Object.fromEntries(Object.entries(hook.melody).map(([b, n]) => [b, [{ ...n[0]!, midi: n[0]!.midi + 1 }]])),
    };
    expect(checkPrecedentEntry(sour, 'hook').join('\n')).toMatch(/chord tones|outside the key/);
    expect(checkPrecedentEntry(sour, 'legacy')).toEqual([]);
    const { ['3.0']: _gone, ...fewer } = hook.chords;
    expect(checkPrecedentEntry({ ...hook, chords: fewer }, 'hook')).toContain('no chord at beat 3');
  });
});

describe('precedentEntryFromNotes', () => {
  it('rebuilds a hook from its notes and half-bar chords exactly', () => {
    const hooks = loadPrecedentBank('hooks');
    // A hook whose chords change at most every half bar (the text format also allows a chord per beat).
    const hook = hooks.find((h) => Object.entries(h.chords).every(([b, c]) => Number(b) % 2 === 0 || h.chords[`${Number(b) - 1}.0`]!.chord === c.chord))!;
    expect(hook).toBeDefined();
    const notes = Object.entries(hook.melody).map(([b, n]) => ({ beat: Number(b), midi: n[0]!.midi, duration: n[0]!.duration }));
    const halfBars = Array.from({ length: hook.properties.end * 2 }, (_, i) => hook.chords[`${i * 2}.0`]!.chord);
    expect(precedentEntryFromNotes(hook, notes.reverse(), halfBars)).toEqual(hook);
  });

  it('recomputes the stats, keeps the other properties, and checks the chord count', () => {
    const base = loadPrecedentBank('schlager')[0]!;
    const halfBars = Array.from({ length: base.properties.end * 2 }, () => 'C');
    const e = precedentEntryFromNotes(base, [{ beat: 0, midi: 50, duration: 1 }, { beat: 1, midi: 43, duration: 1 }], halfBars);
    expect(e.melody).toEqual({ '0.0': [{ note: 'd4', midi: 50, duration: 1 }], '1.0': [{ note: 'g3', midi: 43, duration: 1 }] });
    expect(e.properties).toMatchObject({ name: base.properties.name, lowestNote: 43, highestNote: 50, medianNote: 50, busyness: 0.25, source: base.properties.source });
    expect(Object.keys(e.chords)).toHaveLength(base.properties.end * 4);
    expect(() => precedentEntryFromNotes(base, [], halfBars.slice(1))).toThrow(/half-bar chords/);
  });
});
