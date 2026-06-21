// docs/56c — All-canonical-genre engine-adapter coverage smoke.
//
// For every entry in GenreSchema:
//   1. `toEngineFixture(orchestrate(...), opts)` succeeds.
//   2. Every emitted inst-N.json's `type` literal is either a legal
//      tonal type (basses / leadSynths / synths / keys / popBrass /
//      popStrings / orchestral / vocals / acousticGuitars /
//      electricGuitars) OR a legal non-tonal type
//      (drums / Loop / percussionLoops / transitionSample /
//      signalProcessor / ...). No surprise type strings the engine
//      can't route.
//   3. The TonalInstrument patterns[] stub invariant
//      (docs/56b §"Engine patterns[] gap" + docs/54w) holds — every
//      emitted tonal inst id has a matching entry at
//      envelope.patterns[0].pattern, and that entry's bars[] is
//      non-empty (modulo-by-zero guard).

import { describe, expect, it } from 'vitest';

import { DEFAULT_BPM_BY_GENRE, GenreSchema } from '@casperaki/song-schema';
import { orchestrate, type GenerateParams } from '@casperaki/arrangement';

import { toEngineFixture } from '../src/index.js';

const GENRES = GenreSchema.options as readonly string[];

// Engine type strings that route to a TonalInstrument-derived class.
// Mirrors TONAL_INSTRUMENT_TYPES in src/index.ts; kept in sync with
// Instrument.cpp's typeTable + CasperakiEngine.cpp:440-456.
const TONAL_TYPES: ReadonlySet<string> = new Set([
  'basses',
  'leadSynths',
  'synths',
  'keys',
  'popBrass',
  'popStrings',
  'orchestral',
  'vocals',
  'acousticGuitars',
  'electricGuitars',
]);

// Non-tonal engine type strings the adapter is allowed to emit.
// Drums.h, percussionLoops Loop.h, transitionSample, signalProcessor
// (54q). Anything outside this union ∪ TONAL_TYPES is a regression.
const NON_TONAL_TYPES: ReadonlySet<string> = new Set([
  'drums',
  'percussionLoops',
  'transitionSample',
  'transitionPattern',
  'signalProcessor',
  'VocaloidPlaceholder',
]);

function paramsFor(genre: string): GenerateParams {
  return {
    genre,
    key: 'C',
    bpm: DEFAULT_BPM_BY_GENRE[genre as keyof typeof DEFAULT_BPM_BY_GENRE],
    seed: `${genre}-coverage-smoke`,
  };
}

interface InstJsonShape {
  id?: number;
  type?: string;
  name?: string;
}

interface PatternEntryShape {
  instrumentId?: number;
  bars?: unknown;
}

interface EnvelopeShape {
  patterns: Array<{ pattern: PatternEntryShape[] }>;
}

describe('engine-adapter all-genre coverage (docs/56c)', () => {
  for (const genre of GENRES) {
    describe(genre, () => {
      it('toEngineFixture succeeds', () => {
        const song = orchestrate(paramsFor(genre));
        expect(() =>
          toEngineFixture(song, {
            brainHash: 'fake-hash',
            generatorParams: paramsFor(genre),
          }),
        ).not.toThrow();
      });

      it('every emitted inst-N.json type is a legal engine type', () => {
        const song = orchestrate(paramsFor(genre));
        const fixture = toEngineFixture(song, {
          brainHash: 'fake-hash',
          generatorParams: paramsFor(genre),
        });
        for (const file of fixture.instruments) {
          const j = file.json as InstJsonShape;
          if (typeof j.type !== 'string') continue;
          const legal = TONAL_TYPES.has(j.type) || NON_TONAL_TYPES.has(j.type);
          expect(
            legal,
            `genre=${genre} inst "${j.name ?? ''}" carries unknown type "${j.type}" ` +
              `— not in TONAL_INSTRUMENT_TYPES nor legal non-tonal types`,
          ).toBe(true);
        }
      });

      it('emits unique inst-N.json filenames (no lane clobbers another)', () => {
        // Regression: with Pad active + Keys inactive (schlager), Synths
        // computed its filename from instruments.length and collided with
        // Pad's hardcoded inst-4.json, silently dropping the Pad.
        const song = orchestrate(paramsFor(genre));
        const fixture = toEngineFixture(song, {
          brainHash: 'fake-hash',
          generatorParams: paramsFor(genre),
        });
        const names = fixture.instruments.map((f) => f.filename);
        const dupes = names.filter((n, i) => names.indexOf(n) !== i);
        expect(
          dupes,
          `genre=${genre} emitted duplicate inst filenames: ${[...new Set(dupes)].join(', ')}`,
        ).toEqual([]);
      });

      it('TonalInstrument patterns[] stub invariant holds for every emitted tonal inst', () => {
        const song = orchestrate(paramsFor(genre));
        const fixture = toEngineFixture(song, {
          brainHash: 'fake-hash',
          generatorParams: paramsFor(genre),
        });
        const envelope = fixture.songJson as unknown as EnvelopeShape;
        const patternIds = envelope.patterns[0]!.pattern.map((p) => p.instrumentId);
        for (const file of fixture.instruments) {
          const j = file.json as InstJsonShape;
          if (typeof j.type !== 'string' || !TONAL_TYPES.has(j.type)) continue;
          if (typeof j.id !== 'number') continue;
          expect(
            patternIds,
            `genre=${genre} tonal inst "${j.name ?? ''}" (id=${j.id},type=${j.type}) ` +
              `missing from patterns[0].pattern — engine would silently drop its overrides`,
          ).toContain(j.id);
          const entry = envelope.patterns[0]!.pattern.find(
            (p) => p.instrumentId === j.id,
          );
          expect(
            Array.isArray(entry?.bars) && (entry!.bars as unknown[]).length > 0,
            `genre=${genre} tonal inst id=${j.id} has empty bars[] — ` +
              `TonalInstrument.h:83 would modulo-by-zero`,
          ).toBe(true);
        }
      });
    });
  }
});
