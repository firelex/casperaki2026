// docs/56b — EDM seed adapter lowering tests.
//
// Asserts toEngineFixture lowers the edm-vertical-slice song to a
// valid engine envelope: drums/bass/synths/pluckedSynths/loop/
// transitions present, keys/pad/guitar absent (no edm catalog rows).

import { describe, expect, it } from 'vitest';
import { orchestrate, type GenerateParams } from '@casperaki/arrangement';

import { toEngineFixture } from '../src/index.js';

const EDM_PARAMS: GenerateParams = {
  genre: 'edm',
  key: 'C',
  bpm: 128,
  seed: 'edm-vertical-slice',
};

describe('toEngineFixture — EDM seed (docs/56b + docs/58 lane model)', () => {
  it('emits drums + bass + keys + pad + leadSynths + synthsPlucked lanes', () => {
    const song = orchestrate(EDM_PARAMS);
    const fixture = toEngineFixture(song, {
      brainHash: 'fake-hash',
      generatorParams: EDM_PARAMS,
    });
    const instTypes = fixture.instruments.map((f) => (f.json as { type?: string })?.type);
    expect(instTypes).toContain('drums');
    expect(instTypes).toContain('basses');
    expect(instTypes).toContain('leadSynths'); // Synths (+ Synths 2 duplicate)
    expect(instTypes).toContain('synths'); // PluckedSynths + Pad
    // docs/58 lane model — edm now rosters Keys + Pad too.
    expect(instTypes).toContain('keys');
  });

  it('keeps canonical inst-N slots: Bass=2, Keys=3, Pad=4, Synths=6, PluckedSynths=7; duplicates at 10+', () => {
    const song = orchestrate(EDM_PARAMS);
    const fixture = toEngineFixture(song, {
      brainHash: 'fake-hash',
      generatorParams: EDM_PARAMS,
    });
    const byName = (n: string) =>
      fixture.instruments.find((f) => (f.json as { name?: string }).name === n);
    expect(byName('Bass')?.filename).toBe('inst-2.json');
    expect(byName('Keys')?.filename).toBe('inst-3.json');
    expect(byName('Pad')?.filename).toBe('inst-4.json');
    expect(byName('Synths')?.filename).toBe('inst-6.json');
    expect(byName('PluckedSynths')?.filename).toBe('inst-7.json');
    // The duplicate leadSynths lane lands in the 10+ duplicate slot range.
    const synths2 = byName('Synths 2');
    expect(synths2).toBeDefined();
    expect(Number(/inst-(\d+)\.json/.exec(synths2!.filename)![1])).toBeGreaterThanOrEqual(10);
    // All emitted inst filenames are unique (no lane clobbers another).
    const files = fixture.instruments.map((f) => f.filename);
    expect(new Set(files).size).toBe(files.length);
  });

  it('per-segment instruments flag matches override presence for every lane', () => {
    const song = orchestrate(EDM_PARAMS);
    const fixture = toEngineFixture(song, {
      brainHash: 'fake-hash',
      generatorParams: EDM_PARAMS,
    });
    const envelope = fixture.songJson as {
      arrangement: Record<
        string,
        {
          instruments: Record<string, boolean>;
          overrides: Record<string, { bars?: unknown[] }>;
        }
      >;
    };
    // Tonal lane names emitted as their own inst.
    const tonalLaneNames = fixture.instruments
      .map((f) => f.json as { name: string; type?: string })
      .filter((j) => j.type !== 'drums' && j.type !== 'percussionLoops')
      .map((j) => j.name);
    for (const [seg, payload] of Object.entries(envelope.arrangement)) {
      for (const lane of tonalLaneNames) {
        if (!(lane in payload.instruments)) continue;
        const isActive = payload.instruments[lane] === true;
        const hasOverride = Boolean(payload.overrides[lane]?.bars?.length);
        expect(isActive, `${seg}/${lane}`).toBe(hasOverride);
      }
    }
  });

  it('duplicate leadSynths lane (Synths 2) fires on a different segment set than Synths', () => {
    const song = orchestrate(EDM_PARAMS);
    const fixture = toEngineFixture(song, {
      brainHash: 'fake-hash',
      generatorParams: EDM_PARAMS,
    });
    const envelope = fixture.songJson as {
      arrangement: Record<string, { instruments: Record<string, boolean> }>;
    };
    const activeSegs = (lane: string) =>
      Object.entries(envelope.arrangement)
        .filter(([, v]) => v.instruments[lane] === true)
        .map(([k]) => k);
    const synths = activeSegs('Synths');
    const synths2 = activeSegs('Synths 2');
    expect(synths.length).toBeGreaterThan(0);
    expect(synths2.length).toBeGreaterThan(0);
    // The two duplicate-family lanes are independently activated — they are
    // not forced onto the same segments (the lane model's whole point).
    expect(synths.join(',')).not.toBe(synths2.join(','));
  });

  it('PluckedSynths override carries noteRelative events on active segments', () => {
    const song = orchestrate(EDM_PARAMS);
    const fixture = toEngineFixture(song, {
      brainHash: 'fake-hash',
      generatorParams: EDM_PARAMS,
    });
    const envelope = fixture.songJson as {
      arrangement: Record<string, {
        instruments: Record<string, boolean>;
        overrides: Record<string, { bars?: Array<{ notes?: Record<string, Array<{ type: string; distanceFromMiddleC?: number }>> }> }>;
      }>;
    };
    let totalNoteRelative = 0;
    for (const [, seg] of Object.entries(envelope.arrangement)) {
      if (seg.instruments.PluckedSynths !== true) continue;
      const ov = seg.overrides.PluckedSynths;
      for (const bar of ov?.bars ?? []) {
        for (const events of Object.values(bar.notes ?? {})) {
          for (const ev of events) if (ev.type === 'noteRelative') totalNoteRelative++;
        }
      }
    }
    expect(totalNoteRelative).toBeGreaterThan(0);
  });

  it('diagnostics include PluckedSynths lane lowering message', () => {
    const song = orchestrate(EDM_PARAMS);
    const fixture = toEngineFixture(song, {
      brainHash: 'fake-hash',
      generatorParams: EDM_PARAMS,
    });
    const diag = fixture.diagnostics.find((d) => d.path === 'arrangement.PluckedSynths');
    expect(diag).toBeDefined();
    expect(diag?.action).toBe('normalized');
  });

  // docs/56b §"Synths render silence" — the engine's
  // TonalInstrument::processSegment early-returns when getInstrumentPattern
  // (SequencerUtils.h:75) finds no matching instrumentId, BEFORE consulting
  // the per-segment override. Without a patterns[0].pattern stub, every
  // Synths/PluckedSynths override is silently dropped on the floor. The
  // adapter registers a stub for each emitted tonal inst whose id is not
  // already in the base envelope's patterns table.
  it('patterns[0].pattern includes a stub entry for Synths (id=39140) so the engine override path is reached', () => {
    const song = orchestrate(EDM_PARAMS);
    const fixture = toEngineFixture(song, {
      brainHash: 'fake-hash',
      generatorParams: EDM_PARAMS,
    });
    const envelope = fixture.songJson as {
      patterns: Array<{ pattern: Array<{ instrumentId: number; bars: unknown[] }> }>;
    };
    const synthsStub = envelope.patterns[0]!.pattern.find((p) => p.instrumentId === 39140);
    expect(synthsStub).toBeDefined();
    // A single empty-notes bar avoids `barIndex % bars->size()` modulo-by-zero
    // (TonalInstrument.h:83) on the engine's fallback path; the override
    // replaces these bars on every segment the brain activated.
    expect(Array.isArray(synthsStub?.bars)).toBe(true);
    expect((synthsStub?.bars ?? []).length).toBeGreaterThan(0);
  });

  it('patterns[0].pattern includes a stub entry for PluckedSynths (id=39160)', () => {
    const song = orchestrate(EDM_PARAMS);
    const fixture = toEngineFixture(song, {
      brainHash: 'fake-hash',
      generatorParams: EDM_PARAMS,
    });
    const envelope = fixture.songJson as {
      patterns: Array<{ pattern: Array<{ instrumentId: number; bars: unknown[] }> }>;
    };
    const stub = envelope.patterns[0]!.pattern.find((p) => p.instrumentId === 39160);
    expect(stub).toBeDefined();
    expect(Array.isArray(stub?.bars)).toBe(true);
    expect((stub?.bars ?? []).length).toBeGreaterThan(0);
  });

  it('emits no orphan patterns stub: stripping the leadSynths/plucked lanes drops their insts and stubs', () => {
    // docs/58 lane model — force-strip every leadSynths lane (Synths,
    // Synths 2, …) and the synthsPlucked lane (PluckedSynths) by mutating
    // the orchestrated song. The adapter must then emit NO inst of those
    // types AND push no patterns stub for them: every stub id must map to a
    // currently-emitted tonal inst (no leftover orphan from the base scan).
    const baseSong = orchestrate(EDM_PARAMS);
    const stripped = JSON.parse(JSON.stringify(baseSong)) as typeof baseSong & {
      instrumentDefinitions: Array<{ name?: string }>;
      arrangement: Record<string, { instruments?: Record<string, boolean>; overrides?: Record<string, unknown> }>;
    };
    const isStrippedName = (n: string | undefined) =>
      typeof n === 'string' && (n.startsWith('Synths') || n === 'PluckedSynths');
    stripped.instrumentDefinitions = (stripped.instrumentDefinitions ?? []).filter(
      (d) => !isStrippedName(d.name),
    );
    for (const seg of Object.values(stripped.arrangement ?? {})) {
      for (const map of [seg.instruments, seg.overrides]) {
        if (!map) continue;
        for (const k of Object.keys(map)) if (isStrippedName(k)) delete (map as Record<string, unknown>)[k];
      }
    }
    const fixture = toEngineFixture(stripped, {
      brainHash: 'fake-hash',
      generatorParams: EDM_PARAMS,
    });
    // No leadSynths / synthsPlucked inst emitted any more.
    const emittedTypes = fixture.instruments.map((f) => (f.json as { type?: string }).type);
    expect(emittedTypes).not.toContain('leadSynths');
    // (Pad is also a `synths`-type lane, so we check by emitted name set.)
    const emittedNames = new Set(
      fixture.instruments.map((f) => (f.json as { name?: string }).name),
    );
    expect([...emittedNames].some((n) => n?.startsWith('Synths') || n === 'PluckedSynths')).toBe(
      false,
    );
    // No orphan stubs: every tonal patterns id maps to an emitted inst id
    // (or a legacy base id that the engine ignores when no inst uses it).
    const envelope = fixture.songJson as {
      patterns: Array<{ pattern: Array<{ instrumentId: number }> }>;
    };
    const emittedIds = new Set(
      fixture.instruments.map((f) => (f.json as { id?: number }).id),
    );
    const ids = envelope.patterns[0]!.pattern.map((p) => p.instrumentId);
    // The duplicate-lane stub ids (39300+) are only ever added for emitted
    // duplicate lanes — none survive once the leadSynths lanes are stripped.
    for (const id of ids) {
      if (id >= 39300) {
        expect(emittedIds.has(id), `orphan duplicate-lane stub id ${id}`).toBe(true);
      }
    }
  });
});
