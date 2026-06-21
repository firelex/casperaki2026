// docs/56b §"Engine patterns[] gap" + docs/54w — TonalInstrument
// patterns[] stub invariant tests.
//
// The engine's TonalInstrument::processSegment (TonalInstrument.h:36-43)
// early-returns when getInstrumentPattern(songData, inst->id)
// (SequencerUtils.h:75) finds no matching pattern entry — BEFORE the
// per-segment override is consulted. So every inst-N.json the adapter
// emits whose `type` routes to a TonalInstrument-derived class
// (basses → Bass.h; leadSynths/synths/keys/popBrass/popStrings/
// orchestral/vocals → Synths.h; acousticGuitars/electricGuitars →
// Guitar.h) MUST appear in envelope.patterns[0].pattern at the matching
// instrumentId. The adapter's invariant covers this: for every emitted
// tonal inst, it either finds a pre-existing entry in the base envelope
// (Bass=38842, Keys=38907, Pad=38972, Guitar=39111) or pushes a stub at
// the right id (Synths=39140, PluckedSynths=39160; plus any future
// tonal lane).
//
// These tests pin the invariant directly: every emitted tonal inst id
// has at least one matching pattern entry; the entry's bars[] is
// non-empty (modulo-by-zero guard at TonalInstrument.h:83); no
// duplicates are introduced when a pre-existing entry covers the id;
// no stubs are emitted for non-tonal lanes (Drums/Loop/transitions);
// the patterns.tonalStubs diagnostic surfaces what was added vs what
// was already present.

import { describe, expect, it } from 'vitest';
import { orchestrate, type GenerateParams } from '@casperaki/arrangement';

import { toEngineFixture } from '../src/index.js';

const BRIGHTPOP_PARAMS: GenerateParams = {
  genre: 'brightPop',
  key: 'C',
  bpm: 120,
  seed: 'brightPop-vertical-slice',
};

const EDM_PARAMS: GenerateParams = {
  genre: 'edm',
  key: 'C',
  bpm: 128,
  seed: 'edm-vertical-slice',
};

// Engine type strings that route to a TonalInstrument-derived class.
// Mirrors TONAL_INSTRUMENT_TYPES in src/index.ts; kept in sync with
// Instrument.cpp's typeTable + CasperakiEngine.cpp:440-456.
const TONAL_TYPES = new Set<string>([
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

function buildEnvelopeFor(params: GenerateParams): {
  envelope: EnvelopeShape;
  emittedTonal: Array<{ id: number; type: string; name: string }>;
  diagnostics: ReturnType<typeof toEngineFixture>['diagnostics'];
} {
  const song = orchestrate(params);
  const fixture = toEngineFixture(song, {
    brainHash: 'fake-hash',
    generatorParams: params,
  });
  const envelope = fixture.songJson as unknown as EnvelopeShape;
  const emittedTonal: Array<{ id: number; type: string; name: string }> = [];
  for (const file of fixture.instruments) {
    const j = file.json as InstJsonShape;
    if (typeof j.type === 'string' && TONAL_TYPES.has(j.type) && typeof j.id === 'number') {
      emittedTonal.push({ id: j.id, type: j.type, name: typeof j.name === 'string' ? j.name : '' });
    }
  }
  return { envelope, emittedTonal, diagnostics: fixture.diagnostics };
}

describe('TonalInstrument patterns[] stub invariant (docs/56b + docs/54w)', () => {
  for (const [label, params] of [
    ['brightPop seed (Bass+Keys+Pad+Synths+Synths 2/3+PluckedSynths)', BRIGHTPOP_PARAMS],
    ['edm seed (Bass+Keys+Pad+Synths+Synths 2+PluckedSynths)', EDM_PARAMS],
  ] as const) {
    describe(label, () => {
      it('every emitted tonal inst id has at least one matching patterns[0].pattern entry', () => {
        const { envelope, emittedTonal } = buildEnvelopeFor(params);
        expect(emittedTonal.length).toBeGreaterThan(0);
        const ids = envelope.patterns[0]!.pattern.map((p) => p.instrumentId);
        for (const inst of emittedTonal) {
          expect(
            ids,
            `tonal inst ${inst.name}(id=${inst.id},type=${inst.type}) ` +
              `missing from patterns[0].pattern — engine will silently drop its overrides`,
          ).toContain(inst.id);
        }
      });

      it('every matching patterns entry carries a non-empty bars[] (modulo-by-zero guard)', () => {
        const { envelope, emittedTonal } = buildEnvelopeFor(params);
        const entries = envelope.patterns[0]!.pattern;
        for (const inst of emittedTonal) {
          const entry = entries.find((p) => p.instrumentId === inst.id);
          expect(entry).toBeDefined();
          expect(
            Array.isArray(entry?.bars),
            `${inst.name}(id=${inst.id}) bars[] must be an array`,
          ).toBe(true);
          expect(
            (entry?.bars as unknown[]).length,
            `${inst.name}(id=${inst.id}) bars[] is empty — engine ` +
              `TonalInstrument.h:83 does barIndex % bars->size() → modulo-by-zero`,
          ).toBeGreaterThan(0);
        }
      });

      it('no tonal inst id is duplicated in patterns[0].pattern (no double-stub)', () => {
        const { envelope, emittedTonal } = buildEnvelopeFor(params);
        const entries = envelope.patterns[0]!.pattern;
        const tonalIds = new Set(emittedTonal.map((t) => t.id));
        for (const id of tonalIds) {
          const matches = entries.filter((p) => p.instrumentId === id);
          expect(
            matches.length,
            `inst id ${id} appears ${matches.length}× in patterns[0].pattern — ` +
              `the invariant must not add a stub when one already exists`,
          ).toBe(1);
        }
      });

      it('emits a patterns.tonalStubs diagnostic naming every emitted tonal inst', () => {
        const { emittedTonal, diagnostics } = buildEnvelopeFor(params);
        const diag = diagnostics.find((d) => d.path === 'patterns.tonalStubs');
        expect(diag).toBeDefined();
        for (const inst of emittedTonal) {
          expect(diag?.message).toContain(`id=${inst.id}`);
          expect(diag?.message).toContain(`type=${inst.type}`);
        }
      });
    });
  }

  it('does NOT add patterns stubs for non-tonal lanes (Drums/Loop/transitions stay untouched)', () => {
    const { envelope, emittedTonal } = buildEnvelopeFor(EDM_PARAMS);
    const ids = envelope.patterns[0]!.pattern.map((p) => p.instrumentId);
    const tonalIds = new Set(emittedTonal.map((t) => t.id));
    // The base envelope's pre-existing Drums (100) + Loop (31384, 37297)
    // entries should still be there. New entries added by the invariant
    // can ONLY have tonal instrument ids.
    expect(ids).toContain(100); // Drums
    expect(ids).toContain(31384); // Loop
    for (const entry of envelope.patterns[0]!.pattern) {
      const id = entry.instrumentId;
      if (typeof id !== 'number') continue;
      // Either the entry pre-existed in the base fixture (non-tonal ids
      // like 100/31384/37297 plus the Phase-2 tonal placeholders) OR the
      // entry corresponds to a currently-emitted tonal inst.
      // The invariant must never push a NEW entry whose id is non-tonal.
      const isEmittedTonal = tonalIds.has(id);
      const isLegacyBaseEntry = [
        100, // Drums
        31384, // Loop
        37297, // Loop placeholder
        38842, // Bass (also a tonal id; covered by the next check)
        38907, // Keys
        38972, // Pad
        39111, // Guitar
      ].includes(id);
      expect(
        isEmittedTonal || isLegacyBaseEntry,
        `patterns[0].pattern carries an unexpected id ${id} — neither ` +
          `emitted by this run nor a legacy base entry`,
      ).toBe(true);
    }
  });

  it('does not push a duplicate stub when the lane is also emitted in the legacy base (Bass/Keys/Pad/Guitar byte-stability)', () => {
    // The base envelope ships Bass=38842, Keys=38907, Pad=38972,
    // Guitar=39111. The brightPop seed emits all four. Each id must
    // appear exactly once in patterns[0].pattern.
    const { envelope, emittedTonal } = buildEnvelopeFor(BRIGHTPOP_PARAMS);
    const entries = envelope.patterns[0]!.pattern;
    for (const legacyId of [38842, 38907, 38972, 39111]) {
      const count = entries.filter((p) => p.instrumentId === legacyId).length;
      expect(count, `legacy base id ${legacyId} count`).toBe(1);
    }
    // And the brain-emitted ids that have to be stubbed are also unique.
    const emittedIds = emittedTonal.map((t) => t.id);
    for (const id of emittedIds) {
      const count = entries.filter((p) => p.instrumentId === id).length;
      expect(count, `emitted tonal id ${id} count`).toBe(1);
    }
  });

  it('adds exactly one fresh stub per emitted tonal lane not already in the base, including duplicate-family lanes', () => {
    // docs/58 lane model — brightPop now emits Bass + Keys + Pad (all
    // already in the base envelope) plus the parametric leadSynths lanes
    // Synths / Synths 2 / Synths 3 and PluckedSynths, each with a unique
    // wrapper id. Bass/Keys/Pad reuse their pre-existing base entries; the
    // parametric lanes each get a fresh stub. The old fixed-slot scan
    // silently dropped Synths 2 / Synths 3 — this pins that they're stubbed.
    const { envelope, emittedTonal } = buildEnvelopeFor(BRIGHTPOP_PARAMS);
    const entries = envelope.patterns[0]!.pattern;
    // Legacy base ids that pre-exist regardless of what is emitted.
    const baseIds = new Set([100, 31384, 37297, 38842, 38907, 38972, 39111]);
    // Every emitted tonal inst id appears exactly once.
    for (const inst of emittedTonal) {
      expect(
        entries.filter((p) => p.instrumentId === inst.id).length,
        `tonal inst ${inst.name}(id=${inst.id}) count`,
      ).toBe(1);
    }
    // Fresh-stub ids = emitted tonal ids not already in the base.
    const freshStubIds = emittedTonal
      .map((t) => t.id)
      .filter((id) => !baseIds.has(id));
    // The duplicate-family lanes Synths 2 / Synths 3 (fresh wrapper ids in
    // the 39300+ range) MUST be among the fresh stubs.
    const names = new Map(emittedTonal.map((t) => [t.name, t.id]));
    expect(names.has('Synths 2')).toBe(true);
    expect(freshStubIds).toContain(names.get('Synths 2'));
    // Net count: the base ids plus one entry per emitted tonal lane.
    const expectedCount =
      baseIds.size + emittedTonal.filter((t) => !baseIds.has(t.id)).length;
    expect(entries.length).toBe(expectedCount);
  });

  it('edm seed adds stubs for the parametric leadSynths (39140) AND synthsPlucked (39160) lanes', () => {
    const { envelope } = buildEnvelopeFor(EDM_PARAMS);
    const entries = envelope.patterns[0]!.pattern;
    expect(entries.find((p) => p.instrumentId === 39140)).toBeDefined();
    expect(entries.find((p) => p.instrumentId === 39160)).toBeDefined();
  });
});
