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
  wholeOctaveShift,
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
const HOOK_MAX_NOTE = { verse: 55, preChorus: 64, chorus: 64, bridge: 64 };
function useIndex(rules: Record<string, Rule>, wholeShare = 0.5, hookMaxNote: Record<string, number> = HOOK_MAX_NOTE): void {
  setPrecedentDataForTests({
    index: {
      $schemaVersion: 1,
      banks: { hooks: { file: 'hooks.json' }, schlager: { file: 'mlDataRaw-schlager.json' } },
      wholeShare,
      hooks: { bank: 'hooks', maxNote: hookMaxNote },
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
    useIndex({ chorus: { melodic: ['hooks'] } }, 1, { chorus: 64 });
    const picks = sample(40, 110);
    for (const m of picks) expectWholeHook(m, hookById(m.melodicPrecedentId), 0);
    expect(ids(picks)).toEqual(new Set([A, B, D]));
  });

  it('moves the whole hook by octaves only: the highest shift that fits [43..maxNote]', () => {
    // maxNote 76: A (52..62), B (48..62) and D (43..57) all fit one octave up, and no higher.
    useIndex({ chorus: { melodic: ['hooks'] } }, 1, { chorus: 76 });
    for (const m of sample(30, 110)) expectWholeHook(m, hookById(m.melodicPrecedentId), 12);
    // A has steps of a fifth (g -> d): they stay a fifth (buildContour would have folded them).
    const a = hookById(A) as unknown as Precedent;
    expect(wholeOctaveShift(a, 76)).toBe(12);
    expect(wholeOctaveShift(a, 64)).toBe(0);
    expect(wholeOctaveShift(a, 59)).toBeUndefined(); // 52..62 down an octave is 40..50, below 43
  });

  it('a hook that fits no octave shift is never sung whole: picked, it is remixed', () => {
    // maxNote 59: only D (43..57) fits; A and B would need to go below 43. wholeShare 1: every pick of D is whole.
    useIndex({ chorus: { melodic: ['hooks'] } }, 1, { chorus: 59 });
    const picks = sample(40, 110);
    const whole = picks.filter((m) => m.rhythmicPrecedentId === m.melodicPrecedentId);
    expect(ids(whole)).toEqual(new Set([D]));
    for (const m of whole) expectWholeHook(m, hookById(D), 0);
    expect(picks.length - whole.length).toBeGreaterThan(10); // A or B picked: the remix merge ran
  });

  it('no candidate of either kind: an error naming section, tempo and the reason; with a legacy bank listed, only it', () => {
    // C is the only verse hook at 70 bpm; under maxNote 50 it fits no octave shift, and mixing needs two.
    useIndex({ verse: { melodic: ['hooks'] } }, 1, { verse: 50 });
    expect(() => select('s', 70, 'verse')).toThrow(
      /no melody for testGenre\/verse at 70 bpm: hooks bank "hooks": 1 hook\(s\) written for verse with tempoMin <= 70 <= tempoMax, 0 of them may be sung whole and fit the range up to maxNote 50, 1 may be remixed \(mixing needs two\)/,
    );
    useIndex({ chorus: { melodic: ['hooks', 'schlager'], rhythmic: 'schlager' } }, 1);
    const hookIds = new Set(HOOKS.map((h) => h.id));
    for (const m of sample(20, 200)) expect(hookIds.has(String(m.melodicPrecedentId))).toBe(false);
  });

  it('a hook alone for its section and tempo is sung whole even with wholeShare 0 (it has no partner to mix with)', () => {
    useIndex({ verse: { melodic: ['hooks'] } }, 0);
    for (const m of sample(10, 70, 'verse')) expectWholeHook(m, hookById(C), 0);
  });

  it('cuts a lead-in bar (start 1, end 9) off like the legacy start-1 entries (8-bar section)', () => {
    useIndex({ chorus: { melodic: ['hooks'] } }, 1, { chorus: 64 });
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

describe('hooks: their own maxNote', () => {
  it('hooks use hooks.maxNote of the section type, not the rule maxNote (which stays for legacy picks)', () => {
    // The rule says 55 (no fixture chorus hook fits whole); the hooks setting says 64 (A, B, D fit as written).
    useIndex({ chorus: { melodic: ['hooks'], maxNote: 55 } }, 1, { chorus: 64 });
    const picks = sample(30, 110);
    expect(ids(picks)).toEqual(new Set([A, B, D]));
    for (const m of picks) {
      expectWholeHook(m, hookById(m.melodicPrecedentId), 0);
      expect(m.properties.maxNote).toBe(64);
    }
    useIndex({ chorus: { melodic: ['hooks'], maxNote: 55 } }, 0, { chorus: 64 });
    for (const m of sample(20, 110)) expect(m.properties.maxNote).toBe(64);
    // A legacy pick from the same list keeps the rule's maxNote.
    useIndex({ chorus: { melodic: ['hooks', 'schlager'], rhythmic: 'schlager', maxNote: 55 } }, 1, { chorus: 64 });
    const hookIds = new Set(HOOKS.map((h) => h.id));
    const legacy = sample(30, 110).filter((m) => !hookIds.has(String(m.melodicPrecedentId)));
    expect(legacy.length).toBeGreaterThan(0);
    for (const m of legacy) expect(m.properties.maxNote).toBe(55);
  });

  it('a section type missing from hooks.maxNote is an error when its rule lists the hooks bank', () => {
    useIndex({ bridge: { melodic: ['hooks'] } }, 1, { chorus: 64 });
    expect(() => select('s', 110, 'bridge')).toThrow(/testGenre\/bridge uses the hooks bank but bank-index hooks.maxNote has no entry for "bridge"/);
  });
});

describe('hooks: mixed with a second hook', () => {
  it('takes the rhythm from one hook and the pitches and chords from another (range does not filter)', () => {
    useIndex({ chorus: { melodic: ['hooks'] } }, 0, { chorus: 55 });
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
    useIndex({ chorus: { melodic: ['hooks'] } }, 0.5, { chorus: 64 });
    const whole = sample(200, 110).filter((m) => m.rhythmicPrecedentId === m.melodicPrecedentId).length;
    expect(whole).toBeGreaterThan(70);
    expect(whole).toBeLessThan(130);
  });

});

describe('hooks: section type and tempo filters', () => {
  it('offers only hooks with tempoMin <= tempo <= tempoMax (inclusive)', () => {
    useIndex({ chorus: { melodic: ['hooks'] } }, 1, { chorus: 64 });
    expect(ids(sample(30, 135))).toEqual(new Set([B]));
    expect(ids(sample(40, 130))).toEqual(new Set([A, B]));
    expect(ids(sample(30, 85))).toEqual(new Set([D]));
    expect(() => select('s', 200)).toThrow(/no melody for testGenre\/chorus at 200 bpm/);
  });

  it('offers only hooks written for the section type', () => {
    useIndex({ verse: { melodic: ['hooks'] }, chorus: { melodic: ['hooks'] } }, 1, { verse: 64, chorus: 64 });
    expect(ids(sample(20, 70, 'verse'))).toEqual(new Set([C])); // C is the only Verse hook
    expect(() => select('s', 70, 'chorus')).toThrow(/0 hook\(s\) written for chorus/); // C suits 70 bpm but is a Verse
    expect(() => select('s', 110, 'verse')).toThrow(/0 hook\(s\) written for verse/); // D suits 110 bpm but is a Chorus
  });
});

describe('several melodic banks', () => {
  it('a legacy bank picked from the list behaves exactly as a single-bank rule (after the bank draw)', () => {
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
      index: { $schemaVersion: 1, wholeShare: 0.5, banks: { schlager: { file: 'mlDataRaw-schlager.json' } }, genres: { testGenre: { chorus: { melodic: 'schlager', rhythmic: 'schlager' } } } },
      files: { 'mlDataRaw-schlager.json': schlager },
    });
    expect(select('same', 110)).toEqual(withHooksSetting);
  });
});

describe('bank index checks', () => {
  it('the hooks bank may be a single melodic bank, never a rhythmic bank; lists name known banks', () => {
    useIndex({ chorus: { melodic: 'hooks' } }, 1);
    for (const m of sample(10, 110)) expect([A, B, D]).toContain(m.melodicPrecedentId);
    useIndex({ chorus: { melodic: ['schlager'], rhythmic: 'hooks' } });
    expect(() => loadBankIndex()).toThrow(/cannot be a rhythmic bank/);
    useIndex({ chorus: { melodic: ['schlager', 'nope'] } });
    expect(() => loadBankIndex()).toThrow(/melodic bank "nope" is not listed under banks/);
  });

  it('the real bank index: every section uses every melodic bank (Melody Sauce retired)', () => {
    setPrecedentDataForTests(undefined);
    const index = loadBankIndex();
    expect(index.wholeShare).toBe(0.5);
    expect(index.hooks).toEqual({ bank: 'hooks', maxNote: { verse: 55, preChorus: 64, chorus: 64, bridge: 64 } });
    expect(Object.keys(index.banks)).not.toContain('stefan');
    for (const rules of Object.values(index.genres)) {
      for (const rule of Object.values(rules)) expect(rule.melodic).toEqual(['hooks', 'drLuke', 'schlager', 'limitedRange']);
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
        wholeShare,
        hooks: { bank: 'hooks', maxNote: Object.fromEntries(Object.values(SECTION).map((s) => [s, maxNote])) },
        genres: { testGenre: Object.fromEntries(Object.values(SECTION).map((s) => [s, { melodic: ['hooks'] }])) },
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
          expect((err as Error).message).toMatch(/no melody for testGenre\/\w+ at \d+ bpm/);
          continue;
        }
        for (const m of ms) expect(m.rhythmicPrecedentId).not.toBe(m.melodicPrecedentId);
      }
    }
  });
});

describe('selection by recipe (bank index "recipes")', () => {
  const rhythms = JSON.parse(readFileSync(resolve(PRECEDENTS, 'mlDataRaw-rhythmic-dance.json'), 'utf8')) as Precedent[];
  const schlagerEntries = schlager as Precedent[];
  const pairOf = (id: string | number | undefined, name: string | undefined) => `${id}|${name}`;
  const RHYTHM = new Set(rhythms.map((e) => pairOf(e.id, e.properties.name)));
  const SCHLAGER = new Set(schlagerEntries.map((e) => pairOf(e.id, e.properties.name)));
  const HOOK_IDS = new Set(HOOKS.map((h) => h.id));
  const ZERO = { hookWhole: 0, hookOnHook: 0, hookOnStyle: 0, curatedOnStyle: 0, curatedOnHook: 0 };
  function useRecipes(weights: Partial<typeof ZERO>, curatedBanks: Record<string, number> = { schlager: 1 }): void {
    setPrecedentDataForTests({
      index: {
        $schemaVersion: 1,
        banks: { hooks: { file: 'hooks.json' }, schlager: { file: 'mlDataRaw-schlager.json' }, 'rhythmic-dance': { file: 'mlDataRaw-rhythmic-dance.json' } },
        wholeShare: 0.5,
        hooks: { bank: 'hooks', maxNote: HOOK_MAX_NOTE },
        recipes: { chorus: { ...ZERO, ...weights, curatedBanks } },
        genres: { testGenre: { chorus: { melodic: ['hooks', 'schlager'], rhythmic: 'rhythmic-dance' } } },
      },
      files: { 'hooks.json': HOOKS, 'mlDataRaw-schlager.json': schlager, 'mlDataRaw-rhythmic-dance.json': rhythms },
    });
  }
  const kind = (m: MergedPrecedent) => {
    const mel = HOOK_IDS.has(String(m.melodicPrecedentId)) ? 'hook' : SCHLAGER.has(pairOf(m.melodicPrecedentId, m.melodicPrecedentName)) ? 'schlager' : 'other';
    const rhy = HOOK_IDS.has(String(m.rhythmicPrecedentId)) ? 'hook' : RHYTHM.has(pairOf(m.rhythmicPrecedentId, m.rhythmicPrecedentName)) ? 'style' : 'other';
    return `${mel} on ${rhy}`;
  };

  it('makes each recipe from the right sources and says which it used', () => {
    useRecipes({ hookWhole: 1 });
    for (const m of sample(20, 110)) {
      expect(m.recipe).toBe('hookWhole');
      expect(m.melodicPrecedentId).toBe(m.rhythmicPrecedentId);
      expect(HOOK_IDS.has(String(m.melodicPrecedentId))).toBe(true);
    }
    useRecipes({ hookOnHook: 1 });
    for (const m of sample(20, 110)) {
      expect([m.recipe, kind(m)]).toEqual(['hookOnHook', 'hook on hook']);
      expect(m.melodicPrecedentId).not.toBe(m.rhythmicPrecedentId);
    }
    useRecipes({ hookOnStyle: 1 });
    for (const m of sample(20, 110)) {
      expect([m.recipe, kind(m)]).toEqual(['hookOnStyle', 'hook on style']);
      // The hook brings its chords.
      expect(Object.fromEntries(Object.entries(m.chords).map(([b, c]) => [b, c.chord]))).toEqual(hookFromBarOne(hookById(m.melodicPrecedentId)).chords);
    }
    useRecipes({ curatedOnStyle: 1 });
    for (const m of sample(20, 110)) expect([m.recipe, kind(m)]).toEqual(['curatedOnStyle', 'schlager on style']);
    useRecipes({ curatedOnHook: 1 });
    for (const m of sample(20, 110)) expect([m.recipe, kind(m)]).toEqual(['curatedOnHook', 'schlager on hook']);
  });

  it('draws recipes by their relative weights', () => {
    useRecipes({ hookWhole: 3, curatedOnStyle: 1 });
    const n = 400;
    const whole = sample(n, 110).filter((m) => m.recipe === 'hookWhole').length;
    expect(whole / n).toBeGreaterThan(0.68);
    expect(whole / n).toBeLessThan(0.82);
  });

  it('leaves out a recipe that cannot be made here, and stops with an error when none can', () => {
    // At 135 bpm only one chorus hook suits (Climb B, 100-140): no second hook to mix with.
    useRecipes({ hookOnHook: 1, curatedOnStyle: 1 });
    expect(new Set(sample(30, 135).map((m) => m.recipe))).toEqual(new Set(['curatedOnStyle']));
    useRecipes({ hookOnHook: 1 });
    expect(() => select('x', 135)).toThrow(/no recipe can make a melody for testGenre\/chorus at 135 bpm: .*hookOnHook cannot be made/);
  });

  it('refuses a bank index whose rule lists a curated bank without a weight', () => {
    useRecipes({ curatedOnStyle: 1 }, { drLuke: 1 });
    expect(() => select('x', 110)).toThrow(/melodic bank "schlager" has no weight in recipes.chorus.curatedBanks/);
  });
});
