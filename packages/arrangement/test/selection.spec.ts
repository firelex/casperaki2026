// Step 5 — instrument selection tests (docs/58i lane model).
//
// The roster is now a probabilistic per-song combination of lanes (port of
// legacy `patterns.js getPattern` + `ArrangementsClass.js:578-739`), so tests
// pin the lane CONTRACT rather than a fixed roster:
// - Output validates against SelectionResultSchema.
// - Drums + Bass + a Pad are essential lanes, present in every roster + active
//   in every segment.
// - Every picked entry is a validated catalog row (16-hex id, in byId).
// - Lane names are unique; activeLanes ⊆ roster lane names.
// - Activation is per segment TYPE (chorus1 === chorus2); chorus = full roster.
// - Reproducible (same seed identical) + cross-seed roster variance.
// - Unsupported genre rejected; selection never reads legacy catalog.json.
// - Golden fixture equality.

import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { createRng } from '@casperaki/music-theory';
import { stableStringify } from '@casperaki/song-schema';

import { selectInstruments } from '../src/selection/index.js';
import { generateSongStructure } from '../src/structure/index.js';
import {
  SelectionResultSchema,
  ValidatedCatalogEntrySchema,
  loadValidatedCatalog,
  type GenerateParams,
  type GeneratorContext,
} from '../src/index.js';
import { selectionGoldenPath } from './fixtures.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SELECTION_SRC_DIR = resolve(HERE, '..', 'src', 'selection');

function makeCtx(seed: string | number, key = 'C', genre = 'brightPop'): GeneratorContext {
  const params: GenerateParams = { genre, key, bpm: 120, seed };
  return { rng: createRng(seed), params };
}

function generate(seed: string | number, key = 'C', genre = 'brightPop') {
  const ctx = makeCtx(seed, key, genre);
  return selectInstruments(ctx, generateSongStructure(ctx));
}

type Selection = ReturnType<typeof selectInstruments>;

/** Scan seeds until the roster contains a lane of the given catalog-family
 *  classifier (the roster is probabilistic — docs/58i). */
function generateWithFamily(family: string, genre = 'brightPop'): Selection {
  for (let i = 0; i < 400; i++) {
    const sel = generate(`scan-${family}-${i}`, 'C', genre);
    if (sel.instruments.some((s) => s.family === family)) return sel;
  }
  throw new Error(`generateWithFamily: no "${genre}" seed produced a "${family}" lane`);
}

describe('selectInstruments (lane model)', () => {
  it('validates against SelectionResultSchema', () => {
    const result = generate('schema-check');
    expect(SelectionResultSchema.safeParse(result).success).toBe(true);
  });

  it('roster always carries the essential lanes Drums + Bass + Pad', () => {
    const result = generate('essentials-check');
    const essentials = result.instruments.filter((s) => s.essential);
    const families = essentials.map((s) => s.family).sort();
    expect(families).toEqual(['bass', 'drums', 'pad']);
    // Essential catalog-family mapping.
    const byFamily = new Map(result.instruments.map((s) => [s.family, s]));
    expect(byFamily.get('drums')!.entry.family).toBe('kickDrums');
    expect(byFamily.get('bass')!.entry.family).toBe('basses');
    expect(byFamily.get('pad')!.entry.family).toBe('synths');
    expect(['synthsSoftPad', 'synthsBrightPad']).toContain(byFamily.get('pad')!.lowLevel);
  });

  it('every picked entry passes ValidatedCatalogEntrySchema and is in loadValidatedCatalog().byId', () => {
    const validated = loadValidatedCatalog();
    const result = generate('catalog-shape');
    for (const picked of result.instruments) {
      expect(ValidatedCatalogEntrySchema.safeParse(picked.entry).success).toBe(true);
      expect(picked.entry.id).toMatch(/^[0-9a-f]{16}$/u);
      expect(validated.byId.has(picked.entry.id)).toBe(true);
      expect(validated.byId.get(picked.entry.id)).toEqual(picked.entry);
      // Lane's recorded family/lowLevel agree with the picked row.
      expect(picked.lowLevel).toBe(picked.entry.lowLevel);
    }
  });

  it('picked entries are never audit-missing (across many seeds)', () => {
    const validated = loadValidatedCatalog();
    for (let i = 0; i < 48; i++) {
      const result = generate(`audit-missing-canary-${i}`);
      for (const picked of result.instruments) {
        expect(validated.byId.has(picked.entry.id)).toBe(true);
      }
    }
  });

  it('lane display names are unique within a roster', () => {
    for (let i = 0; i < 48; i++) {
      const result = generate(`unique-lanes-${i}`);
      const names = result.instruments.map((s) => s.lane);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it('every active lane is a roster lane (no dangling activation)', () => {
    for (let i = 0; i < 24; i++) {
      const result = generate(`active-subset-${i}`);
      const roster = new Set(result.instruments.map((s) => s.lane));
      for (const segment of result.segments) {
        for (const lane of segment.activeLanes) {
          expect(roster.has(lane), `lane "${lane}" active but not in roster`).toBe(true);
        }
      }
    }
  });

  it('essential lanes are active in every segment', () => {
    const result = generate('essentials-everywhere');
    const essentialNames = result.instruments.filter((s) => s.essential).map((s) => s.lane);
    for (const segment of result.segments) {
      for (const name of essentialNames) {
        expect(segment.activeLanes, `${segment.segmentName} missing ${name}`).toContain(name);
      }
    }
  });

  it('chorus activates the full base roll; same-type segments share activation', () => {
    const result = generate('chorus-fullness');
    // Chorus uses the base roll (`allInstrumentsUsedInPattern`) — NOT the
    // per-segment "add one" lanes (docs/58i), which join the roster but only
    // activate on the non-chorus segments that introduced them.
    const baseLanes = new Set(
      result.instruments.filter((s) => !s.perSegment).map((s) => s.lane),
    );
    const choruses = result.segments.filter((s) => s.segmentName.startsWith('chorus'));
    expect(choruses.length).toBeGreaterThan(0);
    for (const ch of choruses) {
      expect(new Set(ch.activeLanes)).toEqual(baseLanes);
    }
    // Per-segment-TYPE activation: chorus1 === chorus2 (legacy caches by type).
    if (choruses.length > 1) {
      expect([...choruses[0]!.activeLanes].sort()).toEqual([...choruses[1]!.activeLanes].sort());
    }
  });

  it('activity map matches the structure segment names in order', () => {
    const ctx = makeCtx('activity-order');
    const structure = generateSongStructure(ctx);
    const result = selectInstruments(ctx, structure);
    expect(result.segments.map((s) => s.segmentName)).toEqual(structure.map((s) => s.name));
  });

  it('every segment activates at least one lane', () => {
    const result = generate('activity-non-empty');
    for (const segment of result.segments) {
      expect(segment.activeLanes.length).toBeGreaterThan(0);
    }
  });

  it('is reproducible: same seed twice → byte-identical canonical JSON', () => {
    const a = stableStringify(generate('repro'), 2);
    const b = stableStringify(generate('repro'), 2);
    expect(a).toBe(b);
  });

  it('different seeds → different rosters across a sample of N seeds', () => {
    const signatures = new Set<string>();
    for (let i = 0; i < 32; i++) {
      const result = generate(`variance-${i}`);
      const sig = result.instruments
        .map((s) => `${s.lane}:${s.entry.id}`)
        .sort()
        .join(',');
      signatures.add(sig);
    }
    expect(signatures.size).toBeGreaterThan(1);
  });

  it('does not mutate the input structure', () => {
    const ctx = makeCtx('immutability');
    const structure = generateSongStructure(ctx);
    const before = stableStringify(structure, 2);
    selectInstruments(ctx, structure);
    expect(stableStringify(structure, 2)).toBe(before);
  });

  it('rejects an unsupported genre at the selection boundary', () => {
    const goodCtx = makeCtx('genre-check', 'C', 'brightPop');
    const structure = generateSongStructure(goodCtx);
    const badCtx = makeCtx('genre-check', 'C', 'gospel');
    expect(() => selectInstruments(badCtx, structure)).toThrow(/unsupported genre/u);
  });

  it('does NOT read the legacy hand-authored data/catalog.json — only loadValidatedCatalog()', async () => {
    const files = await readdir(SELECTION_SRC_DIR);
    expect(files.includes('data.ts')).toBe(false);
    for (const f of files) {
      const body = await readFile(resolve(SELECTION_SRC_DIR, f), 'utf8');
      expect(body).not.toMatch(/from ['"]\.\/data\.js['"]/u);
      expect(body).not.toMatch(/\bloadCatalog\b/u);
      expect(body).not.toMatch(/data\/catalog\.json/u);
    }
  });

  it('matches committed golden fixture (brightPop / brightPop-vertical-slice)', async () => {
    const seed = 'brightPop-vertical-slice';
    const generated = `${stableStringify(generate(seed), 2)}\n`;
    const golden = await readFile(selectionGoldenPath('brightPop', seed), 'utf8');
    expect(generated).toBe(golden);
  });
});

// docs/54r — percussion-loop lane.
describe('selectInstruments — percussion loop lane (docs/54r)', () => {
  it('picks a Loop entry at song bpm for brightPop', () => {
    const result = generate('brightPop-vertical-slice');
    expect(result.loop).toBeDefined();
    expect(result.loop!.displayName).toBe('Loop');
    expect(result.loop!.entry.family).toBe('percussionLoops');
    expect(result.loop!.entry.bpm).toBe(120);
  });

  it('flags loopActive=true on every verse segment, false elsewhere', () => {
    const result = generate('brightPop-vertical-slice');
    for (const seg of result.segments) {
      const isVerse = seg.segmentName.startsWith('verse');
      expect(seg.loopActive, `segment "${seg.segmentName}" loopActive`).toBe(isVerse);
    }
  });

  it('is reproducible: same seed → identical loop pick', () => {
    const a = generate('brightPop-vertical-slice');
    const b = generate('brightPop-vertical-slice');
    expect(a.loop?.entry.id).toBe(b.loop?.entry.id);
  });

  it('different seeds → different loop picks (genre-aware pool > 1)', () => {
    const a = generate('seed-loop-one');
    const b = generate('seed-loop-two');
    expect(a.loop?.entry.id).not.toBe(b.loop?.entry.id);
  });
});

// docs/54s/54u — guitar lane (probabilistic in the lane model).
describe('selectInstruments — guitar lane (docs/54s + 54u)', () => {
  it('a guitar lane, when present, is a Default Notes stereo row', () => {
    const result = generateWithFamily('guitar');
    const guitars = result.instruments.filter((s) => s.family === 'guitar');
    expect(guitars.length).toBeGreaterThan(0);
    const allowed = [
      'acousticGuitarsNylonStereo',
      'acousticGuitarsSteelStereo',
      'electricGuitarsDominoStereo',
      'electricGuitarsLpChorusStereo',
      'electricGuitarsStratDriveStereo',
      'electricGuitarsWarmCrunchStereo',
    ];
    for (const g of guitars) {
      expect(['acousticGuitars', 'electricGuitars']).toContain(g.entry.family);
      expect(allowed).toContain(g.entry.lowLevel);
      expect(g.entry.preset).toBe('Default Notes');
    }
  });

  it('is reproducible: same seed → identical guitar picks', () => {
    // Find a guitar-bearing seed deterministically, then re-run it.
    let seed: string | undefined;
    for (let i = 0; i < 400 && !seed; i++) {
      const s = `gtr-${i}`;
      if (generate(s).instruments.some((x) => x.family === 'guitar')) seed = s;
    }
    expect(seed).toBeDefined();
    const a = generate(seed!).instruments.filter((s) => s.family === 'guitar').map((s) => s.entry.id);
    const b = generate(seed!).instruments.filter((s) => s.family === 'guitar').map((s) => s.entry.id);
    expect(a).toEqual(b);
  });
});

// docs/06-16 to-do #9 — popStrings roster breadth. Legacy patterns.js
// getPattern rosters a pop/orchestral string section in five genres:
//   ballad      (decision1 1-in-5 'strings' branch — :480,:507)
//   edm/schlager(focusOnSynths 1-in-2 accented strings :592-616;
//                focusOnBass always 'stringSupport' :645-668)
//   organicVibes(every decision1 branch 1-in-2 strings — :866-904)
//   urban       (trailing 1-in-2 strings — :993-998)
// brightPop (decision1 hard-overridden to 'guitar'), latin, and rock never
// roster strings. The earlier rebuild only rostered strings via
// `edm ? STRINGS : BRASS`, so schlager/ballad/organicVibes/urban were silent.
describe('selectInstruments — popStrings roster breadth (to-do #9)', () => {
  function genreCanRosterStrings(genre: string, trials = 300): boolean {
    for (let i = 0; i < trials; i++) {
      const sel = generate(`strings-scan-${genre}-${i}`, 'C', genre);
      if (sel.instruments.some((s) => s.family === 'popStrings')) return true;
    }
    return false;
  }

  for (const genre of ['ballad', 'edm', 'schlager', 'organicVibes', 'urban']) {
    it(`rosters a popStrings lane for some "${genre}" seed (legacy distribution)`, () => {
      expect(genreCanRosterStrings(genre)).toBe(true);
    });
  }

  for (const genre of ['brightPop', 'latin', 'rock']) {
    it(`never rosters a popStrings lane for "${genre}" (legacy has no strings branch)`, () => {
      expect(genreCanRosterStrings(genre)).toBe(false);
    });
  }
});
