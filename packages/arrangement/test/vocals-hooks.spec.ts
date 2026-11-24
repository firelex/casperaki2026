// Hooks in the vocal melody generator: a bank-index rule whose `melodic` lists several banks, the hooks bank
// among them (src/vocals/precedents.ts, "several melodic banks, hooks"). Uses a test-only bank index and a small
// hooks bank built from hook text; the real bank index lists the hooks bank in no rule yet.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRng } from '@casperaki/music-theory';
import { afterEach, describe, expect, it } from 'vitest';

import { parseHookText, type HookEntry } from '../src/vocals/hook-text.js';
import {
  loadBankIndex,
  selectMergedPrecedent,
  setPrecedentDataForTests,
  wholeHookOctaveShift,
  type MergedPrecedent,
  type Precedent,
} from '../src/vocals/precedents.js';

const PRECEDENTS = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'vocals', 'precedents');
const schlager: unknown = JSON.parse(readFileSync(resolve(PRECEDENTS, 'mlDataRaw-schlager.json'), 'utf8'));

const HOOK_TEXT = `
hook: Anthem A
type: Chorus
tempo: 90-130
feel: anthem
chords: C | G | Am F | G | C | G | Am F | G C
melody: e4:1 g4:1 c5:2 | b4:1 g4:1 d5:2 | c5:1 a4:1 c5:1 a4:1 | b4:4- | b4:2 r:2 |
        b4:1 g4:1 d5:2 | c5:1 a4:1 c5:1 a4:1 | b4:2 c5:2 |

hook: Climb B
type: Chorus
tempo: 100-140
feel: driving
chords: C | F | G | C | Am | F | G | C
melody: c4:2 e4:2 | f4:2 a4:2 | g4:1 b4:1 d5:2 | c5:4 | a4:2 c5:2 | a4:2 f4:2 | g4:2 b4:2 | c5:4 |

hook: Slow C
type: Verse
tempo: 60-85
feel: tender
chords: Am | F | C | G | Am | F | G | C
melody: a3:2 c4:2 | c4:2 a3:2 | c4:2 e4:2 | d4:2 b3:2 | c4:2 e4:2 | f4:2 c4:2 | d4:2 b3:2 | c4:4 |

hook: Pickup D
type: Chorus
tempo: 80-120
feel: tender
leadin: yes
chords: C | C | F | G | C | C | F | G | C
melody: r:3 g3:1 | c4:2 e4:2 | f4:2 a4:2 | g4:2 d4:2 | e4:4 | c4:2 e4:2 | f4:2 a4:2 | g4:2 b3:2 | c4:4 |
`;

const parsed = parseHookText(HOOK_TEXT, 'fx');
if (parsed.errors.length > 0) throw new Error(`fixture hooks do not parse: ${parsed.errors.join('; ')}`);
const HOOKS = parsed.hooks;
const hookById = (id: string | number): HookEntry => {
  const h = HOOKS.find((x) => x.id === id);
  if (!h) throw new Error(`no fixture hook "${id}"`);
  return h;
};
const [A, B, C, D] = ['fx-01', 'fx-02', 'fx-03', 'fx-04'];

type Rule = Record<string, unknown>;
function useIndex(rules: Record<string, Rule>, wholeShare = 0.5): void {
  setPrecedentDataForTests({
    index: {
      $schemaVersion: 1,
      banks: { hooks: { file: 'hooks.json' }, schlager: { file: 'mlDataRaw-schlager.json' } },
      hooks: { bank: 'hooks', wholeShare },
      genres: { testGenre: rules },
    },
    files: { 'hooks.json': HOOKS, 'mlDataRaw-schlager.json': schlager },
  });
}

afterEach(() => setPrecedentDataForTests(undefined));

function select(seed: string, tempo: number, segmentType = 'chorus', desiredPatternLength = 8): MergedPrecedent {
  const merged = selectMergedPrecedent({ desiredPatternLength, segmentType, genre: 'testGenre', tempo, rng: createRng(seed) });
  if (!merged) throw new Error('no merged precedent');
  return merged;
}

/** Many selections, one per seed. */
function sample(n: number, tempo: number, segmentType = 'chorus'): MergedPrecedent[] {
  return Array.from({ length: n }, (_, i) => select(`seed-${i}`, tempo, segmentType));
}

/** The hook's melody and chords as the generator sees them: beats from the first full bar (a lead-in bar cut off). */
function hookFromBarOne(h: HookEntry): { melody: Record<string, { midi: number; duration: number }>; chords: Record<string, string> } {
  const offset = h.properties.start * 4;
  const key = (b: number) => (Number.isInteger(b) ? b.toFixed(1) : String(b));
  const melody: Record<string, { midi: number; duration: number }> = {};
  for (const [b, notes] of Object.entries(h.melody)) {
    if (Number(b) >= offset) melody[key(Number(b) - offset)] = { midi: notes[0]!.midi, duration: notes[0]!.duration };
  }
  const chords: Record<string, string> = {};
  for (const [b, c] of Object.entries(h.chords)) if (Number(b) >= offset) chords[key(Number(b) - offset)] = c.chord;
  return { melody, chords };
}

/** A whole hook comes out exactly, moved by `shift` semitones: same beats, durations, intervals and chords. */
function expectWholeHook(m: MergedPrecedent, h: HookEntry, shift: number): void {
  const want = hookFromBarOne(h);
  expect(m.rhythmicPrecedentId).toBe(h.id);
  expect(m.melodicPrecedentId).toBe(h.id);
  expect(Object.keys(m.melody)).toEqual(Object.keys(want.melody));
  for (const [b, n] of Object.entries(m.melody)) {
    expect(n).toEqual([{ midi: want.melody[b]!.midi + shift, duration: want.melody[b]!.duration }]);
  }
  expect(Object.fromEntries(Object.entries(m.chords).map(([b, c]) => [b, c.chord]))).toEqual(want.chords);
  expect(m.properties.end).toBe(8);
}

const ids = (ms: readonly MergedPrecedent[]) => new Set(ms.map((m) => m.melodicPrecedentId));

describe('hooks: used whole', () => {
  it('reproduces the hook exactly: its rhythm, notes and chords (no octave shift needed under maxNote 64)', () => {
    useIndex({ chorus: { melodic: ['hooks'], maxNote: 64 } }, 1);
    const picks = sample(40, 110);
    for (const m of picks) expectWholeHook(m, hookById(m.melodicPrecedentId), 0);
    expect(ids(picks)).toEqual(new Set([A, B, D]));
  });

  it('moves the whole hook by octaves only: the highest shift that fits [43..maxNote]', () => {
    // maxNote 76: A (52..62), B (48..62) and D (43..57) all fit one octave up, and no higher.
    useIndex({ chorus: { melodic: ['hooks'], maxNote: 76 } }, 1);
    for (const m of sample(30, 110)) expectWholeHook(m, hookById(m.melodicPrecedentId), 12);
    // A has steps of a fifth (g -> d): they stay a fifth (buildContour would have folded them).
    const a = hookById(A) as unknown as Precedent;
    expect(wholeHookOctaveShift(a, 76)).toBe(12);
    expect(wholeHookOctaveShift(a, 64)).toBe(0);
    expect(wholeHookOctaveShift(a, 59)).toBeUndefined(); // 52..62 down an octave is 40..50, below 43
  });

  it('a hook that fits no octave shift is not a candidate for whole use', () => {
    // Default maxNote 59: only D (43..57) fits; A and B would need to go below 43.
    useIndex({ chorus: { melodic: ['hooks'] } }, 1);
    const picks = sample(20, 110);
    expect(ids(picks)).toEqual(new Set([D]));
    for (const m of picks) expectWholeHook(m, hookById(D), 0);
  });

  it('no hook fits whole: an error naming section, tempo and range, or only the other listed banks', () => {
    useIndex({ chorus: { melodic: ['hooks'], maxNote: 55 } }, 1);
    expect(() => select('s', 110)).toThrow(
      /no melody for testGenre\/chorus at 110 bpm: no hook in the hooks bank "hooks" is written for chorus, has tempoMin <= 110 <= tempoMax and fits the range up to maxNote 55 by octave shifts, for use whole, and the rule lists no other melodic bank/,
    );
    useIndex({ chorus: { melodic: ['hooks', 'schlager'], rhythmic: 'schlager', maxNote: 55 } }, 1);
    const hookIds = new Set(HOOKS.map((h) => h.id));
    for (const m of sample(20, 110)) expect(hookIds.has(String(m.melodicPrecedentId))).toBe(false);
  });

  it('cuts a lead-in bar (start 1, end 9) off like the legacy start-1 entries (8-bar section)', () => {
    useIndex({ chorus: { melodic: ['hooks'], maxNote: 64 } }, 1);
    const withD = sample(40, 110).filter((m) => m.melodicPrecedentId === D);
    expect(withD.length).toBeGreaterThan(0);
    const d = hookById(D);
    expect(d.properties).toMatchObject({ start: 1, end: 9 });
    expect(d.melody['3.0']).toBeDefined(); // the pickup note, in the lead-in bar
    for (const m of withD) {
      expectWholeHook(m, d, 0);
      expect(m.melody['0.0']![0]!.duration).toBe(2); // bar 1 starts with the hook's first full-bar note
      expect(Object.keys(m.chords)).toHaveLength(32);
    }
  });
});

describe('hooks: mixed with a second hook', () => {
  it('takes the rhythm from one hook and the pitches and chords from another (range does not filter)', () => {
    useIndex({ chorus: { melodic: ['hooks'], maxNote: 55 } }, 0);
    const picks = sample(40, 110);
    for (const m of picks) {
      expect(m.rhythmicPrecedentId).not.toBe(m.melodicPrecedentId);
      const rhythm = hookFromBarOne(hookById(m.rhythmicPrecedentId));
      const shape = hookFromBarOne(hookById(m.melodicPrecedentId));
      expect(Object.keys(m.melody)).toEqual(Object.keys(rhythm.melody));
      for (const [b, n] of Object.entries(m.melody)) {
        expect(n[0]!.duration).toBe(rhythm.melody[b]!.duration);
        expect(n[0]!.midi).toBeLessThanOrEqual(55);
      }
      expect(Object.fromEntries(Object.entries(m.chords).map(([b, c]) => [b, c.chord]))).toEqual(shape.chords);
      const shapePcs = new Set(Object.values(shape.melody).map((n) => n.midi % 12));
      for (const n of Object.values(m.melody)) expect(shapePcs.has(n[0]!.midi % 12)).toBe(true);
    }
    expect(new Set(picks.map((m) => `${m.rhythmicPrecedentId}>${m.melodicPrecedentId}`)).size).toBeGreaterThan(3);
    for (const m of picks) expect([A, B, D]).toContain(m.rhythmicPrecedentId);
  });

  it('wholeShare splits whole and mixed picks', () => {
    useIndex({ chorus: { melodic: ['hooks'], maxNote: 64 } }, 0.5);
    const whole = sample(200, 110).filter((m) => m.rhythmicPrecedentId === m.melodicPrecedentId).length;
    expect(whole).toBeGreaterThan(70);
    expect(whole).toBeLessThan(130);
  });

  it('mixing needs two hooks for the section: a clear error', () => {
    useIndex({ verse: { melodic: ['hooks'] } }, 0);
    expect(() => select('s', 70, 'verse')).toThrow(
      /no melody for testGenre\/verse at 70 bpm: the hooks bank "hooks" has 1 hook\(s\) written for verse with tempoMin <= 70 <= tempoMax; mixing needs two/,
    );
  });
});

describe('hooks: section type and tempo filters', () => {
  it('offers only hooks with tempoMin <= tempo <= tempoMax (inclusive)', () => {
    useIndex({ chorus: { melodic: ['hooks'], maxNote: 64 } }, 1);
    expect(ids(sample(30, 135))).toEqual(new Set([B]));
    expect(ids(sample(40, 130))).toEqual(new Set([A, B]));
    expect(ids(sample(30, 85))).toEqual(new Set([D]));
    expect(() => select('s', 200)).toThrow(/no melody for testGenre\/chorus at 200 bpm/);
  });

  it('offers only hooks written for the section type', () => {
    useIndex({ verse: { melodic: ['hooks'], maxNote: 64 }, chorus: { melodic: ['hooks'], maxNote: 64 } }, 1);
    expect(ids(sample(20, 70, 'verse'))).toEqual(new Set([C])); // C is the only Verse hook
    expect(() => select('s', 70, 'chorus')).toThrow(/is written for chorus/); // C suits 70 bpm but is a Verse
    expect(() => select('s', 110, 'verse')).toThrow(/is written for verse/); // D suits 110 bpm but is a Chorus
  });
});

describe('several melodic banks', () => {
  it('a legacy bank picked from the list behaves exactly as a single-bank rule (after the mode and bank draws)', () => {
    const listRule = { melodic: ['hooks', 'schlager'], rhythmic: 'schlager', maxNote: 64 };
    const stringRule = { melodic: 'schlager', rhythmic: 'schlager', maxNote: 64 };
    let legacyPicks = 0;
    for (let i = 0; i < 40; i++) {
      useIndex({ chorus: listRule });
      const fromList = selectMergedPrecedent({ desiredPatternLength: 8, segmentType: 'chorus', genre: 'testGenre', tempo: 110, rng: createRng(`seed-${i}`) });
      if (HOOKS.some((h) => h.id === fromList!.melodicPrecedentId)) continue;
      legacyPicks++;
      useIndex({ chorus: stringRule });
      const rng2 = createRng(`seed-${i}`);
      rng2.next(); // whole-or-mixed
      rng2.next(); // the bank draw
      const fromString = selectMergedPrecedent({ desiredPatternLength: 8, segmentType: 'chorus', genre: 'testGenre', tempo: 110, rng: rng2 });
      expect(fromList).toEqual(fromString);
    }
    expect(legacyPicks).toBeGreaterThan(5);
  });

  it('picks the bank first with equal weight, so ~100 hooks are not drowned by a large bank', () => {
    useIndex({ chorus: { melodic: ['hooks', 'schlager'], rhythmic: 'schlager', maxNote: 64 } }, 1);
    const hookIds = new Set(HOOKS.map((h) => h.id));
    const hooks = sample(200, 110).filter((m) => hookIds.has(String(m.melodicPrecedentId))).length;
    expect(hooks).toBeGreaterThan(70);
    expect(hooks).toBeLessThan(130);
  });

  it('a rule with a single melodic bank draws exactly as before (the legacy path)', () => {
    // Same seed, same rule, with and without the hooks setting in the index: identical result.
    useIndex({ chorus: { melodic: 'schlager', rhythmic: 'schlager' } });
    const withHooksSetting = select('same', 110);
    setPrecedentDataForTests({
      index: { $schemaVersion: 1, banks: { schlager: { file: 'mlDataRaw-schlager.json' } }, genres: { testGenre: { chorus: { melodic: 'schlager', rhythmic: 'schlager' } } } },
      files: { 'mlDataRaw-schlager.json': schlager },
    });
    expect(select('same', 110)).toEqual(withHooksSetting);
  });
});

describe('bank index checks', () => {
  it('the hooks bank only inside a melodic list, never alone or as rhythmic bank', () => {
    useIndex({ chorus: { melodic: 'hooks' } });
    expect(() => loadBankIndex()).toThrow(/genres.testGenre.chorus: the hooks bank must be given in a list/);
    useIndex({ chorus: { melodic: ['schlager'], rhythmic: 'hooks' } });
    expect(() => loadBankIndex()).toThrow(/cannot be a rhythmic bank/);
    useIndex({ chorus: { melodic: ['schlager', 'nope'] } });
    expect(() => loadBankIndex()).toThrow(/melodic bank "nope" is not listed under banks/);
  });

  it('the real bank index names the hooks bank but no rule uses it yet', () => {
    setPrecedentDataForTests(undefined);
    const index = loadBankIndex();
    expect(index.hooks).toEqual({ bank: 'hooks', wholeShare: 0.5 });
    for (const rules of Object.values(index.genres)) {
      for (const rule of Object.values(rules)) expect(typeof rule.melodic).toBe('string');
    }
  });
});

describe('the real hooks bank (smoke)', () => {
  const real = JSON.parse(readFileSync(resolve(PRECEDENTS, 'mlDataRaw-hooks.json'), 'utf8')) as HookEntry[];
  const SECTION: Record<string, string> = { Verse: 'verse', 'Pre-chorus': 'preChorus', Chorus: 'chorus', Bridge: 'bridge' };
  const withBank = (hooks: unknown, wholeShare: number, maxNote = 64) =>
    setPrecedentDataForTests({
      index: {
        $schemaVersion: 1,
        banks: { hooks: { file: 'mlDataRaw-hooks.json' } },
        hooks: { bank: 'hooks', wholeShare },
        genres: { testGenre: Object.fromEntries(Object.values(SECTION).map((s) => [s, { melodic: ['hooks'], maxNote }])) },
      },
      files: { 'mlDataRaw-hooks.json': hooks },
    });

  it('every hook comes out whole and exact in its own section type, at both ends of its tempo range', () => {
    expect(real.length).toBeGreaterThan(0);
    for (const h of real) {
      // maxNote at the hook's own top note: it fits as written (shift 0); one octave more room: shift +12.
      for (const [maxNote, shift] of [[h.properties.highestNote, 0], [h.properties.highestNote + 12, 12]] as const) {
        withBank([h], 1, maxNote);
        for (const tempo of [h.properties.tempoMin, h.properties.tempoMax]) {
          expectWholeHook(select('s', tempo, SECTION[h.properties.type]!), h, shift);
        }
      }
    }
  });

  it('mixing among the real hooks works for every section type across the tempo range', () => {
    withBank(real, 0);
    for (const section of Object.values(SECTION)) {
      for (const tempo of [70, 90, 110, 130, 150]) {
        let ms: MergedPrecedent[];
        try {
          ms = sample(10, tempo, section);
        } catch (err) {
          expect((err as Error).message).toMatch(/mixing needs two/);
          continue;
        }
        for (const m of ms) expect(m.rhythmicPrecedentId).not.toBe(m.melodicPrecedentId);
      }
    }
  });
});
