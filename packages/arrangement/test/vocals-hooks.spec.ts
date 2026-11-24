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
  type MergedPrecedent,
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
type: Verse
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

/** `exact`: the hook's pitches come out unchanged. Otherwise each pitch may be moved by whole octaves, which is
 *  what the usual range placement (buildContour, under the rule's maxNote) does to any precedent. */
function expectWholeHook(m: MergedPrecedent, h: HookEntry, exact: boolean): void {
  const want = hookFromBarOne(h);
  expect(Object.keys(m.melody)).toEqual(Object.keys(want.melody));
  const got = Object.entries(m.melody).map(([b, n]) => ({ b, midi: n[0]!.midi, duration: n[0]!.duration }));
  expect(got.map((n) => n.duration)).toEqual(got.map((n) => want.melody[n.b]!.duration));
  if (exact) expect(got.map((n) => n.midi)).toEqual(got.map((n) => want.melody[n.b]!.midi));
  else for (const n of got) expect(Math.abs(n.midi - want.melody[n.b]!.midi) % 12).toBe(0);
  expect(Object.fromEntries(Object.entries(m.chords).map(([b, c]) => [b, c.chord]))).toEqual(want.chords);
  expect(m.properties.end).toBe(8);
}

describe('hooks: used whole', () => {
  it('reproduces the hook: its rhythm, notes and chords', () => {
    useIndex({ chorus: { melodic: ['hooks'], maxNote: 64 } }, 1);
    const picks = sample(40, 110);
    for (const m of picks) {
      expect(m.rhythmicPrecedentId).toBe(m.melodicPrecedentId);
      // B sits inside maxNote 64 with no step wider than a third: placement leaves every pitch as written. The
      // others have steps of a fifth or more, which buildContour folds by an octave (it minimises the widest step).
      expectWholeHook(m, hookById(m.melodicPrecedentId), m.melodicPrecedentId === B);
    }
    // Every hook suiting 110 bpm comes up, the slow one never.
    expect(new Set(picks.map((m) => m.melodicPrecedentId))).toEqual(new Set([A, B, D]));
  });

  it('with the usual range placement (default maxNote 59) keeps rhythm, chords and pitch classes', () => {
    useIndex({ chorus: { melodic: ['hooks'] } }, 1);
    for (const m of sample(20, 110)) {
      const want = hookFromBarOne(hookById(m.melodicPrecedentId));
      expect(Object.keys(m.melody)).toEqual(Object.keys(want.melody));
      for (const [b, n] of Object.entries(m.melody)) {
        expect(n[0]!.duration).toBe(want.melody[b]!.duration);
        expect(Math.abs(n[0]!.midi - want.melody[b]!.midi) % 12).toBe(0);
        expect(n[0]!.midi).toBeLessThanOrEqual(59);
      }
      expect(Object.fromEntries(Object.entries(m.chords).map(([b, c]) => [b, c.chord]))).toEqual(want.chords);
    }
  });

  it('cuts a lead-in bar (start 1, end 9) off like the legacy start-1 entries', () => {
    useIndex({ chorus: { melodic: ['hooks'], maxNote: 64 } }, 1);
    const withD = sample(40, 110).filter((m) => m.melodicPrecedentId === D);
    expect(withD.length).toBeGreaterThan(0);
    const d = hookById(D);
    expect(d.properties).toMatchObject({ start: 1, end: 9 });
    expect(d.melody['3.0']).toBeDefined(); // the pickup note, in the lead-in bar
    for (const m of withD) {
      expectWholeHook(m, d, false);
      expect(m.melody['0.0']![0]!.duration).toBe(2); // bar 1 starts with the hook's first full-bar note
      expect(Object.keys(m.chords)).toHaveLength(32);
    }
  });
});

describe('hooks: mixed with a second hook', () => {
  it('takes the rhythm from one hook and the pitches and chords from another', () => {
    useIndex({ chorus: { melodic: ['hooks'], maxNote: 64 } }, 0);
    const picks = sample(40, 110);
    for (const m of picks) {
      expect(m.rhythmicPrecedentId).not.toBe(m.melodicPrecedentId);
      const rhythm = hookFromBarOne(hookById(m.rhythmicPrecedentId));
      const shape = hookFromBarOne(hookById(m.melodicPrecedentId));
      expect(Object.keys(m.melody)).toEqual(Object.keys(rhythm.melody));
      for (const [b, n] of Object.entries(m.melody)) expect(n[0]!.duration).toBe(rhythm.melody[b]!.duration);
      expect(Object.fromEntries(Object.entries(m.chords).map(([b, c]) => [b, c.chord]))).toEqual(shape.chords);
      // Pitches come from the shape hook: every sung pitch class is one of the shape hook's.
      const shapePcs = new Set(Object.values(shape.melody).map((n) => n.midi % 12));
      for (const n of Object.values(m.melody)) expect(shapePcs.has(n[0]!.midi % 12)).toBe(true);
    }
    const pairs = new Set(picks.map((m) => `${m.rhythmicPrecedentId}>${m.melodicPrecedentId}`));
    expect(pairs.size).toBeGreaterThan(3);
    for (const m of picks) expect([A, B, D]).toContain(m.rhythmicPrecedentId);
  });

  it('wholeShare splits whole and mixed picks', () => {
    useIndex({ chorus: { melodic: ['hooks'] } }, 0.5);
    const whole = sample(200, 110).filter((m) => m.rhythmicPrecedentId === m.melodicPrecedentId).length;
    expect(whole).toBeGreaterThan(70);
    expect(whole).toBeLessThan(130);
  });

  it('a hook alone in its tempo range cannot be mixed: a clear error', () => {
    useIndex({ verse: { melodic: ['hooks'] } }, 0);
    expect(() => select('s', 70, 'verse')).toThrow(/hook "fx-03" is to be mixed with a second hook, but it is the only hook for testGenre\/verse at 70 bpm/);
  });
});

describe('hooks: tempo filter', () => {
  it('offers only hooks with tempoMin <= tempo <= tempoMax (inclusive)', () => {
    useIndex({ chorus: { melodic: ['hooks'] } }, 1);
    expect(new Set(sample(30, 70).map((m) => m.melodicPrecedentId))).toEqual(new Set([C]));
    expect(new Set(sample(30, 135).map((m) => m.melodicPrecedentId))).toEqual(new Set([B]));
    expect(new Set(sample(40, 85).map((m) => m.melodicPrecedentId))).toEqual(new Set([C, D]));
    expect(new Set(sample(40, 130).map((m) => m.melodicPrecedentId))).toEqual(new Set([A, B]));
  });

  it('no hook for the tempo and no other bank listed: an error naming the section and tempo', () => {
    useIndex({ chorus: { melodic: ['hooks'] } });
    expect(() => select('s', 200)).toThrow(/no melody for testGenre\/chorus at 200 bpm: no hook in the hooks bank "hooks" has tempoMin <= 200 <= tempoMax/);
  });

  it('no hook for the tempo but a legacy bank listed: only the legacy bank is a candidate', () => {
    useIndex({ chorus: { melodic: ['hooks', 'schlager'], rhythmic: 'schlager' } });
    const hookIds = new Set(HOOKS.map((h) => h.id));
    for (const m of sample(20, 200)) expect(hookIds.has(String(m.melodicPrecedentId))).toBe(false);
  });
});

describe('several melodic banks', () => {
  it('a legacy bank picked from the list behaves exactly as a single-bank rule (after the one bank draw)', () => {
    const listRule = { melodic: ['hooks', 'schlager'], rhythmic: 'schlager' };
    const stringRule = { melodic: 'schlager', rhythmic: 'schlager' };
    let legacyPicks = 0;
    for (let i = 0; i < 40; i++) {
      useIndex({ chorus: listRule });
      const rng = createRng(`seed-${i}`);
      const fromList = selectMergedPrecedent({ desiredPatternLength: 8, segmentType: 'chorus', genre: 'testGenre', tempo: 110, rng });
      if (HOOKS.some((h) => h.id === fromList!.melodicPrecedentId)) continue;
      legacyPicks++;
      useIndex({ chorus: stringRule });
      const rng2 = createRng(`seed-${i}`);
      rng2.next(); // the bank draw
      const fromString = selectMergedPrecedent({ desiredPatternLength: 8, segmentType: 'chorus', genre: 'testGenre', tempo: 110, rng: rng2 });
      expect(fromList).toEqual(fromString);
    }
    expect(legacyPicks).toBeGreaterThan(5);
  });

  it('picks the bank first with equal weight, so ~100 hooks are not drowned by a large bank', () => {
    useIndex({ chorus: { melodic: ['hooks', 'schlager'], rhythmic: 'schlager' } }, 1);
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
  const withBank = (hooks: unknown, wholeShare: number) =>
    setPrecedentDataForTests({
      index: {
        $schemaVersion: 1,
        banks: { hooks: { file: 'mlDataRaw-hooks.json' } },
        hooks: { bank: 'hooks', wholeShare },
        genres: { testGenre: { chorus: { melodic: ['hooks'] } } },
      },
      files: { 'mlDataRaw-hooks.json': hooks },
    });

  it('every hook is selectable whole inside its tempo range (8-bar section)', () => {
    expect(real.length).toBeGreaterThan(0);
    for (const h of real) {
      withBank([h], 1);
      for (const tempo of [h.properties.tempoMin, h.properties.tempoMax]) {
        const m = select('s', tempo);
        expect(m.melodicPrecedentId).toBe(h.id);
        expectWholeHook(m, h, false);
      }
    }
  });

  it('mixing among the real hooks works across the tempo range', () => {
    withBank(real, 0);
    for (const tempo of [70, 90, 110, 130, 150]) {
      for (const m of sample(30, tempo)) expect(m.rhythmicPrecedentId).not.toBe(m.melodicPrecedentId);
    }
  });
});
